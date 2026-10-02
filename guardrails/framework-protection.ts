/** Lane tooling may read its framework, but cannot repair or reconfigure it. */
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

export type Protection = { roots: string[]; stateDir: string; directory: string; frameworkRoot: string };

function canonical(value: string, cwd: string): string {
  let resolved = path.resolve(cwd, value);
  const tail: string[] = [];
  // Resolve existing parents too: an uncreated file through a junction is protected.
  while (!existsSync(resolved) && path.dirname(resolved) !== resolved) {
    tail.unshift(path.basename(resolved)); resolved = path.dirname(resolved);
  }
  try { resolved = realpathSync(resolved); } catch {}
  return path.join(resolved, ...tail).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
}
const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + "/");

export function protectedFrameworkPath(value: unknown, p: Protection): boolean {
  if (typeof value !== "string" || !value) return false;
  const target = canonical(value, p.directory);
  const roots = p.roots.map(root => canonical(root, p.directory));
  const state = canonical(p.stateDir, p.directory);
  const framework = canonical(p.frameworkRoot, p.directory);
  const mutableState = inside(framework + "/state", state) && state !== framework;
  if (mutableState && inside(state, target) && !/(?:^|\/)(?:\.secrets|signing\.key)(?:\/|$)/.test(target)) return false;
  return roots.some(root => inside(root, target));
}

export function frameworkWriteTargets(tool: string, args: any): string[] {
  if (!["edit", "write", "patch", "apply_patch", "multiedit", "delete", "move", "rename"].includes(tool)) return [];
  const targets: string[] = [];
  for (const key of ["filePath", "file_path", "path", "source", "destination", "dest", "oldPath", "newPath"]) {
    if (typeof args?.[key] === "string") targets.push(args[key]);
  }
  for (const edit of args?.edits ?? []) targets.push(...frameworkWriteTargets("edit", edit));
  const patch = args?.patchText ?? args?.patch ?? args?.input;
  if (typeof patch === "string") {
    for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gm)) targets.push(match[1].trim());
    for (const match of patch.matchAll(/^(?:---|\+\+\+) (?:a\/|b\/)?([^\t\r\n]+)/gm)) {
      if (match[1] !== "/dev/null") targets.push(match[1]);
    }
  }
  return targets;
}

/** Commands naming a protected tree are read-only, except the fixed workflow entry points. */
/** One statement whose quoted spans are literal text: no substitution, no unbalanced quote, no shell operators outside quotes. */
function plainLiteralStatement(command: string): boolean {
  let quote:string|null=null;let syntax='';
  for(let index=0;index<command.length;index++){
    const char=command[index];
    if(quote){
      if(quote==='"'&&(char==='`'||command.slice(index,index+2)==='$('))return false;
      if(char===quote)quote=null;
    }else if(char==='"'||char==="'"){quote=char;syntax+=' ';}
    else syntax+=char;
  }
  syntax=syntax.replace(/^\s*&\s*/,'').replace(/2>&1\s*$/,'');
  return !quote&&!/[\r\n;|<>&`(){}\[\]]/.test(syntax);
}

export function frameworkCommandAllowed(command: string, p: Protection): boolean {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  const mentioned = p.roots.some(root => normalized.includes(root.replace(/\\/g, "/").toLowerCase()))
    || /agent-workflow-lab|\.config[/'"\s+]+opencode|framework-maintenance/.test(normalized);
  if (!mentioned) return true;
  const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const framework = p.frameworkRoot.replace(/\\/g, "/").toLowerCase();
  const aw = new RegExp(`^["']?${escaped(framework)}/bin/aw\\.(?:ps1|cmd)["']?\\s+ticket\\b`);
  const cli = new RegExp(`^(?:py(?:\\.exe)?\\s+-3\\.12|python(?:3(?:\\.12)?)?(?:\\.exe)?)\\s+["']?${escaped(framework)}/agent_workflow/cli\\.py["']?\\s+ticket\\b`);
  // A quoted ruling/error explanation is an argv value, not shell syntax. This
  // exception applies only to the fixed, protected bookkeeping entry points.
  const entry=normalized.replace(/^\s*&\s*/, '').trim();
  if((aw.test(entry)||cli.test(entry))&&plainLiteralStatement(command))return true;
  // The chain renders the PR body into the lane's own ticket state and tells the
  // lane to open the PR with it. `gh pr create|edit --body-file <stateDir>/tickets/<N>/pr-body.md`
  // is therefore lane work, not a framework write: the file is the only framework
  // mention allowed, it must be that exact rendered body (never a key or config),
  // and the command must be one plain literal statement.
  if(/^gh(?:\.exe)?\s+pr\s+(?:create|edit)\b/.test(entry)&&plainLiteralStatement(command)){
    const state=escaped(p.stateDir.replace(/\\/g,"/").toLowerCase());
    const body=new RegExp(`--body-file(?:=|\\s+)["']?${state}/tickets/\\d+/pr-body\\.md["']?(?=\\s|$)`,"g");
    const rest=normalized.replace(body," --body-file <ticket-body> ");
    const stillMentioned=p.roots.some(root=>rest.includes(root.replace(/\\/g,"/").toLowerCase()))
      ||/agent-workflow-lab|\.config[/'"\s+]+opencode|framework-maintenance/.test(rest);
    if(!stillMentioned)return true;
  }
  // Permit only null/error-stream redirection, never a file destination.
  const inspection = command.replace(/\s+2\s*>\s*\$null(?=\s|[;|]|$)/gi, "")
    .replace(/\s+2\s*>\s*&1(?=\s|[;|]|$)/g, "");
  // No script blocks, expressions, substitution, backgrounding or arbitrary code.
  if (/[<>(){}]|&&|`/.test(inspection)) return false;
  if (/\b(?:python[\d.]*|py)(?:\.exe)?\s+(?:-3\.\d+\s+)?-c\b|\b(?:node|bun)\s+(?:-e|--eval)\b|\b(?:bash|sh)\s+-c\b|\b(?:pwsh|powershell)\b.*-(?:command|encodedcommand)\b|\bcmd(?:\.exe)?\s+\/c\b/.test(normalized)) return false;
  if (/framework-maintenance|\battrib\b|\bchmod\b|\bicacls\b|\bset-acl\b|\.write|writeall|set-content|out-file|add-content|new-item/.test(normalized)) return false;
  if (/\s(?:--output(?:-file)?(?:=|\s)|--pre(?:=|\s)|--ext-diff\b|--textconv\b)/.test(normalized)) return false;
  const statements = inspection.split(/[;\r\n]+/).map(s => s.trim()).filter(Boolean);
  if (!statements.length) return false;
  // A `|` inside a quoted span (`Select-String -Pattern "a|b"`) is pattern text, not a pipe.
  const splitStages = (statement: string): string[] => {
    const out: string[] = []; let current = ""; let quote: string | null = null;
    for (const char of statement) {
      if (quote) { current += char; if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'") { quote = char; current += char; continue; }
      if (char === "|") { out.push(current.trim()); current = ""; continue; }
      current += char;
    }
    out.push(current.trim());
    return out;
  };
  return statements.every(statement => {
    const stages = splitStages(statement);
    const first = stages.shift()!;
    const text = first.replace(/\\/g, "/").toLowerCase().replace(/^\s*&\s*/, "").trim();
    // Output projection is a small inert allowlist, not a general PowerShell pipeline. Judge 2026-09-17: widened from
    // Select-Object/Measure-Object to the other argument-only read stages the lane reaches for (a day's log: 17
    // `aw.ps1 ... | ConvertFrom-Json` and ~25 `Get-Content ... | Select-String` refusals, every one a retry). Script
    // blocks, redirects, `&` and substitution are still refused above, so a stage can only filter or format text.
    if (stages.some(stage => !/^(?:select-object|measure-object|select-string|out-string|sort-object|format-table|format-list|group-object|convertfrom-json)(?:\s+[-\w\s,.'":|\\/^$*+?]+)?$/i.test(stage))) return false;
    if (/[&]/.test(first.replace(/^\s*&\s*/, ""))) return false;
    if (aw.test(text) || cli.test(text)) return statements.length === 1;
    if (/^\s*&/.test(first)) return false;
    if (/^(?:get-content|get-item|get-childitem|get-filehash|test-path|select-string|cat|head|tail|type|rg)\b/.test(text)) return true;
    if (/^git\b/.test(text)) {
    // No config-setting -c option and no mutating subcommand on the framework.
    if (/\s-c\s/.test(first)) return false;
    return /\b(?:status|diff|show|log|grep|ls-files|rev-parse)\b/.test(text)
      && !/\b(?:apply|commit|checkout|switch|reset|restore|clean|config|add|mv|rm|stash|pull|merge|rebase|update-index)\b/.test(text);
    }
    return false;
  });
}
