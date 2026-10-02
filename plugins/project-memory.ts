/**
 * project-memory: automatic project memory for every OpenCode session in a memory-enabled directory, so nobody has
 * to type "use memory_bootstrap" by hand.
 *
 * The gateway is a local HTTP memory service you run yourself (its URL is the config's gateway_url; no gateway ships with
 * this plugin) with three adapter routes:
 *   POST /v1/adapter/bootstrap   {task_id, task_summary?, paths?}              -> {verified[], observations[], briefing_text, ...}
 *   POST /v1/adapter/checkpoint  {task_id, event_refs?, note?, paths?}         -> {receipt_id, retained_document_id, observations_degraded, observation_status?}
 *   POST /v1/adapter/finish      {task_id, note?, no_durable_learning_reason?, paths?}
 * Auth is `Authorization: Bearer <value of the config's token_env>` (PROJECT_MEMORY_TOKEN; OpenCode's own
 * `project_memory` MCP entry uses the same variable). ANY non-2xx, a missing token or a connection error means
 * "memory unavailable": a receipt is written, the owner is toasted once, and the session continues untouched.
 * Nothing in this plugin ever throws into a tool call or a chat turn.
 *
 * Three behaviours:
 *  1. BRIEFING, once per session. The first user message of a PRIMARY (non-child) session bootstraps with
 *     task_id = the session id, and the returned briefing_text is injected into the system prompt through
 *     `experimental.chat.system.transform` (output.system.push), wrapped as <project-memory session="...">...</project-memory>.
 *     THE BLOCK MUST BE BYTE-IDENTICAL FOR THE WHOLE SESSION. A per-request timestamp in a sibling plugin's block once
 *     froze the engine's prefix-cache hits at 51,712 tokens for a day (2026-09-11), so the text is fetched ONCE,
 *     cached in memory AND in <state>/project-memory/<sessionID>.briefing.md, and every later request reads the
 *     cached bytes. The file is the anchor, not the Map: OpenCode reloads plugins at startup while a session lives
 *     on, so a reload must not re-fetch and drop a NEW block into the middle of an existing conversation. A failed
 *     bootstrap writes an EMPTY briefing file as a sticky sentinel meaning "this session gets nothing, ever".
 *     Child sessions (subagents) get nothing at all.
 *  2. CAPTURE, bounded, on `tool.execute.after` (bash only):
 *     (a) `git commit` whose output carries git's own success line `[branch sha] subject` (the proven exit-0 signal
 *         in this repo - loop-continuation counts commits the same way, and it also guarantees `git show HEAD`
 *         reads the NEW commit): note = "commit in <slug>: <subject> <paths>", checkpoint with those paths.
 *     (b) a verify command (`capture.verify_command`, a regex, default `aw\.ps1`) whose command line also says `verify`
 *         and whose output carries `"ok": true` or `RESULT:passed`:
 *         note = "verified <label> at head <sha9>: <first 300 chars>", checkpoint with no paths.
 *     At most one checkpoint per 60 s per session. A tool call whose command OR output mentions `project_memory`,
 *     `memory_bootstrap`, `/v1/adapter/` or the gateway's port is a memory self-event and is never captured. A note
 *     matching the secret pattern is dropped rather than sent. A commit whose sha is not this directory's HEAD was
 *     made in another worktree and is skipped, never recorded here under the wrong subject and paths.
 *  3. FINISH, once per session. SIGNAL (the simplest reliable one in the plugin API): the idle event -
 *     `session.idle`, or `session.status` with status.type "idle", the pair loop-continuation already listens for. On idle the session's todo list is read through `client.session.todo`: a list that EXISTS
 *     with nothing pending or in_progress finishes immediately; open todos, or an EMPTY list (a session that does not
 *     use todos at all - finishing there would post after every single turn), arm an unref'd 10-minute timer that
 *     finishes only if no message arrived meanwhile. A genuinely new user message clears the timer and re-arms the
 *     session, so a resumed session finishes again; a re-emission of the SAME message id does not.
 *
 * Config: ~/.config/opencode/project-memory.json (PROJECT_MEMORY_CONFIG overrides the path; read per plugin load,
 * never at module scope, so a test can point it anywhere). The directory is keyed by the loop's slug (slugOf); a
 * directory with no entry, `enabled: false`, or no gateway_url gets NO hooks at all, exactly as the workflow plugins
 * do without a chain config. Receipts: one JSON line per event in <state>/project-memory.jsonl. The token is never written to a
 * receipt, a log line or a toast.
 *
 * Plugins load at OpenCode startup: editing this file needs an OpenCode restart.
 */
import * as fs from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { slugOf } from "../guardrails/agent-workflow-config.ts";
import { commitSha, hasSecret, isSelfEvent, observationStatus, statPaths } from "../guardrails/project-memory-core.ts";

// Secrets never leave this machine in a note. Owner rule and the package's own invariant ("No secrets in receipts").

export default async ({ client, directory }: any) => {
  const dir = String(directory || "");
  const home = os.homedir();
  const configPath = process.env.PROJECT_MEMORY_CONFIG || path.join(home, ".config", "opencode", "project-memory.json");
  let config: any = null;
  try {
    const raw = readFileSync(configPath, "utf8").replace(/^﻿/, "");   // PowerShell may write a BOM
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.schema_version === 1) config = parsed;
  } catch {}
  const slug = slugOf(dir);
  const entry = config?.directories?.[slug];
  // No entry or enabled !== true: this directory has no project memory and the plugin adds NO hooks.
  if (!entry || entry.enabled !== true) return {};
  // The gateway is yours to run; there is no default address. No URL, no hooks.
  if (typeof config.gateway_url !== "string" || !config.gateway_url.trim()) return {};

  const gatewayUrl = String(config.gateway_url).trim().replace(/\/+$/, "");
  const tokenEnv = String(config.token_env || "PROJECT_MEMORY_TOKEN");
  const projectID = typeof entry.project_id === "string" ? entry.project_id : null;
  const capture = config.capture || {};
  const onCommit = capture.on_commit !== false;
  const onVerify = capture.on_verify_receipt !== false;
  const onSessionEnd = capture.on_session_end !== false;
  let verifyCommand = /aw\.ps1/i;
  try { if (typeof capture.verify_command === "string" && capture.verify_command) verifyCommand = new RegExp(capture.verify_command, "i"); } catch {}
  const MAX_NOTE = Math.min(Number(capture.max_note_chars ?? 2000) || 2000, 4000);   // the route's own cap is 4000
  const MAX_BRIEFING = Math.min(Number(config.briefing?.max_chars ?? 6000) || 6000, 6000);
  const DEBOUNCE_MS = Number(process.env.PROJECT_MEMORY_DEBOUNCE_MS ?? 60000);       // one checkpoint per session per minute
  const IDLE_FINISH_MS = Number(process.env.PROJECT_MEMORY_IDLE_FINISH_MS ?? 600000); // 10 minutes of no message
  // Two timeouts, because the two kinds of call have opposite deadlines (live receipts, 2026-09-16).
  // bootstrap sits on the FIRST TURN'S CRITICAL PATH - chat.message awaits it and the system transform awaits it too
  // - so it stays short. checkpoint and finish run after a tool result and never block the model, and a real retain
  // takes about 24 s while the memory backend runs its extraction: at 8 s one was aborted, recorded as
  // `unavailable request_failed:TimeoutError`, and the gateway had stored the note anyway, so the receipt lied.
  const TIMEOUT_MS = Number(process.env.PROJECT_MEMORY_TIMEOUT_MS ?? 8000);           // bootstrap only
  const WRITE_TIMEOUT_MS = Number(process.env.PROJECT_MEMORY_WRITE_TIMEOUT_MS ?? 60000); // checkpoint and finish
  const timeoutFor = (route: string) => (route === "bootstrap" ? TIMEOUT_MS : WRITE_TIMEOUT_MS);
  let gatewayPort = "";
  try { gatewayPort = new URL(gatewayUrl).port; } catch {}

  const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "opencode");
  const receiptFile = path.join(stateDir, "project-memory.jsonl");
  const briefingDir = path.join(stateDir, "project-memory");
  const briefingFile = (id: string) => path.join(briefingDir, `${encodeURIComponent(id)}.briefing.md`);

  // Every client.* call is an HTTP round trip to the OpenCode server and may never settle during bootstrap
  // (seen 2026-09-13): fire and forget, rejection swallowed.
  const detached = (promise: unknown) => { void Promise.resolve(promise).catch(() => {}); };
  const receipt = async (record: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), directory: dir, project_id: projectID, ...record });
    try { detached(client?.app?.log?.({ body: { service: "project-memory", level: "info", message: line } })); } catch {}
    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.appendFile(receiptFile, line + "\n", { mode: 0o600 });
    } catch {}
  };
  const toast = (message: string, warning = false) => {
    try { detached(client?.tui?.showToast?.({ query: { directory: dir }, body: { title: "Project memory", message, variant: warning ? "warning" : "info", duration: 10000 } })); } catch {}
  };

  type MemState = {
    child: boolean;            // a subagent session: never briefed, never finished
    started: boolean;          // bootstrap has been attempted for this session
    block: string | null;      // the exact bytes pushed into the system prompt, or null for "nothing, ever"
    pending: Promise<void> | null;
    lastCheckpointAt: number;
    finished: boolean;
    finishTimer: any;
    lastMessageAt: number;
    userIDs: Set<string>;      // OpenCode re-emits message.updated for the SAME user message during and after a turn
    unavailableToasted: boolean;
  };
  const sessions = new Map<string, MemState>();
  const state = (id: string): MemState => {
    let s = sessions.get(id);
    if (!s) { s = { child: false, started: false, block: null, pending: null, lastCheckpointAt: 0, finished: false, finishTimer: null, lastMessageAt: 0, userIDs: new Set(), unavailableToasted: false }; sessions.set(id, s); }
    return s;
  };

  /**
   * POST one adapter route. Returns the parsed body, or null for "memory unavailable" (missing token, non-2xx,
   * connection refused, timeout, unparseable body) after writing an `unavailable` receipt. NEVER throws and NEVER
   * records the token: only the route, the status and a short reason reach the receipt.
   */
  async function post(route: string, body: Record<string, unknown>, sessionID: string): Promise<any | null> {
    const unavailable = async (why: string, status: number | null = null) => {
      // timeout_ms is on the receipt so a future "it timed out" can be told from "it was never sent".
      await receipt({ sessionID, kind: "unavailable", route, status, why, timeout_ms: timeoutFor(route) });
      const s = state(sessionID);
      if (!s.unavailableToasted) { s.unavailableToasted = true; toast(`Memory unavailable (${route}: ${why}); the session continues without it`, true); }
      return null;
    };
    const token = process.env[tokenEnv];
    if (!token) return unavailable("token_env_unset");
    let response: any;
    try {
      response = await fetch(`${gatewayUrl}/v1/adapter/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutFor(route)),
      });
    } catch (e: any) {
      // A connection refusal, a DNS failure or the timeout. The message can name the host and port but never a token.
      return unavailable("request_failed:" + String(e?.name || e?.message || e).slice(0, 60));
    }
    if (!response.ok) return unavailable(response.status === 401 ? "not_authorized" : "http_error", response.status);
    try {
      return await response.json();
    } catch {
      return unavailable("invalid_json", response.status);
    }
  }

  /** The block is built once and never rebuilt; the file on disk is what survives a plugin reload. */
  const wrap = (sessionID: string, text: string) => `<project-memory session="${sessionID}">\n${text}\n</project-memory>`;

  async function bootstrap(sessionID: string, summary: string) {
    const s = state(sessionID);
    // Sticky across an OpenCode restart: a briefing file (even an empty one, the failure sentinel) is the answer.
    try {
      const cached = readFileSync(briefingFile(sessionID), "utf8");
      s.block = cached.trim() ? wrap(sessionID, cached) : null;
      return;
    } catch {}
    const data = await post("bootstrap", { task_id: sessionID, task_summary: summary.slice(0, 500), paths: [] }, sessionID);
    if (!data || typeof data.briefing_text !== "string" || !data.briefing_text.trim()) {
      s.block = null;
      // Empty sentinel file: a reload must not bootstrap again and inject a block mid-session.
      try { mkdirSync(briefingDir, { recursive: true }); writeFileSync(briefingFile(sessionID), "", { mode: 0o600 }); } catch {}
      await receipt({ sessionID, kind: "bootstrap_failed", reason: data ? "no_briefing_text" : "gateway_unavailable" });
      return;
    }
    const text = data.briefing_text.slice(0, MAX_BRIEFING);
    s.block = wrap(sessionID, text);
    try { mkdirSync(briefingDir, { recursive: true }); writeFileSync(briefingFile(sessionID), text, { mode: 0o600 }); } catch {}
    const verified = Array.isArray(data.verified) ? data.verified.length : 0;
    const records: any[] = Array.isArray(data.observations) ? data.observations : [];
    // An observation RECORD now carries a `fact_count` (several facts can be extracted from one record). The counts
    // here stay record counts and the toast says "M observations" meaning M records, whether or not fact_count is
    // present: the field is recorded alongside, never folded into the headline number.
    const observations = records.length;
    const facts = records.reduce((sum, r) => sum + (Number.isFinite(Number(r?.fact_count)) ? Number(r.fact_count) : 0), 0);
    await receipt({
      sessionID, kind: "bootstrap", receipt_id: data.receipt_id ?? null, task_id: data.task_id ?? sessionID,
      status: data.status ?? null, verified, observations, observations_degraded: !!data.observations_degraded,
      observation_facts: records.some((r) => r && r.fact_count !== undefined) ? facts : null,
      briefing_chars: text.length,
    });
    toast(`Project memory: ${verified} verified, ${observations} observations`);
  }

  async function checkpoint(sessionID: string, note: string, paths: string[], why: string) {
    const s = state(sessionID);
    if (hasSecret(note)) { await receipt({ sessionID, kind: "checkpoint_skipped", why: "secret_pattern", capture: why }); return; }
    // Claim the debounce window BEFORE the await, so two tool results landing together cannot both post.
    s.lastCheckpointAt = Date.now();
    const data = await post("checkpoint", { task_id: sessionID, note: note.slice(0, MAX_NOTE), paths }, sessionID);
    if (!data) return;
    await receipt({
      sessionID, kind: "checkpoint", capture: why, receipt_id: data.receipt_id ?? null,
      retained_document_id: data.retained_document_id ?? null, observations_degraded: !!data.observations_degraded,
      observation_status: observationStatus(data), paths, note_chars: Math.min(note.length, MAX_NOTE),
    });
  }

  /** The last assistant turn's text, the finish note's body. "" when the transcript cannot be read. */
  async function lastAssistantText(sessionID: string): Promise<string> {
    try {
      const response = await client.session.messages({ path: { id: sessionID }, query: { directory: dir } });
      const rows: any[] = Array.isArray(response?.data) ? response.data : [];
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]?.info?.role !== "assistant") continue;
        return (rows[i].parts || []).filter((p: any) => p?.type === "text").map((p: any) => String(p.text || "")).join("\n").trim();
      }
    } catch {}
    return "";
  }

  async function finish(sessionID: string, why: string) {
    const s = state(sessionID);
    if (s.finished || s.child) return;
    s.finished = true;   // set BEFORE the await: both idle event names fire for one idle (loop-continuation's note)
    if (s.finishTimer) { clearTimeout(s.finishTimer); s.finishTimer = null; }
    const summary = await lastAssistantText(sessionID);
    const note = "session summary: " + summary.slice(0, 2000);
    if (hasSecret(note)) {
      await receipt({ sessionID, kind: "checkpoint_skipped", why: "secret_pattern", capture: "finish" });
      return;
    }
    const data = await post("finish", {
      task_id: sessionID, note: note.slice(0, 4000),
      ...(summary ? {} : { no_durable_learning_reason: "no assistant text in the transcript" }),
      paths: [],
    }, sessionID);
    if (!data) return;
    await receipt({
      sessionID, kind: "finish", why, receipt_id: data.receipt_id ?? null,
      retained_document_id: data.retained_document_id ?? null, observations_degraded: !!data.observations_degraded,
      observation_status: observationStatus(data), note_chars: note.length,
    });
  }

  /**
   * The session's todo list, as {count, open}. An EMPTY list is not "the work is done": a directory whose sessions
   * keep no todo list at all (the gateway checkout, any ordinary dev session) would otherwise finish on every single
   * turn, because every turn ends idle with zero todos. Only "todos exist and none of them are pending or
   * in_progress" is the work-is-done signal; an empty or unreadable list falls through to plain inactivity.
   */
  async function todoState(sessionID: string): Promise<{ count: number; open: number }> {
    try {
      const response = await client.session.todo({ path: { id: sessionID }, query: { directory: dir } });
      const todos: any[] = Array.isArray(response?.data) ? response.data : [];
      return { count: todos.length, open: todos.filter((t) => t?.status === "pending" || t?.status === "in_progress").length };
    } catch {
      return { count: 0, open: 0 };
    }
  }

  const textOf = (parts: any) => (Array.isArray(parts) ? parts : []).filter((p: any) => p?.type === "text").map((p: any) => String(p.text || "")).join("\n");

  /** HEAD of the session directory: the fallback when a verify receipt names no head. "" when git cannot answer. */
  const headSha = (): string => {
    try { return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); }
    catch { return ""; }
  };

  await receipt({ kind: "plugin_loaded", sessionID: null, config: configPath, slug, gateway: gatewayUrl, token_env: tokenEnv });

  return {
    /** First user message of a primary session: bootstrap once. Also re-arms a finished session. */
    "chat.message": async (input: any, output: any) => {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";
      if (!sessionID) return;
      const s = state(sessionID);
      s.lastMessageAt = Date.now();
      s.finished = false;                                        // a later message re-arms finish
      // Register the id here too, so the message.updated re-emissions of THIS message cannot re-arm a finished
      // session a second time.
      const mid = typeof input?.messageID === "string" ? input.messageID : typeof output?.message?.id === "string" ? output.message.id : null;
      if (mid) s.userIDs.add(mid);
      if (s.finishTimer) { clearTimeout(s.finishTimer); s.finishTimer = null; }
      if (s.started) return;
      s.started = true;
      s.pending = (async () => {
        try {
          const info = await client.session.get({ path: { id: sessionID }, query: { directory: dir } });
          if (info?.data?.parentID) { s.child = true; return; }  // subagent sessions get nothing
        } catch { /* identity unknown: treat as primary, the gateway call is harmless */ }
        await bootstrap(sessionID, textOf(output?.parts));
      })().catch(async (e: any) => { s.block = null; await receipt({ sessionID, kind: "bootstrap_failed", reason: String(e?.message || e).slice(0, 120) }); });
      await s.pending;
    },

    /** The injection point: push the cached bytes, never rebuild them. */
    "experimental.chat.system.transform": async (input: any, output: any) => {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";
      if (!sessionID || !Array.isArray(output?.system)) return;  // no identity: push NOTHING, a placeholder is churn
      const s = state(sessionID);
      if (s.child) return;
      if (s.pending) await s.pending.catch(() => {});
      if (!s.block) {
        // A plugin reload lost the Map but the session lives on: the file is the byte-stability anchor.
        try {
          const cached = readFileSync(briefingFile(sessionID), "utf8");
          s.block = cached.trim() ? wrap(sessionID, cached) : null;
        } catch { return; }
      }
      if (s.block) output.system.push(s.block);
    },

    /** Bounded capture: a commit, or a signed verification. Never throws into the tool call. */
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (input?.tool !== "bash") return;
        const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";
        if (!sessionID) return;
        const command = String(input?.args?.command ?? "");
        const text = String(output?.output ?? "");
        const isCommit = onCommit && /git\s+commit/.test(command);
        const isVerify = onVerify && verifyCommand.test(command) && /\bverify\b/i.test(command) && /"ok"\s*:\s*true|RESULT:passed/.test(text);
        if (!isCommit && !isVerify) return;
        // Memory self-events are never project facts. The gateway's port counts as a mention of the gateway.
        const portHit = gatewayPort ? new RegExp(`\\b${gatewayPort}\\b`).test(command) || new RegExp(`\\b${gatewayPort}\\b`).test(text) : false;
        if (isSelfEvent(command) || isSelfEvent(text) || portHit) {
          await receipt({ sessionID, kind: "checkpoint_skipped", why: "self_event", capture: isCommit ? "commit" : "verify" });
          return;
        }
        const s = state(sessionID);
        if (Date.now() - s.lastCheckpointAt < DEBOUNCE_MS) {
          await receipt({ sessionID, kind: "checkpoint_skipped", why: "debounced", capture: isCommit ? "commit" : "verify", debounce_ms: DEBOUNCE_MS });
          return;
        }
        if (isCommit) {
          // git's own success line is the exit-0 proof AND names the commit that was made.
          const sha = commitSha(text);
          if (!sha) {
            await receipt({ sessionID, kind: "checkpoint_skipped", why: "commit_not_confirmed", capture: "commit" });
            return;
          }
          // `git show HEAD` is read with cwd = the SESSION directory, but a Manager commits inside a ticket worktree
          // with `git -C <worktree> commit` (agent-workflow's own note), and that success line says nothing about
          // this directory's HEAD. Recording an unrelated commit's subject and paths as this task's memory is worse
          // than recording nothing, so the two must agree before anything is posted.
          const head = headSha();
          if (!head || !head.toLowerCase().startsWith(sha.toLowerCase())) {
            await receipt({ sessionID, kind: "checkpoint_skipped", why: "commit_elsewhere", capture: "commit", commit: sha });
            return;
          }
          let stat = "";
          try {
            stat = execFileSync("git", ["show", "--stat", "--format=%s", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
          } catch {
            await receipt({ sessionID, kind: "checkpoint_skipped", why: "git_show_failed", capture: "commit" });
            return;
          }
          const subject = String(stat.split(/\r?\n/)[0] || "").trim();
          const paths = statPaths(stat);
          const note = `commit in ${slug}: ${subject}${paths.length ? " " + paths.join(" ") : ""}`.slice(0, MAX_NOTE);
          await checkpoint(sessionID, note, paths, "commit");
          return;
        }
        const label = /--label\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1]?.replace(/^["']|["']$/g, "")
          || (/--ticket\s+(\S+)/.exec(command)?.[1] ? `ticket ${/--ticket\s+(\S+)/.exec(command)![1]}` : "verify");
        const sha9 = (/(?:"head"\s*:\s*"|head[\s:=]+)([0-9a-f]{7,40})/i.exec(text)?.[1] || /\b[0-9a-f]{40}\b/.exec(text)?.[0] || headSha()).slice(0, 9) || "unknown";
        await checkpoint(sessionID, `verified ${label} at head ${sha9}: ${text.slice(0, 300)}`, [], "verify");
      } catch (e: any) {
        await receipt({ sessionID: input?.sessionID ?? null, kind: "checkpoint_skipped", why: "error:" + String(e?.message || e).slice(0, 120) });
      }
    },

    event: async ({ event }: any) => {
      const p = event?.properties || {};
      // OpenCode 1.18 reports idleness as `session.status` with status.type "idle"; `session.idle` is the older name.
      const idle = event?.type === "session.idle" || (event?.type === "session.status" && p.status?.type === "idle");
      if (idle && typeof p.sessionID === "string" && onSessionEnd) {
        const sessionID = p.sessionID;
        const s = state(sessionID);
        if (s.child || s.finished) return;
        if (s.finishTimer) { clearTimeout(s.finishTimer); s.finishTimer = null; }
        const todos = await todoState(sessionID);
        if (todos.count > 0 && todos.open === 0) { await finish(sessionID, "idle_no_actionable_todo"); return; }
        // Todos are still open, or this session keeps none: it is between turns, not over. Fall back to inactivity.
        const armedAt = s.lastMessageAt;
        s.finishTimer = setTimeout(() => {
          const now = state(sessionID);
          if (now.finished || now.lastMessageAt !== armedAt) return;   // a message arrived: not over after all
          void finish(sessionID, "idle_10_minutes_no_message").catch(() => {});
        }, IDLE_FINISH_MS);
        s.finishTimer.unref?.();
      } else if (event?.type === "message.updated" && typeof p.info?.sessionID === "string") {
        const s = state(p.info.sessionID);
        if (p.info.role !== "user") { s.lastMessageAt = Date.now(); return; }
        // OpenCode re-emits message.updated for the SAME user message several times during and after a turn
        // (loop-continuation's guardrails trace, 2026-09-10 08:06). Only a NEW id means the owner typed; without this
        // check a re-touch after a finish would clear `finished` and the next idle would finish the session twice.
        const mid = typeof p.info.id === "string" ? p.info.id : null;
        if (mid && s.userIDs.has(mid)) return;
        if (mid) s.userIDs.add(mid);
        s.lastMessageAt = Date.now();
        s.finished = false;                                     // a genuinely new message re-arms finish
        if (s.finishTimer) { clearTimeout(s.finishTimer); s.finishTimer = null; }
      } else if (event?.type === "session.deleted") {
        const id = p.info?.id ?? p.sessionID;
        if (typeof id === "string") {
          const s = sessions.get(id);
          if (s?.finishTimer) clearTimeout(s.finishTimer);
          sessions.delete(id);
        }
      }
    },
  };
};
