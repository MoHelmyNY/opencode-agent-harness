/**
 * bun run eval        run every frozen scenario, print the scorecard, record the result
 *
 * Flags: --label <text> (stored with the result), --no-record (print only), --only <id> (one scenario; never recorded).
 *
 * The scenario set is frozen: evals/manifest.json lists every scenario file with its SHA-256, and this runner refuses
 * to run (exit 2) when a hash differs, a listed file is missing, or an unlisted file is present. Changing the set is a
 * deliberate act: edit the scenarios, run `bun run eval:freeze`, and commit both, so results recorded before and after
 * are never silently compared across different task sets (each result carries the manifest's own hash).
 *
 * Results: evals/results/<UTC timestamp>.json, and the same object appended as one line to evals/results/history.jsonl.
 * Exit code: 0 when every scenario passes, 1 when any fails, 2 when the freeze check refuses.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { metric, metricLabel, OPS, runScenario, sha256 } from "./harness.ts";

const EVAL_DIR = import.meta.dir;
const REPO = path.resolve(EVAL_DIR, "..");
const MANIFEST = path.join(EVAL_DIR, "manifest.json");
const SCENARIO_DIR = path.join(EVAL_DIR, "scenarios");
const RESULTS = path.join(EVAL_DIR, "results");

/** The freeze check. Returns the problems found (empty = the set is exactly the frozen one). Exported for the tests. */
export function verifyManifest(evalDir = EVAL_DIR): { problems: string[]; manifest: any; manifestSha256: string } {
  const manifestFile = path.join(evalDir, "manifest.json");
  const problems: string[] = [];
  if (!existsSync(manifestFile)) return { problems: ["evals/manifest.json is missing"], manifest: null, manifestSha256: "" };
  const raw = readFileSync(manifestFile);
  const manifest = JSON.parse(raw.toString("utf8"));
  const listed = new Map<string, string>((manifest.scenarios || []).map((s: any) => [s.file, s.sha256]));
  const dir = path.join(evalDir, "scenarios");
  const present = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => `scenarios/${f}`) : [];
  for (const file of present) if (!listed.has(file)) problems.push(`${file} is not in the manifest`);
  for (const [file, expected] of listed) {
    const full = path.join(evalDir, file);
    if (!existsSync(full)) { problems.push(`${file} is listed but missing`); continue; }
    const actual = sha256(readFileSync(full));
    if (actual !== expected) problems.push(`${file} sha256 ${actual.slice(0, 12)}... does not match the manifest's ${String(expected).slice(0, 12)}...`);
  }
  return { problems, manifest, manifestSha256: sha256(raw) };
}

function git(args: string[]): string {
  try { return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); }
  catch { return ""; }
}

/** SHA-256 over the harness code under evaluation (plugins/ and guardrails/, line endings normalized). */
function harnessTreeSha(): string {
  const parts: string[] = [];
  for (const sub of ["plugins", "guardrails"]) {
    for (const f of readdirSync(path.join(REPO, sub)).filter((x) => x.endsWith(".ts")).sort()) {
      parts.push(`${sub}/${f}\n${readFileSync(path.join(REPO, sub, f), "utf8").replace(/\r\n/g, "\n")}`);
    }
  }
  return sha256(parts.join("\u0000"));
}

const fmt = (v: any) => (typeof v === "string" ? v : JSON.stringify(v));

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const only = flag("--only");
  const record = !argv.includes("--no-record") && !only;
  const label = flag("--label") || "";

  const { problems, manifest, manifestSha256 } = verifyManifest();
  if (problems.length) {
    console.error("REFUSED: the scenario set does not match evals/manifest.json, so this run could not be compared with earlier ones.");
    for (const p of problems) console.error("  - " + p);
    console.error("If the change is deliberate: bun run eval:freeze, and commit the scenarios with the new manifest.");
    process.exit(2);
  }

  const results: any[] = [];
  const t0 = performance.now();
  for (const entry of manifest.scenarios) {
    const sc = JSON.parse(readFileSync(path.join(EVAL_DIR, entry.file), "utf8"));
    if (only && sc.id !== only) continue;
    const started = performance.now();
    let checks: any[] = [];
    const measured: Record<string, any> = {};
    let error: string | null = null;
    try {
      const r = await runScenario(sc);
      for (const spec of sc.scoring.report || []) measured[metricLabel(spec)] = metric(r, spec);
      checks = (sc.scoring.pass || []).map((rule: any) => {
        const actual = metric(r, rule);
        const ok = OPS[rule.op]?.(actual, rule.value) ?? false;
        return { metric: metricLabel(rule), op: rule.op, expected: rule.value, actual, pass: ok };
      });
    } catch (e: any) {
      // Paths in an error would name this machine's temp directory; only the message's first line is kept.
      error = String(e?.message || e).split("\n")[0].replace(/[A-Za-z]:[\\/][^\s"']*/g, "<path>").slice(0, 200);
    }
    const pass = !error && checks.length > 0 && checks.every((c) => c.pass);
    results.push({ id: sc.id, plugins: sc.plugins, behavior: sc.behavior, pass, checks, measured, error, wall_ms: Math.round(performance.now() - started) });
  }

  // ---- scorecard
  const rows = results.map((r) => {
    const failed = r.checks.filter((c: any) => !c.pass).map((c: any) => `${c.metric} ${c.op} ${fmt(c.expected)} (got ${fmt(c.actual)})`);
    const key = Object.entries(r.measured).slice(0, 3).map(([k, v]) => `${k}=${fmt(v)}`).join("  ");
    return [r.pass ? "PASS" : "FAIL", r.id, `${r.checks.filter((c: any) => c.pass).length}/${r.checks.length}`, r.error ? `error: ${r.error}` : failed.length ? failed.join("; ") : key];
  });
  const widths = [4, Math.max(8, ...rows.map((x) => x[1].length)), 6];
  console.log(`\nHarness eval: ${results.length} frozen scenarios, simulated model and client (manifest ${manifestSha256.slice(0, 12)})\n`);
  console.log(["RES".padEnd(widths[0]), "SCENARIO".padEnd(widths[1]), "CHECKS".padEnd(widths[2]), "MEASURED / FAILURE"].join("  "));
  for (const x of rows) console.log([x[0].padEnd(widths[0]), x[1].padEnd(widths[1]), x[2].padEnd(widths[2]), x[3]].join("  "));
  const passed = results.filter((r) => r.pass).length;
  const checksTotal = results.reduce((n, r) => n + r.checks.length, 0);
  const checksPassed = results.reduce((n, r) => n + r.checks.filter((c: any) => c.pass).length, 0);
  console.log(`\nScore: ${passed}/${results.length} scenarios passed, ${checksPassed}/${checksTotal} checks (${Math.round(performance.now() - t0)} ms wall)`);

  if (record) {
    const commit = git(["rev-parse", "HEAD"]);
    const dirty = git(["status", "--porcelain", "--", "plugins", "guardrails"]) !== "";
    const now = new Date();
    const out = {
      schema: 1,
      run_at: now.toISOString(),
      label,
      harness: { commit, plugins_dirty: dirty, code_sha256: harnessTreeSha() },
      scenario_set: { manifest_sha256: manifestSha256, count: manifest.scenarios.length },
      runtime: { bun: Bun.version, platform: process.platform },
      totals: { scenarios: results.length, passed, failed: results.length - passed, checks: checksTotal, checks_passed: checksPassed, score: Number((passed / results.length).toFixed(4)) },
      results,
    };
    mkdirSync(RESULTS, { recursive: true });
    const file = path.join(RESULTS, `${now.toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    appendFileSync(path.join(RESULTS, "history.jsonl"), JSON.stringify(out) + "\n");
    console.log(`Recorded: evals/results/${path.basename(file)} (+ history.jsonl)`);
  }
  process.exit(passed === results.length ? 0 : 1);
}

if (import.meta.main) await main();
