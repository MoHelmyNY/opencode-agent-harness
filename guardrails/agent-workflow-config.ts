/**
 * Pure logic shared by the plugins in ../plugins (loop-continuation, framework-readonly, project-memory).
 * It lives outside plugins/ on purpose: OpenCode's loader (packages/opencode/src/plugin/index.ts, getLegacyPlugins)
 * calls EVERY export of a plugin module as a plugin and throws "Plugin export is not a function" on a non-function
 * export, so a string constant such as CHAIN_PROMPT can only be exported from here.
 *
 * Config resolution (same order as the workflow framework's own config loader): <git toplevel>/.agent-workflow/workflow.json,
 * then <AGENT_WORKFLOW_CONFIG_HOME or ~/.config/opencode/agent-workflow>/<slug>.json, where the slug is the loop's
 * operator-note slug of the working directory ("/home/me/projects/app-b" -> "home-me-projects-app-b").
 * No file, chain.enabled !== true or schema_version !== 1 means "no chain" and the plugins stay silent.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type WorkflowConfig = {
  schema_version: number;
  // fresh_continuation (owner directive 2026-09-16): the loop plugin continues the chain in a NEW session each time.
  chain?: { enabled?: boolean; gate_mode?: "off" | "shadow" | "enforce"; max_repair_rounds?: number; fresh_continuation?: boolean };
  lane?: { id?: string; directory?: string; worktree_root?: string; artifact_prefix?: string };
  state_dir?: string;
  [key: string]: unknown;
};

/** The workflow framework's home: AGENT_WORKFLOW_HOME, else ~/agent-workflow-lab. */
export function frameworkHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env?.AGENT_WORKFLOW_HOME ? expandHome(env.AGENT_WORKFLOW_HOME) : path.join(os.homedir(), "agent-workflow-lab"));
}

/** The ticket CLI the chain prompt names: AGENT_WORKFLOW_CLI (e.g. `& ~/agent-workflow-lab/bin/aw.ps1`), else `aw`. */
const CHAIN_CLI = process.env.AGENT_WORKFLOW_CLI || "aw";

/** Chain continuation prompt (design plan section 4: a PR is handoff_pr_open, never completion). */
export const CHAIN_PROMPT =
  "Continue the chain. This lane runs the Manager/Finder/Worker/Verifier/Reviewer chain; the procedure and every standing rule are in the agent-workflow-chain skill (load it once per session and follow it; the operator note holds only the queue, the board and lane facts). Every bookkeeping step is one plain command `" + CHAIN_CLI + " ticket --config <config> <subcommand> --ticket <N>`. Order each continuation: (1) for every open PR THIS lane opened, run `judge-sync --ticket <N> --pr <PR>` (a PR whose ticket has no ledger yet: `ticket adopt --ticket <N> --pr <PR>` first); if the phase is judge_changes_requested, repair EVERY open finding in ONE candidate through verify, handoff, reviewer, review-result, push, thread replies, then leave that PR until the next verdict. (2) Take the NEXT todo that is pending or in_progress and not marked BLOCKED, PARKED, OWNER-ONLY, OWNER RULINGS or FINAL; run `ticket open` for it (a ticket with a ledger: it RESUMES and prints next_step; follow next_step, never restart from the brief). (3) If next_step.actionable is false, rewrite that todo as `BLOCKED: waiting on judge #<N> (phase <phase>, head <sha9>)` and take the next todo; when nothing actionable remains, stop: the loop backs off and the judge or owner re-arms it. Push EXACTLY the reviewed head; a commit after PASS is a new head that needs verify, handoff and review again. A PR is a handoff, not completion: after `gh pr create` run `ticket pr-opened` and `ticket status` and write the todo text it prints; mark a todo completed ONLY when `ticket status` prints loop_complete: true; task_complete: true is the owner's acceptance gate and is NOT required to finish the loop. Never claim a check you did not run, never edit outside the ticket's allowed paths, never push to a PR the judge is reviewing, never wait for a human. OpenCode compacts the session by itself; never end or hold a ticket for context reasons.";

/** Identical to loop-continuation's operator-note slug. */
export function slugOf(directory: unknown): string {
  return String(directory ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

/** Expands a leading `~` (the config's state_dir and operator_note use it). */
export function expandHome(p: string): string {
  const s = String(p ?? "");
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Operator-side config directory: AGENT_WORKFLOW_CONFIG_HOME, else ~/.config/opencode/agent-workflow. */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AGENT_WORKFLOW_CONFIG_HOME;
  return fromEnv ? expandHome(fromEnv) : path.join(os.homedir(), ".config", "opencode", "agent-workflow");
}

function gitToplevel(directory: string): string {
  try {
    if (!directory || !fs.existsSync(directory)) return directory;
    const out = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    return out || directory;
  } catch {
    return directory;
  }
}

/** The config path for a working directory: the repo file when it exists, else the operator-side slug file. */
export function resolveConfigPath(directory: unknown, home?: string): string {
  const dir = typeof directory === "string" ? directory : "";
  const repoFile = path.join(gitToplevel(dir) || dir || ".", ".agent-workflow", "workflow.json");
  if (dir && fs.existsSync(repoFile)) return repoFile;
  return path.join(home || configHome(), `${slugOf(dir)}.json`);
}

/** Parsed config, or null when absent, unreadable, not schema 1 or chain.enabled !== true. Never throws. */
export function loadConfig(configPath: unknown): WorkflowConfig | null {
  if (typeof configPath !== "string" || !configPath) return null;
  try {
    const raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
    if (cfg.schema_version !== 1) return null;
    if (cfg.chain?.enabled !== true) return null;
    return cfg as WorkflowConfig;
  } catch {
    return null;
  }
}

/** True when the directory has an enabled chain config (what loop-continuation reads once at load). */
export function chainEnabledFor(directory: unknown, home?: string): boolean {
  return loadConfig(resolveConfigPath(directory, home)) !== null;
}

/**
 * Glob match for the scope brief's allowed_paths: exact posix equality, or a pattern where `*` matches within one
 * segment, `?` one character, and `**` spans segments (`a/**` + `/b` consumes the slash, so `backend/**\/*.py`
 * matches `backend/x.py` and `backend/a/b/x.py`).
 */
export function globMatch(pattern: unknown, relPath: unknown): boolean {
  if (typeof pattern !== "string" || typeof relPath !== "string") return false;
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const r = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p === r) return true;
  if (!/[*?]/.test(p)) return false;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$").test(r);
}

/** Repo-relative posix path of `file` under `root`, or null when the file is not under the root at all. */
export function relativeUnder(root: string, file: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  if (!rel || rel === "." ) return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
