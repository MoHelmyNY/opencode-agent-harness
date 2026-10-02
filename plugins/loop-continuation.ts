/**
 * loop-continuation: keeps an owner-started loop running without a human "continue" (owner 2026-09-10: "Does this
 * automatically happen whenever I do this now, moving forward?").
 *
 * An OpenCode session only runs while a turn is open. When a session that ran /loop-start goes idle and its todo list
 * still holds actionable items (pending or in_progress, and not BLOCKED / PARKED / "waiting on" / OWNER RULING /
 * FINAL within the first 40 characters), this plugin waits a short debounce (so a human who is typing wins),
 * re-checks, and sends the next prompt itself through the SDK.
 * Owner rule (2026-09-10): the loop NEVER stops on its own while actionable todos remain. A ticket may
 * take six turns. The only exits are an empty actionable queue, a user message that says "stop the loop", and the
 * global stop file.
 * Owner rule (2026-09-15) - THE BRAKE: on 2026-09-15 this plugin re-prompted lane C 988 times at 39 s
 * intervals with the identical todo text, lane D 690 times and lane E 488 times, all on blocked work (lane E's todo
 * read "E1 #1860 BLOCKED: ..." and the old column-0 anchor did not see it; the receipts showed stalled reaching 496
 * while STALL was 0). The loop must not disarm, but it must BACK OFF: stalls 0-1 keep the debounce, stalls 2-4 wait
 * LOOP_CONTINUATION_BACKOFF_MS (5 minutes), stalls 5 and above wait LOOP_CONTINUATION_LONG_BACKOFF_MS (30 minutes).
 * A commit, a change in the NEXT todo's text, or a change in the active ticket's ledger progress signature
 * (<lane state_dir>/tickets/<ticket>/ledger.json: phase, last head, open findings, last assignment) resets the
 * counter. Bookkeeping does NOT: until 2026-09-16 any growth of that ticket's events.jsonl counted as progress, so
 * lane A's 22 re-prompts on "OWNER-ONLY: #1473" all recorded stalled 0 because each turn started with a
 * `ticket judge-sync` that appended a judge_sync and a pr_observed event. Every backoff decision writes a `backoff`
 * receipt and a toast. An operator note above LOOP_CONTINUATION_NOTE_MAX_TOKENS (4000, estimated as bytes/4) is NOT
 * prepended: a one-line notice takes its place, with a `note_withheld` receipt and a toast.
 * LOOP_CONTINUATION_MAX exists for tests only (0 = off, the default); LOOP_CONTINUATION_STALL no longer disarms, it
 * names the stall count at which the 30-minute tier starts (0 = the defaults above). While a session is armed the marker file
 * ~/.local/state/opencode/loop-continuation.active.d/<session>.json names it, so an external loop driver can stand down. Receipts: one JSON line
 * per continuation in ~/.local/state/opencode/loop-continuation.jsonl.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { CHAIN_PROMPT, expandHome, loadConfig, resolveConfigPath, slugOf } from "../guardrails/agent-workflow-config.ts";

// Until 2026-09-15 this anchored at column 0 (`/^\s*(?:BLOCKED|OWNER RULINGS?|FINAL:)/i`), so lane E's todo
// "E1 #1860 BLOCKED: ..." counted as actionable and was re-prompted 488 times on work that could not move. A marker
// anywhere in the HEAD of the todo text takes it out of the actionable set; \b keeps "finalize the PR" actionable.
// 2026-09-16: OWNER-ONLY and ESCALATED were missing. Lane A re-prompted 22 times at a 49 s median gap on the todo
// "OWNER-ONLY: #1473 (live-DB remint via #1452, ruling 5686251823)" with stalled 0 on every receipt, because the
// hyphenated spelling matched neither `OWNER RULINGS?` nor anything else here; the notes tell lanes to write
// "BLOCKED: escalated #N" (already covered) but a bare "ESCALATED: #N" must park too.
// PINNED RULE: a marker anywhere in the first 40 characters, CASE-INSENSITIVE, parks the todo - the same rule BLOCKED
// has always had. So "Unblock the owner-only path" is NOT actionable. A position-sensitive or case-sensitive
// exception is exactly the cleverness that produced the column-0 bug above; a lane that means real work writes a
// todo that does not carry a parking word in its head.
const NOT_ACTIONABLE_HEAD = 40;
const NOT_ACTIONABLE = /\b(?:BLOCKED|PARKED|ESCALATED|WAITING ON|OWNER RULINGS?|OWNER[- ]ONLY|FINAL)\b/i;
/** True when a todo carries a not-actionable marker in its first 40 characters. Exported for the tests. */
export function notActionable(content: unknown): boolean {
  return NOT_ACTIONABLE.test(String(content ?? "").slice(0, NOT_ACTIONABLE_HEAD));
}
// Bundles listed in the operator note's QUEUE line(s) as `[B1] #1773 + #1774 (file.py); [B2] ...`. An empty todo list
// with bundles still queued is NOT a finished loop (Lane B disarmed on exactly that, 2026-09-13 03:58 EDT): the next
// continuation tells the model to write the next bundle's tickets as todos and start.
export function queueItems(note: string): string[] {
  const out: string[] = [];
  for (const line of String(note || "").split(/\r?\n/)) {
    if (!/^\s*QUEUE\b/i.test(line)) continue;
    for (const m of line.matchAll(/\[([A-Z]\d+)\]\s*([^;\[\]]+)/g)) out.push(`[${m[1]}] ${m[2].trim().replace(/[;,.\s]+$/, "")}`);
  }
  return out;
}
const QUEUE_PROMPT =
  "Your todo list holds no actionable item, but the OPERATOR NOTE's QUEUE still lists bundles. Take the FIRST bundle in " +
  "the QUEUE whose tickets are not in RULED, not already an open PR of yours and not claimed by another lane in SESSIONS.md; " +
  "write one pending todo per ticket in that bundle (ticket number and seam file), then start the first ticket now. " +
  "If every bundle is done, write one todo `FINAL: queue exhausted` so the loop can end.\n\n";
// Arms on the loop-start command; "continue the loop" typed by the owner re-arms a session that was disarmed (stall, queue
// complete, owner stop). Leading quotes: a CLI-passed prompt kept its quote.
const LOOP_START = /^[\s"'`]*#\s*Loop Start Command|\/loop-start\b|^[\s"'`]*continue the loop\b/i;
const LOOP_STOP = /\b(?:stop|end|cancel|kill) (?:the )?loop\b/i;
const PROMPT =
  "Continue the loop. FIRST: run `gh pr list --state open --author @me --json number,headRefName` and for every open PR " +
  "read its comments (`gh pr view N --comments`). The judge is a separate model that posts comments starting with " +
  "`JUDGE:`. If the newest JUDGE comment says `JUDGE: CHANGES REQUESTED`, fix exactly what it asks on that PR's branch " +
  "with the same red-green discipline, push, and reply on the PR with what changed and the test lines; the judge's " +
  "verdict outranks your own judgment of your work, and a PR is never done until the judge says `JUDGE: APPROVED`. " +
  "THEN: read the session todo list and the runbook this " +
  "session wrote, take the NEXT todo that is pending or in_progress and not marked BLOCKED or OWNER RULINGS. If that " +
  "todo bundles several issues, first replace it with " +
  "one todo per issue and take only the first. Run the full iteration contract for ONE issue (claim check, red test, " +
  "fix, green, sibling grep, gates, a read-only code-reviewer subagent over the diff before commit, commit via message " +
  "file, push the lane branch, PR). Mark it completed in the todo list with the commit SHA and PR number, then give the " +
  "four-field receipt for that ticket. Do not repeat completed work, do not start blocked or owner-ruling items, and " +
  "never claim a check you did not run. OpenCode compacts the session by itself and a full window follows; never end, hold " +
  "or checkpoint a ticket for context reasons, and never wait for a human to say continue.";
/** Chain lanes (an enabled .agent-workflow config for the directory, design plan section 4) get CHAIN_PROMPT: a PR is
 *  handoff_pr_open, never completion. Every other directory keeps PROMPT byte for byte. Exported for tests. */
export function promptFor(chainEnabled: boolean, fromQueue: boolean, laneKind: string | null = null): string {
  // A note-driven lane (authoring, rendering, review) has no PR to sweep: PROMPT's gh/JUDGE steps are noise there.
  if (!chainEnabled && laneKind && laneKind !== "pr") return (fromQueue ? QUEUE_PROMPT : "") + NOTE_PROMPT;
  return (fromQueue ? QUEUE_PROMPT : "") + (chainEnabled ? CHAIN_PROMPT : PROMPT);
}
const NOTE_PROMPT =
  "Continue the loop. This lane's job is defined by the OPERATOR NOTE above, not by pull requests: follow its steps " +
  "exactly and pick up where its output files show you stopped. Do not redo finished work, do not rewrite records that " +
  "already pass, and never claim a check you did not run. When the note's DONE condition is met, write the single FINAL " +
  "todo it names so the loop can end. OpenCode compacts the session by itself and a full window follows; never end, hold " +
  "or checkpoint for context reasons, and never wait for a human to say continue.";
/** `LANE KIND: <kind>` on its own line in the operator note selects NOTE_PROMPT; absent or `pr` keeps PROMPT.
 *  Returns "" when absent, NEVER null: OpenCode calls every export of a plugin module as a plugin factory and reads
 *  `.config` off the result, so a null-returning export crashes server startup (2026-09-28: "null is not an object
 *  (evaluating 'N.config')", HTTP 500 on /provider, OpenCode would not open). */
export function laneKindOf(note: string): string {
  const m = typeof note === "string" ? note.match(/^\s*LANE KIND:\s*([a-z][a-z-]*)\s*$/im) : null;
  return m ? m[1].toLowerCase() : "";
}

// `signature` is the WHOLE todo list and belongs to the WF-04 blocked record (a change anywhere unblocks a packet);
// `nextText` is only the text of the todo the continuation would name, and is what the stall counter compares.
type LoopState = { origin?: string; carriedTodos?: any[]; armed: boolean; scanned: number; iteration: number; stalled: number; signature: string; nextText: string; commits: Set<string>; timer: any; lastUserAt: number; userIDs: Set<string>; lastCtx: number; lastAssistantID: string; providerID: string; modelID: string; compactedFor: string; backoffUntil: number; ledgerMark: string; armedAt?: string };

/** Note-kick decision (exported for the tests): re-arm the session that disarmed on "queue complete" once the operator
 * note lists QUEUE bundles again. Never while it is armed, never under a stop file, never without such a session. */
// OpenCode calls EVERY export of a plugin module as a plugin factory with ({ client, directory }) and reads .config off
// the result, so this must tolerate any arguments and never throw or return null (boot test 2026-09-29 01:37:
// "failed to load plugin ... evaluating 'queued.length'" when it assumed an array).
export function shouldNoteKick(kick?: any, queued?: any, armed?: any, stopFilePresent?: any): boolean {
  return !!kick && typeof kick.sessionID === "string" && Array.isArray(queued) && queued.length > 0 && armed !== true && stopFilePresent !== true;
}

export default async ({ client, directory }: any) => {
  const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode");
  const receiptFile = path.join(stateDir, "loop-continuation.jsonl");
  // WF-05 (audit 2026-09-13): one record PER SESSION under loop-continuation.active.d/<sessionID>.json (sessionID,
  // directory, pid, armedAt, updatedAt). Disarm removes only its own record, so one loop finishing can never erase
  // another armed loop's ownership signal; consumers treat a record older than their TTL as stale.
  const markerDir = path.join(stateDir, "loop-continuation.active.d");
  // WF-04: a guard abort (qwen-guardrails) or a recoverable checkpoint writes loop-blocked.d/<sessionID>.json; the
  // packet stays armed but is not re-prompted until the owner types again or the todo list changes.
  const blockedFile = (id: string) => path.join(stateDir, "loop-blocked.d", `${id}.json`);
  const markerFile = (id: string) => path.join(markerDir, `${id}.json`);
  async function writeMarker(id: string, armedAt?: string) {
    const now = new Date().toISOString();
    await fs.mkdir(markerDir, { recursive: true }).catch(() => {});
    await fs.writeFile(markerFile(id), JSON.stringify({ sessionID: id, directory, pid: process.pid, armedAt: armedAt || now, updatedAt: now }) + "\n").catch(() => {});
  }
  const stopFile = path.join(stateDir, "loop-continuation.stop");
  // Sessions released to a fresh continuation (2026-09-17 13:40-13:58 EDT: the released session stayed armed by its
  // own "continue the loop" history, so every later idle of it spawned ANOTHER fresh Manager; four ran on lane A at
  // once). A released session never continues again unless a user message NEWER than its release re-arms it.
  const releasedFile = path.join(stateDir, "loop-continuation.released.json");
  const released = new Map<string, number>();
  try { for (const [k, v] of Object.entries(JSON.parse(await fs.readFile(releasedFile, "utf8")))) released.set(k, Number(v)); } catch {}
  const saveReleased = async () => { await fs.writeFile(releasedFile, JSON.stringify(Object.fromEntries(released)) + "\n").catch(() => {}); };
  // Note-kick (owner 2026-09-29: the owner should not have to paste the start command to hand a finished lane new
  // work). A lane that finishes its queue disarms ("queue complete") and, being idle, emits no
  // further events, so a QUEUE the reviewer later wrote into the operator note sat unread until the owner pasted the
  // start command. The session that disarmed on queue-complete is remembered here (survives an OpenCode restart); a
  // timer re-reads the note and, when it lists QUEUE bundles again, re-arms that session and continues it through the
  // normal path - inside the TUI, visible. An owner "stop the loop" or a stop file clears it. 0 = off.
  const kickFile = path.join(stateDir, "loop-continuation.kick.json");
  const KICK_MS = Number(process.env.LOOP_CONTINUATION_NOTE_KICK_MS ?? 60000);
  let kick: { sessionID: string; at: number } | null = null;
  try {
    const k = JSON.parse(await fs.readFile(kickFile, "utf8"));
    if (k && typeof k.sessionID === "string" && (!k.directory || k.directory === directory)) kick = { sessionID: k.sessionID, at: Number(k.at) || 0 };
  } catch {}
  // Operator note per working directory: "/home/me/projects/app" -> loop-head/home-me-projects-app.txt
  const slug = String(directory || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
  const headFile = path.join(stateDir, "loop-head", `${slug}.txt`);
  // Once per load: repo .agent-workflow/workflow.json, else agent-workflow/<slug>.json. resolveConfigPath shells out
  // to `git rev-parse`, so it is never re-resolved per continuation; only active-ticket.json and the ticket's
  // ledger.json are read at continuation time.
  const laneConfigPath = resolveConfigPath(directory);
  const laneConfig = loadConfig(laneConfigPath);
  const chainEnabled = laneConfig !== null;
  // Owner directive 2026-09-16 (stateless Manager): with chain.fresh_continuation true in the
  // lane config, or LOOP_CONTINUATION_FRESH_SESSION=1, every continuation goes to a NEW session in the same directory.
  // The ticket status, ledger and notes are the state and the conversation is disposable, so the context never grows
  // past one continuation and nothing is ever compacted. The old session is released (marker removed, state dropped).
  const FRESH = process.env.LOOP_CONTINUATION_FRESH_SESSION === "1" || (laneConfig as any)?.chain?.fresh_continuation === true;
  const laneRawState = laneConfig ? expandHome(String(laneConfig.state_dir || "")) : "";
  const laneStateDir = !laneConfig ? "" : laneRawState ? path.resolve(path.dirname(laneConfigPath), laneRawState) : path.join(stateDir, "agent-workflow", slugOf(directory));
  const MAX = Number(process.env.LOOP_CONTINUATION_MAX || 0);   // 0 = unlimited (owner rule; tests set a cap)
  // Owner rule 2026-09-15: no disarm on stall, a backoff instead. STALL names the stall count at which the long tier
  // starts (0 = the shipped 5); the two waits are env knobs so a lane can be slowed without a code change.
  const STALL = Number(process.env.LOOP_CONTINUATION_STALL || 0);
  const LONG_STALL = STALL > 0 ? Math.max(2, STALL) : 5; // never below 2: stalls 0-1 always keep the plain debounce
  const BACKOFF_MS = Number(process.env.LOOP_CONTINUATION_BACKOFF_MS ?? 300000);        // stalls 2-4: 5 minutes
  const LONG_BACKOFF_MS = Number(process.env.LOOP_CONTINUATION_LONG_BACKOFF_MS ?? 1800000); // stalls >= LONG_STALL: 30 minutes
  const backoffFor = (stalled: number) => (stalled >= LONG_STALL ? LONG_BACKOFF_MS : stalled >= 2 ? BACKOFF_MS : 0);
  const NOTE_MAX_TOKENS = Number(process.env.LOOP_CONTINUATION_NOTE_MAX_TOKENS ?? 4000); // 0 = no cap
  const DEBOUNCE = Number(process.env.LOOP_CONTINUATION_DEBOUNCE_MS ?? 30000);
  // Owner rule (2026-09-12): compact at 70 percent of the window. The model cannot run /compact itself
  // (a TUI command), so the plugin summarizes the session through the SDK before the next continuation when the last
  // assistant turn's context (input + cache read) is past the threshold; two lanes near 200K tokens each overflowed the
  // shared engine pool and stalled every request. LOOP_CONTINUATION_COMPACT_AT=0 disables it (tests).
  // 2026-09-12 16:50 EDT: 0.5 by default. Three contexts share the 428K pool (two lanes and another client at ~170K), and at 0.7
  // (183K) three of them can never fit, so every arrival evicted another's prefix (mean 42.8 tok/s for an hour).
  // The state file loop-compact-at.txt overrides the fraction at each continuation, so tuning it needs no restart.
  const COMPACT_AT = Number(process.env.LOOP_CONTINUATION_COMPACT_AT ?? 0.5);
  const compactAtFile = path.join(stateDir, "loop-compact-at.txt");
  const compactAt = async () => {
    const text = await fs.readFile(compactAtFile, "utf8").then((t) => t.trim(), () => "");
    const n = Number(text);
    return text && Number.isFinite(n) && n >= 0 && n <= 1 ? n : COMPACT_AT;
  };
  // 2026-09-27 18:35 EDT: one WINDOW was applied to every lane, so the 1M-context Zen/DeepSeek models
  // were forced to compact at 0.9 x 262144 (receipts: reason=compact window=262144 tokens=251979 against
  // providerID=opencode-go modelID=deepseek-v4.1-flash). The local lanes really are 262144, so they keep
  // the default; only lanes whose real window is larger carry their own, and the env var still wins globally.
  const WINDOW_ENV = process.env.LOOP_CONTINUATION_WINDOW ? Number(process.env.LOOP_CONTINUATION_WINDOW) : null;
  const WINDOW = WINDOW_ENV ?? 262144;
  // Windows are the models.dev values cached in ~/.cache/opencode/models.json. Models smaller than the
  // 262144 default are mapped too: the default would otherwise sit ABOVE their real window.
  const LANE_WINDOW: Record<string, number> = {
    "opencode-go/deepseek-v4.1-flash": 1000000,
    "opencode-go/deepseek-v4-flash": 1000000,
    "opencode-go/deepseek-v4-flash-vision-exp": 1000000,
    "opencode-go/deepseek-v4-pro": 1000000,
    "opencode-go/glm-5.3-flash": 1000000,
    "opencode-go/glm-5.3": 1000000,
    "opencode-go/glm-5.2": 1000000,
    "opencode-go/glm-5.1": 202752,
    "opencode-go/glm-5": 202752,
    // No local-lane entries (removed 2026-09-28). The local lane compacts natively at its opencode.json
    // limit.input minus reserve (200000 -> ~180K), which fires
    // before 0.9 x any window here, so a lane window for it only broke the compaction-fraction test and changed nothing.
  };
  const windowFor = (providerID: string, modelID: string) =>
    WINDOW_ENV ?? LANE_WINDOW[`${providerID}/${modelID}`] ?? WINDOW;
  const sessions = new Map<string, LoopState>();
  const state = (id: string) => {
    let s = sessions.get(id);
    if (!s) { s = { armed: false, scanned: 0, iteration: 0, stalled: 0, signature: "", nextText: "", commits: new Set(), timer: null, lastUserAt: 0, userIDs: new Set(), lastCtx: 0, lastAssistantID: "", providerID: "", modelID: "", compactedFor: "", backoffUntil: 0, ledgerMark: "" }; sessions.set(id, s); }
    return s;
  };
  const textOf = (row: any) => (row?.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text || "").join("\n");
  const receipt = async (record: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), directory, ...record });
    await Promise.allSettled([
      fs.mkdir(stateDir, { recursive: true }).then(() => fs.appendFile(receiptFile, line + "\n", { mode: 0o600 })),
      client?.app?.log?.({ body: { service: "loop-continuation", level: "info", message: line } }),
    ]);
  };
  const toast = async (message: string, warning = false) => {
    await Promise.allSettled([client?.tui?.showToast?.({ query: { directory }, body: { title: "Loop continuation", message, variant: warning ? "warning" : "info", duration: 10000 } })]);
  };
  const exists = async (p: string) => fs.access(p).then(() => true, () => false);
  async function disarm(id: string, reason: string) {
    const s = state(id);
    if (!s.armed) return;
    s.armed = false;
    await receipt({ sessionID: id, iteration: s.iteration, reason: "disarmed:" + reason });
    await fs.rm(markerFile(id), { force: true }).catch(() => {});
    if (reason.startsWith("queue complete")) {
      kick = { sessionID: id, at: Date.now() };
      await fs.writeFile(kickFile, JSON.stringify({ sessionID: id, directory, at: kick.at }) + "\n").catch(() => {});
    } else if (kick && kick.sessionID === id) {
      kick = null;
      await fs.rm(kickFile, { force: true }).catch(() => {});
    }
    await toast(`Loop stopped: ${reason} (${s.iteration} continuations)`, true);
  }
  /** Arm on a /loop-start user message, disarm on a "stop the loop" one; scans only the messages not seen before. */
  async function scan(id: string) {
    const s = state(id);
    const response = await client.session.messages({ path: { id }, query: { directory } });
    const rows: any[] = Array.isArray(response?.data) ? response.data : [];
    if (process.env.LOOP_CONTINUATION_DEBUG === "1") {
      const users = rows.filter((r) => r?.info?.role === "user");
      await receipt({ sessionID: id, reason: "debug:scan", rows: rows.length, users: users.length, shape: Object.keys(rows[0] || {}).join(","),
        partTypes: [...new Set(users.flatMap((r) => (r.parts || []).map((p: any) => p.type)))].join(","), firstUserText: textOf(users[0]).slice(0, 80), error: response?.error ? String(response.error).slice(0, 120) : null });
    }
    for (const row of rows.slice(s.scanned)) {
      if (row.info?.role !== "user") continue;
      const text = textOf(row);
      if (LOOP_STOP.test(text)) { await disarm(id, "owner said stop"); }
      else if (LOOP_START.test(text) && !s.armed && released.has(id) && !(Number(row.info?.time?.created || 0) > (released.get(id) || 0))) {
        // an arming message that predates the release (or carries no time) is the history that caused the cascade
        continue;
      }
      else if (LOOP_START.test(text) && !s.armed) {
        if (released.has(id)) { released.delete(id); await saveReleased(); await receipt({ sessionID: id, reason: "re-armed after release: new owner message" }); } s.armed = true; s.iteration = 0; s.stalled = 0; s.backoffUntil = 0; s.armedAt = new Date().toISOString(); await writeMarker(id, s.armedAt); await receipt({ sessionID: id, iteration: 0, reason: "armed" }); }
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const info = rows[i]?.info;
      if (info?.role !== "assistant") continue;
      const tk = info.tokens || {};
      s.lastCtx = Number(tk.input || 0) + Number(tk.cache?.read || 0);
      s.lastAssistantID = String(info.id || "");
      s.providerID = String(info.providerID || "");
      s.modelID = String(info.modelID || "");
      break;
    }
    s.scanned = rows.length;
    return s.armed;
  }
  async function actionable(id: string) {
    const response = await client.session.todo({ path: { id }, query: { directory } });
    let todos: any[] = Array.isArray(response?.data) ? response.data : [];
    // A fresh session starts with NO todo list (todos are per session), so the first idle of a fresh continuation
    // read "0 todos" and disarmed the loop (lane A, 2026-09-17 13:32 EDT, iteration 1). Until the new session's
    // Manager has rewritten the list, the origin session's todos are the loop's fuel.
    const origin = sessions.get(id)?.origin;
    if (todos.length === 0 && origin && origin !== id) {
      const inherited = await client.session.todo({ path: { id: origin }, query: { directory } }).catch(() => null);
      if (Array.isArray(inherited?.data) && inherited.data.length) todos = inherited.data;
    }
    return { todos, open: todos.filter((t) => ["pending", "in_progress"].includes(t.status) && !notActionable(t.content)) };
  }
  // Closing dispositions, copied from the framework's own rule (agent_workflow/ledger.py OPEN_CLOSING, used by
  // ledger.open_findings and telemetry.py): a finding is OPEN unless the LAST entry of its `history` carries one of
  // these. There is no top-level `disposition` field on a finding - it is only ever `history[-1].disposition`.
  const CLOSED_DISPOSITIONS = new Set(["verified_fixed", "disproved", "not_applicable", "waived"]);
  /**
   * Progress signature of the lane's active ticket, read from `<lane state_dir>/tickets/<ticket>/ledger.json`:
   * `<ticket>|<phase>|<last head or null>|<open findings>|<last assignment id>`, "" when this is not a chain lane,
   * no ticket is active or the ledger cannot be read.
   *
   * Until 2026-09-16 this was the SIZE of that ticket's `events.jsonl`, and any growth of that file counted as
   * progress. It is a bookkeeping log: lane A ran `ticket judge-sync` at the start of every turn, so each of its 22
   * re-prompts appended a `judge_sync` and a `pr_observed` event, the mark grew every time, and `stalled` was 0 on
   * every receipt while nothing moved. The ledger's own state is what moves when work moves - a phase transition, a
   * new head, a finding opened or disposed, a new assignment - so that is what resets the brake.
   */
  async function ticketProgressMark(): Promise<string> {
    if (!laneStateDir) return "";
    try {
      const activeRaw = await fs.readFile(path.join(laneStateDir, "active-ticket.json"), "utf8");
      const active = JSON.parse(activeRaw.replace(/^\uFEFF/, ""));   // the CLI writes utf-8-sig
      const ticket = active && typeof active === "object" ? String(active.ticket ?? "") : "";
      if (!ticket) return "";
      const ledgerRaw = await fs.readFile(path.join(laneStateDir, "tickets", ticket, "ledger.json"), "utf8");
      const ledger = JSON.parse(ledgerRaw.replace(/^\uFEFF/, ""));
      const heads: unknown[] = Array.isArray(ledger?.heads) ? ledger.heads : [];
      const head = heads.length ? String(heads[heads.length - 1]) : "null";
      const findings: any[] = Array.isArray(ledger?.findings) ? ledger.findings : [];
      const open = findings.filter((finding) => {
        const history: any[] = Array.isArray(finding?.history) ? finding.history : [];
        const last = history.length ? history[history.length - 1] : null;
        return !CLOSED_DISPOSITIONS.has(String(last?.disposition ?? ""));
      }).length;
      const assignments: any[] = Array.isArray(ledger?.assignments) ? ledger.assignments : [];
      const assignment = assignments.length ? String(assignments[assignments.length - 1]?.id ?? "") : "";
      return `${ticket}|${String(ledger?.phase ?? "")}|${head}|${open}|${assignment}`;
    } catch {
      return "";
    }
  }
  /** A CHANGED signature is progress; a first read is only a baseline, and an unreadable ledger is never progress. */
  const ledgerAdvanced = (before: string, now: string) => Boolean(before) && Boolean(now) && before !== now;
  const inFlight = new Map<string, Promise<void>>();
  async function maybeContinue(id: string) {
    const s = state(id);
    s.timer = null;
    // Both idle event names fire for one idle: the second caller waits for the first's continuation instead of
    // starting another (and instead of returning early, which would let a headless process exit mid-scan).
    const running = inFlight.get(id);
    if (running) { await running; return; }
    const work = continueOnce(id, s).finally(() => inFlight.delete(id));
    inFlight.set(id, work);
    await work;
  }
  async function continueOnce(id: string, s: LoopState) {
    if (!(await scan(id))) return;
    if (await exists(stopFile)) { await disarm(id, "stop file present"); return; }
    if (Date.now() - s.lastUserAt < DEBOUNCE) return; // the owner is typing; their turn will fire idle again later
    const { todos, open } = await actionable(id);
    // An operator note (head of queue, items pulled out) lives in a file so it can change without a restart.
    // It is PER WORKING DIRECTORY (owner finding 2026-09-11 08:15 EDT: one global note leaked one project's judge
    // rules into another project's loop): loop-head/<slug of the directory>.txt, nothing else is read.
    const head = await fs.readFile(headFile, "utf8").then((t) => t.trim(), () => "");
    const queued = open.length === 0 ? queueItems(head) : [];
    const fromQueue = open.length === 0 && queued.length > 0;
    if (open.length === 0 && !fromQueue) { await disarm(id, `queue complete (${todos.length} todos, none actionable, no QUEUE bundles in the note)`); return; }
    const signature = JSON.stringify(todos.map((t) => [t.content, t.status]));
    const blockedRaw = await fs.readFile(blockedFile(id), "utf8").catch(() => null);
    if (blockedRaw !== null) {
      let blocked: any = {};
      try { blocked = JSON.parse(blockedRaw); } catch {}
      const blockedAt = Date.parse(blocked.at || "") || 0;
      const ownerTypedSince = s.lastUserAt > blockedAt;
      const todosChanged = typeof blocked.signature === "string" && blocked.signature !== signature;
      if (!ownerTypedSince && !todosChanged) {
        if (typeof blocked.signature !== "string") await fs.writeFile(blockedFile(id), JSON.stringify({ ...blocked, signature }) + "\n").catch(() => {});
        await receipt({ sessionID: id, iteration: s.iteration, reason: "blocked:" + String(blocked.reason || "checkpoint"), since: blocked.at || null });
        return;
      }
      await fs.rm(blockedFile(id), { force: true }).catch(() => {});
      await receipt({ sessionID: id, iteration: s.iteration, reason: "unblocked:" + (ownerTypedSince ? "owner-typed" : "todos-changed") });
    }
    const mark = await ticketProgressMark();
    // The stall test is the NEXT todo's TEXT, not the whole todo list (2026-09-16): a lane that re-prompts on the same
    // `next` while rewriting or re-ordering its other todos is stalled on the item the continuation actually names,
    // and the old whole-list comparison read every such rewrite as progress. The commit half is unchanged.
    const nextText = fromQueue ? String(queued[0] || "") : String(open[0]?.content || "");
    const progressed = s.iteration === 0 || nextText !== s.nextText || s.commits.size > 0 || ledgerAdvanced(s.ledgerMark, mark);
    s.signature = signature; s.nextText = nextText; s.commits.clear(); s.ledgerMark = mark;
    // Owner rule 2026-09-15: NEVER disarm on a stall; back off instead. The counter is raised once per decision, not
    // once per wake-up, so a backoff timer firing cannot walk the session up the tiers on its own.
    if (progressed) { s.stalled = 0; s.backoffUntil = 0; }
    else if (!s.backoffUntil) s.stalled = s.stalled + 1;
    if (MAX > 0 && s.iteration >= MAX) { await disarm(id, `max continuations (${MAX}) reached`); return; }
    const waitMs = backoffFor(s.stalled);
    if (waitMs > 0) {
      const waiting = nextText;
      if (!s.backoffUntil) {
        s.backoffUntil = Date.now() + waitMs;
        await receipt({ sessionID: id, iteration: s.iteration, reason: "backoff", stalled: s.stalled, waitMs, next: waiting.slice(0, 120) });
        await toast(`Backing off ${Math.round(waitMs / 60000)} min: ${s.stalled} continuations on the same next todo with no commit and no ledger progress (the loop does not stop)`, true);
      }
      const remaining = s.backoffUntil - Date.now();
      if (remaining > 0) {
        // Nothing else will wake an idle session, so the backoff owns the timer until it expires.
        if (s.timer) clearTimeout(s.timer);
        s.timer = setTimeout(() => { void maybeContinue(id).catch(async (e: any) => receipt({ sessionID: id, reason: "error:" + String(e?.message || e) })); }, remaining);
        s.timer.unref?.();
        return;
      }
      s.backoffUntil = 0; // the wait elapsed: this continuation goes out
    }
    const threshold = await compactAt();
    const lane = windowFor(s.providerID, s.modelID);
    if (threshold > 0 && s.lastCtx > threshold * lane && s.providerID && s.modelID && s.compactedFor !== s.lastAssistantID && typeof client.session.summarize === "function") {
      // Summarize first; the summary turn ends in another idle event, which brings us back here with a small context.
      // compactedFor guards the case where the summary did not shrink the context (then we prompt anyway).
      s.compactedFor = s.lastAssistantID;
      await receipt({ sessionID: id, iteration: s.iteration, reason: "compact", tokens: s.lastCtx, window: lane, threshold });
      await toast(`Compacting before the next continuation (${Math.round((100 * s.lastCtx) / lane)}% of the window)`);
      await client.session.summarize({ path: { id }, query: { directory }, body: { providerID: s.providerID, modelID: s.modelID } });
      return;
    }
    s.iteration++;
    await writeMarker(id, s.armedAt);
    const next = nextText;   // same value the stall test compared, so a receipt's `next` and `stalled` can never drift
    // Note cap (owner 2026-09-15): an operator note is prepended to EVERY continuation, so an oversized one is paid
    // for on every turn of the loop. Above the cap it is withheld and the model is told to have the operator trim it;
    // the note is still parsed for QUEUE bundles above, because dropping those would disarm the loop.
    const noteTokens = head ? Math.ceil(Buffer.byteLength(head, "utf8") / 4) : 0;
    const noteWithheld = NOTE_MAX_TOKENS > 0 && noteTokens > NOTE_MAX_TOKENS;
    if (noteWithheld) {
      await receipt({ sessionID: id, iteration: s.iteration, reason: "note_withheld", tokens: noteTokens, max: NOTE_MAX_TOKENS });
      await toast(`OPERATOR NOTE withheld: ${noteTokens} tokens exceeds the ${NOTE_MAX_TOKENS} cap; trim ${headFile}`, true);
    }
    await receipt({ sessionID: id, iteration: s.iteration, actionable: open.length, queued: queued.length, stalled: s.stalled, reason: fromQueue ? "continue:queue" : "continue", next: next.slice(0, 120) });
    await toast(fromQueue ? `Continuing the loop (${s.iteration}): todo list empty, ${queued.length} QUEUE bundles left` : `Continuing the loop (${s.iteration}): ${open.length} actionable todos left`);
    // A withheld note is not sent, so a note-driven prompt would point at nothing: fall back to PROMPT.
    const body = promptFor(chainEnabled, fromQueue, noteWithheld ? null : laneKindOf(head));
    const text = noteWithheld
      ? `OPERATOR NOTE withheld: ${noteTokens} tokens exceeds the ${NOTE_MAX_TOKENS} cap; the operator must trim it\n\n${body}`
      : head ? `OPERATOR NOTE: ${head}\n\n${body}` : body;
    if (FRESH && typeof client.session.create === "function") {
      const target = await freshSession(id, s);
      if (target) {
        // The first line re-arms the new session on its own (LOOP_START matches "continue the loop"), so a plugin
        // restart re-discovers it from its messages exactly like a session the owner armed by hand.
        const carriedTodos: any[] = sessions.get(target)?.carriedTodos || [];
        const todoBlock = carriedTodos.length
          ? "TODO LIST carried from the previous session (this new session starts with an EMPTY list; rewrite it with the todo tool as your FIRST step, same items and statuses, then work it; the loop's fuel is this list):\n" +
            carriedTodos.map((t: any) => `- [${t.status}] ${String(t.content || "").slice(0, 300)}`).join("\n") + "\n\n"
          : "";
        const fresh = `continue the loop (fresh session ${s.iteration}; previous session ${id} released)\n\n` +
          "STATELESS MANAGER: the previous conversation is gone by design. Ground from `ticket status --ticket <N>` for the active ticket " +
          "(active-ticket.json names it), its notes (`ticket notes --ticket <N> --show`) and the operator note; never assume an earlier turn.\n\n" + todoBlock + text;
        await receipt({ sessionID: target, iteration: s.iteration, reason: "continue:fresh", from: id, next: next.slice(0, 120) });
        await client.session.promptAsync({ path: { id: target }, query: { directory }, body: { parts: [{ type: "text", text: fresh }] } });
        return;
      }
    }
    await client.session.promptAsync({ path: { id }, query: { directory }, body: { parts: [{ type: "text", text }] } });
  }
  /** Fresh-session continuation: create the new session, carry the loop state to it, release the old one. Null (and a
   *  receipt) when the server refuses, so the continuation falls back to the same session rather than being lost. */
  async function freshSession(id: string, s: LoopState): Promise<string | null> {
    try {
      const created = await client.session.create({ query: { directory }, body: { title: `loop ${slug} #${s.iteration}` } });
      const target = created?.data?.id;
      if (typeof target !== "string" || !target) return null;
      let carriedTodos: any[] = [];
      try { const t = await client.session.todo({ path: { id }, query: { directory } }); carriedTodos = Array.isArray(t?.data) ? t.data : []; } catch {}
      if (!carriedTodos.length && Array.isArray(s.carriedTodos)) carriedTodos = s.carriedTodos;
      const carried: LoopState = { ...s, origin: s.origin ?? id, carriedTodos, armed: true, scanned: 0, timer: null, commits: new Set(), userIDs: new Set(), lastUserAt: 0, compactedFor: "", lastCtx: 0, lastAssistantID: "" };
      sessions.set(target, carried);
      await writeMarker(target, s.armedAt);
      // The released session keeps a DISARMED state (its messages are not rescanned) and a persisted release time;
      // its old "continue the loop" history can never arm it again.
      released.set(id, Date.now());
      await saveReleased();
      if (s.timer) clearTimeout(s.timer);
      sessions.set(id, { ...s, armed: false, timer: null });
      await fs.unlink(markerFile(id)).catch(() => {});
      return target;
    } catch (e: any) {
      await receipt({ sessionID: id, iteration: s.iteration, reason: "fresh_session_failed:" + String(e?.message || e) });
      return null;
    }
  }
  async function noteKickTick() {
    if (!kick) return;
    const id = kick.sessionID;
    const s = state(id);
    const head = await fs.readFile(headFile, "utf8").then((t) => t.trim(), () => "");
    if (!shouldNoteKick(kick, queueItems(head), s.armed, await exists(stopFile))) return;
    kick = null;
    await fs.rm(kickFile, { force: true }).catch(() => {});
    // Mark the existing history as scanned: after a restart the state is empty, and rescanning old messages could
    // replay an old "stop the loop" and disarm the kick at once. Only messages newer than this point are scanned.
    const rows = await client.session.messages({ path: { id }, query: { directory } }).catch(() => null);
    if (Array.isArray(rows?.data)) s.scanned = rows.data.length;
    s.armed = true; s.iteration = 0; s.stalled = 0; s.backoffUntil = 0; s.armedAt = new Date().toISOString();
    await writeMarker(id, s.armedAt);
    await receipt({ sessionID: id, iteration: 0, reason: "armed:note-queue", queued: queueItems(head).length });
    await toast("Loop re-armed: the operator note lists new QUEUE jobs");
    await maybeContinue(id);
  }
  if (KICK_MS > 0) {
    const t: any = setInterval(() => { void noteKickTick().catch(async (e: any) => receipt({ reason: "error:note-kick:" + String(e?.message || e) })); }, KICK_MS);
    t.unref?.();
  }
  return {
    event: async ({ event }: any) => {
      const p = event.properties || {};
      // OpenCode 1.18 reports idleness as `session.status` with status.type "idle"; `session.idle` is the older
      // event name. Handle both.
      const idle = (event.type === "session.idle") || (event.type === "session.status" && p.status?.type === "idle");
      if (idle && typeof p.sessionID === "string") {
        const id = p.sessionID;
        const info = await client.session.get({ path: { id }, query: { directory } });
        if (!info?.data || info.data.parentID) return; // subagent sessions are never looped
        const s = state(id);
        await receipt({ sessionID: id, iteration: s.iteration, reason: "idle", armed: s.armed, debounceMs: DEBOUNCE });
        if (s.timer) clearTimeout(s.timer);
        if (DEBOUNCE <= 0) await maybeContinue(id).catch(async (e: any) => receipt({ sessionID: id, reason: "error:" + String(e?.message || e) }));
        else { s.timer = setTimeout(() => { void maybeContinue(id).catch(async (e: any) => receipt({ sessionID: id, reason: "error:" + String(e?.message || e) })); }, DEBOUNCE); s.timer.unref?.(); }
      } else if (event.type === "message.updated" && p.info?.role === "user" && typeof p.info.sessionID === "string") {
        // OpenCode re-emits message.updated for the SAME user message several times during and after a turn
        // (seen in the guardrails trace, 2026-09-10 08:06). Only a NEW user message id means the owner typed.
        const s = state(p.info.sessionID);
        const mid = typeof p.info.id === "string" ? p.info.id : null;
        if (mid && s.userIDs.has(mid)) return;
        if (mid) s.userIDs.add(mid);
        s.lastUserAt = Date.now();
        if (s.timer) { clearTimeout(s.timer); s.timer = null; await receipt({ sessionID: p.info.sessionID, iteration: s.iteration, reason: "cancelled: new user message" }); }
      } else if (event.type === "session.deleted") {
        const id = p.info?.id;
        if (typeof id === "string") { const s = sessions.get(id); if (s?.timer) clearTimeout(s.timer); sessions.delete(id); }
      }
    },
    "tool.execute.after": async (input: any, output: any) => {
      if (input?.tool !== "bash" || typeof output?.output !== "string" || typeof input.sessionID !== "string") return;
      if (/git commit/.test(String(input.args?.command || ""))) {
        for (const sha of output.output.matchAll(/\[[\w./-]+ ([0-9a-f]{7,})\]/g)) state(input.sessionID).commits.add(sha[1]);
      }
    },
  };
};
