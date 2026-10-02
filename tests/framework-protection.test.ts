import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { frameworkWriteTargets, frameworkCommandAllowed, protectedFrameworkPath } from "../guardrails/framework-protection.ts";
import plugin from "../plugins/framework-readonly.ts";
import { slugOf } from "../guardrails/agent-workflow-config.ts";
// Several tests spawn real `git` processes (temp repos, or `git rev-parse` during config resolution). Where process
// start is slow (one measured Windows box: `git init` 2.9 s, `git add` 4.8 s) a test outlives bun's 5 s default, so the
// per-test budget is raised. Logic is unaffected; only the wall-clock allowance changes.
setDefaultTimeout(60_000);

function setup() {
  const root=mkdtempSync(join(tmpdir(),"framework-ro-"));
  const frameworkRoot=join(root,"framework"); const stateDir=join(frameworkRoot,"state","lane-a");
  mkdirSync(stateDir,{recursive:true}); const directory=join(root,"worktree");mkdirSync(directory);
  const code=join(frameworkRoot,"coordinator.py");writeFileSync(code,"original\n");
  return {root,code,frameworkRoot,stateDir,directory,roots:[frameworkRoot,join(homedir(),".config","opencode")]};
}

test("source/config paths are protected while only this lane's state stays writable",()=>{
  const p=setup();
  expect(protectedFrameworkPath(p.code,p)).toBe(true);
  expect(protectedFrameworkPath(join(homedir(),".config/opencode/opencode.json"),p)).toBe(true);
  expect(protectedFrameworkPath(join(p.stateDir,"brief.json"),p)).toBe(false);
  expect(protectedFrameworkPath(join(p.stateDir,"signing.key"),p)).toBe(true);
  expect(protectedFrameworkPath(join(p.frameworkRoot,"state/lane-b/brief.json"),p)).toBe(true);
  expect(protectedFrameworkPath(join(p.directory,"app.py"),p)).toBe(false);
});

test("junction paths cannot disguise a protected source target",()=>{
  const p=setup(); const alias=join(p.directory,"source-alias");
  symlinkSync(p.frameworkRoot,alias,process.platform==="win32" ? "junction" : "dir");
  expect(protectedFrameworkPath(join(alias,"coordinator.py"),p)).toBe(true);
  expect(protectedFrameworkPath(join(alias,"new-module.py"),p)).toBe(true);
  rmSync(alias); // link only, never recurse through a junction
});

test("all patch target spellings and moves are inspected",()=>{
  const p=setup();
  expect(frameworkWriteTargets("apply_patch",{patchText:`*** Update File: ${p.code}\n@@\n-a\n+b\n*** Move to: ${p.code}.new`})).toEqual([p.code,p.code+".new"]);
  expect(frameworkWriteTargets("multiedit",{edits:[{filePath:p.code}]})).toEqual([p.code]);
});

test("framework shell mutations are refused, reads and the approved CLI stay available",()=>{
  const p=setup();
  const windows=p.code.replaceAll("/","\\");
  for(const command of [
    `Set-Content -LiteralPath "${windows}" -Value broken`,
    `python -c "from pathlib import Path; Path('${p.code}').write_text('broken')"`,
    `git -C "${p.frameworkRoot}" apply change.patch`,
    `git -C "${p.frameworkRoot}" reset --hard`,
    `git -C "${p.frameworkRoot}" diff --output="${p.code}"`,
    `bash -c "echo broken > '${p.code}'"`,
    `attrib -R "${p.code}"`,
    `pwsh -File "${p.frameworkRoot}/bin/framework-maintenance.ps1" -Mode Unlock`,
  ]) expect(frameworkCommandAllowed(command,p)).toBe(false);
  expect(frameworkCommandAllowed(`Get-Content -LiteralPath "${p.code}"`,p)).toBe(true);
  expect(frameworkCommandAllowed(`git -C "${p.frameworkRoot}" diff --stat`,p)).toBe(true);
  expect(frameworkCommandAllowed(`& "${p.frameworkRoot}/bin/aw.ps1" ticket --config "${homedir()}/.config/opencode/agent-workflow/lane.json" status --ticket 7`,p)).toBe(true);
  expect(frameworkCommandAllowed(`py -3.12 "${p.frameworkRoot}/agent_workflow/cli.py" ticket status --ticket 7`,p)).toBe(true);
  expect(frameworkCommandAllowed(`git -C "${p.directory}" commit -F message.txt`,p)).toBe(true);
});

test("native hook rejects framework writes in shadow and with the chain disabled",async()=>{
  const p=setup(); const home=mkdtempSync(join(tmpdir(),"framework-ro-config-"));
  process.env.AGENT_WORKFLOW_HOME=p.frameworkRoot;process.env.AGENT_WORKFLOW_CONFIG_HOME=home;
  const cfg=join(home,slugOf(p.directory)+".json");
  for(const enabled of [true,false]) {
    writeFileSync(cfg,JSON.stringify({schema_version:1,chain:{enabled,gate_mode:"shadow"},state_dir:p.stateDir}));
    const hooks:any=await plugin({directory:p.directory});
    await expect(hooks["tool.execute.before"]({tool:"edit",sessionID:"lane"},{args:{filePath:p.code,oldString:"original",newString:"changed"}})).rejects.toThrow("read-only");
    await expect(hooks["tool.execute.before"]({tool:"apply_patch"},{args:{patchText:`*** Update File: ${p.code}\n@@\n-x\n+y`}})).rejects.toThrow("read-only");
    await expect(hooks["tool.execute.before"]({tool:"bash"},{args:{command:`Set-Content '${p.code}' changed`}})).rejects.toThrow("read-only");
    await expect(hooks["tool.execute.before"]({tool:"patch"},{args:{unknown:"not an inspectable patch"}})).rejects.toThrow("read-only");
    await hooks["tool.execute.before"]({tool:"read"},{args:{filePath:p.code}});
    if(enabled) await hooks["tool.execute.before"]({tool:"write"},{args:{filePath:join(p.stateDir,"brief.json"),content:"{}"}});
    expect(readFileSync(p.code,"utf8")).toBe("original\n");
  }
});

test("Windows read-only attribute prevents ordinary writes even outside the tool hook",()=>{
  if(process.platform!=="win32")return;
  const p=setup();chmodSync(p.code,0o444);
  try {expect(()=>writeFileSync(p.code,"changed")).toThrow();expect(readFileSync(p.code,"utf8")).toBe("original\n");}
  finally {chmodSync(p.code,0o666);}
});

test("lane state inspection and read-only projections do not require a shell workaround",()=>{
  const p=setup();
  for (const command of [
    `Get-ChildItem "${p.stateDir}" | Select-Object Name, Length; Test-Path "${p.directory}"; git -C "${p.directory}" rev-parse HEAD 2>$null; git -C "${p.directory}" status --short 2>$null`,
    `Get-Content -LiteralPath "${p.code}" | Select-Object -Skip 10 -First 20`,
    `Get-Content -LiteralPath "${p.code}" | Measure-Object -Line`,
    `Get-Item "${p.code}"\nGet-FileHash "${p.code}"`,
    `& "${p.frameworkRoot}/bin/aw.ps1" ticket --help 2>&1 | Select-Object -First 60`,
    // Judge 2026-09-17: the read idioms the lane actually types (a day's log: 17 + ~25 refusals, each a retry)
    `& "${p.frameworkRoot}/bin/aw.ps1" ticket --config "${p.configPath}" status --ticket 2076 | ConvertFrom-Json`,
    `& "${p.frameworkRoot}/bin/aw.ps1" ticket --config "${p.configPath}" status --ticket 2076 2>&1 | Out-String -Width 400`,
    `Get-Content -LiteralPath "${p.stateDir}/checks/2076/red-adde85680580/stdout.log" | Select-String -Pattern "AssertionError|Failed:|assert"`,
    `Get-ChildItem "${p.stateDir}/checks/2080" | Sort-Object LastWriteTime | Format-Table Name, Length`,
    `rg -n "F-1962-00" "${p.stateDir}/lanes/lane-a/tickets/1962/events.jsonl" | Select-String -Pattern "finding_opened" | Out-String`,
  ]) expect(frameworkCommandAllowed(command,p)).toBe(true);
  // a stage that runs code, writes, or is not a read stage is still refused
  for (const command of [
    `Get-Content "${p.stateDir}/x.json" | Where-Object { $_ -match "a" }`,
    `Get-Content "${p.stateDir}/x.json" | ForEach-Object { $_ }`,
    `Get-Content "${p.stateDir}/x.json" | Out-File "${p.stateDir}/y.json"`,
    `Get-Content "${p.stateDir}/x.json" | Set-Content "${p.stateDir}/y.json"`,
    `& "${p.frameworkRoot}/bin/aw.ps1" ticket --config "${p.configPath}" status --ticket 1 | ConvertFrom-Json; Remove-Item "${p.code}"`,
  ]) expect(frameworkCommandAllowed(command,p)).toBe(false);
});

test("read composition cannot hide a mutation or an opaque script",()=>{
  const p=setup();
  for (const command of [
    `Get-Content "${p.code}"; Set-Content "${p.code}" changed`,
    `Get-Content "${p.code}" | Set-Content "${p.code}"`,
    `Get-Content "${p.code}" > "${p.code}"`,
    `Get-Content "${p.code}" 2>$null; attrib -R "${p.code}"`,
    `Get-Content "${p.code}" | ForEach-Object { Remove-Item "${p.code}" }`,
    `Get-Content "${p.code}" | Select-Object @{Name='x';Expression={Remove-Item "${p.code}"}}`,
    `Get-Content "${p.code}"; git -C "${p.frameworkRoot}" reset --hard`,
    `Get-Content "${p.code}"; python -c "print('opaque')"`,
    `Get-Content "${p.code}"; rg --pre helper "${p.code}"`,
    `Get-Content "${p.code}"; git -c core.pager=helper show`,
    `& "${p.frameworkRoot}/bin/aw.ps1" ticket status --ticket 7; Get-Content "${p.code}"`,
    `Get-Content "${p.code}" | Select-Object $(Remove-Item "${p.code}")`,
  ]) expect(frameworkCommandAllowed(command,p)).toBe(false);
});

test("guard refusals identify an unexecuted command rather than resembling file content",async()=>{
  const p=setup();
  process.env.AGENT_WORKFLOW_HOME=p.frameworkRoot;
  const hooks:any=await plugin({directory:p.directory});
  await expect(hooks["tool.execute.before"]({tool:"bash"},{args:{command:`Get-Content "${p.code}"; Set-Content "${p.code}" changed`}}))
    .rejects.toThrow("FRAMEWORK_GUARD_REFUSED: command not executed");
  expect(readFileSync(p.code,"utf8")).toBe("original\n");
});

test("quoted escalation text is data, while shell execution around the approved CLI stays blocked",()=>{
  const p=setup();const aw=`& "${p.frameworkRoot}/bin/aw.ps1" ticket`;
  expect(frameworkCommandAllowed(`${aw} escalate --ticket 7 --reason "Blocked (history gate); source says write foo -> bar"`,p)).toBe(true);
  expect(frameworkCommandAllowed(`${aw} note --ticket 7 --base-failures 'The literal $(example) is documentation; not a script'`,p)).toBe(true);
  expect(frameworkCommandAllowed(`${aw} escalate --ticket 7 --reason "$(Set-Content '${p.code}' bad)"`,p)).toBe(false);
  expect(frameworkCommandAllowed(`${aw} status --ticket 7; Set-Content '${p.code}' bad`,p)).toBe(false);
});

test("the lane opens its PR with the body rendered into its own ticket state, and nothing else under the framework",()=>{
  const p=setup();
  const body=join(p.stateDir,"tickets","1962","pr-body.md");
  expect(frameworkCommandAllowed(`gh pr create --repo o/r --head qwen/fix-1962 --base main --title "fix(1962): lock the read" --body-file "${body}" --issue 1962`,p)).toBe(true);
  expect(frameworkCommandAllowed(`gh pr edit 2086 --body-file ${body}`,p)).toBe(true);
  for (const command of [
    `gh pr create --base main --body-file "${join(p.stateDir,"signing.key")}"`,
    `gh pr create --base main --body-file "${join(p.stateDir,"tickets","1962","..","..","signing.key")}"`,
    `gh pr create --base main --body-file "${join(p.frameworkRoot,"bin","aw.ps1")}"`,
    `gh pr create --base main --body-file "${body}"; Set-Content "${p.code}" changed`,
    `gh pr create --base main --body-file "${body}" --title "$(Get-Content ${p.code})"`,
    `gh pr create --base main --body-file "${body}" > "${p.code}"`,
    `gh pr comment 1 --body-file "${body}"`,
    `Copy-Item "${body}" C:/tmp/x.md`,
  ]) expect(frameworkCommandAllowed(command,p)).toBe(false);
});
