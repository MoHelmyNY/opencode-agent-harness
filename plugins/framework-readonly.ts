/**
 * framework-readonly: always-on protection of the agent harness itself, independent of experimental handoff/shadow
 * settings. A working lane may READ its framework (the workflow framework under AGENT_WORKFLOW_HOME, OpenCode's own
 * config directory, the loop's operator notes, the repo's .agent-workflow config), but it can never repair or
 * reconfigure it: edits, patches, moves and mutating shell commands that name a protected path are refused before
 * they run. Only the lane's own ticket state stays writable, and the framework's fixed ticket entry points
 * (`<framework>/bin/aw.(ps1|cmd) ticket ...`, `<framework>/agent_workflow/cli.py ticket ...`) stay callable.
 * The refusal text says plainly that the command was NOT executed, so a model never mistakes it for file content.
 * Receipts: ~/.local/state/opencode/framework-protection.jsonl.
 */
import * as path from "node:path";
import * as os from "node:os";
import { appendFile, mkdir } from "node:fs/promises";
import { loadConfig, resolveConfigPath, expandHome, frameworkHome } from "../guardrails/agent-workflow-config.ts";
import { frameworkCommandAllowed, frameworkWriteTargets, protectedFrameworkPath } from "../guardrails/framework-protection.ts";

export default async ({directory}: any) => {
  const dir = typeof directory === "string" ? directory : process.cwd();
  const frameworkRoot = frameworkHome();
  const configRoot = path.join(os.homedir(), ".config", "opencode");
  const configPath = resolveConfigPath(dir);
  const cfg = loadConfig(configPath);
  const stateDir = typeof cfg?.state_dir === "string" ? expandHome(cfg.state_dir) : path.join(frameworkRoot, "state", "unassigned");
  const policy = {directory:dir, frameworkRoot, stateDir,
    roots:[frameworkRoot, configRoot, path.join(os.homedir(), ".local", "state", "opencode", "loop-head"), path.join(dir, ".agent-workflow"), configPath]};
  const receiptFile = path.join(os.homedir(), ".local", "state", "opencode", "framework-protection.jsonl");
  return {
    "tool.execute.before": async (input:any, output:any) => {
      const tool = input?.tool;
      if (typeof tool !== "string") return;
      const args = output?.args || {};
      const declared = frameworkWriteTargets(tool,args);
      const unknownMutation = ["edit","write","patch","apply_patch","multiedit","delete","move","rename"].includes(tool) && declared.length === 0;
      const targets = declared.filter(target => protectedFrameworkPath(target,policy));
      const deniedCommand = tool === "bash" && typeof args.command === "string" && !frameworkCommandAllowed(args.command,policy);
      if (!targets.length && !deniedCommand && !unknownMutation) return;
      const receipt = {at:new Date().toISOString(),kind:"framework_write_refused",directory:dir,sessionID:input.sessionID ?? null,
        tool,targets,reason:unknownMutation ? "mutation-target-unknown" : deniedCommand ? "protected-framework-command" : "protected-framework-path"};
      await mkdir(path.dirname(receiptFile),{recursive:true}).then(()=>appendFile(receiptFile,JSON.stringify(receipt)+"\n")).catch(()=>{});
      throw new Error("FRAMEWORK_GUARD_REFUSED: command not executed. This is a tool-policy refusal, not file content or shell output. Framework source and configuration are read-only to working lanes, including shadow mode. Use the read tool or simple read-only commands for inspection; approved aw ticket commands and lane-owned ticket state remain available. Do not retry the rejected script, repair the framework or try an alternative write method. If required evidence is still inaccessible, preserve this error and use the existing escalation path.");
    },
  };
};
