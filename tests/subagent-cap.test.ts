import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const load = async () => {
  delete (globalThis as any).__opencodeSubagentCap;
  const mod: any = await import("../plugins/subagent-cap.ts?" + Math.random());
  return mod;
};
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let stateHome = "";
beforeEach(() => {
  stateHome = mkdtempSync(path.join(os.tmpdir(), "subagent-cap-"));
  process.env.XDG_STATE_HOME = stateHome;
  process.env.SUBAGENT_CAP_POLL_MS = "10";
  delete process.env.SUBAGENT_CAP;
  delete process.env.SUBAGENT_CAP_MAX_HOLD_MS;
});
afterEach(() => { delete process.env.XDG_STATE_HOME; });

async function hooksFor(provider: string, sessionID = "ses_parent") {
  const mod = await load();
  const hooks = await mod.default({});
  await hooks["chat.params"]({ sessionID, model: { providerID: provider } });
  return hooks;
}
function start(hooks: any, callID: string, sessionID = "ses_parent") {
  const state = { admitted: false };
  const p = hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, { args: {} }).then(() => { state.admitted = true; });
  return { state, p };
}

test("every export survives being called as a plugin factory", async () => {
  const mod = await load();
  for (const [name, exp] of Object.entries(mod)) {
    expect(typeof exp).toBe("function");
    const result = await (exp as any)({});
    expect(result, `export ${name}`).not.toBeNull();
    expect(typeof result).toBe("object");
  }
});

test("local model: two subagents run, the third waits until one returns", async () => {
  const hooks = await hooksFor("vllm");
  const calls = ["c1", "c2", "c3", "c4", "c5"].map((id) => start(hooks, id));
  await tick();
  expect(calls.map((c) => c.state.admitted)).toEqual([true, true, false, false, false]);
  await hooks["tool.execute.after"]({ tool: "task", callID: "c1" });
  await tick();
  expect(calls.map((c) => c.state.admitted)).toEqual([true, true, true, false, false]);
  await hooks["tool.execute.after"]({ tool: "task", callID: "c2" });
  await hooks["tool.execute.after"]({ tool: "task", callID: "c3" });
  await tick();
  expect(calls.map((c) => c.state.admitted)).toEqual([true, true, true, true, true]);
  const kinds = readFileSync(path.join(stateHome, "opencode", "subagent-cap.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
  expect(kinds.filter((k) => k === "queued").length).toBe(3);
  expect(kinds.filter((k) => k === "admitted").length).toBe(5);
});

test("queued calls are admitted first come, first served", async () => {
  const hooks = await hooksFor("vllm");
  const order: string[] = [];
  const ps = ["a", "b", "c", "d"].map((id) =>
    hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_parent", callID: id }, { args: {} }).then(() => order.push(id)));
  await tick();
  await hooks["tool.execute.after"]({ tool: "task", callID: "a" });
  await tick();
  await hooks["tool.execute.after"]({ tool: "task", callID: "b" });
  await Promise.all(ps);
  // a and b are admitted together (cap 2); each resolves after its own receipt write, so their relative order is
  // file-I/O order, not admission order. The FIFO property is about the QUEUED calls: c is admitted before d.
  expect(order.slice(0, 2).sort()).toEqual(["a", "b"]);
  expect(order.slice(2)).toEqual(["c", "d"]);
});

test("API models are never capped", async () => {
  const hooks = await hooksFor("deepseek");
  const calls = ["c1", "c2", "c3", "c4", "c5"].map((id) => start(hooks, id));
  await tick();
  expect(calls.every((c) => c.state.admitted)).toBe(true);
});

test("a session whose provider is unknown is not capped", async () => {
  const mod = await load();
  const hooks = await mod.default({});
  const calls = ["c1", "c2", "c3"].map((id) => start(hooks, id, "ses_unseen"));
  await tick();
  expect(calls.every((c) => c.state.admitted)).toBe(true);
});

test("tools other than task are never held", async () => {
  const hooks = await hooksFor("vllm");
  start(hooks, "c1"); start(hooks, "c2");
  await tick();
  let done = false;
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_parent", callID: "b1" }, { args: {} }).then(() => { done = true; });
  expect(done).toBe(true);
});

test("a slot held past the max hold time is freed", async () => {
  process.env.SUBAGENT_CAP_MAX_HOLD_MS = "80";
  const hooks = await hooksFor("vllm");
  const calls = ["c1", "c2", "c3"].map((id) => start(hooks, id));
  await tick(20);
  expect(calls[2].state.admitted).toBe(false);
  await tick(150);
  expect(calls[2].state.admitted).toBe(true);
});

test("SUBAGENT_CAP_PROVIDERS chooses which providers count as local", async () => {
  process.env.SUBAGENT_CAP_PROVIDERS = "my-local-lane";
  try {
    const local = await hooksFor("my-local-lane");
    const held = ["c1", "c2", "c3"].map((id) => start(local, id));
    await tick();
    expect(held.map((c) => c.state.admitted)).toEqual([true, true, false]);
    await local["tool.execute.after"]({ tool: "task", callID: "c1" });
    const other = await hooksFor("vllm", "ses_other");
    const free = ["d1", "d2", "d3"].map((id) => start(other, id, "ses_other"));
    await tick();
    expect(free.every((c) => c.state.admitted)).toBe(true);
  } finally { delete process.env.SUBAGENT_CAP_PROVIDERS; }
});

test("SUBAGENT_CAP=0 disables the cap", async () => {
  process.env.SUBAGENT_CAP = "0";
  const hooks = await hooksFor("vllm");
  const calls = ["c1", "c2", "c3"].map((id) => start(hooks, id));
  await tick();
  expect(calls.every((c) => c.state.admitted)).toBe(true);
});
