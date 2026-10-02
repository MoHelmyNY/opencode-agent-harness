// bun test tests/loop-continuation.test.ts
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Several tests spawn real `git` processes (temp repos, or `git rev-parse` during config resolution). Where process
// start is slow (one measured Windows box: `git init` 2.9 s, `git add` 4.8 s) a test outlives bun's 5 s default, so the
// per-test budget is raised. Logic is unaffected; only the wall-clock allowance changes.
setDefaultTimeout(60_000);
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "loop-continuation-test-"));
process.env.LOOP_CONTINUATION_DEBOUNCE_MS = "0";
process.env.LOOP_CONTINUATION_MAX = "3";
process.env.LOOP_CONTINUATION_STALL = "2";
// The note-kick timer is off for every test except the one that turns it on for its own plugin instance.
process.env.LOOP_CONTINUATION_NOTE_KICK_MS = "0";
// Chain configs for the promptFor integration case live in a temp config home, read by the plugin per plugin() call.
process.env.AGENT_WORKFLOW_CONFIG_HOME = mkdtempSync(join(tmpdir(), "loop-continuation-chain-"));
import plugin, { notActionable, queueItems, promptFor, laneKindOf, shouldNoteKick } from "../plugins/loop-continuation.ts";

const stateDir = join(process.env.XDG_STATE_HOME!, "opencode");
const user = (text: string) => ({ info: { role: "user" }, parts: [{ type: "text", text }] });
const todo = (content: string, status = "pending") => ({ content, status, priority: "medium" });

function harness(messages: any[], todos: any[]) {
  const prompts: any[] = [];
  const replies: any[] = [];
  const summaries: any[] = [];
  const client = {
    session: {
      get: async ({ path }: any) => ({ data: { id: path.id, parentID: path.id.startsWith("child") ? "ses_parent" : null } }),
      messages: async () => ({ data: messages }),
      todo: async () => ({ data: todos }),
      promptAsync: async (args: any) => { prompts.push(args); return { data: {} }; },
      summarize: async (args: any) => { summaries.push(args); return { data: true }; },
    },
    postSessionIdPermissionsPermissionId: async (args: any) => { replies.push(args); return { data: true }; },
    tui: { showToast: async () => {} },
    app: { log: async () => {} },
  };
  return { client, prompts, replies, summaries, messages, todos };
}
const ask = (hooks: any, sessionID: string, id: string, title: string, type = "bash") =>
  hooks.event({ event: { type: "permission.asked", properties: { permission: { id, sessionID, type, title, pattern: title, messageID: "m", metadata: {}, time: { created: 1 } } } } });
const idle = (hooks: any, id = "ses_loop") => hooks.event({ event: { type: "session.idle", properties: { sessionID: id } } });
const receipts = () => existsSync(join(stateDir, "loop-continuation.jsonl")) ? readFileSync(join(stateDir, "loop-continuation.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

describe("loop-continuation note-kick (owner 2026-09-29: new QUEUE jobs start the finished lane without a paste)", () => {
  test("decision: kicks only a remembered queue-complete session, with QUEUE items, not armed, no stop file", () => {
    const k = { sessionID: "ses_k" };
    expect(shouldNoteKick(k, ["[J1] x"], false, false)).toBe(true);
    expect(shouldNoteKick(null, ["[J1] x"], false, false)).toBe(false);
    expect(shouldNoteKick(k, [], false, false)).toBe(false);
    expect(shouldNoteKick(k, ["[J1] x"], true, false)).toBe(false);
    expect(shouldNoteKick(k, ["[J1] x"], false, true)).toBe(false);
  });

  test("a lane disarmed on queue-complete is re-armed and continued when the note gains a QUEUE", async () => {
    const note = join(stateDir, "loop-head", "e-kick.txt");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(stateDir, "loop-head"), { recursive: true });
    writeFileSync(note, "LANE KIND: authoring\nAll jobs done.");
    const h = harness([user("# Loop Start Command\ngo")], [todo("FINAL: jobs done", "completed")]);
    process.env.LOOP_CONTINUATION_NOTE_KICK_MS = "20";
    let hooks: any;
    try { hooks = await plugin({ client: h.client, directory: "E:/kick" }); } finally { process.env.LOOP_CONTINUATION_NOTE_KICK_MS = "0"; }
    await idle(hooks, "ses_kick");
    expect(h.prompts).toHaveLength(0);
    expect(receipts().some((r: any) => r.sessionID === "ses_kick" && String(r.reason).startsWith("disarmed:queue complete"))).toBe(true);
    const kickFile = join(stateDir, "loop-continuation.kick.json");
    expect(JSON.parse(readFileSync(kickFile, "utf8")).sessionID).toBe("ses_kick");
    await new Promise((r) => setTimeout(r, 80));
    expect(h.prompts).toHaveLength(0); // no QUEUE yet: nothing happens
    writeFileSync(note, "LANE KIND: authoring\nQUEUE: [J5] judge the themes; [J6] repair lines\nNew jobs.");
    await new Promise((r) => setTimeout(r, 120));
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].path.id).toBe("ses_kick");
    expect(h.prompts[0].body.parts[0].text).toContain("OPERATOR NOTE");
    expect(h.prompts[0].body.parts[0].text).toContain("QUEUE");
    expect(receipts().some((r: any) => r.sessionID === "ses_kick" && r.reason === "armed:note-queue")).toBe(true);
    expect(existsSync(kickFile)).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.prompts).toHaveLength(1); // kicked once, not on every tick
  });
});

describe("loop-continuation", () => {
  test("re-prompts an idle session that ran /loop-start and still has actionable todos", async () => {
    const h = harness([user("# Loop Start Command\nStart a managed autonomous loop")], [todo("#1 done", "completed"), todo("QUEUE: #2 fix", "pending"), todo("BLOCKED: #3", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].path.id).toBe("ses_loop");
    expect(h.prompts[0].body.parts[0].text).toContain("Continue the loop");
    expect(JSON.parse(readFileSync(join(stateDir, "loop-continuation.active.d", "ses_loop.json"), "utf8")).sessionID).toBe("ses_loop");
    const last = receipts().at(-1);
    expect(last).toMatchObject({ sessionID: "ses_loop", iteration: 1, actionable: 1, reason: "continue" });
  });

  test("treats session.status idle exactly like session.idle (what OpenCode 1.18 emits)", async () => {
    const h = harness([user("/loop-start")], [todo("QUEUE: #2", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_status", status: { type: "busy" } } } });
    expect(h.prompts).toHaveLength(0);
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_status", status: { type: "idle" } } } });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].path.id).toBe("ses_status");
  });

  test("with a real debounce, a re-emitted update of the same user message does not cancel the continuation; a new user message does", async () => {
    process.env.LOOP_CONTINUATION_DEBOUNCE_MS = "60";
    try {
      const h = harness([user("/loop-start")], [todo("QUEUE: #2", "pending")]);
      const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
      const userUpdate = (id: string) => hooks.event({ event: { type: "message.updated", properties: { info: { id, role: "user", sessionID: "ses_db" } } } });
      await userUpdate("msg_u1");                 // the owner's prompt
      await new Promise((r) => setTimeout(r, 70)); // the turn runs longer than the debounce
      await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_db", status: { type: "idle" } } } });
      await userUpdate("msg_u1");                 // OpenCode touching the same message again after idle
      await new Promise((r) => setTimeout(r, 120));
      expect(h.prompts).toHaveLength(1);
      // Second idle, but this time a genuinely new user message arrives inside the debounce window.
      await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_db", status: { type: "idle" } } } });
      await userUpdate("msg_u2");
      await new Promise((r) => setTimeout(r, 120));
      expect(h.prompts).toHaveLength(1);
      const reasons = receipts().filter((r) => r.sessionID === "ses_db").map((r) => r.reason);
      expect(reasons).toContain("idle");
      expect(reasons).toContain("cancelled: new user message");
    } finally {
      process.env.LOOP_CONTINUATION_DEBOUNCE_MS = "0";
    }
  });

  test("stays silent for a session that never ran /loop-start, and for subagent sessions", async () => {
    const h = harness([user("fix the bug in a.py")], [todo("QUEUE: #2 fix", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks, "ses_plain");
    await idle(hooks, "child_ses");
    expect(h.prompts).toHaveLength(0);
  });

  test("stops when only blocked, owner-ruling or completed todos remain", async () => {
    const h = harness([user("/loop-start sequential")], [todo("#1", "completed"), todo("BLOCKED: #3"), todo("OWNER RULINGS (7): ..."), todo("FINAL: push + report")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks, "ses_done");
    expect(h.prompts).toHaveLength(0);
    expect(receipts().at(-1).reason).toMatch(/queue complete/);
    expect(existsSync(join(stateDir, "loop-continuation.active.d", "ses_done.json"))).toBe(false);
  });

  test("disarms after two continuations that changed nothing, and progress resets the count", async () => {
    const h = harness([user("/loop-start")], [todo("QUEUE: #2", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks, "ses_stall");            // 1: first continuation always allowed
    await idle(hooks, "ses_stall");            // 2: no change -> stalled 1
    expect(h.prompts).toHaveLength(2);
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_stall", args: { command: "git commit -F msg.txt" } }, { output: "[qwen/x abc1234] fix", metadata: {} });
    await idle(hooks, "ses_stall");            // 3: a commit counts as progress -> continue (stalled reset)
    expect(h.prompts).toHaveLength(3);
    await idle(hooks, "ses_stall");            // max 3 reached -> disarm
    expect(h.prompts).toHaveLength(3);
    expect(receipts().at(-1).reason).toMatch(/max continuations/);
  });

  test("a stalled loop BACKS OFF instead of being cut off (owner 2026-09-15: it must not disarm)", async () => {
    // LOOP_CONTINUATION_STALL=2 (module top) no longer disarms: it names the stall count at which the long tier starts.
    const h = harness([user("/loop-start")], [todo("QUEUE: #9", "in_progress")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks, "ses_spin"); // iteration 1
    await idle(hooks, "ses_spin"); // iteration 2, stalled 1 -> still the plain debounce
    await idle(hooks, "ses_spin"); // stalled 2 -> waits, no prompt, NO disarm
    expect(h.prompts).toHaveLength(2);
    expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_spin", reason: "backoff", stalled: 2, waitMs: 1800000, next: "QUEUE: #9" });
    expect(receipts().filter((r) => r.sessionID === "ses_spin" && String(r.reason).startsWith("disarmed"))).toHaveLength(0);
    expect(existsSync(join(stateDir, "loop-continuation.active.d", "ses_spin.json"))).toBe(true);
  });

  test("the owner's own `continue the loop` message re-arms a session the owner stopped", async () => {
    const h = harness([user("/loop-start")], [todo("QUEUE: #1691", "in_progress")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks, "ses_rearm"); // iteration 1
    await idle(hooks, "ses_rearm"); // iteration 2, stalled 1
    expect(h.prompts).toHaveLength(2);
    h.messages.push(user("stop the loop"));
    await idle(hooks, "ses_rearm"); // the owner's stop is the only thing that disarms a stalled loop now
    expect(h.prompts).toHaveLength(2);
    expect(receipts().at(-1).reason).toMatch(/owner said stop/);
    h.messages.push(user("continue the loop"));
    await idle(hooks, "ses_rearm"); // the owner's message is scanned, arms again, iteration count restarts
    expect(h.prompts).toHaveLength(3);
    const mine = receipts().filter((r) => r.sessionID === "ses_rearm").map((r) => r.reason);
    expect(mine.filter((r) => r === "armed")).toHaveLength(2);
    expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_rearm", iteration: 1, reason: "continue" });
  });

  test("with the shipped defaults it never stops on its own: 60 idle turns with no commit and no todo change never disarm, they throttle", async () => {
    const savedMax = process.env.LOOP_CONTINUATION_MAX, savedStall = process.env.LOOP_CONTINUATION_STALL;
    delete process.env.LOOP_CONTINUATION_MAX; delete process.env.LOOP_CONTINUATION_STALL;
    try {
      const h = harness([user("# Loop Start Command")], [todo("QUEUE: #1691 six-turn ticket", "in_progress")]);
      const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
      for (let i = 0; i < 60; i++) await idle(hooks, "ses_forever");
      // stalls 0 and 1 continue; from the second stall the 5-minute wait holds the session instead of re-prompting it
      // (lane C got 988 prompts at 39 s on 2026-09-15). The wait is decided ONCE, not once per idle.
      expect(h.prompts).toHaveLength(2);
      const mine = receipts().filter((r) => r.sessionID === "ses_forever");
      expect(mine.filter((r) => String(r.reason).startsWith("disarmed"))).toHaveLength(0);
      const waits = mine.filter((r) => r.reason === "backoff");
      expect(waits).toHaveLength(1);
      expect(waits[0]).toMatchObject({ stalled: 2, waitMs: 300000 });
      expect(JSON.parse(readFileSync(join(stateDir, "loop-continuation.active.d", "ses_forever.json"), "utf8")).sessionID).toBe("ses_forever");
      h.todos[0].status = "completed";
      await idle(hooks, "ses_forever");
      expect(h.prompts).toHaveLength(2);
      expect(receipts().at(-1).reason).toMatch(/queue complete/);
    } finally {
      process.env.LOOP_CONTINUATION_MAX = savedMax!; process.env.LOOP_CONTINUATION_STALL = savedStall!;
    }
  });

  test("never answers permission prompts (auto-approval is not enabled; the owner decides)", async () => {
    const h = harness([user("/loop-start")], [todo("QUEUE: #2", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks, "ses_perm");
    await ask(hooks, "ses_perm", "perm_1", "Copy-Item tests/a.py ../scratch/");
    expect(h.replies).toHaveLength(0);
  });

  test("the owner can stop it with a message, and the stop file stops every session", async () => {
    const h = harness([user("/loop-start")], [todo("QUEUE: #2", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks, "ses_owner");
    expect(h.prompts).toHaveLength(1);
    h.messages.push(user("stop the loop please"));
    await idle(hooks, "ses_owner");
    expect(h.prompts).toHaveLength(1);
    expect(receipts().at(-1).reason).toMatch(/owner said stop/);

    const h2 = harness([user("/loop-start")], [todo("QUEUE: #2", "pending")]);
    const hooks2: any = await plugin({ client: h2.client, directory: "E:/repo" });
    writeFileSync(join(stateDir, "loop-continuation.stop"), "");
    await idle(hooks2, "ses_stopfile");
    rmSync(join(stateDir, "loop-continuation.stop"));
    expect(h2.prompts).toHaveLength(0);
    expect(receipts().at(-1).reason).toMatch(/stop file/);
  });
});

describe("loop-continuation operator note scope", () => {
  test("the compaction fraction comes from loop-compact-at.txt when present (no restart to tune it), default 0.5", async () => {
    const assistant = (id: string, ctx: number) => ({ info: { id, role: "assistant", providerID: "vllm", modelID: "qwen-coder", tokens: { input: ctx - 1000, output: 500, cache: { read: 1000, write: 0 } } }, parts: [] });
    // default 0.5 of 262,144 = 131,072: a 140K turn compacts, a 120K turn does not
    const h = harness([user("/loop-start"), assistant("m_140", 140000)], [todo("QUEUE: #2", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks, "ses_half");
    expect(h.summaries).toHaveLength(1);
    expect(receipts().at(-1)).toMatchObject({ reason: "compact", tokens: 140000, threshold: 0.5 });
    const h2 = harness([user("/loop-start"), assistant("m_120", 120000)], [todo("QUEUE: #2", "pending")]);
    const hooks2: any = await plugin({ client: h2.client, directory: "E:/repo" });
    await idle(hooks2, "ses_under");
    expect(h2.summaries).toHaveLength(0);
    expect(h2.prompts).toHaveLength(1);
    // the state file wins and is read per continuation
    writeFileSync(join(stateDir, "loop-compact-at.txt"), "0.4");
    try {
      const h3 = harness([user("/loop-start"), assistant("m_110", 110000)], [todo("QUEUE: #2", "pending")]);
      const hooks3: any = await plugin({ client: h3.client, directory: "E:/repo" });
      await idle(hooks3, "ses_file");
      expect(h3.summaries).toHaveLength(1);
      expect(receipts().at(-1)).toMatchObject({ reason: "compact", tokens: 110000, threshold: 0.4 });
    } finally { rmSync(join(stateDir, "loop-compact-at.txt"), { force: true }); }
  });

  test("compacts through the SDK before continuing when the last assistant turn is past 70% of the window, then continues once the context is small", async () => {
    const assistant = (id: string, ctx: number) => ({ info: { id, role: "assistant", providerID: "vllm", modelID: "qwen-coder", tokens: { input: ctx - 1000, output: 500, cache: { read: 1000, write: 0 } } }, parts: [] });
    const h = harness([user("/loop-start"), assistant("m_big", 200000)], [todo("QUEUE: #2", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo" });
    await idle(hooks, "ses_big");
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0]).toMatchObject({ path: { id: "ses_big" }, body: { providerID: "vllm", modelID: "qwen-coder" } });
    expect(h.prompts).toHaveLength(0);
    expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_big", reason: "compact", tokens: 200000 });
    // the summary turn ends in another idle; the context is small now, so the continuation goes out
    h.messages.push(assistant("m_small", 40000));
    await idle(hooks, "ses_big");
    expect(h.summaries).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
    // if the summary did not shrink the context, the same assistant turn is not compacted twice
    h.messages.length = 0; h.messages.push(user("/loop-start"), assistant("m_stuck", 210000));
    const h2 = harness(h.messages, [todo("QUEUE: #3", "pending")]);
    const hooks2: any = await plugin({ client: h2.client, directory: "E:/repo" });
    await idle(hooks2, "ses_stuck");
    expect(h2.summaries).toHaveLength(1);
    await idle(hooks2, "ses_stuck");
    expect(h2.summaries).toHaveLength(1);
    expect(h2.prompts).toHaveLength(1);
  });

  test("prepends only the note filed for the session's own working directory", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(stateDir, "loop-head"), { recursive: true });
    writeFileSync(join(stateDir, "loop-head", "e-repo.txt"), "App judge rules for E:/repo");
    writeFileSync(join(stateDir, "loop-head", "e-other-lab.txt"), "Dragon rules for E:/other lab");
    writeFileSync(join(stateDir, "loop-head.txt"), "LEGACY GLOBAL NOTE must not be read");
    const a = harness([user("# Loop Start Command\nStart a managed autonomous loop")], [todo("QUEUE: #2 fix", "pending")]);
    const hooksA: any = await plugin({ client: a.client, directory: "E:/repo" });
    await idle(hooksA, "ses_loop");
    const b = harness([user("# Loop Start Command\nStart a managed autonomous loop")], [todo("B1-#85 queue base", "pending")]);
    const hooksB: any = await plugin({ client: b.client, directory: "E:\other lab" });
    await idle(hooksB, "ses_loop");
    expect(a.prompts[0].body.parts[0].text).toContain("OPERATOR NOTE: App judge rules for E:/repo");
    expect(a.prompts[0].body.parts[0].text).not.toContain("Dragon rules");
    expect(b.prompts[0].body.parts[0].text).toContain("OPERATOR NOTE: Dragon rules for E:/other lab");
    expect(b.prompts[0].body.parts[0].text).not.toContain("App judge rules");
    expect(b.prompts[0].body.parts[0].text).not.toContain("LEGACY GLOBAL NOTE");
    const c = harness([user("# Loop Start Command\nStart a managed autonomous loop")], [todo("x", "pending")]);
    const hooksC: any = await plugin({ client: c.client, directory: "E:/nowhere" });
    await idle(hooksC, "ses_loop");
    expect(c.prompts[0].body.parts[0].text.startsWith("OPERATOR NOTE")).toBe(false);
  });
  test("a note declaring LANE KIND gets the note-driven prompt, a note without one keeps the PR sweep", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(stateDir, "loop-head"), { recursive: true });
    writeFileSync(join(stateDir, "loop-head", "e-lanekind.txt"), "STANDING ORDERS\nLANE KIND: authoring\nWrite 100 subjects.");
    writeFileSync(join(stateDir, "loop-head", "e-lanepr.txt"), "STANDING ORDERS without a lane kind");
    const a = harness([user("# Loop Start Command\nStart a managed autonomous loop")], [todo("write batch 1", "pending")]);
    const hooksA: any = await plugin({ client: a.client, directory: "E:/lanekind" });
    await idle(hooksA, "ses_loop");
    const b = harness([user("# Loop Start Command\nStart a managed autonomous loop")], [todo("QUEUE: #9 fix", "pending")]);
    const hooksB: any = await plugin({ client: b.client, directory: "E:/lanepr" });
    await idle(hooksB, "ses_loop");
    const ta = a.prompts[0].body.parts[0].text, tb = b.prompts[0].body.parts[0].text;
    expect(ta).toContain("OPERATOR NOTE: STANDING ORDERS");
    expect(ta).toContain("This lane's job is defined by the OPERATOR NOTE");
    expect(ta).not.toContain("gh pr list");
    expect(tb).toContain("gh pr list");
    expect(tb).not.toContain("This lane's job is defined by the OPERATOR NOTE");
  });
  test("WF-05: each armed session owns its own record and one session stopping preserves the other", async () => {
    const h = harness([user("# Loop Start Command\nStart a managed autonomous loop")], [todo("QUEUE: #9 fix", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo-wf05" });
    await idle(hooks, "ses_a");
    await idle(hooks, "ses_b");
    const dir = join(stateDir, "loop-continuation.active.d");
    expect(existsSync(join(dir, "ses_a.json"))).toBe(true);
    expect(existsSync(join(dir, "ses_b.json"))).toBe(true);
    const recB = JSON.parse(readFileSync(join(dir, "ses_b.json"), "utf8"));
    expect(recB.sessionID).toBe("ses_b");
    expect(recB.directory).toBe("E:/repo-wf05");
    expect(typeof recB.pid).toBe("number");
    h.messages.push(user("stop the loop"));
    await idle(hooks, "ses_a");
    expect(existsSync(join(dir, "ses_a.json"))).toBe(false);
    expect(existsSync(join(dir, "ses_b.json"))).toBe(true);
    expect(existsSync(join(stateDir, "loop-continuation.active"))).toBe(false);
  });
  test("WF-04: a blocked record holds the packet until the owner types, then continuation resumes", async () => {
    const h = harness([user("# Loop Start Command" + String.fromCharCode(10) + "Start a managed autonomous loop")], [todo("QUEUE: #7 fix", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo-wf04" });
    const dir = join(stateDir, "loop-blocked.d");
    const { mkdirSync } = await import("node:fs"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ses_blk.json"), JSON.stringify({ sessionID: "ses_blk", reason: "repeat-guard-abort", at: new Date(Date.now() + 60000).toISOString() }));
    await idle(hooks, "ses_blk");
    expect(h.prompts).toHaveLength(0);
    expect(receipts().filter((r) => r.sessionID === "ses_blk" && String(r.reason).startsWith("blocked:")).length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "ses_blk.json"))).toBe(true);
    writeFileSync(join(dir, "ses_blk.json"), JSON.stringify({ sessionID: "ses_blk", reason: "repeat-guard-abort", at: new Date(Date.now() - 60000).toISOString() }));
    h.messages.push(user("continue the loop"));
    await hooks.event({ event: { type: "message.updated", properties: { info: { id: "u_blk_1", role: "user", sessionID: "ses_blk" } } } });
    await idle(hooks, "ses_blk");
    expect(h.prompts).toHaveLength(1);
    expect(existsSync(join(dir, "ses_blk.json"))).toBe(false);
  });
});

describe("QUEUE bundles in the operator note keep the loop alive (Lane B disarmed on an empty todo list, 2026-09-13)", () => {
  test("queueItems parses bundle markers from QUEUE lines only", () => {
    const note = "CONTEXT: x\nQUEUE (Lane B, after #1835): [B1] #1773 + #1774 (contacts.py); [B2] #1760 + #1754 (a.py); [B3] #1700 (z.py).\nOPEN PRS: [X9] not a queue line\nQUEUE AND OWNERSHIP: families only";
    expect(queueItems(note)).toEqual(["[B1] #1773 + #1774 (contacts.py)", "[B2] #1760 + #1754 (a.py)", "[B3] #1700 (z.py)"]);
    expect(queueItems("RULED: [B1] done\n")).toEqual([]);
    expect(queueItems("")).toEqual([]);
  });

  test("an empty todo list with bundles queued continues with the queue prompt instead of disarming", async () => {
    const dir = "E:/queue-repo";
    const headDir = join(stateDir, "loop-head");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(headDir, { recursive: true });
    writeFileSync(join(headDir, "e-queue-repo.txt"), "QUEUE (Lane B): [B1] #1773 + #1774 (contacts.py); [B2] #1760 (a.py)\n");
    const h = harness([user("/loop-start")], [todo("Item 2: restore SessionLocal", "completed")]);
    const hooks: any = await plugin({ client: h.client, directory: dir });
    await idle(hooks, "ses_queue");
    expect(h.prompts).toHaveLength(1);
    const text = h.prompts[0].body.parts[0].text;
    expect(text).toContain("OPERATOR NOTE:");
    expect(text).toContain("QUEUE still lists bundles");
    const last = receipts().at(-1);
    expect(last.reason).toBe("continue:queue");
    expect(last.queued).toBe(2);
    expect(last.next).toBe("[B1] #1773 + #1774 (contacts.py)");
    expect(existsSync(join(stateDir, "loop-continuation.active.d", "ses_queue.json"))).toBe(true);
    rmSync(join(headDir, "e-queue-repo.txt"));
    await idle(hooks, "ses_queue");
    expect(receipts().at(-1).reason).toMatch(/queue complete/);
  });
});

describe("chain lanes get CHAIN_PROMPT (design plan section 4: a PR is handoff_pr_open, never completion)", () => {
  test("promptFor(false, false) is today's loop prompt, untouched", () => {
    const text = promptFor(false, false);
    expect(text.startsWith("Continue the loop.")).toBe(true);
    expect(text).toContain("Mark it completed in the todo list with the commit SHA and PR number");
    expect(text).not.toContain("Continue the chain");
  });

  test("promptFor(true, false) is the chain prompt with the completion-state rule", () => {
    const text = promptFor(true, false);
    expect(text.startsWith("Continue the chain.")).toBe(true);
    expect(text).toContain("loop_complete: true");
    expect(text).toContain("BLOCKED: waiting on judge #<N>");  // WF-06: waiting tickets leave the actionable set
    expect(text).toContain("it RESUMES");
    expect(text).toContain("Push EXACTLY the reviewed head");   // WF-05
    expect(text).toContain("ticket adopt --ticket <N> --pr <PR>"); // universal rollout: open PRs are adopted, not restarted
    expect(text).toContain("aw ticket --config <config> <subcommand> --ticket <N>"); // WF-01 invocation form (AGENT_WORKFLOW_CLI, default aw)
    expect(text).toContain("task_complete: true is the owner's acceptance gate and is NOT required to finish the loop");
    expect(text).not.toContain("mark a todo completed ONLY when ticket status prints task_complete: true");
    expect(text).toContain("judge-sync --ticket <N> --pr <PR>");
    expect(text).not.toContain("Mark it completed in the todo list");
  });

  test("promptFor(true, true) and promptFor(false, true) start with the QUEUE text", () => {
    expect(promptFor(true, true).startsWith("Your todo list holds no actionable item")).toBe(true);
    expect(promptFor(true, true)).toContain("Continue the chain");
    expect(promptFor(false, true).startsWith("Your todo list holds no actionable item")).toBe(true);
    expect(promptFor(false, true)).toContain("Continue the loop");
  });

  test("an armed idle session in a directory with chain.enabled receives the chain prompt; E:/repo (no config) keeps the loop prompt", async () => {
    const chainHome = process.env.AGENT_WORKFLOW_CONFIG_HOME!;
    const laneState = mkdtempSync(join(tmpdir(), "loop-continuation-lane-"));
    writeFileSync(join(chainHome, "e-repo-chain.json"), JSON.stringify({
      schema_version: 1,
      repository: { github: "example/app", remote: "origin", target_branch: "main", lane_branch_prefix: "lane/" },
      lane: { id: "lane-b", directory: "E:/repo-chain", worktree_root: laneState, artifact_prefix: "b-" },
      chain: { enabled: true, gate_mode: "shadow", max_repair_rounds: 2 },
      state_dir: laneState,
    }));
    const chain = harness([user("# Loop Start Command" + String.fromCharCode(10) + "Start a managed autonomous loop")], [todo("#1769 -> opened", "pending")]);
    const chainHooks: any = await plugin({ client: chain.client, directory: "E:/repo-chain" });
    await idle(chainHooks, "ses_chain");
    expect(chain.prompts).toHaveLength(1);
    expect(chain.prompts[0].body.parts[0].text).toContain("Continue the chain");
    expect(chain.prompts[0].body.parts[0].text).not.toContain("Continue the loop");
    expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_chain", iteration: 1, reason: "continue" });
    const plain = harness([user("# Loop Start Command" + String.fromCharCode(10) + "Start a managed autonomous loop")], [todo("QUEUE: #2 fix", "pending")]);
    const plainHooks: any = await plugin({ client: plain.client, directory: "E:/repo" });
    await idle(plainHooks, "ses_plain_prompt");
    expect(plain.prompts[0].body.parts[0].text).toContain("Continue the loop");
    expect(plain.prompts[0].body.parts[0].text).not.toContain("Continue the chain");
    // a disabled config is the same as none
    writeFileSync(join(chainHome, "e-repo-off.json"), JSON.stringify({ schema_version: 1, chain: { enabled: false }, state_dir: laneState }));
    const off = harness([user("/loop-start")], [todo("QUEUE: #2", "pending")]);
    const offHooks: any = await plugin({ client: off.client, directory: "E:/repo-off" });
    await idle(offHooks, "ses_off");
    expect(off.prompts[0].body.parts[0].text).toContain("Continue the loop");
  });
});

describe("the loop brake (owner 2026-09-15: it must not disarm, it must back off)", () => {
  const { mkdirSync, appendFileSync } = require("node:fs");
  const noStall = () => {
    const saved = { max: process.env.LOOP_CONTINUATION_MAX, stall: process.env.LOOP_CONTINUATION_STALL };
    delete process.env.LOOP_CONTINUATION_MAX; delete process.env.LOOP_CONTINUATION_STALL;
    return () => { process.env.LOOP_CONTINUATION_MAX = saved.max!; process.env.LOOP_CONTINUATION_STALL = saved.stall!; };
  };
  const mine = (id: string) => receipts().filter((r) => r.sessionID === id);

  test("a marker anywhere in the first 40 characters takes a todo out of the actionable set", () => {
    expect(notActionable("E1 #1860 BLOCKED: waiting on the owner ruling")).toBe(true);   // lane E, 488 re-prompts
    expect(notActionable("[D3b] #1863 repair PARKED")).toBe(true);                       // lane D, 690 re-prompts
    expect(notActionable("C2 #1904 waiting on CI before the next push")).toBe(true);
    expect(notActionable("BLOCKED: #3")).toBe(true);
    expect(notActionable("OWNER RULINGS (7): ...")).toBe(true);
    expect(notActionable("FINAL: push + report")).toBe(true);
    // 2026-09-16: lane A re-prompted this exact todo 22 times at a 49 s median gap with stalled 0 on every receipt.
    expect(notActionable("OWNER-ONLY: #1473 (live-DB remint via #1452, ruling 5686251823)")).toBe(true);
    expect(notActionable("OWNER ONLY: #1473")).toBe(true);
    expect(notActionable("A1 #1473 owner-only until the owner rules")).toBe(true);
    // the notes tell lanes to write "BLOCKED: escalated #N" (already covered); a bare ESCALATED must park too
    expect(notActionable("ESCALATED: #1988 waiting on the owner")).toBe(true);
    expect(notActionable("BLOCKED: escalated #1989")).toBe(true);
    expect(notActionable("A3 #1936 escalated, ruling requested")).toBe(true);
    // PINNED (2026-09-16): the marker rule is position-in-head only, case-insensitive, exactly as BLOCKED already
    // behaved mid-sentence. A lowercase marker inside a sentence in the first 40 characters therefore PARKS the todo.
    expect(notActionable("Unblock the owner-only path")).toBe(true);
    // ... and past the first 40 characters it does not, which is the escape hatch for real work.
    expect(notActionable("write the red test for the remint seam, then the owner-only path")).toBe(false);
    expect(notActionable("write the green fix for billing runtime, then escalated work")).toBe(false);
    expect(notActionable("owners of the only remaining seam file")).toBe(false);   // no OWNER-ONLY / OWNER ONLY token
    // the backoff is what limits an unmarked todo; the marker rule must not swallow real work
    expect(notActionable("Behavioural pin: ride next C2 push")).toBe(false);
    expect(notActionable("QUEUE: #2 fix")).toBe(false);
    expect(notActionable("finalize the PR body and reply")).toBe(false);   // \b keeps FINALIZE actionable
    expect(notActionable("write the red test for billing runtime, then BLOCKED work")).toBe(false); // past 40 chars
    expect(notActionable(undefined)).toBe(false);
    expect(notActionable({} as any)).toBe(false);   // what the OpenCode loader passes
  });

  test("a todo list of only mid-line BLOCKED/PARKED items is not actionable at all (no prompt)", async () => {
    const h = harness([user("/loop-start")], [todo("E1 #1860 BLOCKED: waiting on the owner ruling", "in_progress"), todo("[D3b] #1863 repair PARKED", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/brake-repo" });
    await idle(hooks, "ses_marked");
    expect(h.prompts).toHaveLength(0);
    expect(receipts().at(-1).reason).toMatch(/queue complete/);
  });

  test("three continuations with no progress produce a 5-minute wait receipt and no prompt", async () => {
    const restore = noStall();
    try {
      const h = harness([user("/loop-start")], [todo("QUEUE: #1861 repair", "in_progress")]);
      const hooks: any = await plugin({ client: h.client, directory: "E:/brake-repo" });
      await idle(hooks, "ses_backoff"); // 1st continuation
      await idle(hooks, "ses_backoff"); // 2nd, stalled 1: still the plain debounce tier
      expect(h.prompts).toHaveLength(2);
      await idle(hooks, "ses_backoff"); // 3rd decision, stalled 2: the 5-minute tier
      expect(h.prompts).toHaveLength(2);
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_backoff", reason: "backoff", stalled: 2, waitMs: 300000, next: "QUEUE: #1861 repair" });
      expect(mine("ses_backoff").filter((r) => String(r.reason).startsWith("disarmed"))).toHaveLength(0);
    } finally { restore(); }
  });

  test("the wait elapses on its own, the tiers escalate to the long one at the fifth stall, and it never disarms", async () => {
    const restore = noStall();
    process.env.LOOP_CONTINUATION_BACKOFF_MS = "20";
    process.env.LOOP_CONTINUATION_LONG_BACKOFF_MS = "40";
    try {
      const h = harness([user("/loop-start")], [todo("QUEUE: #1861 repair", "in_progress")]);
      const hooks: any = await plugin({ client: h.client, directory: "E:/brake-wait" });
      // each cycle: one idle, then long enough for a pending wait to elapse and send its own continuation
      for (let i = 0; i < 5; i++) { await idle(hooks, "ses_wait"); await new Promise((r) => setTimeout(r, 70)); }
      expect(h.prompts).toHaveLength(5);
      const waits = mine("ses_wait").filter((r) => r.reason === "backoff");
      expect(waits.map((r) => r.stalled)).toEqual([2, 3, 4]);
      expect(waits.map((r) => r.waitMs)).toEqual([20, 20, 20]);
      await idle(hooks, "ses_wait");
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_wait", reason: "backoff", stalled: 5, waitMs: 40 });
      await new Promise((r) => setTimeout(r, 90)); // drain the long wait inside this test
      expect(h.prompts).toHaveLength(6);
      expect(mine("ses_wait").filter((r) => String(r.reason).startsWith("disarmed"))).toHaveLength(0);
      expect(existsSync(join(stateDir, "loop-continuation.active.d", "ses_wait.json"))).toBe(true);
    } finally {
      restore();
      delete process.env.LOOP_CONTINUATION_BACKOFF_MS; delete process.env.LOOP_CONTINUATION_LONG_BACKOFF_MS;
    }
  });

  // A chain lane on disk: the config (and so state_dir) is resolved at plugin load, so it is written before plugin().
  // The ledger is shaped like a real one (<framework>/state/lanes/lane-a/tickets/1976/ledger.json):
  // `phase`, `heads` (list of SHAs), `findings` (each with a `history`, the LAST entry carrying the disposition) and
  // `assignments` (each with an `id`). The CLI writes utf-8-sig, so the fixture leads with a BOM on purpose.
  const laneFixture = (slug: string, ticket: string, ledger: any) => {
    const laneState = mkdtempSync(join(tmpdir(), "loop-continuation-ledger-"));
    writeFileSync(join(process.env.AGENT_WORKFLOW_CONFIG_HOME!, `${slug}.json`), JSON.stringify({
      schema_version: 1, chain: { enabled: true, gate_mode: "shadow" }, lane: { id: "lane-x" }, state_dir: laneState,
    }));
    mkdirSync(join(laneState, "tickets", ticket), { recursive: true });
    writeFileSync(join(laneState, "active-ticket.json"), "\uFEFF" + JSON.stringify({ ticket, head: null, allowed_paths: ["backend/**"], worktree: "E:/wt" }));
    const events = join(laneState, "tickets", ticket, "events.jsonl");
    const ledgerFile = join(laneState, "tickets", ticket, "ledger.json");
    writeFileSync(events, JSON.stringify({ kind: "ticket_opened" }) + "\n");
    const writeLedger = () => writeFileSync(ledgerFile, "\uFEFF" + JSON.stringify(ledger, null, 1));
    writeLedger();
    // what `ticket judge-sync` appends at the start of EVERY lane turn: pure bookkeeping, no ledger movement
    const bookkeeping = () => appendFileSync(events, JSON.stringify({ kind: "judge_sync" }) + "\n" + JSON.stringify({ kind: "pr_observed" }) + "\n");
    return { laneState, events, ledgerFile, ledger, writeLedger, bookkeeping };
  };

  test("22 bookkeeping events with an unchanged ledger signature do NOT reset the stall counter (lane A, 2026-09-16)", async () => {
    // Lane A's 22 continuations sat at a 49 s median gap with `stalled: 0` on every receipt and `next` =
    // "OWNER-ONLY: #1473 ...", because each turn's `ticket judge-sync` appended a judge_sync and a pr_observed event
    // and the old mark (the SIZE of events.jsonl) grew every time. The brake must see straight through that.
    const restore = noStall();
    process.env.LOOP_CONTINUATION_BACKOFF_MS = "15";
    process.env.LOOP_CONTINUATION_LONG_BACKOFF_MS = "15";
    const lane = laneFixture("e-brake-bookkeeping", "1473", {
      schema_version: 1, ticket: "1473", phase: "escalated", heads: [], findings: [], assignments: null,
    });
    try {
      const h = harness([user("/loop-start")], [todo("A1 #1473 remint seam, waiting for nothing", "in_progress")]);
      const hooks: any = await plugin({ client: h.client, directory: "E:/brake-bookkeeping" });
      for (let i = 0; i < 22; i++) {
        lane.bookkeeping();                                  // the only thing that moves on disk
        await idle(hooks, "ses_book");
        await new Promise((r) => setTimeout(r, 60));         // let a pending wait elapse and send its own prompt
      }
      expect(readFileSync(lane.events, "utf8").trim().split("\n")).toHaveLength(45);   // 1 + 22 * 2 events written
      const waits = mine("ses_book").filter((r) => r.reason === "backoff");
      expect(waits[0]).toMatchObject({ stalled: 2, next: "A1 #1473 remint seam, waiting for nothing" });
      expect(waits.map((r) => r.stalled)).toEqual([...waits.keys()].map((i) => i + 2));  // strictly rising: 2,3,4,...
      expect(waits.at(-1)!.stalled).toBeGreaterThanOrEqual(5);                           // and well past the old 0
      const continues = mine("ses_book").filter((r) => r.reason === "continue").map((r) => r.stalled);
      expect(continues.slice(0, 2)).toEqual([0, 1]);                 // the first two continuations are free
      expect(continues.slice(2).every((n) => n >= 2)).toBe(true);    // never 0 again while nothing moves
      expect(mine("ses_book").filter((r) => String(r.reason).startsWith("disarmed"))).toHaveLength(0);
    } finally {
      restore();
      delete process.env.LOOP_CONTINUATION_BACKOFF_MS; delete process.env.LOOP_CONTINUATION_LONG_BACKOFF_MS;
    }
  });

  test("a ledger phase change resets the counter; bookkeeping during the wait does not", async () => {
    const restore = noStall();
    const lane = laneFixture("e-brake-phase", "1861", {
      schema_version: 1, ticket: "1861", phase: "verifying",
      heads: ["1111111111111111111111111111111111111111"], findings: [], assignments: [{ id: "A-1861-01", kind: "initial" }],
    });
    try {
      const h = harness([user("/loop-start")], [todo("#1861 repair round 3", "in_progress")]);
      const hooks: any = await plugin({ client: h.client, directory: "E:/brake-phase" });
      await idle(hooks, "ses_phase"); // 1st continuation, the signature is the baseline
      await idle(hooks, "ses_phase"); // stalled 1
      expect(h.prompts).toHaveLength(2);
      await idle(hooks, "ses_phase"); // stalled 2: the 5-minute wait
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_phase", reason: "backoff", stalled: 2, waitMs: 300000 });
      lane.bookkeeping();
      await idle(hooks, "ses_phase"); // events.jsonl grew: NOT progress, the wait still holds
      expect(h.prompts).toHaveLength(2);
      expect(mine("ses_phase").filter((r) => r.reason === "continue")).toHaveLength(2);
      lane.ledger.phase = "review_ready";
      lane.writeLedger();
      await idle(hooks, "ses_phase"); // the ledger moved: the brake releases at once, inside the wait
      expect(h.prompts).toHaveLength(3);
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_phase", reason: "continue", stalled: 0 });
    } finally { restore(); }
  });

  test("every field of the progress signature releases the brake: head, open findings, assignment, and a commit", async () => {
    const restore = noStall();
    const lane = laneFixture("e-brake-signature", "1861", {
      schema_version: 1, ticket: "1861", phase: "implementing",
      heads: ["1111111111111111111111111111111111111111"], findings: [], assignments: [{ id: "A-1861-01", kind: "initial" }],
    });
    const h = harness([user("/loop-start")], [todo("#1861 repair round 3", "in_progress")]);
    try {
      const hooks: any = await plugin({ client: h.client, directory: "E:/brake-signature" });
      let prompts = 0;
      const toTheBrake = async () => {
        await idle(hooks, "ses_sig"); prompts++;   // progress (or the first continuation)
        expect(h.prompts).toHaveLength(prompts);
        expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_sig", reason: "continue", stalled: 0 });
        await idle(hooks, "ses_sig"); prompts++;   // stalled 1
        await idle(hooks, "ses_sig");              // stalled 2: braked
        expect(h.prompts).toHaveLength(prompts);
        expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_sig", reason: "backoff", stalled: 2 });
      };
      await toTheBrake();
      // a new head (the Worker delivered a candidate)
      lane.ledger.heads.push("2222222222222222222222222222222222222222"); lane.writeLedger();
      await toTheBrake();
      // a finding opened by the judge: open findings 0 -> 1 (the disposition is history[-1].disposition, ledger.py)
      lane.ledger.findings.push({ id: "F-1861-001", severity: "P2", history: [{ head: "222222222", disposition: "open", by: "judge" }] });
      lane.writeLedger();
      await toTheBrake();
      // the same finding verified: open findings 1 -> 0. A non-closing disposition would NOT move the count.
      lane.ledger.findings[0].history.push({ head: "222222222", disposition: "verified_fixed", by: "verifier" });
      lane.writeLedger();
      await toTheBrake();
      // a new assignment (a worker-continuation was granted)
      lane.ledger.assignments.push({ id: "A-1861-02", kind: "worker-continuation" }); lane.writeLedger();
      await toTheBrake();
      // and the commit half of `progressed` is untouched by any of this
      await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_sig", args: { command: "git commit -F msg.txt" } }, { output: "[qwen/x abc1234] fix", metadata: {} });
      await idle(hooks, "ses_sig"); prompts++;
      expect(h.prompts).toHaveLength(prompts);
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_sig", reason: "continue", stalled: 0 });
      expect(mine("ses_sig").filter((r) => String(r.reason).startsWith("disarmed"))).toHaveLength(0);
    } finally { restore(); }
  });

  test("the same NEXT todo with the other todos rewritten is still a stall (the whole-list compare used to hide it)", async () => {
    const restore = noStall();
    try {
      const todos = [todo("#1861 repair round 3", "in_progress"), todo("#1862 later", "pending"), todo("bookkeeping note", "pending")];
      const h = harness([user("/loop-start")], todos);
      const hooks: any = await plugin({ client: h.client, directory: "E:/brake-nexttodo" });
      await idle(hooks, "ses_next");                      // 1st continuation
      todos[1].content = "#1862 later - judge sync 1";    // the lane rewrites its OTHER todos every turn
      await idle(hooks, "ses_next");                      // stalled 1 (the old compare read this as progress)
      expect(h.prompts).toHaveLength(2);
      todos[2].status = "completed"; todos.push(todo("#1863 queued", "pending"));
      await idle(hooks, "ses_next");                      // stalled 2: braked on the unchanged `next`
      expect(h.prompts).toHaveLength(2);
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_next", reason: "backoff", stalled: 2, next: "#1861 repair round 3" });
      // changing the NEXT todo itself is still progress
      todos[0].content = "#1861 repair round 4";
      await idle(hooks, "ses_next");
      expect(h.prompts).toHaveLength(3);
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_next", reason: "continue", stalled: 0, next: "#1861 repair round 4" });
    } finally { restore(); }
  });

  test("the backoff really holds the session: no `continue` receipt is written inside the wait", async () => {
    const restore = noStall();
    process.env.LOOP_CONTINUATION_BACKOFF_MS = "400";   // stands in for the 5-minute tier
    process.env.LOOP_CONTINUATION_LONG_BACKOFF_MS = "400";
    try {
      const h = harness([user("/loop-start")], [todo("#1861 repair round 3", "in_progress")]);
      const hooks: any = await plugin({ client: h.client, directory: "E:/brake-delay" });
      const continues = () => mine("ses_delay").filter((r) => r.reason === "continue");
      await idle(hooks, "ses_delay");
      await idle(hooks, "ses_delay");
      await idle(hooks, "ses_delay");   // stalled 2 -> the wait starts here
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_delay", reason: "backoff", stalled: 2, waitMs: 400 });
      expect(continues()).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 120));      // well inside the wait
      expect(continues()).toHaveLength(2);
      expect(h.prompts).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 150));      // still inside it
      expect(continues()).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 400));      // now past it
      expect(continues()).toHaveLength(3);
      expect(h.prompts).toHaveLength(3);
      expect(mine("ses_delay").filter((r) => String(r.reason).startsWith("disarmed"))).toHaveLength(0);
    } finally {
      restore();
      delete process.env.LOOP_CONTINUATION_BACKOFF_MS; delete process.env.LOOP_CONTINUATION_LONG_BACKOFF_MS;
    }
  });
});

describe("operator note cap (owner 2026-09-15: an oversized note is paid for on every continuation)", () => {
  const { mkdirSync } = require("node:fs");
  const headDir = join(stateDir, "loop-head");

  test("a note under the cap is prepended; one above it is withheld with a notice and a receipt", async () => {
    mkdirSync(headDir, { recursive: true });
    writeFileSync(join(headDir, "e-note-small.txt"), "STANDING RULES: three test runs per ticket, push complete work only");
    const small = harness([user("/loop-start")], [todo("QUEUE: #1861", "pending")]);
    const smallHooks: any = await plugin({ client: small.client, directory: "E:/note-small" });
    await idle(smallHooks, "ses_note_ok");
    expect(small.prompts[0].body.parts[0].text).toContain("OPERATOR NOTE: STANDING RULES: three test runs per ticket");
    expect(receipts().filter((r) => r.sessionID === "ses_note_ok" && r.reason === "note_withheld")).toHaveLength(0);

    const big = "STANDING RULES: " + "judge round economy and ticket history. ".repeat(500); // ~20 KB, ~5000 tokens
    writeFileSync(join(headDir, "e-note-big.txt"), big);
    const h = harness([user("/loop-start")], [todo("QUEUE: #1861", "pending")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/note-big" });
    await idle(hooks, "ses_note_big");
    const text = h.prompts[0].body.parts[0].text;
    const tokens = Math.ceil(Buffer.byteLength(big.trim(), "utf8") / 4);
    expect(tokens).toBeGreaterThan(4000);
    expect(text.startsWith("OPERATOR NOTE withheld: " + tokens + " tokens exceeds the 4000 cap; the operator must trim it")).toBe(true);
    expect(text).not.toContain("judge round economy");
    expect(text).toContain("Continue the loop");
    const withheld = receipts().filter((r) => r.sessionID === "ses_note_big" && r.reason === "note_withheld");
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toMatchObject({ tokens, max: 4000, iteration: 1 });
  });

  test("an oversized note is still parsed for QUEUE bundles, so the loop does not disarm on it", async () => {
    mkdirSync(headDir, { recursive: true });
    writeFileSync(join(headDir, "e-note-queue.txt"), "QUEUE (Lane X): [X1] #1861 (a.py); [X2] #1862 (b.py)\n" + "history line. ".repeat(1500));
    const h = harness([user("/loop-start")], [todo("done", "completed")]);
    const hooks: any = await plugin({ client: h.client, directory: "E:/note-queue" });
    await idle(hooks, "ses_note_queue");
    expect(h.prompts).toHaveLength(1);
    const text = h.prompts[0].body.parts[0].text;
    expect(text.startsWith("OPERATOR NOTE withheld:")).toBe(true);
    expect(text).toContain("QUEUE still lists bundles");
    expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_note_queue", reason: "continue:queue", queued: 2, next: "[X1] #1861 (a.py)" });
  });

  test("LOOP_CONTINUATION_NOTE_MAX_TOKENS tunes the cap and 0 disables it", async () => {
    mkdirSync(headDir, { recursive: true });
    writeFileSync(join(headDir, "e-note-knob.txt"), "QUEUE: none. STANDING RULES: short note of about sixty bytes");
    process.env.LOOP_CONTINUATION_NOTE_MAX_TOKENS = "5";
    try {
      const h = harness([user("/loop-start")], [todo("QUEUE: #1861", "pending")]);
      const hooks: any = await plugin({ client: h.client, directory: "E:/note-knob" });
      await idle(hooks, "ses_note_knob");
      expect(h.prompts[0].body.parts[0].text.startsWith("OPERATOR NOTE withheld:")).toBe(true);
      expect(receipts().filter((r) => r.sessionID === "ses_note_knob" && r.reason === "note_withheld")).toHaveLength(1);
      process.env.LOOP_CONTINUATION_NOTE_MAX_TOKENS = "0";
      const off = harness([user("/loop-start")], [todo("QUEUE: #1861", "pending")]);
      const offHooks: any = await plugin({ client: off.client, directory: "E:/note-knob" });
      await idle(offHooks, "ses_note_off");
      expect(off.prompts[0].body.parts[0].text.startsWith("OPERATOR NOTE: QUEUE: none.")).toBe(true);
      expect(receipts().filter((r) => r.sessionID === "ses_note_off" && r.reason === "note_withheld")).toHaveLength(0);
    } finally { delete process.env.LOOP_CONTINUATION_NOTE_MAX_TOKENS; }
  });
});

describe("LOOP_CONTINUATION_STALL floor", () => {
  test("STALL=1 does not put the first stall in the long tier: stalls 0-1 always keep the plain debounce", async () => {
    const saved = { max: process.env.LOOP_CONTINUATION_MAX, stall: process.env.LOOP_CONTINUATION_STALL };
    delete process.env.LOOP_CONTINUATION_MAX;
    process.env.LOOP_CONTINUATION_STALL = "1";
    try {
      const h = harness([user("/loop-start")], [todo("QUEUE: #1861 repair", "in_progress")]);
      const hooks: any = await plugin({ client: h.client, directory: "E:/brake-floor" });
      await idle(hooks, "ses_floor"); // 1st continuation
      await idle(hooks, "ses_floor"); // stalled 1: still prompts, no wait
      expect(h.prompts).toHaveLength(2);
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_floor", reason: "continue", stalled: 1 });
      await idle(hooks, "ses_floor"); // stalled 2: the long tier the knob asked for
      expect(h.prompts).toHaveLength(2);
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_floor", reason: "backoff", stalled: 2, waitMs: 1800000 });
    } finally {
      process.env.LOOP_CONTINUATION_MAX = saved.max!; process.env.LOOP_CONTINUATION_STALL = saved.stall!;
    }
  });
});

describe("fresh-session continuation (owner directive 2026-09-16: stateless Manager)", () => {
  test("LOOP_CONTINUATION_FRESH_SESSION=1 sends the continuation to a NEW session, self-armed, and releases the old one", async () => {
    process.env.LOOP_CONTINUATION_FRESH_SESSION = "1";
    try {
      const h = harness([user("/loop-start")], [todo("QUEUE: #2 fix", "pending")]);
      const created: any[] = [];
      (h.client.session as any).create = async (args: any) => { created.push(args); return { data: { id: "ses_fresh_1" } }; };
      const hooks: any = await plugin({ client: h.client, directory: "E:/repo-fresh" });
      await idle(hooks, "ses_old");
      expect(created).toHaveLength(1);
      expect(created[0].query.directory).toBe("E:/repo-fresh");
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0].path.id).toBe("ses_fresh_1");
      const text = h.prompts[0].body.parts[0].text;
      expect(text.startsWith("continue the loop (fresh session 1; previous session ses_old released)")).toBe(true);
      expect(text).toContain("STATELESS MANAGER");
      expect(text).toContain("Continue the loop");
      expect(existsSync(join(stateDir, "loop-continuation.active.d", "ses_fresh_1.json"))).toBe(true);
      expect(existsSync(join(stateDir, "loop-continuation.active.d", "ses_old.json"))).toBe(false);
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_fresh_1", iteration: 1, reason: "continue:fresh", from: "ses_old" });
      // The new session idles after its turn: it continues again as a fresh session of its own, never the old one.
      (h.client.session as any).create = async () => ({ data: { id: "ses_fresh_2" } });
      await idle(hooks, "ses_fresh_1");
      expect(h.prompts).toHaveLength(2);
      expect(h.prompts[1].path.id).toBe("ses_fresh_2");
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_fresh_2", iteration: 2, reason: "continue:fresh", from: "ses_fresh_1" });
    } finally {
      delete process.env.LOOP_CONTINUATION_FRESH_SESSION;
    }
  });

  test("a fresh session starts with no todo list: the origin's todos carry it, in the prompt and in the idle check (lane A disarmed on this, 2026-09-17 13:32 EDT)", async () => {
    process.env.LOOP_CONTINUATION_FRESH_SESSION = "1";
    try {
      const h = harness([user("/loop-start")], [todo("#1470 full chain", "in_progress"), todo("#2059 done", "completed")]);
      // Todos are per session: only the original session has any; the fresh sessions return an empty list.
      (h.client.session as any).todo = async ({ path }: any) => ({ data: path.id === "ses_origin" ? h.todos : [] });
      let n = 0;
      (h.client.session as any).create = async () => ({ data: { id: `ses_fresh_${++n}` } });
      const hooks: any = await plugin({ client: h.client, directory: "E:/repo-fresh-todos" });
      await idle(hooks, "ses_origin");
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0].path.id).toBe("ses_fresh_1");
      const text = h.prompts[0].body.parts[0].text;
      expect(text).toContain("TODO LIST carried from the previous session");
      expect(text).toContain("- [in_progress] #1470 full chain");
      // The fresh session idles with an empty list of its own: it must NOT disarm, it continues on the inherited list.
      await idle(hooks, "ses_fresh_1");
      expect(h.prompts).toHaveLength(2);
      expect(h.prompts[1].path.id).toBe("ses_fresh_2");
      expect(h.prompts[1].body.parts[0].text).toContain("- [in_progress] #1470 full chain");
      expect(receipts().some((r) => ["ses_origin", "ses_fresh_1"].includes(r.sessionID) && String(r.reason).startsWith("disarmed:"))).toBe(false);
      // Once every inherited item is done, the loop does end.
      h.todos.splice(0, h.todos.length, todo("#1470 full chain", "completed"));
      await idle(hooks, "ses_fresh_2");
      expect(h.prompts).toHaveLength(2);
      expect(receipts().at(-1)).toMatchObject({ sessionID: "ses_fresh_2", reason: expect.stringContaining("disarmed:queue complete") });
    } finally {
      delete process.env.LOOP_CONTINUATION_FRESH_SESSION;
    }
  });

  test("a released session never spawns another fresh Manager from its old history; only a NEWER owner message re-arms it (four Managers ran at once, 2026-09-17)", async () => {
    process.env.LOOP_CONTINUATION_FRESH_SESSION = "1";
    try {
      const t0 = Date.now() - 60_000;
      const messages: any[] = [{ info: { role: "user", time: { created: t0 } }, parts: [{ type: "text", text: "continue the loop" }] }];
      const h = harness(messages, [todo("#1943 open ticket", "in_progress")]);
      let n = 0;
      (h.client.session as any).create = async () => ({ data: { id: `ses_spawn_${++n}` } });
      (h.client.session as any).todo = async ({ path }: any) => ({ data: path.id === "ses_owner" ? h.todos : [] });
      const hooks: any = await plugin({ client: h.client, directory: "E:/repo-released" });
      await idle(hooks, "ses_owner");
      expect(h.prompts.map((p) => p.path.id)).toEqual(["ses_spawn_1"]);
      // The owner's TUI session goes idle again (its own turn ended): NO second fresh Manager.
      await idle(hooks, "ses_owner");
      await idle(hooks, "ses_owner");
      expect(h.prompts.map((p) => p.path.id)).toEqual(["ses_spawn_1"]);
      expect(existsSync(join(stateDir, "loop-continuation.released.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(stateDir, "loop-continuation.released.json"), "utf8"))).toHaveProperty("ses_owner");
      // A NEW owner message after the release re-arms that session and it continues (fresh again, into a new session).
      messages.push({ info: { role: "user", id: "m_new", time: { created: Date.now() + 1000 } }, parts: [{ type: "text", text: "continue the loop" }] });
      await idle(hooks, "ses_owner");
      expect(h.prompts.map((p) => p.path.id)).toEqual(["ses_spawn_1", "ses_spawn_2"]);
      expect(receipts().some((r) => r.sessionID === "ses_owner" && String(r.reason).startsWith("re-armed after release"))).toBe(true);
    } finally {
      delete process.env.LOOP_CONTINUATION_FRESH_SESSION;
    }
  });

  test("a server that cannot create a session falls back to the same session with a receipt", async () => {
    process.env.LOOP_CONTINUATION_FRESH_SESSION = "1";
    try {
      const h = harness([user("/loop-start")], [todo("QUEUE: #2 fix", "pending")]);
      (h.client.session as any).create = async () => { throw new Error("create refused"); };
      const hooks: any = await plugin({ client: h.client, directory: "E:/repo-fresh-fail" });
      await idle(hooks, "ses_same");
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0].path.id).toBe("ses_same");
      expect(receipts().some((r) => r.sessionID === "ses_same" && String(r.reason).startsWith("fresh_session_failed:"))).toBe(true);
    } finally {
      delete process.env.LOOP_CONTINUATION_FRESH_SESSION;
    }
  });

  test("without the flag the continuation stays in the same session even when the server could create one", async () => {
    const h = harness([user("/loop-start")], [todo("QUEUE: #2 fix", "pending")]);
    const created: any[] = [];
    (h.client.session as any).create = async (args: any) => { created.push(args); return { data: { id: "ses_never" } }; };
    const hooks: any = await plugin({ client: h.client, directory: "E:/repo-same" });
    await idle(hooks, "ses_stay");
    expect(created).toHaveLength(0);
    expect(h.prompts[0].path.id).toBe("ses_stay");
  });
});

describe("lane kind (2026-09-28)", () => {
  const NOTE_LINE = "This lane's job is defined by the OPERATOR NOTE";
  test("two arguments keep the PR prompt byte for byte", () => {
    expect(promptFor(false, false)).toBe(promptFor(false, false, null));
    expect(promptFor(false, false)).toContain("gh pr list");
  });
  test("a non-pr lane kind selects the note-driven prompt; pr keeps the sweep", () => {
    expect(promptFor(false, false, "authoring")).toContain(NOTE_LINE);
    expect(promptFor(false, false, "authoring")).not.toContain("gh pr list");
    expect(promptFor(false, false, "pr")).toBe(promptFor(false, false));
  });
  test("queue text still leads, and a chain lane keeps its chain prompt", () => {
    expect(promptFor(false, true, "authoring").startsWith(promptFor(false, true).slice(0, 40))).toBe(true);
    expect(promptFor(true, false, "authoring")).toBe(promptFor(true, false));
  });
  test("LANE KIND is read only from its own line", () => {
    expect(laneKindOf(["STANDING ORDERS", "LANE KIND: authoring", "rest"].join(String.fromCharCode(10)))).toBe("authoring");
    expect(laneKindOf("  lane kind: Render-Review  ")).toBe("render-review");
    expect(laneKindOf("the LANE KIND: authoring appears mid-sentence")).toBe("");
    expect(laneKindOf("")).toBe("");
  });
  test("every export survives being called as a plugin factory (OpenCode calls them all)", async () => {
    // A null result from ANY export crashed OpenCode startup on 2026-09-28 (laneKindOf returned null).
    const mod: any = await import("../plugins/loop-continuation.ts");
    const input = { client: {}, directory: "E:/probe", project: {}, worktree: "E:/probe", $: () => {} };
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== "function") continue;
      const out = await Promise.resolve().then(() => (fn as any)(input)).catch(() => undefined);
      expect({ name, isNull: out === null }).toEqual({ name, isNull: false });
    }
  });
});
