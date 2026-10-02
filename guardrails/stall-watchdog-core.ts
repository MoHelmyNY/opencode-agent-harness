/**
 * stall-watchdog core (owner 2026-09-17: a subagent that gets stuck overnight must be resolved without anyone awake).
 *
 * Two stalls were seen on one lane that only a keypress in the TUI could clear: a reviewer subagent whose `grep` on one
 * Temp file sat in "running" for six minutes with the engine at zero requests (a permission prompt no subagent can
 * answer), and the general case of a tool call that never returns. This module gives the plugin two answers:
 *
 *  1. `permission.ask`: read-only tool permissions (read / grep / glob / list, or an external-directory ask for a path
 *     under the lane's Temp, worktree or lab-state directories) are ALLOWED without a prompt. Writes, bash, edits, and
 *     anything naming a secrets directory keep the default (ask).
 *  2. Tool-call stall abort: every `tool.execute.before` is recorded per callID and cleared on `tool.execute.after`
 *     or session idle. A call still running after STALL_MS (default 5 min; bash 25 min because verification runs are
 *     long; `task` never, a parent legitimately waits on its child) while the engine reports no running request is
 *     aborted through `client.session.abort`, with a receipt and a toast. A busy engine defers the abort until twice
 *     the threshold.
 *
 * Nothing here retries a prompt, changes a ledger, or touches a lane's files: the loop plugin re-continues an aborted
 * Manager from disk, and an aborted subagent returns to its Manager as an incomplete task result.
 *
 * Bash timeout that holds (owner 2026-09-26: bash calls hung on processes they launched). On Windows a `Start-Process` with `-RedirectStandard*` or `-NoNewWindow` and no `-Wait` hands the shell's
 * stdout pipe to the child; the shell exits at once but OpenCode waits for EOF until the child exits, and its own bash
 * timeout never ends the call (a web project, 2026-09-26: `Start-Process cmd /c npm run dev -RedirectStandardOutput`
 * ran 372 s, past the 120 s default, until the owner aborted it; scratchpad repro: pwsh exit 263 ms, EOF 24.5 s = the
 * child's lifetime; with the redirect inside the cmd string and no -Redirect/-NoNewWindow flag, EOF at 281 ms). So:
 *  3. such a launch is refused before it runs, with the working form in the error the model sees;
 *  4. every bash call is aborted once it outlives its OWN timeout (args.timeout, else OpenCode's 120 s default) plus
 *     BASH_GRACE_MS, capped at the bash stall limit, without the busy-engine deferral (a shell command does not wait
 *     on the engine). A bash call that OpenCode's timeout could kill never gets that far (15 s case, 15.3 s).
 *  5. A call's clock includes a permission prompt waiting on the owner (14-day store scan: 4 of 17,962 timeout-less bash
 *     calls ran past 180 s, one of them 212 s ending "The user rejected permission"), so every running call of a session
 *     with an open permission ask is paused, and its clock restarts when the ask is answered.
 */
export type RunningCall = { callID: string; sessionID: string; tool: string; at: number; limit?: number; paused?: boolean };
export type Permission = { id?: string; type?: string; pattern?: string | string[]; sessionID?: string; title?: string; metadata?: Record<string, unknown> };

export const DEFAULT_STALL_MS = 5 * 60_000;
export const DEFAULT_BASH_STALL_MS = 25 * 60_000;
export const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "list", "workflow-evidence", "workflow-inspect"]);
const SECRET_PATH = /(^|[\\/])(\.secrets|secrets)([\\/]|$)|\.env(\.|$)|keys\.json|id_rsa|\.pem$/i;
const READ_ONLY_TYPES = new Set(["read", "grep", "glob", "list"]);

function patterns(input: Permission): string[] {
  const p = input.pattern;
  const list = Array.isArray(p) ? p : p ? [p] : [];
  return list.map(String).concat(input.title ? [String(input.title)] : []);
}

/** True when the ask is a read-only tool (by permission type, or by the tool the metadata names) on a non-secret path
 *  inside one of the given read roots (any path when the type itself is a read-only tool type). */
export function readOnlyPermission(input: Permission, readRoots: string[]): boolean {
  const type = String(input.type || "").toLowerCase();
  const tool = String((input.metadata as any)?.tool || (input.metadata as any)?.toolName || "").toLowerCase();
  const names = patterns(input);
  if (names.some((n) => SECRET_PATH.test(n))) return false;
  if (READ_ONLY_TYPES.has(type)) return true;
  if (type === "external_directory") {
    if (tool && !READ_ONLY_TOOLS.has(tool)) return false;
    const roots = readRoots.map((r) => r.replace(/\\/g, "/").toLowerCase().replace(/\/$/, ""));
    const under = (n: string) => { const c = n.replace(/\\/g, "/").toLowerCase(); return roots.some((r) => c === r || c.startsWith(r + "/")); };
    return names.length > 0 && names.every(under);
  }
  return false;
}

export const OPENCODE_BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_BASH_GRACE_MS = 60_000;

/** The bash call's abort threshold: its own timeout (else OpenCode's default) plus the grace, never above the cap. */
export function bashLimitMs(args: any, graceMs = DEFAULT_BASH_GRACE_MS, capMs = DEFAULT_BASH_STALL_MS): number {
  const own = Number(args?.timeout);
  const timeout = Number.isFinite(own) && own > 0 ? own : OPENCODE_BASH_DEFAULT_TIMEOUT_MS;
  return Math.min(timeout + graceMs, capMs);
}

/** The refusal text when a bash command would launch a background process that keeps the tool's stdout pipe open
 *  (Start-Process with -RedirectStandard* or -NoNewWindow and no -Wait); null when the command is fine. */
export function heldPipeLaunch(command: unknown): string | null {
  const c = String(command || "");
  if (!/\bStart-Process\b/i.test(c) || /\s-Wait\b/i.test(c)) return null;
  const flag = c.match(/\s(-RedirectStandard(?:Output|Error|Input)|-NoNewWindow)\b/i)?.[1];
  if (!flag) return null;
  return `Refused before running (stall-watchdog): Start-Process with ${flag} and no -Wait gives the background process this `
    + `shell's output pipe, so the tool call never returns while that process lives (OpenCode's timeout cannot end it). `
    + `To start a server or other long-running process, drop -RedirectStandard*/-NoNewWindow and redirect inside the command, e.g. `
    + `Start-Process -FilePath cmd.exe -ArgumentList '/c','npm run dev > "%TEMP%\\opencode\\dev.log" 2>&1' -WindowStyle Hidden; `
    + `then poll the log or the port in a separate call. For a command that should finish, add -Wait or just run it directly with a timeout.`;
}

/** The running calls older than their threshold. */
export function stalledCalls(running: Map<string, RunningCall>, now: number, stallMs = DEFAULT_STALL_MS, bashStallMs = DEFAULT_BASH_STALL_MS): RunningCall[] {
  const out: RunningCall[] = [];
  for (const rec of running.values()) {
    if (rec.tool === "task" || rec.paused) continue;
    const limit = rec.tool === "bash" ? (rec.limit ?? bashStallMs) : stallMs;
    if (now - rec.at >= limit) out.push(rec);
  }
  return out;
}

/** null when the metrics endpoint cannot be read; otherwise whether the engine has no running request. */
export async function engineIdle(fetchImpl: typeof fetch, url: string): Promise<boolean | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetchImpl(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const text = await response.text();
    const m = text.match(/^vllm:num_requests_running\{[^}]*\}\s+([0-9.]+)/m);
    return m ? Number(m[1]) === 0 : null;
  } catch { return null; }
}

export type WatchdogOptions = {
  client: any; directory: string; readRoots: string[]; stallMs?: number; bashStallMs?: number; bashGraceMs?: number; metricsUrl?: string;
  fetchImpl?: typeof fetch; now?: () => number; receipt?: (row: Record<string, unknown>) => Promise<void>; toast?: (text: string) => Promise<void>;
};

export function createWatchdog(options: WatchdogOptions) {
  const running = new Map<string, RunningCall>();
  const now = options.now || (() => Date.now());
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const bashStallMs = options.bashStallMs ?? DEFAULT_BASH_STALL_MS;
  const bashGraceMs = options.bashGraceMs ?? DEFAULT_BASH_GRACE_MS;
  const receipt = options.receipt || (async () => {});
  const toast = options.toast || (async () => {});
  const fetchImpl = options.fetchImpl || fetch;
  const metricsUrl = options.metricsUrl || "http://127.0.0.1:8000/metrics";

  /** "running" | "done" | "unknown": what the session store says about the call. A call the framework guard refused
   *  in `tool.execute.before` never reaches `tool.execute.after` (2026-09-17: a refused `ticket verify`
   *  sat in this map for 26 minutes and the abort hit the owner's live session, killing a contract-judge dispatch), so
   *  the store, not this map, decides whether a call is still running. */
  async function storeStatus(rec: RunningCall): Promise<"running" | "done" | "unknown"> {
    try {
      const res = await options.client.session.messages({ path: { id: rec.sessionID }, query: { directory: options.directory } });
      const rows: any[] = (res?.data ?? res) || [];
      for (const row of rows) {
        for (const part of (row?.parts || [])) {
          if (part?.callID === rec.callID || part?.id === rec.callID) return part?.state?.status === "running" ? "running" : "done";
        }
      }
      return "done"; // no part carries the call: it never persisted as running
    } catch { return "unknown"; }
  }

  async function tick(): Promise<RunningCall[]> {
    const at = now();
    const stale = stalledCalls(running, at, stallMs, bashStallMs);
    if (!stale.length) return [];
    const idle = stale.some((r) => r.tool !== "bash") ? await engineIdle(fetchImpl, metricsUrl) : null;
    const aborted: RunningCall[] = [];
    for (const rec of stale) {
      const limit = rec.tool === "bash" ? (rec.limit ?? bashStallMs) : stallMs;
      // the engine is decoding for someone: wait for twice the threshold (not for bash, whose own timeout already passed)
      if (rec.tool !== "bash" && idle === false && at - rec.at < 2 * limit) continue;
      const status = await storeStatus(rec);
      if (status !== "running") {
        running.delete(rec.callID);
        await receipt({ at: new Date(at).toISOString(), kind: "stall_cleared", sessionID: rec.sessionID, tool: rec.tool, callID: rec.callID, running_ms: at - rec.at, store: status });
        continue; // a phantom (refused or already finished) or an unreadable store: never abort on this map alone
      }
      running.delete(rec.callID);
      let ok = true; let error: string | undefined;
      try { await options.client.session.abort({ path: { id: rec.sessionID }, query: { directory: options.directory } }); }
      catch (e: any) { ok = false; error = String(e?.message || e).slice(0, 200); }
      await receipt({ at: new Date(at).toISOString(), kind: "stall_abort", sessionID: rec.sessionID, tool: rec.tool, callID: rec.callID, running_ms: at - rec.at, limit_ms: limit, engine_idle: idle, ok, error });
      await toast(`stall-watchdog: aborted ${rec.tool} in ${rec.sessionID.slice(0, 12)} after ${Math.round((at - rec.at) / 60000)} min`);
      aborted.push(rec);
    }
    return aborted;
  }

  /** An open permission ask pauses every running call of its session; the answer restarts their clocks. */
  function pauseSession(sessionID: unknown, paused: boolean) {
    if (!sessionID) return;
    for (const rec of running.values()) {
      if (rec.sessionID !== sessionID) continue;
      rec.paused = paused;
      if (!paused) rec.at = now();
    }
  }

  const hooks = {
    "permission.ask": async (input: Permission, output: { status: "ask" | "deny" | "allow" }) => {
      if (output.status !== "ask") return;
      if (readOnlyPermission(input, options.readRoots)) {
        output.status = "allow";
        await receipt({ at: new Date(now()).toISOString(), kind: "permission_allowed", sessionID: input.sessionID, type: input.type, pattern: patterns(input).slice(0, 3) });
        return;
      }
      pauseSession(input.sessionID, true); // the owner is being asked: not a stall
    },
    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }, output?: { args?: any }) => {
      if (!input?.callID) return;
      const tool = String(input.tool || "");
      if (tool === "bash") {
        const refusal = heldPipeLaunch(output?.args?.command);
        if (refusal) {
          await receipt({ at: new Date(now()).toISOString(), kind: "bash_launch_refused", sessionID: input.sessionID, callID: input.callID, command: String(output?.args?.command).slice(0, 200) });
          throw new Error(refusal); // a refused call never runs, so it is not tracked
        }
      }
      const limit = tool === "bash" ? bashLimitMs(output?.args, bashGraceMs, bashStallMs) : undefined;
      running.set(input.callID, { callID: input.callID, sessionID: input.sessionID, tool, at: now(), limit });
    },
    "tool.execute.after": async (input: { tool: string; sessionID: string; callID: string }) => {
      if (input?.callID) running.delete(input.callID);
    },
    event: async ({ event }: any) => {
      const p = event?.properties || {};
      const type = String(event?.type || "");
      if (type === "permission.asked" || type === "permission.updated" || type === "permission.v2.asked") { pauseSession(p.sessionID, true); return; }
      if (type === "permission.replied" || type === "permission.v2.replied") { pauseSession(p.sessionID, false); return; }
      const idle = event?.type === "session.idle" || (event?.type === "session.status" && p.status?.type === "idle");
      if (!idle) return;
      for (const [id, rec] of running) if (rec.sessionID === p.sessionID) running.delete(id);
    },
  };
  return { hooks, tick, running };
}
