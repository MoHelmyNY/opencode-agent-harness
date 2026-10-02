// bun test tests/qwen-guardrails.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The plugin appends receipts under $XDG_STATE_HOME/opencode; tests must never write into the real state directory.
process.env.XDG_GUARDRAILS_TEST_STATE = process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "qwen-guardrails-test-"));
import {
  CONTEXT_STAGES,
  DEFAULT_CONTEXT_WINDOW,
  EDIT_NUDGE_AT,
  contextNudge,
  contextWindowFor,
  newState,
  recordCall,
  recordResult,
  recordContext,
  recordEdit,
  resetContextStages,
  shouldNudgeEdit,
  tokensTotal,
  REPEAT_ABORT_AT,
  BASH_TIMEOUT_CAP_MS,
  boundCommand,
  graphifyNudge,
  GRAPHIFY_NUDGE_EVERY,
  backendModuleOf,
  ghJqVerdict,
  waitVerdict,
  REPEAT_NOTE_AT,
  REPEAT_REFUSE_AT,
} from "../guardrails/qwen-guardrails-core.ts";
import plugin from "../plugins/qwen-guardrails.ts";

describe("edit-loop guard", () => {
  test("is silent for the first five edits and speaks on the sixth, tenth and fourteenth", () => {
    const s = newState();
    const spoken: number[] = [];
    for (let i = 1; i <= 15; i++) {
      const r = recordEdit(s, "C:\\work\\app\\backend\\services\\repositories\\inventory.py");
      expect(r.count).toBe(i);
      if (r.nudge) spoken.push(i);
    }
    expect(spoken).toEqual([6, 10, 14]);
    expect(shouldNudgeEdit(EDIT_NUDGE_AT - 1)).toBe(false);
  });

  test("counts the same file once whatever the slash or case", () => {
    const s = newState();
    recordEdit(s, "C:\\worktrees\\x\\Backend\\a.py");
    const r = recordEdit(s, "c:/worktrees/x/backend/a.py");
    expect(r.count).toBe(2);
    expect(s.edits.size).toBe(1);
  });

  test("keeps files independent and names the file in the note", () => {
    const s = newState();
    for (let i = 0; i < 5; i++) recordEdit(s, "/repo/a.py");
    expect(recordEdit(s, "/repo/b.py").nudge).toBeNull();
    const r = recordEdit(s, "/repo/a.py");
    expect(r.nudge).toContain("edit #6 to a.py");
    expect(r.nudge).toContain("change it");
    expect(r.nudge).not.toMatch(/hurry|faster|quick/i);
  });
});

describe("context-budget guard", () => {
  test("uses the engine's total when present and sums the parts when it is absent", () => {
    // The live session's own accounting on 2026-09-10 03:37 EDT.
    expect(tokensTotal({ total: 161238, input: 113959, output: 354, reasoning: 61, cache: { read: 46864, write: 0 } })).toBe(161238);
    expect(tokensTotal({ input: 113959, output: 354, reasoning: 61, cache: { read: 46864, write: 0 } })).toBe(161238);
  });

  test("fires verify at 50% and checkpoint at 70%, each once", () => {
    const s = newState(DEFAULT_CONTEXT_WINDOW);
    recordContext(s, { total: 100000, input: 100000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(contextNudge(s)).toBeNull();
    recordContext(s, { total: 131072, input: 131072, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    const first = contextNudge(s);
    expect(first?.stage).toBe("verify");
    expect(first?.nudge).toContain("50%");
    expect(first?.nudge).toContain("never end, hold or checkpoint");
    expect(contextNudge(s)).toBeNull();
    recordContext(s, { total: 190000, input: 190000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    const second = contextNudge(s);
    expect(second?.stage).toBe("checkpoint");
    expect(second?.nudge).toContain("keep working");
    expect(contextNudge(s)).toBeNull();
  });

  test("speaks only the most urgent stage when the first observation is already past both", () => {
    const s = newState(DEFAULT_CONTEXT_WINDOW);
    recordContext(s, { total: 200000, input: 200000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(contextNudge(s)?.stage).toBe("checkpoint");
    expect(contextNudge(s)).toBeNull();
    expect(s.fired.size).toBe(CONTEXT_STAGES.length);
  });

  test("re-arms after compaction", () => {
    const s = newState(DEFAULT_CONTEXT_WINDOW);
    recordContext(s, { total: 140000, input: 140000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(contextNudge(s)?.stage).toBe("verify");
    resetContextStages(s);
    recordContext(s, { total: 60000, input: 60000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(contextNudge(s)).toBeNull();
    recordContext(s, { total: 140000, input: 140000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(contextNudge(s)?.stage).toBe("verify");
  });

  test("a zero-token announcement of the next message never resets the last known size", () => {
    const s = newState(DEFAULT_CONTEXT_WINDOW);
    recordContext(s, { total: 140000, input: 140000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(recordContext(s, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBe(140000);
    expect(contextNudge(s)?.stage).toBe("verify");
    // A smaller non-zero total (after compaction) is honoured.
    expect(recordContext(s, { total: 60000, input: 60000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBe(60000);
  });

  test("stays silent when the window is unknown", () => {
    const s = newState(null);
    recordContext(s, { total: 250000, input: 250000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(contextNudge(s)).toBeNull();
  });

  test("knows the local provider's window, honours the override and the provider list, ignores other providers", () => {
    expect(contextWindowFor("vllm", {})).toBe(262144);
    expect(contextWindowFor("anthropic", {})).toBeNull();
    expect(contextWindowFor("my-lane", { QWEN_GUARDRAILS_PROVIDERS: "my-lane, other" })).toBe(262144);
    expect(contextWindowFor("vllm", { QWEN_GUARDRAILS_PROVIDERS: "my-lane" })).toBeNull();
    expect(contextWindowFor("anthropic", { QWEN_GUARDRAILS_CONTEXT_WINDOW: "32000" })).toBe(32000);
    expect(() => contextWindowFor("vllm", { QWEN_GUARDRAILS_CONTEXT_WINDOW: "lots" })).toThrow();
  });
});

describe("plugin wiring", () => {
  const fakeClient = () => {
    const logs: string[] = [];
    return { logs, app: { log: async ({ body }: any) => { logs.push(body.message); } } };
  };
  const tokens = (total: number) => ({ total, input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

  test("appends the loop note to the sixth edit's tool output and nothing before", async () => {
    const client = fakeClient();
    const hooks: any = await plugin({ client, directory: "/work/app" });
    for (let i = 1; i <= 6; i++) {
      const output = { title: "edit", output: "ok", metadata: {} };
      await hooks["tool.execute.after"]({ tool: "edit", sessionID: "ses_a", callID: `c${i}`, args: { filePath: "E:/repo/x.py" } }, output);
      if (i < 6) expect(output.output).toBe("ok");
      else expect(output.output).toContain("[qwen-guardrails] This is edit #6 to x.py");
    }
    expect(client.logs.some((l) => l.includes('"guard":"edit-loop"'))).toBe(true);
  });

  test("reads the window from the assistant message's provider and nudges once past 50%", async () => {
    const client = fakeClient();
    const hooks: any = await plugin({ client, directory: "/work/app" });
    await hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "ses_b", providerID: "vllm", modelID: "qwen-coder", tokens: tokens(140000) } } } });
    const out1 = { title: "bash", output: "done", metadata: {} };
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_b", callID: "c1", args: { command: "pytest" } }, out1);
    expect(out1.output).toContain("[qwen-guardrails] Context is at 53%");
    const out2 = { title: "bash", output: "done", metadata: {} };
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_b", callID: "c2", args: { command: "pytest" } }, out2);
    expect(out2.output).toBe("done");
  });

  test("after a compaction, states the real size once, only when a post-compaction size exists", async () => {
    const client = fakeClient();
    const hooks: any = await plugin({ client, directory: "/work/app" });
    const upd = (n: number) => hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "ses_k", providerID: "vllm", modelID: "qwen-coder", tokens: tokens(n) } } } });
    const call = async (id: string) => { const o = { title: "bash", output: "done", metadata: {} }; await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_k", callID: id, args: { command: "git status" } }, o); return o.output; };
    await upd(184000);                         // 70%: the checkpoint note fires here
    expect(await call("c1")).toContain("Context is at 70%");
    await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ses_k" } } });
    expect(await call("c2")).toBe("done");     // no post-compaction size yet: say nothing rather than a stale number
    await upd(106000);                         // the first step after compaction reports the real size
    const out = await call("c3");
    expect(out).toContain("OpenCode compacted this session. Context is now at 40%");
    expect(out).toContain("do not end the turn for context reasons");
    expect(await call("c4")).toBe("done");     // said once
    await upd(140000);                         // stages re-armed: the 50% note speaks again on the next climb
    expect(await call("c5")).toContain("Context is at 53%");
  });

  test("a 30% token drop with no compaction event is treated as a compaction", async () => {
    const client = fakeClient();
    const hooks: any = await plugin({ client, directory: "/work/app" });
    const upd = (n: number) => hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "ses_d", providerID: "vllm", modelID: "qwen-coder", tokens: tokens(n) } } } });
    const call = async (id: string) => { const o = { title: "bash", output: "done", metadata: {} }; await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_d", callID: id, args: { command: "git status" } }, o); return o.output; };
    await upd(184000);
    expect(await call("c1")).toContain("Context is at 70%");
    await upd(106000);                         // OpenCode compacted without telling us
    const out = await call("c2");
    expect(out).toContain("OpenCode compacted this session. Context is now at 40%");
    expect(out).not.toContain("Compaction is near");
    expect(await call("c3")).toBe("done");
  });

  test("leaves other providers and other sessions alone", async () => {
    const client = fakeClient();
    const hooks: any = await plugin({ client, directory: "/tmp" });
    await hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "ses_c", providerID: "anthropic", modelID: "claude", tokens: tokens(250000) } } } });
    const out = { title: "bash", output: "done", metadata: {} };
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_c", callID: "c1", args: {} }, out);
    expect(out.output).toBe("done");
    const other = { title: "bash", output: "done", metadata: {} };
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_d", callID: "c1", args: {} }, other);
    expect(other.output).toBe("done");
  });

  test("ignores tool results that are not text and user messages", async () => {
    const hooks: any = await plugin({ client: fakeClient(), directory: "/tmp" });
    await hooks.event({ event: { type: "message.updated", properties: { info: { role: "user", sessionID: "ses_e" } } } });
    const out = { title: "edit", output: undefined as any, metadata: {} };
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: "ses_e", callID: "c1", args: { filePath: "a" } }, out);
    expect(out.output).toBeUndefined();
  });
});

describe("repeat guard", () => {
  const args = { command: 'rg -ln "collect_rows|row_roster|report_roster" tests | Select-Object -First 5', timeout: 60000, workdir: "C:/work/app/backend" };

  test("notes the third and sixth identical call, refuses from the eighth, aborts at the fifteenth", () => {
    const s = newState();
    const spoken: number[] = [];
    const refused: number[] = [];
    const aborted: number[] = [];
    for (let i = 1; i <= 16; i++) {
      const r = recordCall(s, "bash", args);
      expect(r.count).toBe(i);
      if (r.note) spoken.push(i);
      if (r.refuse) refused.push(i);
      if (r.abort) aborted.push(i);
    }
    expect(spoken).toEqual([3, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(refused[0]).toBe(REPEAT_REFUSE_AT);
    expect(aborted[0]).toBe(REPEAT_ABORT_AT);
    expect(REPEAT_NOTE_AT).toBeLessThan(REPEAT_REFUSE_AT);
  });

  test("a different call resets the count and argument key order does not matter", () => {
    const s = newState();
    recordCall(s, "bash", args);
    recordCall(s, "bash", { workdir: args.workdir, timeout: 60000, command: args.command });
    expect(s.lastCall!.count).toBe(2);
    expect(recordCall(s, "bash", { ...args, command: "git status" }).count).toBe(1);
    expect(recordCall(s, "read", { filePath: "a.py" }).count).toBe(1);
    expect(recordCall(s, "bash", args).count).toBe(1);
  });

  test("the note names the tool, says the last results were identical, and asks for a different step", () => {
    const s = newState();
    let r = recordCall(s, "bash", args);
    for (let i = 0; i < 2; i++) r = recordCall(s, "bash", args);
    expect(r.note).toContain("identical call #3 of bash");
    expect(r.note).toContain("last results were identical");
    expect(r.note).toContain("DIFFERENT next step");
    for (let i = 0; i < 5; i++) r = recordCall(s, "bash", args);
    expect(r.note).toStartWith("[qwen-guardrails] REFUSED");
  });
});

describe("repeat guard through the plugin hooks", () => {
  test("appends the note after the third call and throws on the eighth", async () => {
    const hooks: any = await plugin({ client: { app: { log: async () => {} } }, directory: "E:/x" });
    const input = { sessionID: "ses_repeat", tool: "bash", callID: "c" };
    const args = { command: "rg -l nothing tests" };
    let out: any;
    for (let i = 1; i <= 7; i++) {
      await hooks["tool.execute.before"](input, { args });
      out = { output: "(no output)" };
      await hooks["tool.execute.after"](input, out);
      if (i === 3 || i === 6) expect(out.output).toContain(`identical call #${i}`);
      else expect(out.output).toBe("(no output)");
    }
    await expect(hooks["tool.execute.before"](input, { args })).rejects.toThrow(/REFUSED: this would be consecutive identical call #8/);
  });
});

describe("command bounds", () => {
  test("caps a timeout above the cap and leaves smaller ones alone", () => {
    expect(boundCommand({ command: "git status", timeout: 3_600_000 }).timeoutMs).toBe(BASH_TIMEOUT_CAP_MS);
    expect(boundCommand({ command: "git status", timeout: 60_000 }).timeoutMs).toBeNull();
    expect(boundCommand({ command: "git status" }).timeoutMs).toBeNull();
  });

  test("refuses pytest with no test path and no list variable, allows explicit paths", () => {
    expect(boundCommand({ command: "py -3.12 -m pytest -n auto -p no:cacheprovider -q" }).refuse).toContain("REFUSED");
    expect(boundCommand({ command: "pytest" }).refuse).toContain("REFUSED");
    expect(boundCommand({ command: "py -3.12 -m pytest tests/test_notifications.py -n auto -q" }).refuse).toBeNull();
    expect(boundCommand({ command: "py -3.12 -m pytest -k twin -q" }).refuse).toBeNull();
    expect(boundCommand({ command: "rg -n pytest tests" }).refuse).toBeNull();
    // 2026-09-11 23:10 EDT: the three shapes a reviewer session was wrongly refused on.
    expect(boundCommand({ command: 'py -3.12 -m pytest "C:/Users/x/Temp/opencode/exp_append.py" -s -x -q --basetemp="C:/t" 2>&1 | Select-Object -Last 15' }).refuse).toBeNull();
    expect(boundCommand({ command: 'Move-Item -LiteralPath "a.py" -Destination "b.py" -Force; py -3.12 -m pytest "C:/Users/x/Temp/opencode/test_exp_append.py" -s -x -q 2>&1 | Select-Object -Last 20' }).refuse).toBeNull();
    const single = boundCommand({ command: 'py -3.12 -m pytest $f -s -x -q --basetemp="C:/t" 2>&1 | Select-Object -Last 15' });
    expect(single.refuse).toBeNull();
    expect(single.note).toContain("variable");
    expect(boundCommand({ command: "py -3.12 -m pytest tests -q" }).refuse).toBeNull();
    expect(boundCommand({ command: "py -3.12 -m pytest backend/tests/test_x.py::test_y -q" }).refuse).toBeNull();
    // Still refused: a pytest whose own arguments name nothing, even when the rest of the line mentions a test file.
    expect(boundCommand({ command: 'Copy-Item "tests/test_a.py" "x.py"; py -3.12 -m pytest -n auto -q' }).refuse).toContain("REFUSED");
  });

  test("a list-variable pytest is allowed but carries the count note", () => {
    const v = boundCommand({ command: "$files = Get-Content x.txt; py -3.12 -m pytest @files -n auto -q" });
    expect(v.refuse).toBeNull();
    expect(v.note).toContain("greater than zero");
  });
});

describe("WF-03 result-aware repeat guard", () => {
  test("twenty identical calls with CHANGING results are never refused or aborted", () => {
    const s = newState(null);
    const args = { command: "git -C wt status --short", workdir: "wt" };
    for (let i = 1; i <= 20; i++) {
      const r = recordCall(s, "bash", args);
      expect(r.refuse).toBe(false); expect(r.abort).toBe(false);
      recordResult(s, "bash", args, "M file" + i);
    }
  });
  test("identical calls with IDENTICAL results still refuse at the eighth and abort at the fifteenth", () => {
    const s = newState(null);
    const args = { command: "rg -n needle src" };
    const refusedAt: number[] = []; const abortedAt: number[] = [];
    for (let i = 1; i <= 15; i++) { const r = recordCall(s, "bash", args); if (r.refuse) refusedAt.push(i); if (r.abort) abortedAt.push(i); recordResult(s, "bash", args, "(no output)"); }
    expect(refusedAt[0]).toBe(REPEAT_REFUSE_AT); expect(abortedAt[0]).toBe(REPEAT_ABORT_AT);
  });
  test("a run of identical results followed by a change resets the count", () => {
    const s = newState(null); const args = { command: "cat build.log" };
    for (let i = 1; i <= 7; i++) { recordCall(s, "bash", args); recordResult(s, "bash", args, "same"); }
    recordResult(s, "bash", args, "different"); 
    expect(recordCall(s, "bash", args).refuse).toBe(false);
  });
});

describe("graphify dependency-analysis nudge (owner 2026-09-13)", () => {
  const edit = (s: any, f: string) => graphifyNudge(s, "edit", { filePath: f });
  test("a second distinct backend module edited without a verb call nudges once, naming both targets", () => {
    const s = newState();
    expect(edit(s, "C:\\Temp\\wt-1\\backend\\services\\coverage.py")).toBeNull();
    expect(edit(s, "C:\\Temp\\wt-1\\backend\\services\\coverage.py")).toBeNull();
    expect(edit(s, "C:\\Temp\\wt-1\\backend\\tests\\test_coverage.py")).toBeNull();
    const note = edit(s, "C:\\Temp\\wt-1\\backend\\services\\export.py");
    expect(note).toContain("code-graph_graphify_affected");
    expect(note).toContain('{"target": "coverage.py"}');
    expect(note).toContain('{"target": "export.py"}');
    expect(edit(s, "C:\\Temp\\wt-1\\backend\\tasks.py")).toBeNull();
  });
  test("a verb call marks its target analysed; analysed modules never count again, unanalysed ones do", () => {
    const s = newState();
    edit(s, "/e/wt/backend/a.py");
    expect(graphifyNudge(s, "code-graph_explain_module", { target: "a.py" })).toBeNull();
    expect(s.graphify.verbs).toBe(1);
    expect(s.graphify.modulesSinceVerb.size).toBe(0);
    expect(edit(s, "/e/wt/backend/b.py")).toBeNull();
    for (let i = 0; i < 20; i++) expect(edit(s, "/e/wt/backend/a.py")).toBeNull();
    expect(edit(s, "/e/wt/backend/services/c.py")).not.toBeNull();
    graphifyNudge(s, "code-graph_graphify_affected", { target: "b.py" });
    graphifyNudge(s, "other-server_graphify_affected", { target: "c.py" });
    expect(s.graphify.modulesSinceVerb.size).toBe(0);
  });
  test("the nudge names function targets as name() and flags base-app modules as uncovered", () => {
    const s = newState();
    edit(s, "/e/wt/backend/batch_db_operations.py");
    const note = edit(s, "/e/wt/backend/services/coverage.py") as string;
    expect(note).toContain('"advance_coverage()"');
    expect(note).toContain("batch_db_operations.py) are in no graph profile");
  });
  test("the nudge repeats only after GRAPHIFY_NUDGE_EVERY further tool calls", () => {
    const s = newState();
    edit(s, "/e/wt/backend/a.py");
    expect(edit(s, "/e/wt/backend/b.py")).not.toBeNull();
    let notes = 0;
    for (let i = 0; i < GRAPHIFY_NUDGE_EVERY - 1; i++) if (graphifyNudge(s, "read", { filePath: "x" })) notes++;
    expect(notes).toBe(0);
    expect(graphifyNudge(s, "read", { filePath: "x" })).not.toBeNull();
  });
  test("delegating a mapping to explore before any verb call nudges; after a verb call it does not", () => {
    const s = newState();
    expect(graphifyNudge(s, "task", { subagent_type: "explore", description: "map" })).toContain("before delegating");
    for (let i = 0; i < GRAPHIFY_NUDGE_EVERY; i++) graphifyNudge(s, "read", {});
    graphifyNudge(s, "code-graph_graphify_affected", { target: "a.py" });
    expect(graphifyNudge(s, "task", { subagent_type: "explore" })).toBeNull();
  });
  test("backendModuleOf ignores tests, scripts and non-python files", () => {
    expect(backendModuleOf("E:\\x\\backend\\services\\repositories\\exports.py")).toBe("services/repositories/exports.py");
    expect(backendModuleOf("E:\\x\\backend\\tests\\test_a.py")).toBeNull();
    expect(backendModuleOf("E:\\x\\backend\\scripts\\run.py")).toBeNull();
    expect(backendModuleOf("E:\\x\\frontend\\src\\a.ts")).toBeNull();
    expect(backendModuleOf("E:\\x\\backend\\alembic\\versions\\m.py")).toBe("alembic/versions/m.py");
  });
});

describe("gh --jq string building is refused in PowerShell (owner 2026-09-13)", () => {
  test("a bare field path is allowed", () => {
    expect(ghJqVerdict('gh pr view 1831 --repo o/r --json state --jq ".state"')).toBeNull();
    expect(ghJqVerdict("gh pr view 1831 --json state --jq .state")).toBeNull();
    expect(ghJqVerdict("gh run list --json databaseId --jq '.[0].databaseId'")).toBeNull();
  });
  test("string concatenation, pipes and filters are refused with the ConvertFrom-Json form", () => {
    const v = ghJqVerdict('gh pr view 1831 --json state,mergedAt --jq ".state + \\" \\" + (.mergedAt|tostring)"');
    expect(v).toContain("ConvertFrom-Json");
    expect(ghJqVerdict("gh pr list --json number --jq '.[] | select(.number > 3)'")).not.toBeNull();
    expect(ghJqVerdict("gh pr view 1 --json title --jq '.title | ascii_upcase'")).not.toBeNull();
  });
  test("commands without gh or without --jq pass", () => {
    expect(ghJqVerdict("git status")).toBeNull();
    expect(ghJqVerdict("gh pr view 1 --json state")).toBeNull();
  });
});

describe("waiting on CI or the judge is refused (owner 2026-09-13)", () => {
  test("long sleeps are refused, short ones pass", () => {
    expect(waitVerdict("Start-Sleep -Seconds 240")).toContain("never waits");
    expect(waitVerdict("cd x; sleep 60; git status")).not.toBeNull();
    expect(waitVerdict("Start-Sleep -Seconds 5")).toBeNull();
    expect(waitVerdict("sleep 2 && echo ok")).toBeNull();
  });
  test("CI and run polling is refused", () => {
    expect(waitVerdict("gh pr checks 1833 --repo o/r")).toContain("judge's job");
    expect(waitVerdict("gh run watch 123")).not.toBeNull();
    expect(waitVerdict("gh run list --branch x --limit 1")).not.toBeNull();
    expect(waitVerdict("gh api repos/o/r/actions/runs/1/jobs")).not.toBeNull();
  });
  test("ordinary gh and git commands pass", () => {
    expect(waitVerdict("gh pr view 1833 --json state")).toBeNull();
    expect(waitVerdict("gh pr create --base main")).toBeNull();
    expect(waitVerdict("gh api repos/o/r/pulls/1833/comments")).toBeNull();
    expect(waitVerdict("git fetch origin")).toBeNull();
  });
});
