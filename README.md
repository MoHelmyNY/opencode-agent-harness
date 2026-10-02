# opencode-agent-harness

Six [OpenCode](https://opencode.ai) plugins for running coding agents unattended, most of all on a **local model**
(a Qwen model served by vLLM, sharing one GPU's KV cache between several sessions). Each plugin exists because of a
specific failure seen in long autonomous runs. The header comment of every file records that failure and the
reasoning behind each design decision; this README summarizes them.

| Plugin | Problem it solves |
| --- | --- |
| `loop-continuation.ts` | An OpenCode session only works while a turn is open, so an autonomous loop stops whenever the model ends its turn. This plugin keeps it going without a human typing "continue". |
| `subagent-cap.ts` | A local engine's KV pool serves only a few live requests. One message that launches five subagents makes every request evict another's cache. |
| `stall-watchdog.ts` | A subagent waits forever on a permission prompt nobody can answer, or a tool call never returns. |
| `qwen-guardrails.ts` | Local models loop: the same edit to one file, or the same search, over and over. They also give up "for context reasons" right after a compaction. |
| `framework-readonly.ts` | An agent that hits a guard tries to "fix" the guard itself by editing its own harness config. |
| `project-memory.ts` | Each new session starts from nothing. This plugin briefs it from a memory service and records commits and verified results back. |

Supporting pure logic lives in `guardrails/`, outside `plugins/`, for a reason explained under
[Plugin-loader rules](#plugin-loader-rules-that-shaped-the-code).

## The plugins

### loop-continuation

A session **arms** when the owner's message starts with `# Loop Start Command`, contains `/loop-start`, or starts
with `continue the loop`. When an armed session goes idle and its todo list still has actionable items, the plugin
waits a debounce (`LOOP_CONTINUATION_DEBOUNCE_MS`, default 30 s; a human who is typing wins), checks again, and sends
the next prompt through the SDK. Child (subagent) sessions are never looped.

Key decisions:

- **It never stops on its own while actionable work remains.** The only exits are:
  - an empty actionable queue;
  - the owner writing "stop the loop";
  - a global stop file, `~/.local/state/opencode/loop-continuation.stop`.
- **It backs off instead of disarming.** One day it re-prompted three lanes 988, 690 and 488 times at about 39 s
  intervals, all on blocked work. Now:
  - stalls 0-1 keep the debounce;
  - stalls 2-4 wait 5 minutes (`LOOP_CONTINUATION_BACKOFF_MS`);
  - stalls 5 and above wait 30 minutes (`LOOP_CONTINUATION_LONG_BACKOFF_MS`).
- **What counts as progress.** Only three things reset the stall counter:
  - a commit;
  - a change in the text of the *next* todo;
  - a change in the active ticket's ledger signature (phase, head, open findings, assignment).

  Bookkeeping does not count: appending to an event log once hid 22 identical re-prompts.
- **Parking words.** A todo with `BLOCKED`, `PARKED`, `ESCALATED`, `WAITING ON`, `OWNER RULING(S)`, `OWNER-ONLY` or
  `FINAL` anywhere in its first 40 characters (case-insensitive) is not actionable. The old column-0 anchor missed
  `E1 #1860 BLOCKED: ...`, which is how the 488 re-prompts happened.
- **Per-directory operator note.** The note lives at `~/.local/state/opencode/loop-head/<slug>.txt`, and the slug comes
  from the working directory. It is prepended to every continuation and can be edited without a restart. Scoping it
  per directory stops one project's rules leaking into another's loop.
  - A note above `LOOP_CONTINUATION_NOTE_MAX_TOKENS` (default 4000, estimated as bytes/4) is withheld, with a receipt,
    because it would be paid for on every turn.
  - A `QUEUE: [J1] ...; [J2] ...` line keeps the loop alive when the todo list is empty.
  - A `LANE KIND: <kind>` line swaps the PR-sweep prompt for "follow the operator note".
- **Note-kick.** A lane that finished its queue is re-armed automatically, inside the TUI, once its note lists new
  `QUEUE` items. The note is re-checked every 60 s (`LOOP_CONTINUATION_NOTE_KICK_MS`, 0 = off).
- **Compaction before continuing.** When the last turn's context is past a fraction of the window, the plugin compacts
  through the SDK first. The fraction is `LOOP_CONTINUATION_COMPACT_AT` (default 0.5), and the file
  `~/.local/state/opencode/loop-compact-at.txt` overrides it per continuation. At 0.7, three contexts sharing one 428K
  KV pool could never fit together, and throughput fell to a mean of 42.8 tok/s for an hour.
- **Optional fresh-session mode.** Set `LOOP_CONTINUATION_FRESH_SESSION=1` to send each continuation to a new session.
  The state lives on disk, so the conversation is disposable. A released session can never respawn a fresh one from
  its own history.
- **Optional chain mode.** A directory with an enabled `.agent-workflow/workflow.json` (schema 1, `chain.enabled: true`)
  gets a chain prompt that drives an external ticket CLI. `AGENT_WORKFLOW_CLI` names it; the default is `aw`.

Receipts: `~/.local/state/opencode/loop-continuation.jsonl`, one JSON line per decision.

### subagent-cap

At most `SUBAGENT_CAP` (default 2) task-tool subagents run at once for sessions on a **local** provider. Extra calls
wait in line, first come first served; they never fail. API models are not capped.

- Which providers count as local: `SUBAGENT_CAP_PROVIDERS`, comma-separated. The default is
  `vllm,ollama,lmstudio,llama,llama-cpp,local`.
- Why 2: the parent is blocked while its subagent runs, so it does not count toward the cap.
- OpenCode has no built-in setting for this. Its `subagent_depth` limits nesting, not concurrency.
- A slot is freed in `tool.execute.after`. As a safety net it is also freed after `SUBAGENT_CAP_MAX_HOLD_MS` (default
  40 min), so an aborted call cannot lock the lane.
- The cap applies per OpenCode process.

### stall-watchdog

1. **Read-only permission asks are allowed** without a prompt: `read`, `grep`, `glob` and `list`, and an
   external-directory read under the working directory, OpenCode's temp directory, the framework state directory, or
   `STALL_WATCHDOG_READ_ROOTS`. Anything that names a secrets path (`.secrets`, `.env`, `keys.json`, `id_rsa`, `*.pem`)
   still asks.
2. **A hung tool call is aborted.**
   - Thresholds: 5 min by default (`STALL_WATCHDOG_MS`). `task` is never aborted, because a parent legitimately waits on
     its child.
   - A busy engine defers the abort until twice the threshold. "Busy" is read from vLLM's
     `vllm:num_requests_running` at `STALL_WATCHDOG_METRICS`, default `http://127.0.0.1:8000/metrics`.
   - Before aborting, the session store is consulted. A call the store no longer shows as running is only cleared. A
     guard-refused call once sat in memory for 26 minutes and the abort killed an unrelated live session.
3. **Bash calls get a timeout that holds.**
   - On Windows, `Start-Process` with `-RedirectStandard*` or `-NoNewWindow` and no `-Wait` hands the tool's stdout pipe
     to the child. OpenCode then waits for EOF, and its own timeout never fires (one such call ran 372 s). Such a
     launch is refused before it runs, and the error shows the working form.
   - Every bash call is aborted once it outlives its own timeout (OpenCode's default is 120 s) plus
     `STALL_WATCHDOG_BASH_GRACE_MS` (60 s), capped at `STALL_WATCHDOG_BASH_MS` (25 min).
   - A call's clock pauses while a permission prompt for its session is open. In a 14-day scan, 4 of 17,962
     timeout-less bash calls ran past 180 s, and one of them was the owner thinking.

`STALL_WATCHDOG_DISABLED=1` turns the plugin off.

### qwen-guardrails

Notes are appended to a tool **result**, which sits at the tail of the prompt, so the engine's cached prefix is never
invalidated. A system-prompt change would re-prefill the whole conversation. No note ever tells the model to hurry.

- **Edit-loop note.** It fires at the 6th, 10th and 14th edit to one file.
  - Evidence: of 47 sessions of one project that edited files, 15 edited one file six or more times and 7 ten or more.
  - Modelled on LangChain's harness-engineering write-up.
- **Repeat guard** for identical consecutive calls with identical results:
  - a note at the 3rd and 6th call;
  - refusal from the 8th;
  - a session abort at the 15th, which writes a blocked record that `loop-continuation` honours.

  A repeated call whose result *changes* is polling, not a loop, and never escalates.
- **Context-budget notes** at 50% and 70% of the window, plus a one-time "you were compacted, the context is now N%"
  note. After a compaction, models kept repeating "context exhausted at 99%" when the real size was 40%.
  - Applies to providers in `QWEN_GUARDRAILS_PROVIDERS` (default `vllm`), with a 262,144-token window or
    `QWEN_GUARDRAILS_CONTEXT_WINDOW`.
- **Command bounds.**
  - Bash timeouts are capped at 20 min.
  - A `pytest` that names no test path is refused before it collects an entire suite.
  - A `gh --jq` expression that PowerShell would split is refused, with the `ConvertFrom-Json` form shown.
  - Sleeps of 20 s or more, and CI polling, are refused: a lane never waits.
- **Optional Graphify nudge** (`QWEN_GUARDRAILS_GRAPHIFY=1`). It asks for dependency-analysis tool calls before a
  multi-module change; one lane once made 10,999 tool calls without a single one. The MCP server name is
  `QWEN_GUARDRAILS_GRAPH_SERVER` (default `code-graph`).

Receipts: `~/.local/state/opencode/qwen-guardrails.jsonl`.

### framework-readonly

A working agent may read its own harness but never change it. Edits, patches, moves and mutating shell commands are
refused before they run when they name any of these:

- the workflow framework (`AGENT_WORKFLOW_HOME`, default `~/agent-workflow-lab`);
- OpenCode's config directory;
- the loop's operator notes;
- the repo's `.agent-workflow` config.

Junctions and symlinks are resolved, so an alias cannot disguise a protected target. What stays allowed:

- read-only inspection, including a small allowlist of read-only pipeline stages such as `Select-Object` and
  `ConvertFrom-Json`;
- the framework's fixed ticket entry points;
- writes to the lane's own ticket state.

The refusal text says the command was **not executed**, so the model never mistakes it for file content.

### project-memory

This plugin is a client for a memory service you run yourself; no server is included. It speaks three HTTP routes
(`POST /v1/adapter/bootstrap`, `/checkpoint`, `/finish`) with bearer auth taken from an environment variable.

- **Briefing.** Once per primary session, the bootstrap text is injected into the system prompt.
  - The block is **byte-identical for the whole session**: fetched once, cached in memory and on disk. A per-request
    timestamp in an injected block once froze the engine's prefix-cache hits at 51,712 tokens for a day.
  - A failed bootstrap writes an empty sentinel, so a plugin reload can never insert a block mid-conversation.
- **Capture** after a tool call:
  - a `git commit` that git confirmed and that is this directory's HEAD;
  - a verify command (`capture.verify_command`, a regex) whose output says it passed.

  Captures are debounced to one per minute per session. Memory self-events are excluded, and anything that matches a
  secret pattern is dropped.
- **Finish** on idle: once the todo list exists with nothing open, or after 10 idle minutes.
- **Timeouts.** Bootstrap sits on the first turn's critical path and times out at 8 s. Writes get 60 s: a real retain
  took about 24 s, and an 8 s write deadline once logged a stored note as failed.
- **Never in the way.** Any error means "memory unavailable": a receipt is written, one toast is shown, and the session
  continues untouched. The token never reaches a receipt, log or toast.

Config: `~/.config/opencode/project-memory.json`, or the path in `PROJECT_MEMORY_CONFIG`:

```json
{
  "schema_version": 1,
  "gateway_url": "http://127.0.0.1:<port>",
  "token_env": "PROJECT_MEMORY_TOKEN",
  "directories": { "home-me-projects-app": { "enabled": true, "project_id": "app" } },
  "capture": { "on_commit": true, "on_verify_receipt": true, "on_session_end": true, "verify_command": "make\\s+verify" },
  "briefing": { "max_chars": 6000 }
}
```

The directory key is the working directory lower-cased, with every run of non-alphanumerics replaced by `-`. A
directory with no entry, or a config with no `gateway_url`, gets no hooks at all.

## Plugin-loader rules that shaped the code

- **OpenCode calls every export of a plugin module as a plugin factory** and reads `.config` off the result.
  - An export that returns `null` kills server startup ("null is not an object (evaluating 'N.config')").
  - An export that is not a function throws.

  So each file in `plugins/` exports its factory and, at most, helpers that tolerate being called with the plugin
  input. Constants and pure logic live in `guardrails/`, and tests assert that every export survives the call.
- **Plugins load once, at startup.** Restart OpenCode after changing one. The operator note and
  `loop-compact-at.txt` are read on every continuation, so those need no restart.

## Install

OpenCode loads every file in `~/.config/opencode/plugins/` (global) or `<project>/.opencode/plugins/` (project) at
startup. The plugins import `../guardrails/`, so copy both folders side by side, and **not** `guardrails/` inside
`plugins/`, or OpenCode would load the helpers as plugins:

```sh
# global install (Linux/macOS; on Windows the same folders under %USERPROFILE%\.config\opencode)
mkdir -p ~/.config/opencode/plugins ~/.config/opencode/guardrails
cp plugins/*.ts    ~/.config/opencode/plugins/
cp guardrails/*.ts ~/.config/opencode/guardrails/
```

Copy only the plugins you want; the `guardrails/` modules are shared. There are no npm dependencies; the plugins use
only Node built-ins, which OpenCode's Bun runtime provides. Restart OpenCode afterwards.

## Tests

Requires [Bun](https://bun.sh) and `git`. No install step:

```sh
bun test
```

The tests use temp directories for all state, so they never touch your real `~/.local/state/opencode` or config. The
`project-memory` tests run a fake gateway on a random loopback port and create throwaway git repos. The three test files
that spawn `git` raise bun's per-test timeout to 60 s, because a git call can take several seconds where process start
is slow.

## Evals

The tests above check that each piece still works. The eval checks whether the harness, run as a whole, still does
its job, and lets one run be compared with the next. The distinction is the one Marmelab's
[State of AI Harness Engineering 2026](https://marmelab.com/blog/2026/09/24/the-state-of-ai-harness-engineering-2026.html)
draws (François Zaninotto, 24 September 2026):

- "A test tells you a script still works": a reproducible check, in code, that a function or hook behaves.
- "An eval tells you the harness helps": freeze a set of tasks, run them end to end, and score the outcomes, so a
  change to the harness can be seen to improve or degrade its behavior.

```sh
bun run eval                    # run the frozen set, print the scorecard, record the result
bun run eval -- --no-record     # print only
bun run eval -- --only <id>     # one scenario (never recorded)
bun run eval:freeze             # rewrite the manifest after a deliberate change to the set
```

**What is frozen.** `evals/scenarios/*.json` holds 16 scenarios. Each declares:

- the plugins under test;
- its inputs: sessions, todos, files, scripted model behavior;
- an event timeline;
- the expected outcome in words;
- a scoring rule: pass rules over named metrics, plus the numbers to report.

`evals/manifest.json` lists every scenario file with its SHA-256. `evals/run.ts` refuses to run (exit 2) when a hash
differs, a listed file is missing or an unlisted file is present, so the set cannot move silently. `.gitattributes`
keeps the files LF on every platform, so the hashes hold on any checkout.

**What it records.** Each run writes `evals/results/<UTC timestamp>.json` and appends the same object to
`evals/results/history.jsonl`. The object holds:

- the harness commit;
- whether `plugins/` or `guardrails/` had uncommitted changes;
- a SHA-256 of that code;
- the manifest's own hash, so only runs of the same set are compared;
- each scenario's checks and measured numbers;
- totals.

The exit code is 0 only when every scenario passes.

| Scenario | Behavior scored |
| --- | --- |
| `loop-01-continue-actionable` | An armed, idle session with actionable todos is continued once, after the 30 s debounce, on the next actionable todo. |
| `loop-02-idle-no-actionable-work` | With no actionable work and no QUEUE, nothing is sent and the loop disarms. |
| `loop-03-parking-word-mid-text` | `E1 #1860 BLOCKED: ...`, `OWNER-ONLY` and `ESCALATED` inside the first 40 characters park a todo. |
| `loop-04-backoff-blocked-repeat` | A blocked task repeating for 2 simulated hours: the re-prompts stay bounded, and the loop never disarms. |
| `loop-05-progress-resets-brake` | A lane that commits every turn is never backed off. |
| `loop-06-owner-stop` | "stop the loop" cancels the pending continuation and ends the loop. |
| `subagent-01-third-call-queues-fifo` | Five subagents on a local model: two run, the rest queue in arrival order, none fails. |
| `subagent-02-api-model-uncapped` | The same five on an API model all start at once. |
| `watchdog-01-hung-tool-aborted` | A hung `grep` is aborted at the 5 min threshold; the parent's `task` call is not. |
| `watchdog-02-busy-engine-defers` | With the engine busy, the abort waits for twice the threshold. |
| `framework-01-protected-writes-refused` | Six attempts to edit, patch or shell-write the harness's own files are refused, and the files keep their bytes. |
| `framework-02-ordinary-work-allowed` | The control: worktree edits and reads of the protected config go through. |
| `guardrails-01-edit-loop-nudge-in-tool-output` | Fifteen edits to one file: nudges land in the results of edits 6, 10 and 14, and the system prompt never changes. |
| `guardrails-02-identical-repeat-refused` | An identical search with identical results is noted at calls 3 and 6, then refused from the 8th. |
| `memory-01-briefing-byte-identical` | 30 requests, a second message and a plugin reload: one distinct system prompt and one gateway fetch, although the gateway answers differently every time. |
| `memory-02-failed-bootstrap-no-midsession-block` | A briefing that failed at the start never appears later in the session, even after the gateway recovers. |

**How it runs, and what it is not.** The scenarios call the plugins' real exported hooks, and the plugins write their
real receipts.

- **Simulated, not live.** The model and the OpenCode client are simulated. The "model" is a script: a turn lasts a
  set time, makes the tool calls the scenario lists, then the session goes idle. The client is an in-memory session
  store. **No live model is called**, so the eval scores how the harness responds to a given model behavior. It catches
  a harness change that breaks or weakens a behavior. It does not show that a real model finishes more work with the
  harness than without it.
- **Hook order.** Hooks run in OpenCode 1.18's order. Plugins are awaited in load order, and a throw in
  `tool.execute.before` stops the call, so neither the tool nor `tool.execute.after` runs.
- **Virtual time.** `Date.now` and the timers are replaced during a scenario, so every plugin runs at its **shipped
  defaults** and two simulated hours take seconds. After each timer, the runner waits in real time for the plugins'
  async work to go quiet.
- **No behavior knobs are set.** The eval sets none of the plugins' behavior knobs. It points only paths at a temp
  sandbox (`HOME`, `USERPROFILE`, `XDG_STATE_HOME` and the workflow and memory config paths), and it points vLLM's
  metrics URL and the memory gateway at loopback fakes. Nothing touches your real config or state.
- **Speed.** A full run takes about 15 s.

**Baseline.** [`evals/results/2026-10-02T08-51-56-632Z.json`](evals/results/2026-10-02T08-51-56-632Z.json) was
recorded on harness commit `1de7d46`, with the plugins unmodified, under Bun 1.4.0. It scored **16/16 scenarios and
54/54 checks**. Its numbers:

- **Loop backoff.** A blocked task repeating for two simulated hours got **8 continuations**, against about 184 with
  no brake. They came at 30 s, 69 s, then 5-minute and 30-minute waits; the longest gap was 30.65 min, and the loop
  never disarmed.
- **Progress.** A lane committing every turn got 92 continuations in an hour with 0 backoffs.
- **Subagents.** Of five on a local model, the queued three were admitted in order t3, t4, t5, after 11, 21 and 31 s.
  Never more than 2 ran at once, and 0 failed.
- **Watchdog.** A hung `grep` was aborted **314 s** after it started (5 min threshold plus the 15 s tick phase), or
  **600 s** with the engine busy.
- **Read-only guard.** **6/6** harness writes were refused, with 0 protected bytes changed; 5/5 ordinary calls were
  allowed.
- **Edit loop.** Nudges landed in the results of edits **6, 10 and 14**, with 0 system-prompt blocks added.
- **Memory.** 30 requests produced **1 distinct system prompt** from 1 bootstrap call.

**The eval can fail (mutation check).** Two behaviors were broken on purpose, the eval was run, and the change was
reverted (`git diff --exit-code plugins guardrails` clean afterwards):

| Mutation | Result |
| --- | --- |
| Backoff disabled (`backoffFor` returns 0) | 15/16. `loop-04` fails: 184 continuations in two simulated hours, one every 39 s, against a bound of 10; longest backoff 0 min. |
| Read-only guard disabled (`tool.execute.before` returns at once) | 15/16. `framework-01` fails: 0 of 6 writes refused, 4 protected files changed. |

In each case the failing scenario was the one covering the broken behavior, and the other 15 still passed.

**A finding the eval surfaced.** `guardrails-02` reports 0 session aborts, although the repeat guard is documented
above to abort at the 15th identical call.

- **Why.** The guard counts a run of identical *results*, and a result is recorded in `tool.execute.after`. OpenCode
  (1.18.29, `Plugin.trigger`) skips `tool.execute.after` for a call that `tool.execute.before` refused. So from the
  8th call on, every repeat is refused and the count stays at 8. The abort never fires, and neither does the blocked
  record that `loop-continuation` honours.
- **Why the unit test missed it.** It reaches 15 because it records a result for refused calls as well.
- **Status.** The scenario scores the refusals, which do hold, and reports the abort count, so a fix will show up as
  a change in the recorded numbers.

## License

MIT. See [LICENSE](LICENSE).
