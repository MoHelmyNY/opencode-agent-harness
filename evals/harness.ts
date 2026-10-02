/**
 * Eval world: runs one frozen scenario end to end through the plugins' real exported hooks.
 *
 * What is real: every plugin factory and hook, their receipts on disk, the stall watchdog's own interval, the loop's
 * own backoff timers, the project-memory HTTP calls (to a loopback fake gateway).
 * What is simulated: the model and the OpenCode client. The "model" is scripted by the scenario (how long a turn
 * takes, which tool calls it makes); the client is an in-memory session store (messages, todos, prompts, aborts).
 *
 * Time is virtual. Date.now and the timer functions are replaced for the duration of a scenario, so the plugins run
 * at their SHIPPED defaults (30 s debounce, 5 and 30 minute backoff, 5 minute stall threshold, 15 s watchdog tick,
 * 500 ms subagent poll) and two simulated hours take a few seconds. After every timer fires the world waits, in real
 * time, until the plugins' async work has gone quiet before it moves the clock again.
 *
 * Hook order follows OpenCode 1.18 (Plugin.trigger in the shipped binary): plugins run in load order, each awaited;
 * a throw in `tool.execute.before` stops the call, so neither the tool nor `tool.execute.after` runs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const PLUGINS: Record<string, string> = {
  "loop-continuation": "../plugins/loop-continuation.ts",
  "subagent-cap": "../plugins/subagent-cap.ts",
  "stall-watchdog": "../plugins/stall-watchdog.ts",
  "qwen-guardrails": "../plugins/qwen-guardrails.ts",
  "framework-readonly": "../plugins/framework-readonly.ts",
  "project-memory": "../plugins/project-memory.ts",
};

// Real timer functions, captured before any scenario installs the virtual ones.
const real = {
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now, fetch: globalThis.fetch,
};
const realSleep = (ms: number) => new Promise<void>((r) => real.setTimeout(r, ms));

type Timer = { id: number; at: number; fn: (...a: any[]) => any; args: any[]; every: number | null };

/** Virtual clock. `activity` counts observable work (timer changes, client calls, fetches) so `settle` can tell
 *  when the plugins' async chains have gone quiet. */
export class VirtualClock {
  now: number;
  private timers = new Map<number, Timer>();
  private seq = 1;
  activity = 0;
  pending = 0;
  constructor(start: number) { this.now = start; }
  install() {
    const self = this;
    const handle = (id: number) => ({ id, unref() { return this; }, ref() { return this; }, hasRef() { return false; }, refresh() { return this; }, [Symbol.toPrimitive]() { return id; } });
    const add = (fn: any, ms: any, args: any[], every: boolean) => {
      const delay = Math.max(0, Number(ms) || 0);
      const id = self.seq++;
      self.timers.set(id, { id, at: self.now + delay, fn, args, every: every ? Math.max(1, delay) : null });
      self.activity++;
      return handle(id);
    };
    const clear = (h: any) => {
      const id = typeof h === "number" ? h : Number(h?.id);
      if (self.timers.delete(id)) self.activity++;
    };
    (globalThis as any).setTimeout = (fn: any, ms?: any, ...args: any[]) => add(fn, ms, args, false);
    (globalThis as any).setInterval = (fn: any, ms?: any, ...args: any[]) => add(fn, ms, args, true);
    (globalThis as any).clearTimeout = clear;
    (globalThis as any).clearInterval = clear;
    Date.now = () => self.now;
    (globalThis as any).fetch = async (...a: any[]) => {
      self.pending++; self.activity++;
      try { return await (real.fetch as any)(...a); } finally { self.pending--; self.activity++; }
    };
  }
  uninstall() {
    Object.assign(globalThis, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, setInterval: real.setInterval, clearInterval: real.clearInterval, fetch: real.fetch });
    Date.now = real.now;
    this.timers.clear();
  }
  /** Wait in real time until nothing observable has happened for `quiet` consecutive polls. */
  async settle(quiet = 5) {
    let still = 0;
    let last = -1;
    for (let i = 0; i < 5000 && still < quiet; i++) {
      await realSleep(1);
      if (this.pending === 0 && this.activity === last) still++;
      else { still = 0; last = this.activity; }
    }
  }
  /** Fire every timer due up to `target`, in time order, settling after each. */
  async advanceTo(target: number) {
    await this.settle();
    for (;;) {
      let at = Infinity;
      for (const t of this.timers.values()) if (t.at <= target && t.at < at) at = t.at;
      if (at === Infinity) break;
      // every timer due at this instant fires, in creation order, before the world settles
      const due = [...this.timers.values()].filter((t) => t.at === at).sort((a, b) => a.id - b.id);
      this.now = Math.max(this.now, at);
      for (const t of due) {
        if (!this.timers.has(t.id)) continue; // cleared by an earlier callback at this instant
        if (t.every) t.at = this.now + t.every; else this.timers.delete(t.id);
        try { t.fn(...t.args); } catch {}
        this.activity++;
      }
      await this.settle();
    }
    this.now = Math.max(this.now, target);
  }
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

type Row = { info: any; parts: any[] };
type SessionDef = { parentID?: string | null; messages?: { role: string; text: string }[]; todos?: any[] };
type ToolResult = { index: number; callID: string; tool: string; refused: boolean; refusal: string; output: string; hung: boolean };

/** Everything a scenario observes; metrics are computed from this. */
export type Record_ = {
  start: number;
  prompts: { session: string; at: number; text: string }[];
  aborts: { session: string; at: number }[];
  tools: ToolResult[];
  tasks: Map<string, { session: string; startedAt: number; admittedAt: number | null; releasedAt: number | null; failed: boolean; order: number }>;
  admissions: string[];
  transforms: { session: string; system: string[]; base: number }[];
  gatewayCalls: { route: string }[];
  hangs: Map<string, number>;
  watched: Map<string, string>;
  receiptsDir: string;
  writesApplied: number;
};

/** Replace {ROOT} {HOME} {WORK} {STATE} {FRAMEWORK} {WORK_SLUG} {GATEWAY} {METRICS} in every string of a value. */
function fill(value: any, vars: Record<string, string>): any {
  if (typeof value === "string") return value.replace(/\{([A-Z_]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [fill(k, vars), fill(v, vars)]));
  return value;
}

const ENV_PREFIXES = /^(LOOP_CONTINUATION|SUBAGENT_CAP|STALL_WATCHDOG|QWEN_GUARDRAILS|PROJECT_MEMORY|AGENT_WORKFLOW)/;

export async function runScenario(sc: any): Promise<Record_> {
  const savedEnv = { ...process.env };
  const root = mkdtempSync(path.join(tmpdir(), "harness-eval-")).replace(/\\/g, "/");
  const servers: any[] = [];
  const clock = new VirtualClock(real.now());
  try {
    // ---- hermetic paths: nothing may reach the real home, state or config directories
    const vars: Record<string, string> = {
      ROOT: root, HOME: `${root}/home`, STATE: `${root}/state`, WORK: `${root}/work/app`, FRAMEWORK: `${root}/home/agent-workflow-lab`,
    };
    vars.WORK_SLUG = vars.WORK.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    for (const k of Object.keys(process.env)) if (ENV_PREFIXES.test(k)) delete process.env[k];
    Object.assign(process.env, {
      HOME: vars.HOME, USERPROFILE: vars.HOME, XDG_STATE_HOME: vars.STATE, LOCALAPPDATA: `${vars.HOME}/AppData/Local`,
      AGENT_WORKFLOW_HOME: vars.FRAMEWORK, AGENT_WORKFLOW_CONFIG_HOME: `${vars.HOME}/.config/opencode/agent-workflow`,
      PROJECT_MEMORY_CONFIG: `${vars.HOME}/.config/opencode/project-memory.json`,
    });
    mkdirSync(vars.HOME, { recursive: true });
    const inputs = sc.inputs || {};

    // ---- fake engine metrics (stall-watchdog reads vLLM's num_requests_running) and fake memory gateway
    let engineRunning = Number(inputs.engine?.running ?? 0);
    const metrics = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`vllm:num_requests_running{engine="0",model_name="eval"} ${engineRunning}.0\n`) });
    servers.push(metrics);
    vars.METRICS = `http://127.0.0.1:${metrics.port}/metrics`;
    process.env.STALL_WATCHDOG_METRICS = vars.METRICS;
    let gatewayMode = String(inputs.gateway?.mode ?? "ok");
    let gatewayN = 0;
    const rec: Record_ = { start: clock.now, prompts: [], aborts: [], tools: [], tasks: new Map(), admissions: [], transforms: [], gatewayCalls: [], hangs: new Map(), watched: new Map(), receiptsDir: `${vars.STATE}/opencode`, writesApplied: 0 };
    const gateway = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const route = new URL(req.url).pathname.replace("/v1/adapter/", "");
        const body: any = await req.json().catch(() => ({}));
        rec.gatewayCalls.push({ route });
        if (gatewayMode !== "ok") return new Response("unavailable", { status: 503 });
        gatewayN++;
        if (route === "bootstrap") {
          // The briefing changes on EVERY request (a timestamp and a counter), so a plugin that re-fetched would
          // push different bytes. Only a plugin that fetches once and reuses the bytes keeps the block identical.
          const text = String(inputs.gateway?.briefing ?? "").replace("{N}", String(gatewayN)).replace("{NOW}", new Date(real.now()).toISOString());
          return Response.json({ task_id: body.task_id, receipt_id: `r${gatewayN}`, status: "ok", verified: [], observations: [], briefing_text: text });
        }
        return Response.json({ receipt_id: `r${gatewayN}`, retained_document_id: null, observations_degraded: false });
      },
    });
    servers.push(gateway);
    vars.GATEWAY = `http://127.0.0.1:${gateway.port}`;

    for (const [k, v] of Object.entries(fill(inputs.env || {}, vars))) process.env[k] = String(v);
    for (const [file, content] of Object.entries(fill(inputs.files || {}, vars))) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }
    if (inputs.worktree) mkdirSync(vars.WORK, { recursive: true });
    for (const file of fill(inputs.watch || [], vars) as string[]) rec.watched.set(file, existsSync(file) ? sha256(readFileSync(file)) : "");
    const directory = inputs.worktree ? vars.WORK : `${root}/work/not-created`;

    // ---- the simulated OpenCode client: an in-memory session store
    const sessions = new Map<string, { parentID: string | null; rows: Row[]; todos: any[] }>();
    let msgSeq = 0;
    const session = (id: string) => {
      let s = sessions.get(id);
      if (!s) { s = { parentID: null, rows: [], todos: [] }; sessions.set(id, s); }
      return s;
    };
    const addMessage = (id: string, role: string, text: string) => {
      const mid = `msg_${String(++msgSeq).padStart(4, "0")}`;
      session(id).rows.push({ info: { id: mid, role, sessionID: id, time: { created: clock.now } }, parts: [{ type: "text", text }] });
      return mid;
    };
    for (const [id, def] of Object.entries(fill(inputs.sessions || {}, vars)) as [string, SessionDef][]) {
      const s = session(id);
      s.parentID = def.parentID ?? null;
      s.todos = def.todos || [];
      for (const m of def.messages || []) addMessage(id, m.role, m.text);
    }
    const model = inputs.model || null;
    let turn = 0;
    const touch = <T>(v: T) => { clock.activity++; return v; };
    const client: any = {
      session: {
        get: async ({ path: p }: any) => touch({ data: { id: p.id, parentID: session(p.id).parentID } }),
        messages: async ({ path: p }: any) => touch({ data: session(p.id).rows.map((r) => ({ info: { ...r.info }, parts: r.parts.map((x) => ({ ...x, state: x.state ? { ...x.state } : undefined })) })) }),
        todo: async ({ path: p }: any) => touch({ data: session(p.id).todos.map((t) => ({ ...t })) }),
        summarize: async () => touch({ data: true }),
        abort: async ({ path: p }: any) => {
          rec.aborts.push({ session: p.id, at: clock.now - rec.start });
          for (const row of session(p.id).rows) for (const part of row.parts) if (part.type === "tool" && part.state?.status === "running") part.state.status = "error";
          return touch({ data: true });
        },
        promptAsync: async ({ path: p, body }: any) => {
          const text = (body?.parts || []).map((x: any) => x.text || "").join("\n");
          rec.prompts.push({ session: p.id, at: clock.now - rec.start, text });
          addMessage(p.id, "user", text);
          if (model) {
            // The scripted model: the turn runs `turnMs`, makes its scripted tool calls, then the session goes idle.
            const n = ++turn;
            globalThis.setTimeout(async () => {
              for (const call of model.toolsPerTurn || []) {
                const sha = createHash("sha1").update(`turn-${n}`).digest("hex").slice(0, 7);
                const c = fill(call, { TURN: String(n), SHA: sha });
                await runTool(p.id, c.tool, c.args || {}, c.output ?? "");
              }
              await dispatch({ type: "session.idle", properties: { sessionID: p.id } });
            }, Number(model.turnMs || 0));
          }
          return touch({ data: {} });
        },
      },
      tui: { showToast: async () => touch({ data: true }) },
      app: { log: async () => touch({ data: true }) },
    };

    // ---- load the plugins (factories read their env at call time)
    const loaded: { name: string; hooks: any }[] = [];
    const load = async () => {
      loaded.length = 0;
      for (const name of sc.plugins as string[]) {
        if (!PLUGINS[name]) throw new Error(`unknown plugin ${name}`);
        if (name === "subagent-cap") delete (globalThis as any).__opencodeSubagentCap;
        const mod: any = await import(PLUGINS[name]);
        loaded.push({ name, hooks: (await mod.default({ client, directory })) || {} });
      }
    };
    clock.install();
    await load();
    await clock.settle();

    const dispatch = async (event: any) => {
      for (const p of loaded) if (p.hooks.event) { try { await p.hooks.event({ event }); } catch {} }
    };
    const inside = (file: string) => path.resolve(file).replace(/\\/g, "/").toLowerCase().startsWith(root.toLowerCase() + "/");
    let callSeq = 0;
    /** One tool call through OpenCode's order: every before hook (a throw stops the call), the tool, every after hook. */
    async function runTool(sessionID: string, tool: string, args: any, output: string, opts: { hang?: boolean; callID?: string; effect?: any } = {}) {
      const callID = opts.callID || `call_${String(++callSeq).padStart(4, "0")}`;
      const part = { type: "tool", callID, tool, state: { status: "running" } };
      session(sessionID).rows.push({ info: { id: `msg_tool_${callID}`, role: "assistant", sessionID, time: { created: clock.now } }, parts: [part] });
      const out = { args: structuredClone(args) };
      const result: ToolResult = { index: rec.tools.length + 1, callID, tool, refused: false, refusal: "", output: "", hung: !!opts.hang };
      rec.tools.push(result);
      clock.activity++;
      for (const p of loaded) {
        const before = p.hooks["tool.execute.before"];
        if (!before) continue;
        try { await before({ tool, sessionID, callID }, out); }
        catch (e: any) { result.refused = true; result.refusal = String(e?.message || e); part.state.status = "error"; return result; }
      }
      if (opts.hang) { rec.hangs.set(callID, clock.now - rec.start); return result; }
      // The tool's effect. Writes land only inside the sandbox; anything else is a scenario error.
      const effect = opts.effect || (["edit", "write"].includes(tool) && typeof out.args?.filePath === "string" ? { write: out.args.filePath, content: String(out.args.content ?? out.args.newString ?? "") } : null);
      if (effect?.write) {
        if (!inside(effect.write)) throw new Error("scenario tried to write outside the sandbox");
        mkdirSync(path.dirname(effect.write), { recursive: true });
        writeFileSync(effect.write, String(effect.content ?? ""));
        rec.writesApplied++;
      }
      const after = { title: tool, output, metadata: {} as any };
      for (const p of loaded) {
        const hook = p.hooks["tool.execute.after"];
        if (!hook) continue;
        try { await hook({ tool, sessionID, callID, args: out.args }, after); } catch {}
      }
      part.state.status = "completed";
      result.output = after.output;
      return result;
    }
    const startTask = (sessionID: string, callID: string) => {
      const order = rec.tasks.size;
      const t = { session: sessionID, startedAt: clock.now - rec.start, admittedAt: null as number | null, releasedAt: null as number | null, failed: false, order };
      rec.tasks.set(callID, t);
      session(sessionID).rows.push({ info: { id: `msg_task_${callID}`, role: "assistant", sessionID, time: { created: clock.now } }, parts: [{ type: "tool", callID, tool: "task", state: { status: "running" } }] });
      void (async () => {
        for (const p of loaded) {
          const before = p.hooks["tool.execute.before"];
          if (before) await before({ tool: "task", sessionID, callID }, { args: { description: "eval subagent", prompt: "review", subagent_type: "general" } });
        }
      })().then(() => { t.admittedAt = clock.now - rec.start; rec.admissions.push(callID); clock.activity++; }, () => { t.failed = true; clock.activity++; });
    };
    const endTask = async (sessionID: string, callID: string) => {
      const t = rec.tasks.get(callID);
      if (t) t.releasedAt = clock.now - rec.start;
      for (const p of loaded) {
        const hook = p.hooks["tool.execute.after"];
        if (hook) { try { await hook({ tool: "task", sessionID, callID, args: {} }, { title: "task", output: "done", metadata: {} }); } catch {} }
      }
      for (const row of session(sessionID).rows) for (const part of row.parts) if (part.callID === callID) part.state.status = "completed";
    };

    // ---- the timeline
    const steps: any[] = fill(sc.timeline || [], vars);
    for (const step of steps) {
      await clock.advanceTo(rec.start + Number(step.at || 0));
      const sid = step.session;
      switch (step.do) {
        case "idle": await dispatch({ type: "session.idle", properties: { sessionID: sid } }); break;
        case "status": await dispatch({ type: "session.status", properties: { sessionID: sid, status: { type: step.status } } }); break;
        case "userMessage": {
          const mid = addMessage(sid, "user", step.text);
          for (const p of loaded) if (p.hooks["chat.message"]) await p.hooks["chat.message"]({ sessionID: sid, messageID: mid }, { message: { id: mid }, parts: [{ type: "text", text: step.text }] });
          await dispatch({ type: "message.updated", properties: { info: { id: mid, role: "user", sessionID: sid } } });
          break;
        }
        case "setTodos": session(sid).todos = step.todos; break;
        case "chatParams":
          for (const p of loaded) if (p.hooks["chat.params"]) await p.hooks["chat.params"]({ sessionID: sid, model: { providerID: step.providerID, id: step.modelID || "m" } }, {});
          break;
        case "tool": await runTool(sid, step.tool, step.args || {}, step.output ?? "", { hang: !!step.hang, callID: step.callID, effect: step.effect }); break;
        case "toolRepeat":
          for (let i = 1; i <= Number(step.times); i++) {
            const args = step.varyArgs ? fill(step.args, { I: String(i) }) : step.args;
            const output = String(step.output ?? "");
            await runTool(sid, step.tool, args || {}, step.varyOutput ? output.replace("{I}", String(i)) : output);
          }
          break;
        case "taskStart": for (const id of step.callIDs) startTask(sid, id); break;
        case "taskEnd": for (const id of step.callIDs) await endTask(sid, id); break;
        case "systemTransform":
          for (let i = 0; i < Number(step.times || 1); i++) {
            const base = ["You are a coding agent.", "Environment: eval"];
            const out = { system: [...base] };
            for (const p of loaded) if (p.hooks["experimental.chat.system.transform"]) await p.hooks["experimental.chat.system.transform"]({ sessionID: sid, model: {} }, out);
            rec.transforms.push({ session: sid, system: out.system, base: base.length });
          }
          break;
        case "reloadPlugins": await load(); break;
        case "gateway": gatewayMode = step.mode; break;
        case "engine": engineRunning = Number(step.running); break;
        case "end": break;
        default: throw new Error(`unknown timeline action ${step.do}`);
      }
      await clock.settle();
    }
    // A scenario must leave no session timer behind (the loop's backoff timer is otherwise unref'd but live).
    for (const id of sessions.keys()) await dispatch({ type: "session.deleted", properties: { info: { id } } });
    for (const [file, before] of rec.watched) rec.watched.set(file, (existsSync(file) ? sha256(readFileSync(file)) : "") === before ? "unchanged" : "changed");
    rec.receiptsDir = `${vars.STATE}/opencode`;
    (rec as any).receipts = readReceipts(rec.receiptsDir, `${vars.HOME}/.local/state/opencode`);
    return rec;
  } finally {
    clock.uninstall();
    for (const s of servers) s.stop(true);
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

/** Every plugin's JSONL receipts, keyed by file name without extension. */
function readReceipts(dir: string, homeStateDir: string): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const name of ["loop-continuation", "subagent-cap", "stall-watchdog", "qwen-guardrails", "framework-protection", "project-memory"]) {
    // framework-readonly writes under the home directory, not XDG_STATE_HOME (both are inside the sandbox)
    const file = path.join(name === "framework-protection" ? homeStateDir : dir, `${name}.jsonl`);
    out[name] = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------
// Metrics. A scenario names the metrics it reports and the rules it is scored on; these are their definitions.
const loopReceipts = (r: any) => (r.receipts?.["loop-continuation"] || []) as any[];
const ids = (list: { callID: string }[]) => list.map((t) => t.callID);
export const METRICS: Record<string, (r: any, p: any) => any> = {
  /** continuations the loop sent */
  prompts: (r) => r.prompts.length,
  /** continuation times in simulated seconds */
  promptTimesS: (r) => r.prompts.map((p: any) => Math.round(p.at / 1000)),
  /** continuations sent after `p.afterS` simulated seconds */
  promptsAfter: (r, p) => r.prompts.filter((x: any) => x.at > Number(p.afterS) * 1000).length,
  /** largest gap between two continuations, minutes */
  maxGapMin: (r) => { let m = 0; for (let i = 1; i < r.prompts.length; i++) m = Math.max(m, r.prompts[i].at - r.prompts[i - 1].at); return Math.round(m / 600) / 100; },
  /** the loop disarmed itself (any reason) */
  disarmed: (r) => loopReceipts(r).some((x) => String(x.reason || "").startsWith("disarmed:")),
  disarmReason: (r) => String(loopReceipts(r).find((x) => String(x.reason || "").startsWith("disarmed:"))?.reason || "").replace(/ \(.*$/, ""),
  armed: (r) => loopReceipts(r).some((x) => x.reason === "armed"),
  /** backoff decisions, and the longest wait chosen */
  backoffs: (r) => loopReceipts(r).filter((x) => x.reason === "backoff").length,
  maxBackoffMin: (r) => Math.max(0, ...loopReceipts(r).filter((x) => x.reason === "backoff").map((x) => Number(x.waitMs) / 60000)),
  maxStalled: (r) => Math.max(0, ...loopReceipts(r).map((x) => Number(x.stalled || 0))),
  /** tool calls refused before they ran, and their 1-based positions */
  refused: (r) => r.tools.filter((t: ToolResult) => t.refused).length,
  refusedAt: (r) => r.tools.filter((t: ToolResult) => t.refused).map((t: ToolResult) => t.index),
  firstRefusedAt: (r) => r.tools.find((t: ToolResult) => t.refused)?.index ?? null,
  allowed: (r) => r.tools.filter((t: ToolResult) => !t.refused).length,
  /** every refusal says the command was not executed (so the model cannot mistake it for output) */
  refusalsSayNotExecuted: (r) => r.tools.filter((t: ToolResult) => t.refused).every((t: ToolResult) => /not executed|was not run|Refused before running/i.test(t.refusal)),
  /** 1-based positions of tool results that carry `p.text` */
  outputsContaining: (r, p) => r.tools.filter((t: ToolResult) => !t.refused && t.output.includes(String(p.text))).map((t: ToolResult) => t.index),
  /** system-prompt blocks added by the plugins, max over all transforms */
  systemBlocksAdded: (r) => Math.max(0, ...r.transforms.map((t: any) => t.system.length - t.base)),
  /** the system prompt carried `p.text` in any transform */
  systemContains: (r, p) => r.transforms.some((t: any) => t.system.join("\n").includes(String(p.text))),
  transforms: (r) => r.transforms.length,
  /** distinct system prompts across all transforms (1 = byte-identical every request) */
  distinctSystemPrompts: (r) => new Set(r.transforms.map((t: any) => sha256(t.system.join("\u0000")))).size,
  systemPromptSha12: (r) => r.transforms.length ? sha256(r.transforms[0].system.join("\u0000")).slice(0, 12) : "",
  gatewayCalls: (r, p) => r.gatewayCalls.filter((c: any) => !p.route || c.route === p.route).length,
  /** sessions aborted, and simulated seconds from the hung call's start to its session's abort */
  aborts: (r) => r.aborts.length,
  abortedSessions: (r) => r.aborts.map((a: any) => a.session),
  secondsToAbort: (r, p) => {
    const startedAt = r.hangs.get(String(p.callID));
    const a = r.aborts.find((x: any) => x.session === String(p.session));
    return startedAt === undefined || !a ? null : Math.round((a.at - startedAt) / 1000);
  },
  /** subagent (task) calls: admitted immediately, queued, failed, admission order of the queued ones */
  tasksAdmittedAtStart: (r) => [...r.tasks.values()].filter((t: any) => t.admittedAt !== null && t.admittedAt === t.startedAt).length,
  tasksQueued: (r) => [...r.tasks.values()].filter((t: any) => t.admittedAt === null || t.admittedAt > t.startedAt).length,
  tasksFailed: (r) => [...r.tasks.values()].filter((t: any) => t.failed).length,
  tasksNeverAdmitted: (r) => [...r.tasks.values()].filter((t: any) => t.admittedAt === null && !t.failed).length,
  queuedAdmissionOrder: (r) => r.admissions.filter((id: string) => { const t = r.tasks.get(id); return t.admittedAt > t.startedAt; }),
  /** most subagents running at the same instant (admitted and not yet returned) */
  maxConcurrentTasks: (r) => {
    const edges: [number, number][] = [];
    for (const t of r.tasks.values()) if (t.admittedAt !== null) { edges.push([t.admittedAt, 1]); edges.push([t.releasedAt ?? Infinity, -1]); }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, max = 0;
    for (const [, d] of edges) { cur += d; max = Math.max(max, cur); }
    return max;
  },
  taskWaitS: (r) => Object.fromEntries([...r.tasks.entries()].map(([id, t]: any) => [id, t.admittedAt === null ? null : Math.round((t.admittedAt - t.startedAt) / 1000)])),
  /** watched (protected) files whose bytes changed */
  watchedChanged: (r) => [...r.watched.values()].filter((v) => v === "changed").length,
  writesApplied: (r) => r.writesApplied,
  receiptCount: (r, p) => (r.receipts?.[p.file] || []).filter((x: any) => !p.where || Object.entries(p.where).every(([k, v]) => x[k] === v)).length,
};

const deepEqual = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
export const OPS: Record<string, (a: any, b: any) => boolean> = {
  "==": deepEqual, "!=": (a, b) => !deepEqual(a, b),
  "<=": (a, b) => a !== null && a <= b, ">=": (a, b) => a !== null && a >= b, "<": (a, b) => a !== null && a < b, ">": (a, b) => a !== null && a > b,
};

export function metric(r: any, spec: any) {
  const name = typeof spec === "string" ? spec : spec.metric;
  const fn = METRICS[name];
  if (!fn) throw new Error(`unknown metric ${name}`);
  return fn(r, typeof spec === "string" ? {} : spec);
}
export const metricLabel = (spec: any) => typeof spec === "string" ? spec : spec.label || spec.metric;
