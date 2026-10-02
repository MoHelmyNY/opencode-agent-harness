// bun test tests/project-memory.test.ts
//
// A fake gateway on a random port stands in for the real service (the contract is fixed). Nothing here touches the
// network beyond loopback, the real config or the real PROJECT_MEMORY_TOKEN.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// Several tests spawn real `git` processes (temp repos, or `git rev-parse` during config resolution). Where process
// start is slow (one measured Windows box: `git init` 2.9 s, `git add` 4.8 s) a test outlives bun's 5 s default, so the
// per-test budget is raised. Logic is unaffected; only the wall-clock allowance changes.
setDefaultTimeout(60_000);

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "project-memory-state-"));
// A distinctive value: the last assertion greps the whole receipt file for it.
const TEST_TOKEN = "pm-test-token-not-a-secret-0001";
process.env.PROJECT_MEMORY_TEST_TOKEN = TEST_TOKEN;

import plugin from "../plugins/project-memory.ts";
import { commitSha, hasSecret, isSelfEvent, observationStatus, statPaths } from "../guardrails/project-memory-core.ts";

const stateDir = join(process.env.XDG_STATE_HOME!, "opencode");
const receiptFile = join(stateDir, "project-memory.jsonl");
const receipts = () =>
  existsSync(receiptFile) ? readFileSync(receiptFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const kinds = (sessionID: string, kind?: string) =>
  receipts().filter((r) => r.sessionID === sessionID && (!kind || r.kind === kind));

// ---------------------------------------------------------------------------------------------------------------
// Fake gateway. Records every request; the Authorization header is kept in memory only and never written anywhere
// a receipt could read it.
type Call = { route: string; body: any; auth: string | null };
function gateway(handler?: (route: string, body: any) => Response | null) {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname.replace("/v1/adapter/", "");
      const body = await request.json().catch(() => ({}));
      calls.push({ route, body, auth: request.headers.get("authorization") });
      const custom = handler?.(route, body);
      if (custom) return custom;
      if (route === "bootstrap")
        return Response.json({
          project_id: "app", task_id: body.task_id, receipt_id: "rcpt-boot-1", status: "ok",
          verified: [{ claim_id: "c1", revision: 3, claim_text: "the judge lands PRs by merge-into-head", evidence_refs: ["#1840"], created_at: "2026-09-15T00:00:00Z", tier: "verified", verified: true }],
          // Each observation RECORD now carries a fact_count; the headline count stays the number of records.
          observations: [
            { text: "lane A runs at most three local test runs per ticket", type: "process", when: "2026-09-12", tags: ["lane"], document_id: "d1", tier: "observation", verified: false, fact_count: 3 },
            { text: "CI cancels superseded runs each tick", type: "process", when: "2026-09-12", tags: ["ci"], document_id: "d2", tier: "observation", verified: false, fact_count: 1 },
          ],
          observations_degraded: false,
          briefing_text: "# Project memory\n\n- VERIFIED: the judge lands PRs by merge-into-head.\n- observation: three local test runs per ticket.",
        });
      if (route === "checkpoint") return Response.json({ receipt_id: "rcpt-chk-1", retained_document_id: "doc-9", observations_degraded: false, observation_status: "retained" });
      if (route === "finish") return Response.json({ receipt_id: "rcpt-fin-1", retained_document_id: "doc-10", observations_degraded: false, observation_status: "accepted-pending" });
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { server, calls, url: `http://127.0.0.1:${server.port}` };
}
const servers: any[] = [];
afterAll(() => { for (const s of servers) { try { s.stop(true); } catch {} } });

const DIR = "/work/app";
const SLUG = "work-app";

/** Writes a config for this test and returns its path; every test gets its own so they cannot interfere. */
function configFor(url: string, { enabled = true, slug = SLUG }: { enabled?: boolean; slug?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "project-memory-config-"));
  const file = join(home, "project-memory.json");
  writeFileSync(file, JSON.stringify({
    schema_version: 1, gateway_url: url, token_env: "PROJECT_MEMORY_TEST_TOKEN",
    directories: { [slug]: { enabled, project_id: "app" } },
    capture: { on_commit: true, on_verify_receipt: true, on_session_end: true, max_note_chars: 2000 },
    briefing: { max_chars: 6000 },
  }));
  return file;
}

function harness(url: string, options: { enabled?: boolean; slug?: string; assistant?: string; todos?: any[]; children?: string[] } = {}) {
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "start" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: options.assistant ?? "Landed #1902: the fixture now reads the canonical head." }] },
  ];
  const children = new Set(options.children ?? []);
  const client = {
    session: {
      get: async ({ path }: any) => ({ data: { id: path.id, parentID: children.has(path.id) ? "ses_parent" : null } }),
      messages: async () => ({ data: messages }),
      todo: async () => ({ data: options.todos ?? [] }),
    },
    tui: { showToast: async () => {} },
    app: { log: async () => {} },
  };
  process.env.PROJECT_MEMORY_CONFIG = configFor(url, options);
  return { client, messages };
}

const load = async (client: any, directory = DIR) => (await plugin({ client, directory })) as any;
const firstMessage = (hooks: any, sessionID: string, text = "fix the enrichment fixture drift on #1902") =>
  hooks["chat.message"]({ sessionID }, { message: { id: "msg1", role: "user" }, parts: [{ type: "text", text }] });
const systemBlock = async (hooks: any, sessionID: string) => {
  const output = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]({ sessionID, model: {} }, output);
  return output.system;
};
const idle = (hooks: any, sessionID: string) =>
  hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } });
const bash = (hooks: any, sessionID: string, command: string, out: string) =>
  hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: "c" + Math.random(), args: { command } }, { title: "bash", output: out, metadata: {} });

/** A temp git repo with one commit already in it, so the plugin's `git show HEAD` has something real to read. */
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "project-memory-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q");
  mkdirSync(join(root, "backend"), { recursive: true });
  writeFileSync(join(root, "backend", "fixture.py"), "x = 1\n");
  writeFileSync(join(root, "README.md"), "one\n");
  git("add", "-A");
  return { root, git };
}

// ---------------------------------------------------------------------------------------------------------------

describe("project-memory pure helpers", () => {
  test("survive being called with the plugin input (OpenCode calls every export as a plugin factory)", () => {
    const pluginInput = { client: {}, directory: DIR, project: {}, worktree: DIR } as any;
    expect(() => hasSecret(pluginInput)).not.toThrow();
    expect(() => isSelfEvent(pluginInput)).not.toThrow();
    expect(() => commitSha(pluginInput)).not.toThrow();
    expect(() => statPaths(pluginInput)).not.toThrow();
    expect(() => observationStatus(pluginInput)).not.toThrow();
    expect(hasSecret("api_key: FAKE-NOT-A-REAL-KEY-0000")).toBe(true);
    expect(hasSecret("commit in lane: fix the token bucket")).toBe(false);
    expect(isSelfEvent("curl /v1/adapter/checkpoint")).toBe(true);
    expect(commitSha("[qwen/fix-1902 0a1b2c3] fix the fixture")).toBe("0a1b2c3");
    expect(statPaths(" backend/a.py | 2 +-\n old.py => new.py | 4 ++--\n")).toEqual(["backend/a.py", "new.py"]);
  });
});

describe("project-memory briefing", () => {
  test("bootstraps once and pushes a BYTE-IDENTICAL system block on three consecutive requests", async () => {
    const g = gateway();
    const h = harness(g.url);
    const hooks = await load(h.client);
    await firstMessage(hooks, "ses_brief");

    const a = await systemBlock(hooks, "ses_brief");
    const b = await systemBlock(hooks, "ses_brief");
    const c = await systemBlock(hooks, "ses_brief");
    expect(a).toHaveLength(1);
    expect(a[0]).toStartWith('<project-memory session="ses_brief">');
    expect(a[0]).toEndWith("</project-memory>");
    expect(a[0]).toContain("VERIFIED: the judge lands PRs by merge-into-head");
    expect(b[0]).toBe(a[0]);                                  // same bytes, so the engine's prefix cache holds
    expect(c[0]).toBe(a[0]);
    expect(Buffer.byteLength(b[0])).toBe(Buffer.byteLength(a[0]));

    expect(g.calls.filter((k) => k.route === "bootstrap")).toHaveLength(1);   // fetched ONCE, never re-fetched
    expect(g.calls[0].body).toMatchObject({ task_id: "ses_brief", paths: [] });
    expect(g.calls[0].body.task_summary).toBe("fix the enrichment fixture drift on #1902");
    expect(g.calls[0].auth).toBe(`Bearer ${TEST_TOKEN}`);      // the header IS sent...
    expect(readFileSync(join(stateDir, "project-memory", "ses_brief.briefing.md"), "utf8")).toContain("Project memory");
    // Two RECORDS holding four facts: the headline count (and the toast) is records, facts are recorded beside it.
    expect(kinds("ses_brief", "bootstrap")[0]).toMatchObject({ kind: "bootstrap", verified: 1, observations: 2, observation_facts: 4, receipt_id: "rcpt-boot-1" });
  });

  test("a child (subagent) session is never briefed and never finished", async () => {
    const g = gateway();
    const h = harness(g.url, { children: ["ses_child"] });
    const hooks = await load(h.client);
    await firstMessage(hooks, "ses_child");
    expect(await systemBlock(hooks, "ses_child")).toEqual([]);
    await idle(hooks, "ses_child");
    expect(g.calls).toHaveLength(0);
    expect(existsSync(join(stateDir, "project-memory", "ses_child.briefing.md"))).toBe(false);
  });

  test("a directory that is not memory-enabled gets NO hooks at all", async () => {
    const g = gateway();
    const h = harness(g.url, { enabled: false });
    const hooks = await load(h.client);
    expect(hooks).toEqual({});
    const unknown = await load(h.client, "/work/some-other-repo");
    expect(unknown).toEqual({});
  });
});

describe("project-memory capture", () => {
  test("a git commit produces exactly one checkpoint carrying the changed paths", async () => {
    const repo = gitRepo();
    const g = gateway();
    // The temp repo's own slug is what the config must enable: the plugin keys on the working directory.
    const h = harness(g.url, { slug: slugOfPath(repo.root) });
    const hooks = await load(h.client, repo.root);
    const out = repo.git("commit", "-q", "-m", "fix the enrichment fixture drift");
    const sha = repo.git("rev-parse", "--short", "HEAD");
    await bash(hooks, "ses_commit", 'git commit -m "fix the enrichment fixture drift"', `[main ${sha}] fix the enrichment fixture drift\n 2 files changed\n${out}`);

    const posted = g.calls.filter((k) => k.route === "checkpoint");
    expect(posted).toHaveLength(1);
    expect(posted[0].body.task_id).toBe("ses_commit");
    expect(posted[0].body.paths.sort()).toEqual(["README.md", "backend/fixture.py"]);
    expect(posted[0].body.note).toContain("fix the enrichment fixture drift");
    expect(posted[0].body.note).toStartWith("commit in ");
    expect(kinds("ses_commit", "checkpoint")[0]).toMatchObject({ capture: "commit", receipt_id: "rcpt-chk-1", retained_document_id: "doc-9", observation_status: "retained" });
  });

  test("a commit made in ANOTHER worktree is not recorded as this session's memory", async () => {
    // A Manager commits with `git -C <ticket worktree> commit`; that success line says nothing about this
    // directory's HEAD, and `git show HEAD` here would describe an unrelated commit.
    const repo = gitRepo();
    repo.git("commit", "-q", "-m", "one");
    const g = gateway();
    const h = harness(g.url, { slug: slugOfPath(repo.root) });
    const hooks = await load(h.client, repo.root);
    await bash(hooks, "ses_elsewhere", 'cd "../worktrees/t-1902" && git commit -m "fix over there"', "[qwen/fix-1902 9f9f9f9] fix over there");
    expect(g.calls.filter((k) => k.route === "checkpoint")).toHaveLength(0);
    expect(kinds("ses_elsewhere", "checkpoint_skipped")[0]).toMatchObject({ why: "commit_elsewhere", capture: "commit", commit: "9f9f9f9" });
  });

  test("the self-event filter blocks a call that mentions memory_bootstrap", async () => {
    const g = gateway();
    const h = harness(g.url);
    const hooks = await load(h.client);
    await bash(hooks, "ses_self", 'git commit -m "wire up memory_bootstrap in the adapter"', "[main abc1234] wire up memory_bootstrap");
    expect(g.calls).toHaveLength(0);
    expect(kinds("ses_self", "checkpoint_skipped")[0]).toMatchObject({ why: "self_event", capture: "commit" });
  });

  test("the debounce allows at most one checkpoint per 60 s per session", async () => {
    const repo = gitRepo();
    const g = gateway();
    const h = harness(g.url, { slug: slugOfPath(repo.root) });
    const hooks = await load(h.client, repo.root);
    repo.git("commit", "-q", "-m", "first");
    const one = repo.git("rev-parse", "--short", "HEAD");
    await bash(hooks, "ses_debounce", "git commit -m first", `[main ${one}] first`);
    writeFileSync(join(repo.root, "README.md"), "two\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "second");
    const two = repo.git("rev-parse", "--short", "HEAD");
    await bash(hooks, "ses_debounce", "git commit -m second", `[main ${two}] second`);

    expect(g.calls.filter((k) => k.route === "checkpoint")).toHaveLength(1);
    expect(kinds("ses_debounce", "checkpoint_skipped")[0]).toMatchObject({ why: "debounced", debounce_ms: 60000 });
  });

  test("the secret filter drops a note rather than sending it", async () => {
    const repo = gitRepo();
    const g = gateway();
    const h = harness(g.url, { slug: slugOfPath(repo.root) });
    const hooks = await load(h.client, repo.root);
    repo.git("commit", "-q", "-m", "rotate api_key: FAKE-NOT-A-REAL-KEY-0001 in the gateway policy");
    const sha = repo.git("rev-parse", "--short", "HEAD");
    await bash(hooks, "ses_secret", "git commit -F msg.txt", `[main ${sha}] rotate api_key`);
    expect(g.calls.filter((k) => k.route === "checkpoint")).toHaveLength(0);
    expect(kinds("ses_secret", "checkpoint_skipped")[0]).toMatchObject({ why: "secret_pattern", capture: "commit" });
  });

  test("a signed aw.ps1 verify receipt is captured with its label and head", async () => {
    const g = gateway();
    const h = harness(g.url);
    const hooks = await load(h.client);
    await bash(hooks, "ses_verify",
      '& ~/agent-workflow-lab/bin/aw.ps1 ticket --config c.json verify --ticket 1902 --label pytest-lane',
      '{"ok": true, "head": "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", "checks": 3}');
    const posted = g.calls.filter((k) => k.route === "checkpoint");
    expect(posted).toHaveLength(1);
    expect(posted[0].body.note).toStartWith("verified pytest-lane at head 0a1b2c3d4:");
    expect(posted[0].body.paths).toEqual([]);
    expect(kinds("ses_verify", "checkpoint")[0]).toMatchObject({ capture: "verify" });
  });

  test("a verify receipt that names no head falls back to the session directory's HEAD", async () => {
    const repo = gitRepo();
    repo.git("commit", "-q", "-m", "one");
    const g = gateway();
    const h = harness(g.url, { slug: slugOfPath(repo.root) });
    const hooks = await load(h.client, repo.root);
    await bash(hooks, "ses_verify_head", "pwsh -File aw.ps1 ticket verify --ticket 1902", "RESULT:passed (3 checks)");
    const posted = g.calls.filter((k) => k.route === "checkpoint");
    expect(posted).toHaveLength(1);
    expect(posted[0].body.note).toBe(`verified ticket 1902 at head ${repo.git("rev-parse", "HEAD").slice(0, 9)}: RESULT:passed (3 checks)`);
  });
});

describe("project-memory finish", () => {
  test("finishes exactly once on idle with the last assistant turn as the summary, and a later message re-arms it", async () => {
    const g = gateway();
    const h = harness(g.url, { assistant: "Landed #1902 at d5fbab202; 12/12 green.", todos: [{ content: "#1902 fixture", status: "completed" }] });
    const hooks = await load(h.client);
    await firstMessage(hooks, "ses_finish");
    await idle(hooks, "ses_finish");
    await idle(hooks, "ses_finish");                       // both idle event names fire for one idle: still one finish
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_finish" } } });

    let posted = g.calls.filter((k) => k.route === "finish");
    expect(posted).toHaveLength(1);
    expect(posted[0].body.task_id).toBe("ses_finish");
    expect(posted[0].body.note).toBe("session summary: Landed #1902 at d5fbab202; 12/12 green.");
    expect(kinds("ses_finish", "finish")[0]).toMatchObject({ why: "idle_no_actionable_todo", receipt_id: "rcpt-fin-1", observation_status: "accepted-pending" });

    await hooks.event({ event: { type: "message.updated", properties: { info: { id: "m2", role: "user", sessionID: "ses_finish" } } } });
    await idle(hooks, "ses_finish");                       // re-armed by the owner's next message
    posted = g.calls.filter((k) => k.route === "finish");
    expect(posted).toHaveLength(2);
  });

  test("an idle session that still has actionable todos does not finish", async () => {
    const g = gateway();
    const h = harness(g.url, { todos: [{ content: "#1902 fixture", status: "in_progress" }] });
    const hooks = await load(h.client);
    await firstMessage(hooks, "ses_open");
    await idle(hooks, "ses_open");
    expect(g.calls.filter((k) => k.route === "finish")).toHaveLength(0);
  });

  test("a session that keeps NO todo list does not finish on every turn", async () => {
    // The gateway checkout is memory-enabled but is an ordinary dev directory: an empty list means "this session is
    // not using todos", not "the work is done". Finishing there would post a finish after every single turn.
    const g = gateway();
    const h = harness(g.url, { todos: [], slug: "work-memory-gateway" });
    const hooks = await load(h.client, "/work/memory-gateway");
    await firstMessage(hooks, "ses_notodos");
    await idle(hooks, "ses_notodos");
    await idle(hooks, "ses_notodos");
    expect(g.calls.filter((k) => k.route === "finish")).toHaveLength(0);
  });

  test("a re-emitted update of the SAME user message does not re-arm a finished session", async () => {
    // OpenCode touches one user message several times during and after a turn; without the id guard the second idle
    // would post a second finish for one turn.
    const g = gateway();
    const h = harness(g.url, { todos: [{ content: "#1902", status: "completed" }] });
    const hooks = await load(h.client);
    await hooks["chat.message"]({ sessionID: "ses_dedupe", messageID: "msg1" }, { message: { id: "msg1", role: "user" }, parts: [{ type: "text", text: "go" }] });
    await idle(hooks, "ses_dedupe");
    expect(g.calls.filter((k) => k.route === "finish")).toHaveLength(1);
    const touch = (id: string) => hooks.event({ event: { type: "message.updated", properties: { info: { id, role: "user", sessionID: "ses_dedupe" } } } });
    await touch("msg1");                                   // the same message, re-emitted
    await idle(hooks, "ses_dedupe");
    expect(g.calls.filter((k) => k.route === "finish")).toHaveLength(1);
    await touch("msg2");                                   // a genuinely new message re-arms
    await idle(hooks, "ses_dedupe");
    expect(g.calls.filter((k) => k.route === "finish")).toHaveLength(2);
  });
});

describe("project-memory unavailability", () => {
  test("a 401 writes an `unavailable` receipt, adds nothing to the system prompt and throws nothing", async () => {
    const g = gateway((route) => (route === "bootstrap" ? new Response("no", { status: 401 }) : null));
    const h = harness(g.url);
    const hooks = await load(h.client);
    await firstMessage(hooks, "ses_401");
    expect(await systemBlock(hooks, "ses_401")).toEqual([]);
    expect(kinds("ses_401", "unavailable")[0]).toMatchObject({ route: "bootstrap", status: 401, why: "not_authorized" });
    expect(kinds("ses_401", "bootstrap_failed")).toHaveLength(1);
    // The empty sentinel keeps a plugin reload from injecting a block mid-session.
    expect(readFileSync(join(stateDir, "project-memory", "ses_401.briefing.md"), "utf8")).toBe("");
    const reloaded = await load(h.client);
    await firstMessage(reloaded, "ses_401");
    expect(await systemBlock(reloaded, "ses_401")).toEqual([]);
  });

  test("a connection refusal writes an `unavailable` receipt and throws nothing", async () => {
    const repo = gitRepo();
    repo.git("commit", "-q", "-m", "one");
    const dead = gateway();
    const url = dead.url;
    dead.server.stop(true);                                // nothing is listening on that port any more
    const h = harness(url, { slug: slugOfPath(repo.root) });
    const hooks = await load(h.client, repo.root);
    await firstMessage(hooks, "ses_refused");
    expect(await systemBlock(hooks, "ses_refused")).toEqual([]);
    const sha = repo.git("rev-parse", "--short", "HEAD");
    await bash(hooks, "ses_refused", "git commit -m x", `[main ${sha}] one`);  // capture must not throw either
    const unavailable = kinds("ses_refused", "unavailable");
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
    expect(unavailable[0].route).toBe("bootstrap");
    expect(String(unavailable[0].why)).toStartWith("request_failed:");
    // The receipt names the deadline that applied, and the two defaults differ: 8 s on the first turn's critical
    // path, 60 s for a write that runs after the tool result (a real retain takes ~24 s).
    expect(unavailable[0].timeout_ms).toBe(8000);
    expect(unavailable.find((r) => r.route === "checkpoint").timeout_ms).toBe(60000);
  });

  test("the write timeout is separate from the bootstrap one: a slow retain completes, a slow bootstrap does not", async () => {
    // Live defect 2026-09-16: one checkpoint was aborted at 8 s and logged `unavailable request_failed:TimeoutError`
    // while the gateway had stored the note anyway, so the receipt lied. bootstrap keeps the short deadline because
    // chat.message and the system transform both await it; checkpoint and finish never block the model.
    const repo = gitRepo();
    repo.git("commit", "-q", "-m", "one");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const route = new URL(request.url).pathname.replace("/v1/adapter/", "");
        await request.json().catch(() => ({}));
        await Bun.sleep(300);                               // longer than the bootstrap deadline, well under the write one
        if (route === "checkpoint") return Response.json({ receipt_id: "rcpt-slow", retained_document_id: "doc-slow", observation_status: "retained" });
        return Response.json({ briefing_text: "late", verified: [], observations: [] });
      },
    });
    servers.push(server);
    process.env.PROJECT_MEMORY_TIMEOUT_MS = "50";           // bootstrap: aborts
    process.env.PROJECT_MEMORY_WRITE_TIMEOUT_MS = "3000";   // checkpoint: waits
    try {
      const h = harness(`http://127.0.0.1:${server.port}`, { slug: slugOfPath(repo.root) });
      const hooks = await load(h.client, repo.root);
      await firstMessage(hooks, "ses_slow");
      expect(await systemBlock(hooks, "ses_slow")).toEqual([]);   // the slow bootstrap was abandoned
      expect(kinds("ses_slow", "unavailable")[0]).toMatchObject({ route: "bootstrap", why: "request_failed:TimeoutError", timeout_ms: 50 });

      const sha = repo.git("rev-parse", "--short", "HEAD");
      await bash(hooks, "ses_slow", "git commit -m one", `[main ${sha}] one`);
      expect(kinds("ses_slow", "checkpoint")[0]).toMatchObject({ capture: "commit", receipt_id: "rcpt-slow", observation_status: "retained" });
      expect(kinds("ses_slow", "unavailable").filter((r) => r.route === "checkpoint")).toHaveLength(0);
    } finally {
      delete process.env.PROJECT_MEMORY_TIMEOUT_MS;
      delete process.env.PROJECT_MEMORY_WRITE_TIMEOUT_MS;
    }
  });

  test("an observation_status the gateway does not document is recorded verbatim, and a reply without one records null", () => {
    expect(observationStatus({ observation_status: "retained" })).toBe("retained");
    expect(observationStatus({ observation_status: "accepted-pending" })).toBe("accepted-pending");
    expect(observationStatus({ observation_status: "rejected" })).toBe("rejected");
    expect(observationStatus({ observation_status: "absent" })).toBe("absent");
    expect(observationStatus({ observation_status: "queued-somewhere-new" })).toBe("queued-somewhere-new");
    expect(observationStatus({ receipt_id: "r" })).toBeNull();          // an older gateway: no field, no claim
    expect(observationStatus({ observation_status: 7 })).toBeNull();
    expect(observationStatus(undefined)).toBeNull();
  });

  test("the token never reaches a receipt", () => {
    const raw = readFileSync(receiptFile, "utf8");
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).not.toContain(TEST_TOKEN);
    expect(raw).not.toContain("Bearer ");
    expect(raw).toContain('"token_env":"PROJECT_MEMORY_TEST_TOKEN"');   // the NAME is recorded, never the value
  });
});

describe("project-memory configuration", () => {
  test("a config with no gateway_url adds no hooks (there is no default gateway address)", async () => {
    const home = mkdtempSync(join(tmpdir(), "project-memory-config-"));
    const file = join(home, "project-memory.json");
    writeFileSync(file, JSON.stringify({ schema_version: 1, token_env: "PROJECT_MEMORY_TEST_TOKEN", directories: { [SLUG]: { enabled: true } } }));
    process.env.PROJECT_MEMORY_CONFIG = file;
    expect(await plugin({ client: {}, directory: DIR })).toEqual({});
  });

  test("capture.verify_command selects which command's verify output is captured", async () => {
    const g = gateway();
    const h = harness(g.url);
    const cfg = JSON.parse(readFileSync(process.env.PROJECT_MEMORY_CONFIG!, "utf8"));
    cfg.capture.verify_command = "make\\s+verify";
    writeFileSync(process.env.PROJECT_MEMORY_CONFIG!, JSON.stringify(cfg));
    const hooks = await load(h.client);
    await bash(hooks, "ses_verify_cmd_a", "aw.ps1 ticket verify --ticket 7", '{"ok": true, "head": "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567"}');
    expect(g.calls.filter((k) => k.route === "checkpoint")).toHaveLength(0);
    await bash(hooks, "ses_verify_cmd_b", "make verify --label unit", '{"ok": true, "head": "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567"}');
    const posted = g.calls.filter((k) => k.route === "checkpoint");
    expect(posted).toHaveLength(1);
    expect(posted[0].body.note).toStartWith("verified unit at head 0a1b2c3d4:");
  });
});

/** The plugin keys a directory by loop-continuation's slug; the tests need the same function for temp repos. */
function slugOfPath(p: string): string {
  return String(p ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}
