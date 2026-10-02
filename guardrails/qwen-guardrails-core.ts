/**
 * Pure logic for the qwen-guardrails plugin (no I/O, no OpenCode types) so it can be unit-tested with bun.
 * It lives outside plugins/ on purpose: OpenCode's loader calls every export of a plugin module and throws on a
 * non-function export, and this module exports constants.
 *
 * Two guards, both modelled on LangChain's harness-engineering write-up (Terminal Bench 2.0, 30th -> 5th with the
 * model held fixed): a per-file edit-loop detector and a context-budget nudge. Neither blocks anything and neither
 * tells the model to hurry. They append text to a tool result, which sits at the tail of the prompt, so the cached
 * prefix on the local vLLM engine is untouched (a system-prompt change would re-prefill the whole conversation).
 */

export const DEFAULT_CONTEXT_WINDOW = 262144;
/** Edit number at which the first loop nudge fires, then every EDIT_NUDGE_EVERY edits after that (6, 10, 14, ...). */
export const EDIT_NUDGE_AT = 6;
export const EDIT_NUDGE_EVERY = 4;
export const CONTEXT_STAGES = [
  { name: "verify", ratio: 0.5 },
  { name: "checkpoint", ratio: 0.7 },
] as const;
export type StageName = (typeof CONTEXT_STAGES)[number]["name"];

export type SessionState = {
  edits: Map<string, number>;
  contextTokens: number;
  contextWindow: number | null;
  fired: Set<StageName>;
  /** Count of non-zero token reports seen; lets a compaction note wait for a size measured AFTER the compaction. */
  tokenUpdates: number;
  /** tokenUpdates at the last compaction, or null when no compaction is waiting to be announced. */
  compactedAt: number | null;
  /** The last tool call's identity and how many times in a row it has been issued unchanged. */
  lastCall: { key: string; count: number; resultHash?: string; stagnant: number } | null;
  /** Graphify usage (owner 2026-09-13): backend modules edited since the last dependency verb, tool calls seen, and the call index of the last nudge. */
  graphify: { verbs: number; modulesSinceVerb: Set<string>; analyzed: Set<string>; toolCalls: number; nudgedAt: number };
};

export type TokenUsage = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export function newState(contextWindow: number | null = null): SessionState {
  return { edits: new Map(), contextTokens: 0, contextWindow, fired: new Set(), tokenUpdates: 0, compactedAt: null, lastCall: null, graphify: { verbs: 0, modulesSinceVerb: new Set(), analyzed: new Set(), toolCalls: 0, nudgedAt: -1000 } };
}

/** Case-insensitive on purpose: Windows paths reach the tools in both spellings. */
export function normalizeFile(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

export function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

export function shouldNudgeEdit(count: number): boolean {
  return count >= EDIT_NUDGE_AT && (count - EDIT_NUDGE_AT) % EDIT_NUDGE_EVERY === 0;
}

export function editNudge(filePath: string, count: number): string {
  return (
    `[qwen-guardrails] This is edit #${count} to ${basename(filePath)} in this session. Before touching it again: ` +
    `re-read the spec's fix shape and the failing test, and state in one line what the previous edit got wrong. ` +
    `If the approach is not converging, change it: re-derive the fix from the writer and consumer in source (a Graphify verb or a ` +
    `subagent read helps) rather than trying another variant of the same lines; keep the ticket going.`
  );
}

export function recordEdit(state: SessionState, filePath: string): { count: number; nudge: string | null } {
  const key = normalizeFile(filePath);
  const count = (state.edits.get(key) || 0) + 1;
  state.edits.set(key, count);
  return { count, nudge: shouldNudgeEdit(count) ? editNudge(filePath, count) : null };
}

/** vLLM reports `total`; when a provider omits it, the prompt size is input + cache reads plus this turn's output. */
export function tokensTotal(tokens: TokenUsage): number {
  if (typeof tokens.total === "number" && tokens.total > 0) return tokens.total;
  const cache = tokens.cache || { read: 0, write: 0 };
  return (tokens.input || 0) + (cache.read || 0) + (cache.write || 0) + (tokens.output || 0) + (tokens.reasoning || 0);
}

/**
 * OpenCode announces every new assistant message with all-zero tokens before the model has answered (seen in the
 * 2026-09-10 trace, interleaved with the previous step's final totals); a zero report is "unknown", not "empty", so
 * it never lowers the last known size. Real shrinkage after compaction arrives as a smaller non-zero total.
 */
export function recordContext(state: SessionState, tokens: TokenUsage): number {
  const total = tokensTotal(tokens);
  if (total > 0) {
    // A real shrink of 30% or more is a compaction whether or not OpenCode announced it (1.18 announced idleness
    // under a different event name than expected; do not depend on `session.compacted` alone).
    if (state.contextTokens > 0 && total < state.contextTokens * 0.7) resetContextStages(state);
    state.contextTokens = total;
    state.tokenUpdates++;
  }
  return state.contextTokens;
}

/** Compaction shrinks the prompt; the stages re-arm so the next climb is announced again. */
export function resetContextStages(state: SessionState): void {
  state.fired.clear();
  state.compactedAt = state.tokenUpdates;
}

/**
 * After OpenCode compacts a session the model keeps repeating its last pre-compaction belief ("context exhausted at
 * 99%", seen 2026-09-10 15:33-15:38 EDT: four turns ended within a minute each while the real size was 40%). Once a
 * size measured after the compaction exists, say the real number once so the next turn is a working turn.
 */
export function compactionNudge(state: SessionState): string | null {
  if (state.compactedAt === null || !state.contextWindow || state.contextTokens <= 0) return null;
  if (state.tokenUpdates <= state.compactedAt) return null; // still the pre-compaction size
  state.compactedAt = null;
  const pct = Math.round((state.contextTokens / state.contextWindow) * 100);
  return (
    `[qwen-guardrails] OpenCode compacted this session. Context is now at ${pct}% of the ` +
    `${state.contextWindow.toLocaleString("en-US")}-token window (${state.contextTokens.toLocaleString("en-US")} tokens). ` +
    `Any earlier note or report saying the context is exhausted or near the limit is stale: do not end the turn for ` +
    `context reasons; continue the current ticket to a commit and PR.`
  );
}

export function contextNudgeText(stage: StageName, tokens: number, window: number): string {
  const pct = Math.round((tokens / window) * 100);
  const head = "[qwen-guardrails] Context is at " + pct + "% of the " + window.toLocaleString("en-US") + "-token window (" + tokens.toLocaleString("en-US") + " tokens).";
  if (stage === "verify") {
    return (
      head + " OpenCode compacts this session by itself before the window fills and a full window follows, so never end, hold or checkpoint a ticket for context reasons. " +
      "Stop exploring: run the named tests on what exists now, then continue the work the spec requires. Delegate bounded reads to subagents (file list and finding, never the transcript)."
    );
  }
  return (
    head + " Compaction will summarize this session soon and the summary keeps SHAs, paths and receipts better than prose: if the named tests are green, commit the complete work now via a message file so the summary carries a SHA; " +
    "if they are not green, keep working (compaction is not a stop) and write the current state into the todo list so the next window resumes exactly here. Never end the ticket for context reasons."
  );
}


/**
 * Fires each stage once per climb. If the first observation is already past several stages, only the most urgent
 * one is spoken and the earlier ones are marked as fired, so a session never receives two budget notes at once.
 */
export function contextNudge(state: SessionState): { stage: StageName; nudge: string } | null {
  if (!state.contextWindow || state.contextTokens <= 0) return null;
  // Right after a compaction the last known size is the PRE-compaction one; re-armed stages must not fire on it
  // (that would re-issue the 70% "write the FINAL REPORT now" note to a session that just shrank to 40%).
  if (state.compactedAt !== null && state.tokenUpdates <= state.compactedAt) return null;
  const reached = CONTEXT_STAGES.filter((s) => state.contextTokens >= s.ratio * state.contextWindow! && !state.fired.has(s.name));
  if (reached.length === 0) return null;
  for (const s of reached) state.fired.add(s.name);
  const top = reached[reached.length - 1];
  return { stage: top.name, nudge: contextNudgeText(top.name, state.contextTokens, state.contextWindow) };
}

/** Provider IDs whose sessions get the context guard by default (comma-separated in QWEN_GUARDRAILS_PROVIDERS). */
export const DEFAULT_GUARDED_PROVIDERS = "vllm";

/**
 * The budget guard needs to know the window. The local Qwen lanes (the providers listed in QWEN_GUARDRAILS_PROVIDERS,
 * default `vllm`) serve 262,144; QWEN_GUARDRAILS_CONTEXT_WINDOW overrides it for experiments; any other provider is
 * left alone (null disables the context guard, the edit guard still runs).
 */
export function contextWindowFor(providerID: string | undefined, env: Record<string, string | undefined>): number | null {
  const override = env.QWEN_GUARDRAILS_CONTEXT_WINDOW;
  if (override !== undefined) {
    if (!/^[1-9][0-9]*$/.test(override)) throw new Error("QWEN_GUARDRAILS_CONTEXT_WINDOW must be a positive integer when set.");
    return Number(override);
  }
  const guarded = String(env.QWEN_GUARDRAILS_PROVIDERS ?? DEFAULT_GUARDED_PROVIDERS).split(",").map((p) => p.trim()).filter(Boolean);
  return providerID && guarded.includes(providerID) ? DEFAULT_CONTEXT_WINDOW : null;
}

/**
 * Repeat guard (2026-09-11 14:01 EDT): a session issued the same `rg` search every two seconds for minutes, thinking
 * collapsed to one fixed line, the tool answering "(no output)" every time. The model never breaks such a cycle by
 * itself because every step's input is byte-identical to the last. Three escalating responses, all keyed on the
 * count of CONSECUTIVE identical calls (same tool, same arguments): a note appended to the result at the third and
 * sixth, a refusal (the tool is not run; the error text is the note) from the eighth, and an abort of the session at
 * the fifteenth so the owner's TUI shows an idle session instead of a spinning one. A different call resets the count.
 */
export const REPEAT_NOTE_AT = 3;
export const REPEAT_NOTE_EVERY = 3;
export const REPEAT_REFUSE_AT = 8;
export const REPEAT_ABORT_AT = 15;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function callKey(tool: string, args: unknown): string {
  return tool + " " + stableJson(args ?? null);
}

export function repeatNote(tool: string, count: number, refused: boolean): string {
  const head = refused
    ? `[qwen-guardrails] REFUSED: this would be consecutive identical call #${count} of ${tool} with the same arguments; it was not run.`
    : `[qwen-guardrails] This is consecutive identical call #${count} of ${tool} with the same arguments.`;
  return (
    `${head} Its last results were identical ("(no output)" from a search means it matched nothing). Do not issue it again unchanged. ` +
    `Write one line stating what the result means, then take a DIFFERENT next step: a different query or path, the next ` +
    `step of the task without this result, or end the turn with INCOMPLETE and the reason.`
  );
}

export type RepeatVerdict = { count: number; note: string | null; refuse: boolean; abort: boolean };

/** Call once per tool invocation, before it runs. */
/** WF-03 (audit 2026-09-13): a repeated call whose RESULT changes is polling, not a loop. Call after the tool
 * ran; identical consecutive results raise `stagnant`, a different result resets it to 1. */
export function recordResult(state: SessionState, tool: string, args: unknown, output: unknown): void {
  const key = callKey(tool, args);
  if (!state.lastCall || state.lastCall.key !== key) return;
  const text = typeof output === "string" ? output : stableJson(output ?? null);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  const hash = String(h) + ":" + text.length;
  state.lastCall.stagnant = state.lastCall.resultHash === hash ? state.lastCall.stagnant + 1 : 1;
  state.lastCall.resultHash = hash;
}

export function recordCall(state: SessionState, tool: string, args: unknown): RepeatVerdict {
  const key = callKey(tool, args);
  const same = !!state.lastCall && state.lastCall.key === key;
  const raw = same ? state.lastCall!.count + 1 : 1;
  // With results recorded, the effective count is the run of IDENTICAL results plus this call; a changing
  // result (a build log growing, a queue draining) never accumulates toward refusal or abort. Without
  // results (a caller that never reports them) the raw count applies, as before.
  const count = same && state.lastCall!.resultHash !== undefined ? state.lastCall!.stagnant + 1 : raw;
  state.lastCall = { key, count: raw, resultHash: same ? state.lastCall!.resultHash : undefined, stagnant: same ? state.lastCall!.stagnant : 0 };
  const refuse = count >= REPEAT_REFUSE_AT;
  const speak = refuse || (count >= REPEAT_NOTE_AT && (count - REPEAT_NOTE_AT) % REPEAT_NOTE_EVERY === 0);
  return { count, note: speak ? repeatNote(tool, count, refuse) : null, refuse, abort: count >= REPEAT_ABORT_AT };
}

/**
 * Command bounds (2026-09-11 16:40 EDT): a command built an empty file list and ran `pytest -n auto`
 * with no paths, collecting the whole backend suite. OpenCode kills one command at its default 10 minutes, but a
 * model may ask for more and may retry. Two bounds: every bash timeout is capped at BASH_TIMEOUT_CAP_MS, and a
 * pytest invocation that names no test path and no list variable is refused before it runs.
 */
export const BASH_TIMEOUT_CAP_MS = 20 * 60 * 1000;
const PYTEST_RE = /(^|[;&|]\s*)(py(thon)?(3)?(\s+-3\.\d+)?\s+-m\s+pytest|pytest)(\s|$)/;
// A pytest ARGUMENT that names something to collect: any .py path (quoted or not, test_-prefixed or not), a
// node id, a tests directory, -k, or a collect-only flag. Judged on the invocation's own tokens, not on the
// whole command line (2026-09-11 23:10 EDT: the whole-line regex refused an explicit single .py file that
// was not test_-prefixed, and a `$f` list variable, six times in one reviewer session).
const PATH_TOKEN_RE = /(\.py["']?$|::|(^|[\/\\])tests?([\/\\]|["']?$)|^--co$|^--collect-only$|^-k$)/;
const VAR_TOKEN_RE = /^["']?[$@][\w{(]/;

function pytestTokens(command: string): string[] | null {
  const m = PYTEST_RE.exec(command);
  if (!m) return null;
  const rest = command.slice(m.index + m[0].length);
  const end = rest.search(/(\s\|\s|\s*;|\s&&|\s\|\||\s2>|\r?\n)/);
  const segment = end === -1 ? rest : rest.slice(0, end);
  return segment.trim().split(/\s+/).filter(Boolean);
}

export type CommandVerdict = { timeoutMs: number | null; refuse: string | null; note: string | null };

export function boundCommand(args: { command?: unknown; timeout?: unknown } | undefined): CommandVerdict {
  const command = typeof args?.command === "string" ? args.command : "";
  let timeoutMs: number | null = null;
  if (typeof args?.timeout === "number" && args.timeout > BASH_TIMEOUT_CAP_MS) timeoutMs = BASH_TIMEOUT_CAP_MS;
  const tokens = pytestTokens(command);
  if (tokens === null) return { timeoutMs, refuse: null, note: null };
  const hasPath = tokens.some((t) => PATH_TOKEN_RE.test(t));
  const hasVar = tokens.some((t) => VAR_TOKEN_RE.test(t)) || /\bxargs\b/.test(command);
  if (!hasPath && !hasVar) {
    return {
      timeoutMs,
      refuse:
        "[qwen-guardrails] REFUSED: this pytest command names no test path, so it would collect the ENTIRE suite " +
        "(thousands of tests, tens of minutes). Pass explicit test files, or a list variable whose count you have " +
        "printed and confirmed is greater than zero.",
      note: null,
    };
  }
  const note = hasVar && !hasPath
    ? "[qwen-guardrails] This pytest command takes its files from a variable. If that list was empty, pytest just " +
      "collected the whole suite: confirm the printed count was greater than zero before trusting this result."
    : null;
  return { timeoutMs, refuse: null, note };
}

// ---- Graphify dependency-analysis nudge (owner, 2026-09-13 01:45 EDT) ------------------------------------------------
// The lane made 10,999 tool calls on 2026-09-12/13 and called a Graphify verb zero times; the project's rules require
// the verbs (or a recorded refusal) before a multi-module change. This nudge fires at the tail of a tool result when the
// session has edited a second distinct backend module without calling a verb since, and when it delegates a mapping to
// an explore/planner/architect subagent without having called one. Never the system prompt (prefix cache).
// The verbs are the tools of a Graphify MCP server; OpenCode names an MCP tool `<server>_<tool>`, so the server name
// comes from QWEN_GUARDRAILS_GRAPH_SERVER (default `code-graph`). Any server prefix counts as a verb call.
// The plugin only runs this nudge when QWEN_GUARDRAILS_GRAPHIFY=1.
export const GRAPH_SERVER = process.env.QWEN_GUARDRAILS_GRAPH_SERVER || "code-graph";
const verb = (name: string) => `${GRAPH_SERVER}_${name}`;
export const GRAPHIFY_VERB_RE = /^(?:[\w-]+_)?(graphify_affected|explain_module|graphify_path|graphify_query)$/;
export const GRAPHIFY_NUDGE_EVERY = 12;
export const GRAPHIFY_MAPPING_AGENTS = new Set(["explore", "planner", "architect", "code-architect", "code-explorer"]);

/** The backend module a path names (relative to backend/), or null for tests, scripts, non-Python and non-backend files. */
export function backendModuleOf(filePath: string): string | null {
  const p = normalizeFile(filePath);
  const i = p.lastIndexOf("/backend/");
  if (i < 0 || !p.endsWith(".py")) return null;
  const rel = p.slice(i + "/backend/".length);
  if (rel.startsWith("tests/") || rel.includes("/tests/") || rel.startsWith("scripts/")) return null;
  return rel;
}

/** The graph labels modules by file basename. */
export function graphifyTarget(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

export function graphifyNudgeText(modules: string[]): string {
  const targets = modules.map((m) => `{"target": "${graphifyTarget(m)}"}`).join(", ");
  const baseApp = modules.filter((m) => !m.includes("/"));
  const baseNote = baseApp.length
    ? ` Base-app modules (${baseApp.join(", ")}) are in no graph profile: record that refusal verbatim and do the source-based analysis for them.`
    : "";
  return (
    `DEPENDENCY ANALYSIS: this session has edited ${modules.length} backend modules (${modules.join(", ")}) without a Graphify verb on them. ` +
    `Call ${verb("graphify_affected")} and ${verb("explain_module")} for each (targets are graph labels: a module by file basename, ${targets}; a function as name(), e.g. {"target": "advance_coverage()"}; ` +
    `${verb("graphify_path")} {"source", "target"} for a producer-to-consumer route). ` +
    `Verify the answers in your worktree's source (the graph is built from the main checkout at its own HEAD; name that revision) and record them or the refusal under ` +
    "`## Dependency analysis` in the PR body." + baseNote
  );
}


export function graphifyDelegationText(): string {
  return (
    `DEPENDENCY ANALYSIS: before delegating a code mapping to a subagent, call ${verb("explain_module")}, ${verb("graphify_affected")} ` +
    `or ${verb("graphify_path")} yourself on the modules in question` + '  (targets are file basenames as the graph labels them, e.g. {"target": "coverage.py"}); ' +
    "one verb call answers what an explore subagent spends minutes reading, and its output belongs under `## Dependency analysis` in the PR body."
  );
}

/** Record a tool call for the Graphify nudge and return the note to append, if any. Called from tool.execute.after. */
export function graphifyNudge(state: SessionState, tool: string, args: unknown): string | null {
  const g = state.graphify;
  g.toolCalls += 1;
  const a = (args ?? {}) as Record<string, unknown>;
  if (GRAPHIFY_VERB_RE.test(tool)) {
    g.verbs += 1;
    for (const key of ["target", "source"]) {
      const v = a[key];
      if (typeof v !== "string") continue;
      const label = graphifyTarget(v.replace(/\\/g, "/")).replace(/\(\)$/, "").toLowerCase();
      g.analyzed.add(label);
      for (const m of [...g.modulesSinceVerb]) if (graphifyTarget(m).toLowerCase() === label || m.toLowerCase().endsWith("/" + label) || m.toLowerCase() === label) g.modulesSinceVerb.delete(m);
    }
    return null;
  }
  if ((tool === "edit" || tool === "write") && typeof a.filePath === "string") {
    const mod = backendModuleOf(a.filePath);
    if (mod && !g.analyzed.has(graphifyTarget(mod).toLowerCase())) g.modulesSinceVerb.add(mod);
  }
  if (g.toolCalls - g.nudgedAt < GRAPHIFY_NUDGE_EVERY) return null;
  if (g.modulesSinceVerb.size >= 2) {
    g.nudgedAt = g.toolCalls;
    return graphifyNudgeText([...g.modulesSinceVerb].sort());
  }
  const sub = typeof a.subagent_type === "string" ? a.subagent_type : typeof a.subagentType === "string" ? a.subagentType : "";
  if (tool === "task" && GRAPHIFY_MAPPING_AGENTS.has(sub) && g.verbs === 0) {
    g.nudgedAt = g.toolCalls;
    return graphifyDelegationText();
  }
  return null;
}


// ---- gh --jq string building in PowerShell (owner, 2026-09-13 01:50 EDT) -------------------------------------------
// PowerShell splits a jq expression that carries quotes, `+` or `|` into several arguments, gh then errors, and the
// lane burns turns rewriting the call. A field path (`.state`, `.[0].name`) survives; anything else is refused with
// the ConvertFrom-Json form the lane must use instead.
export const JQ_FLAG_RE = /--jq(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g;
export const JQ_SIMPLE_RE = /^[.\w\[\]"'?-]*$/;

export function ghJqVerdict(command: string): string | null {
  if (!/\bgh\b/.test(command)) return null;
  for (const m of command.matchAll(JQ_FLAG_RE)) {
    const expr = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!expr) continue;
    if (/[+|(){}]|"\s*"|\bif\b|\bselect\b|\bjoin\b|\btostring\b|\bmap\b/.test(expr) || !JQ_SIMPLE_RE.test(expr.replace(/\s+/g, ""))) {
      return (
        `Refused: --jq expression \`${expr.slice(0, 80)}\` builds strings or filters, which PowerShell splits into separate arguments. ` +
        "Request the fields with --json and read them in PowerShell instead, e.g. `$r = gh pr view N --json state,mergedAt | ConvertFrom-Json; " +
        "\"$($r.state) $($r.mergedAt)\"`. A bare field path such as --jq .state is allowed."
      );
    }
  }
  return null;
}

// ---- waiting on CI or the judge (owner throughput rule, 2026-09-13 03:50 EDT) ----------------------------------------
// Lane A slept 240 s and polled `gh pr checks` waiting for a run instead of taking the next todo. CI and merges are the
// judge's job; a lane never waits. Long sleeps and CI/run polling are refused with the rule, short sleeps (< 20 s) pass.
export const WAIT_SLEEP_MAX_S = 20;
export const WAIT_POLL_RE = /\bgh\s+(pr\s+checks|run\s+(watch|list|view)|api\s+[^\n|]*\/actions\/)/;
export const WAIT_SLEEP_RE = /(?:^|[\s;&|(])(?:Start-Sleep(?:\s+-Seconds)?|sleep|timeout\s+\/t)\s+(\d+)/gi;

export function waitVerdict(command: string): string | null {
  if (WAIT_POLL_RE.test(command)) {
    return (
      "Refused: polling CI or workflow runs (gh pr checks, gh run ..., actions API) is the judge's job; a lane never waits on a run or a verdict. " +
      "Push complete work, then take the NEXT actionable todo at once; the judge reads CI, merges, and updates the operator note when your work changes."
    );
  }
  for (const m of command.matchAll(WAIT_SLEEP_RE)) {
    const s = Number(m[1]);
    if (s >= WAIT_SLEEP_MAX_S) {
      return (
        `Refused: a ${s} s sleep is waiting, and a lane never waits (on CI, Codex, the judge, or a queue). ` +
        "If you are waiting for a process you started, read its log or receipt instead; otherwise take the NEXT actionable todo now."
      );
    }
  }
  return null;
}
