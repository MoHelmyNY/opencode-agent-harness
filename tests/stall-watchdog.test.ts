// bun test tests/stall-watchdog.test.ts
import { expect, test } from "bun:test";
import { createWatchdog, readOnlyPermission, stalledCalls, engineIdle, bashLimitMs, heldPipeLaunch } from "../guardrails/stall-watchdog-core.ts";
import plugin from "../plugins/stall-watchdog.ts";

const ROOTS = ["C:/Users/dev/AppData/Local/Temp/opencode", "/srv/agent-workflow-lab/state"];
const metrics = (running: number) => async () => ({ ok: true, text: async () => `vllm:num_requests_running{engine="0",model_name="x"} ${running}.0\n` }) as any;

function harness(opts: Partial<Parameters<typeof createWatchdog>[0]> = {}) {
  const aborts: any[] = []; const receipts: any[] = []; const toasts: string[] = [];
  let clock = 1_000_000;
  // the store answers "running" for every tracked call unless the test marks it done through `finished`
  const finished = new Set<string>();
  let w: ReturnType<typeof createWatchdog>;
  const client = { session: { abort: async (args: any) => { aborts.push(args); return { data: true }; },
                              messages: async (args: any) => ({ data: [{ info: { id: "m1" }, parts: [...w.running.values()].filter((r) => r.sessionID === args.path.id).map((r) => ({ type: "tool", callID: r.callID, state: { status: finished.has(r.callID) ? "error" : "running" } })) }] }) } };
  w = createWatchdog({ client, directory: "/work/app", readRoots: ROOTS, stallMs: 300_000, bashStallMs: 1_500_000,
    fetchImpl: metrics(0), now: () => clock, receipt: async (r) => { receipts.push(r); }, toast: async (t) => { toasts.push(t); }, ...opts });
  return { w, aborts, receipts, toasts, finished, client, advance: (ms: number) => { clock += ms; } };
}

test("a call the store no longer shows as running is cleared, never aborted; an unreadable store never aborts either", async () => {
  // 2026-09-17: a guard-refused `ticket verify` never reached tool.execute.after; 26 minutes later the abort
  // hit the owner's live session and killed a contract-judge dispatch.
  const { w, aborts, receipts, finished, advance } = harness();
  await w.hooks["tool.execute.before"]({ tool: "bash", sessionID: "owner", callID: "refused1" });
  await w.hooks["tool.execute.before"]({ tool: "grep", sessionID: "child1", callID: "hung1" });
  finished.add("refused1"); // the store recorded the refusal as an error part
  advance(26 * 60_000);
  const aborted = await w.tick();
  expect(aborted.map((r) => r.callID)).toEqual(["hung1"]);
  expect(aborts.map((a) => a.path.id)).toEqual(["child1"]);
  expect(receipts.filter((r) => r.kind === "stall_cleared").map((r) => [r.callID, r.store])).toEqual([["refused1", "done"]]);
  expect(w.running.size).toBe(0);
  const down = harness({ client: { session: { abort: async () => { throw new Error("must not abort"); }, messages: async () => { throw new Error("store down"); } } } as any });
  await down.w.hooks["tool.execute.before"]({ tool: "grep", sessionID: "child9", callID: "x1" });
  down.advance(10 * 60_000);
  expect(await down.w.tick()).toEqual([]);
  expect(down.receipts.at(-1)).toMatchObject({ kind: "stall_cleared", callID: "x1", store: "unknown" });
});

test("read-only permission asks are allowed; writes, bash and secrets keep asking", async () => {
  expect(readOnlyPermission({ type: "read", pattern: "C:/anything/file.md" }, ROOTS)).toBe(true);
  expect(readOnlyPermission({ type: "grep", pattern: "C:/Users/dev/AppData/Local/Temp/opencode/prbody-1962-r4-draft.md" }, ROOTS)).toBe(true);
  expect(readOnlyPermission({ type: "external_directory", pattern: "C:\\Users\\dev\\AppData\\Local\\Temp\\opencode\\prbody.md", metadata: { tool: "grep" } }, ROOTS)).toBe(true);
  expect(readOnlyPermission({ type: "external_directory", pattern: "C:/Users/dev/AppData/Local/Temp/opencode/x.md", metadata: { tool: "edit" } }, ROOTS)).toBe(false);
  expect(readOnlyPermission({ type: "external_directory", pattern: "C:/Windows/System32/drivers/etc/hosts", metadata: { tool: "read" } }, ROOTS)).toBe(false);
  expect(readOnlyPermission({ type: "read", pattern: "C:/Users/dev/.config/opencode/secrets/provider.env" }, ROOTS)).toBe(false);
  expect(readOnlyPermission({ type: "read", pattern: "/srv/model-gateway/.secrets/keys.json" }, ROOTS)).toBe(false);
  expect(readOnlyPermission({ type: "edit", pattern: "/work/app/backend/x.py" }, ROOTS)).toBe(false);
  expect(readOnlyPermission({ type: "bash", pattern: "git status" }, ROOTS)).toBe(false);
  const { w, receipts } = harness();
  const out = { status: "ask" as const };
  await w.hooks["permission.ask"]({ id: "p1", type: "grep", sessionID: "child1", pattern: "C:/Users/dev/AppData/Local/Temp/opencode/a.md" }, out);
  expect(out.status).toBe("allow");
  expect(receipts.map((r) => r.kind)).toEqual(["permission_allowed"]);
  const keep = { status: "ask" as const };
  await w.hooks["permission.ask"]({ id: "p2", type: "bash", sessionID: "child1", pattern: "rm -rf x" }, keep);
  expect(keep.status).toBe("ask");
});

test("a tool call hung past the threshold with the engine idle is aborted once; task never; bash at its own timeout + grace", async () => {
  const { w, aborts, receipts, toasts, advance } = harness();
  await w.hooks["tool.execute.before"]({ tool: "grep", sessionID: "child1", callID: "c1" });
  await w.hooks["tool.execute.before"]({ tool: "task", sessionID: "parent", callID: "t1" });
  await w.hooks["tool.execute.before"]({ tool: "bash", sessionID: "parent", callID: "b1" }, { args: { command: "pytest -q", timeout: 600_000 } });
  advance(4 * 60_000);
  expect(await w.tick()).toEqual([]);
  advance(2 * 60_000); // 6 minutes: grep is stale, bash (own 10 min + 1) and task are not
  const aborted = await w.tick();
  expect(aborted.map((r) => r.callID)).toEqual(["c1"]);
  expect(aborts).toEqual([{ path: { id: "child1" }, query: { directory: "/work/app" } }]);
  expect(receipts.at(-1)).toMatchObject({ kind: "stall_abort", sessionID: "child1", tool: "grep", engine_idle: true, ok: true });
  expect(toasts.length).toBe(1);
  expect(await w.tick()).toEqual([]); // not aborted twice
  advance(5 * 60_000 - 1); // bash just under 11 minutes
  expect(await w.tick()).toEqual([]);
  advance(1);
  expect((await w.tick()).map((r) => r.callID)).toEqual(["b1"]);
  expect(receipts.at(-1)).toMatchObject({ kind: "stall_abort", tool: "bash", limit_ms: 660_000 });
  expect(stalledCalls(w.running, Number.MAX_SAFE_INTEGER)).toEqual([]); // only the task remains and task is never stale
});

test("bash limit: own timeout + grace, 120 s default without one, capped; a busy engine does not defer bash", async () => {
  expect(bashLimitMs({ timeout: 15_000 })).toBe(75_000);
  expect(bashLimitMs({})).toBe(180_000);
  expect(bashLimitMs(undefined)).toBe(180_000);
  expect(bashLimitMs({ timeout: "abc" })).toBe(180_000);
  expect(bashLimitMs({ timeout: 3_600_000 })).toBe(1_500_000); // the cap
  // a web project, 2026-09-26: no timeout arg, held pipe, 372 s until a manual abort
  const { w, aborts, advance } = harness({ fetchImpl: metrics(1) }); // engine busy decoding for another session
  await w.hooks["tool.execute.before"]({ tool: "bash", sessionID: "webdev", callID: "hang1" }, { args: { command: "some-server --watch" } });
  await w.hooks["tool.execute.before"]({ tool: "read", sessionID: "other", callID: "r9" });
  advance(179_000);
  expect(await w.tick()).toEqual([]);
  advance(1_000);
  expect((await w.tick()).map((r) => r.callID)).toEqual(["hang1"]);
  expect(aborts.map((a) => a.path.id)).toEqual(["webdev"]);
});

test("an open permission ask pauses the session's calls; the answer restarts the clock", async () => {
  // 14-day store scan 2026-09-26: a 212 s timeout-less bash call ended "The user rejected permission" - the owner's
  // think time is inside the call's clock and must never read as a stall
  const { w, aborts, advance } = harness();
  await w.hooks["tool.execute.before"]({ tool: "bash", sessionID: "owner", callID: "p1" }, { args: { command: "git push" } });
  await w.hooks["tool.execute.before"]({ tool: "bash", sessionID: "other", callID: "o1" }, { args: { command: "server" } });
  const out = { status: "ask" as const };
  await w.hooks["permission.ask"]({ id: "q1", type: "bash", sessionID: "owner", pattern: "git push" }, out);
  expect(out.status).toBe("ask");
  advance(20 * 60_000); // the owner is away for 20 minutes
  expect((await w.tick()).map((r) => r.callID)).toEqual(["o1"]); // only the unpaused session's hung call
  await w.hooks.event({ event: { type: "permission.replied", properties: { sessionID: "owner", permissionID: "q1", response: "once" } } });
  advance(179_000);
  expect(await w.tick()).toEqual([]);
  advance(1_000); // 180 s after the answer
  expect((await w.tick()).map((r) => r.callID)).toEqual(["p1"]);
  // the event form alone (another plugin answered the hook) pauses too
  await w.hooks["tool.execute.before"]({ tool: "read", sessionID: "s2", callID: "r2" });
  await w.hooks.event({ event: { type: "permission.asked", properties: { sessionID: "s2", id: "q2" } } });
  advance(60 * 60_000);
  expect(await w.tick()).toEqual([]);
  expect(aborts.map((a) => a.path.id)).toEqual(["other", "owner"]);
});

test("a Start-Process launch that would hold the tool's pipe is refused before it runs; safe forms pass", async () => {
  const held = [
    `Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run dev" -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\\opencode\\astro-dev.log" -RedirectStandardError "$env:TEMP\\opencode\\astro-dev.err.log"; Start-Sleep -Seconds 10`,
    `start-process node -ArgumentList server.js -NoNewWindow`,
    `Start-Process npm -RedirectStandardInput in.txt`,
  ];
  for (const c of held) expect(heldPipeLaunch(c)).toContain("Refused before running");
  const fine = [
    `Start-Process -FilePath cmd.exe -ArgumentList '/c','npm run dev > "%TEMP%\\opencode\\dev.log" 2>&1' -WindowStyle Hidden`,
    `Start-Process npm -ArgumentList test -NoNewWindow -Wait`,
    `Start-Process msiexec -RedirectStandardOutput o.txt -Wait -PassThru`,
    `npm run dev`, `git status`, ``,
  ];
  for (const c of fine) expect(heldPipeLaunch(c)).toBeNull();
  const { w, receipts } = harness();
  await expect(w.hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "x1" }, { args: { command: held[0] } })).rejects.toThrow("Refused before running");
  expect(w.running.size).toBe(0);
  expect(receipts.at(-1)).toMatchObject({ kind: "bash_launch_refused", callID: "x1" });
  await w.hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "x2" }, { args: { command: fine[0] } });
  expect(w.running.get("x2")?.limit).toBe(180_000);
});

test("a busy engine defers the abort until twice the threshold, and a finished or idle call is forgotten", async () => {
  const { w, aborts, advance } = harness({ fetchImpl: metrics(1) });
  await w.hooks["tool.execute.before"]({ tool: "read", sessionID: "child2", callID: "r1" });
  await w.hooks["tool.execute.before"]({ tool: "read", sessionID: "child3", callID: "r2" });
  await w.hooks["tool.execute.after"]({ tool: "read", sessionID: "child3", callID: "r2" });
  advance(6 * 60_000);
  expect(await w.tick()).toEqual([]);
  advance(5 * 60_000); // 11 minutes > 2 x 5
  expect((await w.tick()).map((r) => r.callID)).toEqual(["r1"]);
  expect(aborts.length).toBe(1);
  await w.hooks["tool.execute.before"]({ tool: "glob", sessionID: "child4", callID: "g1" });
  await w.hooks.event({ event: { type: "session.status", properties: { sessionID: "child4", status: { type: "idle" } } } });
  advance(60 * 60_000);
  expect(await w.tick()).toEqual([]);
});

test("engine idleness is read from the metrics line and unknown when unreachable", async () => {
  expect(await engineIdle(metrics(0), "http://x")).toBe(true);
  expect(await engineIdle(metrics(2), "http://x")).toBe(false);
  expect(await engineIdle((async () => { throw new Error("down"); }) as any, "http://x")).toBeNull();
});

test("the plugin factory returns the four hooks and nothing else the loader would call", async () => {
  const hooks: any = await plugin({ client: { session: { abort: async () => ({}), messages: async () => ({ data: [] }) }, tui: { showToast: async () => ({}) } }, directory: "/work/app" });
  expect(Object.keys(hooks).sort()).toEqual(["event", "permission.ask", "tool.execute.after", "tool.execute.before"]);
});
