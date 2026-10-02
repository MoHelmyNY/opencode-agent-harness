/**
 * qwen-guardrails: edit-loop detection and a context-budget nudge for the local Qwen lane (owner request 2026-09-10).
 *
 * Evidence that motivated it: of 47 sessions of one project that edited files between 2026-09-06 and 09-10, 15 edited
 * one file six or more times and 7 edited one file ten or more times. Both guards only append a note to a tool result
 * (tail of the prompt, prefix cache untouched); nothing is blocked, retried, or capped, and the notes never ask the
 * model to hurry: they ask it to verify, and to report INCOMPLETE rather than commit something that is not green.
 * Receipts: one JSON line per nudge in ~/.local/state/opencode/qwen-guardrails.jsonl.
 * Env: QWEN_GUARDRAILS_PROVIDERS (providers that get the context guard, default vllm), QWEN_GUARDRAILS_CONTEXT_WINDOW,
 * QWEN_GUARDRAILS_GRAPHIFY=1 (turns on the Graphify dependency-analysis nudge), QWEN_GUARDRAILS_GRAPH_SERVER,
 * QWEN_GUARDRAILS_DEBUG=1.
 * The pure logic sits in ../guardrails/ (outside plugins/, whose every export the loader treats as a plugin).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import * as nodeOs from "node:os";
import { boundCommand, compactionNudge, contextNudge, contextWindowFor, newState, recordCall, recordContext, recordEdit, recordResult, resetContextStages, graphifyNudge, ghJqVerdict, waitVerdict, type SessionState } from "../guardrails/qwen-guardrails-core.ts";

const EDIT_TOOLS = new Set(["edit", "write"]);

export default async ({ client, directory }: any) => {
  const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode");
  const logFile = path.join(stateDir, "qwen-guardrails.jsonl");
  const sessions = new Map<string, SessionState>();
  const state = (id: string) => {
    let s = sessions.get(id);
    if (!s) {
      // Storage bound for a long-lived server; sessions are tiny, so this only matters after thousands of them.
      if (sessions.size > 500) sessions.clear();
      s = newState();
      sessions.set(id, s);
    }
    return s;
  };
  const receipt = async (record: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), directory, ...record });
    await Promise.allSettled([
      fs.mkdir(stateDir, { recursive: true }).then(() => fs.appendFile(logFile, line + "\n", { mode: 0o600 })),
      client?.app?.log?.({ body: { service: "qwen-guardrails", level: "info", message: line } }),
    ]);
  };
  // QWEN_GUARDRAILS_DEBUG=1 traces what the plugin observes (one line per event and tool result) into the same file.
  const debug = process.env.QWEN_GUARDRAILS_DEBUG === "1" ? (record: Record<string, unknown>) => receipt({ guard: "debug", ...record }) : async () => {};
  await debug({ what: "init" });
  return {
    event: async ({ event }: any) => {
      if (event.type === "message.updated") {
        const info = event.properties?.info;
        await debug({ what: "message.updated", role: info?.role, sessionID: info?.sessionID, providerID: info?.providerID, tokens: info?.tokens, finish: info?.finish });
        if (info?.role !== "assistant" || !info.tokens || typeof info.sessionID !== "string") return;
        const s = state(info.sessionID);
        if (s.contextWindow === null) s.contextWindow = contextWindowFor(info.providerID, process.env);
        recordContext(s, info.tokens);
      } else if (event.type === "session.compacted") {
        const id = event.properties?.sessionID;
        if (typeof id === "string") resetContextStages(state(id));
      } else if (event.type === "session.deleted") {
        const id = event.properties?.info?.id;
        if (typeof id === "string") sessions.delete(id);
      }
    },
    // Repeat guard: identical consecutive calls are noted, then refused (the thrown error is the tool result the
    // model sees), then the session is aborted so it stops spinning in the owner's TUI. The pending note is handed
    // to tool.execute.after through the session state so it lands at the tail of the real result.
    "tool.execute.before": async (input: any, output: any) => {
      if (typeof input?.sessionID !== "string" || typeof input?.tool !== "string") return;
      const s = state(input.sessionID);
      const r = recordCall(s, input.tool, output?.args);
      (s as any).pendingRepeatNote = r.refuse ? null : r.note;
      if (r.note) await receipt({ guard: "repeat", sessionID: input.sessionID, tool: input.tool, count: r.count, refused: r.refuse, abort: r.abort });
      if (r.abort) {
        // WF-04 (audit 2026-09-13): a guard abort leaves a blocked record that loop-continuation honours until the
        // owner types or the todo list changes; without it an open todo re-queued the same spinning packet.
        try {
          const blockedDir = nodePath.join(process.env.XDG_STATE_HOME || nodePath.join(nodeOs.homedir(), ".local", "state"), "opencode", "loop-blocked.d");
          await nodeFs.mkdir(blockedDir, { recursive: true });
          await nodeFs.writeFile(nodePath.join(blockedDir, `${input.sessionID}.json`), JSON.stringify({ sessionID: input.sessionID, reason: "repeat-guard-abort", tool: input.tool, count: r.count, at: new Date().toISOString() }) + "\n");
        } catch {}
        try {
          await client?.session?.abort?.({ path: { id: input.sessionID }, query: { directory } });
        } catch (error) {
          await receipt({ guard: "repeat", sessionID: input.sessionID, abortError: String(error) });
        }
      }
      if (r.refuse) throw new Error(r.note!);
      if (input.tool === "bash" && output?.args) {
      if (input.tool === "bash" && typeof output?.args?.command === "string") {
        const wait = waitVerdict(output.args.command);
        if (wait) {
          await receipt({ guard: "wait", sessionID: input.sessionID, command: String(output.args.command).slice(0, 200) });
          throw new Error(wait);
        }
        const jq = ghJqVerdict(output.args.command);
        if (jq) {
          await receipt({ guard: "gh-jq", sessionID: input.sessionID, command: String(output.args.command).slice(0, 200) });
          throw new Error(jq);
        }
      }
        const b = boundCommand(output.args);
        if (b.timeoutMs !== null) {
          await receipt({ guard: "timeout-cap", sessionID: input.sessionID, requested: output.args.timeout, capped: b.timeoutMs });
          output.args.timeout = b.timeoutMs;
        }
        if (b.note) (s as any).pendingRepeatNote = ((s as any).pendingRepeatNote ? (s as any).pendingRepeatNote + "\n\n" : "") + b.note;
        if (b.refuse) {
          await receipt({ guard: "bare-pytest", sessionID: input.sessionID, command: String(output.args.command).slice(0, 200) });
          throw new Error(b.refuse);
        }
      }
    },
    "tool.execute.after": async (input: any, output: any) => {
      if (typeof output?.output !== "string" || typeof input?.sessionID !== "string") return;
      const s = state(input.sessionID);
      recordResult(s, input.tool, input.args, output.output);
      const pending = (s as any).pendingRepeatNote as string | null | undefined;
      (s as any).pendingRepeatNote = null;
      if (pending) output.output += "\n\n" + pending;
      await debug({ what: "tool.execute.after", tool: input.tool, sessionID: input.sessionID, contextTokens: s.contextTokens, window: s.contextWindow, fired: [...s.fired] });
      const notes: string[] = [];
      if (EDIT_TOOLS.has(input.tool) && typeof input.args?.filePath === "string") {
        const r = recordEdit(s, input.args.filePath);
        if (r.nudge) {
          notes.push(r.nudge);
          await receipt({ guard: "edit-loop", sessionID: input.sessionID, file: input.args.filePath, count: r.count });
        }
      }
      const c = contextNudge(s);
      if (c) {
        notes.push(c.nudge);
        await receipt({ guard: "context-budget", sessionID: input.sessionID, stage: c.stage, tokens: s.contextTokens, window: s.contextWindow });
      }
      const gn = process.env.QWEN_GUARDRAILS_GRAPHIFY === "1" ? graphifyNudge(s, input.tool, input.args) : null;
      if (gn) {
        notes.push(gn);
        await receipt({ guard: "graphify-nudge", sessionID: input.sessionID, tool: input.tool, modules: [...s.graphify.modulesSinceVerb], verbs: s.graphify.verbs });
      }
      const k = compactionNudge(s);
      if (k) {
        notes.push(k);
        await receipt({ guard: "context-compacted", sessionID: input.sessionID, tokens: s.contextTokens, window: s.contextWindow });
      }
      if (notes.length) output.output += "\n\n" + notes.join("\n\n");
    },
  };
};
