/**
 * subagent-cap: at most N subagents (task-tool calls) run at once for sessions on a LOCAL model; extra calls wait in
 * line (first come, first served) instead of failing. API models are never capped.
 *
 * Owner decision (2026-09-28): the local engine's KV pool serves about two live requests. While a parent waits on a
 * subagent it is not generating, so the cap counts subagents only: 2. Evidence: an authoring lane launched 5 critic
 * subagents in one message; OpenCode has no setting for this (its only related key, subagent_depth, limits nesting),
 * and a workflow-level concurrency budget only exists in directories with a workflow config and refuses rather than
 * queues.
 *
 * Safe to wait here: OpenCode fires tool.execute.before inside each tool call's own execution (session/tools.ts), so
 * a queued call does not block the calls already admitted.
 *
 * Slots are released in tool.execute.after. A slot older than SUBAGENT_CAP_MAX_HOLD_MS (default 40 min) is dropped so
 * an aborted call that never reaches tool.execute.after cannot lock the lane. The cap is per OpenCode process (shared by
 * every project and session in it), not across two OpenCode windows.
 *
 * Env: SUBAGENT_CAP (default 2; 0 disables), SUBAGENT_CAP_MAX_HOLD_MS, SUBAGENT_CAP_POLL_MS (default 500),
 * SUBAGENT_CAP_PROVIDERS (comma-separated provider IDs that count as local; default vllm,ollama,lmstudio,llama,llama-cpp,local).
 * Receipts: ~/.local/state/opencode/subagent-cap.jsonl (queued / admitted / released / expired).
 *
 * ONLY a default export: OpenCode calls every export of a plugin module as a plugin factory.
 */
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOCAL_PROVIDERS = "vllm,ollama,lmstudio,llama,llama-cpp,local";
const STATE_KEY = "__opencodeSubagentCap";

type Slot = { at: number; sessionID: string | null };
type CapState = { held: Map<string, Slot>; nextTicket: number; waiting: number[] };

export default async (_ctx: any) => {
  const g = globalThis as any;
  const state: CapState = g[STATE_KEY] ?? (g[STATE_KEY] = { held: new Map(), nextTicket: 0, waiting: [] });
  const envNum = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const cap = envNum("SUBAGENT_CAP", 2);
  const maxHoldMs = envNum("SUBAGENT_CAP_MAX_HOLD_MS", 40 * 60 * 1000);
  const pollMs = Math.max(10, envNum("SUBAGENT_CAP_POLL_MS", 500));
  const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode");
  const receiptFile = path.join(stateDir, "subagent-cap.jsonl");
  const sessionProviders = new Map<string, string>();
  const LOCAL_PROVIDERS = new Set(
    String(process.env.SUBAGENT_CAP_PROVIDERS ?? DEFAULT_LOCAL_PROVIDERS).split(",").map((p) => p.trim()).filter(Boolean),
  );

  const receipt = async (record: Record<string, unknown>) => {
    try {
      await mkdir(stateDir, { recursive: true });
      await appendFile(receiptFile, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
    } catch {}
  };
  const expire = async () => {
    const now = Date.now();
    for (const [callID, slot] of state.held) {
      if (now - slot.at > maxHoldMs) {
        state.held.delete(callID);
        await receipt({ kind: "expired", callID, sessionID: slot.sessionID, heldMs: now - slot.at, cap });
      }
    }
  };

  return {
    "chat.params": async (input: any) => {
      const provider = input?.model?.providerID ?? input?.provider?.id ?? input?.provider?.providerID;
      if (typeof input?.sessionID === "string" && typeof provider === "string") sessionProviders.set(input.sessionID, provider);
    },
    "tool.execute.before": async (input: any) => {
      if (input?.tool !== "task" || cap <= 0) return;
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : null;
      const provider = sessionID ? sessionProviders.get(sessionID) : undefined;
      if (!provider || !LOCAL_PROVIDERS.has(provider)) return;
      const callID = typeof input?.callID === "string" ? input.callID : `anon-${Date.now()}-${Math.random()}`;
      const ticket = state.nextTicket++;
      state.waiting.push(ticket);
      const queuedAt = Date.now();
      let announced = false;
      try {
        while (true) {
          await expire();
          if (state.held.size < cap && state.waiting[0] === ticket) break;
          if (!announced) {
            announced = true;
            await receipt({ kind: "queued", callID, sessionID, provider, held: state.held.size, ahead: state.waiting.indexOf(ticket), cap });
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
        state.held.set(callID, { at: Date.now(), sessionID });
      } finally {
        const i = state.waiting.indexOf(ticket);
        if (i >= 0) state.waiting.splice(i, 1);
      }
      await receipt({ kind: "admitted", callID, sessionID, provider, waitedMs: Date.now() - queuedAt, held: state.held.size, cap });
    },
    "tool.execute.after": async (input: any) => {
      if (input?.tool !== "task" || typeof input?.callID !== "string") return;
      const slot = state.held.get(input.callID);
      if (!slot) return;
      state.held.delete(input.callID);
      await receipt({ kind: "released", callID: input.callID, sessionID: slot.sessionID, heldMs: Date.now() - slot.at, held: state.held.size, cap });
    },
  };
};
