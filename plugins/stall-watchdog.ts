/**
 * stall-watchdog plugin (owner 2026-09-17): answers read-only permission asks so a subagent never waits on a human,
 * and aborts a tool call that has hung past its threshold while the engine is idle. Logic and tests live in
 * guardrails/stall-watchdog-core.ts; this file exports only the factory (the loader calls every export).
 * Bash (owner 2026-09-26): a bash call is aborted once it outlives its own timeout (else 120 s) + STALL_WATCHDOG_BASH_GRACE_MS
 * (60000), STALL_WATCHDOG_BASH_MS being only the cap; a Start-Process launch that would hold the tool's pipe is refused.
 * Knobs: STALL_WATCHDOG_MS (default 300000), STALL_WATCHDOG_BASH_MS (1500000), STALL_WATCHDOG_TICK_MS (15000),
 * STALL_WATCHDOG_METRICS (the local engine's Prometheus endpoint; default http://127.0.0.1:8000/metrics, vLLM's default
 * port), STALL_WATCHDOG_READ_ROOTS (extra directories whose read-only asks are allowed, separated by the platform path
 * delimiter), STALL_WATCHDOG_DISABLED=1 turns it off.
 * Receipts: ~/.local/state/opencode/stall-watchdog.jsonl.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createWatchdog } from "../guardrails/stall-watchdog-core.ts";
import { frameworkHome } from "../guardrails/agent-workflow-config.ts";

export default async ({ client, directory }: any) => {
  if (process.env.STALL_WATCHDOG_DISABLED === "1") return {};
  const dir = typeof directory === "string" ? directory : process.cwd();
  const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode");
  const receiptFile = path.join(stateDir, "stall-watchdog.jsonl");
  const readRoots = [
    dir,
    path.join(os.tmpdir(), "opencode"),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Temp", "opencode"),
    path.join(frameworkHome(), "state"),
    ...String(process.env.STALL_WATCHDOG_READ_ROOTS || "").split(path.delimiter).map((r) => r.trim()).filter(Boolean),
  ];
  const receipt = async (row: Record<string, unknown>) => {
    await fs.mkdir(stateDir, { recursive: true }).then(() => fs.appendFile(receiptFile, JSON.stringify({ ...row, directory: dir }) + "\n")).catch(() => {});
  };
  const toast = async (text: string) => { await client?.tui?.showToast?.({ body: { title: "stall-watchdog", message: text, variant: "warning", duration: 8000 } }).catch(() => {}); };
  const watchdog = createWatchdog({
    client, directory: dir, readRoots, receipt, toast,
    stallMs: Number(process.env.STALL_WATCHDOG_MS || 300000),
    bashStallMs: Number(process.env.STALL_WATCHDOG_BASH_MS || 1500000),
    bashGraceMs: Number(process.env.STALL_WATCHDOG_BASH_GRACE_MS || 60000),
    metricsUrl: process.env.STALL_WATCHDOG_METRICS || "http://127.0.0.1:8000/metrics",
  });
  const timer = setInterval(() => { watchdog.tick().catch(() => {}); }, Number(process.env.STALL_WATCHDOG_TICK_MS || 15000));
  (timer as any).unref?.();
  return watchdog.hooks;
};
