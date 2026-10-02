/**
 * bun run eval:freeze   rewrite evals/manifest.json from the scenario files on disk.
 *
 * Run it only when the scenario set is meant to change, and commit the new manifest with the scenarios. Every recorded
 * result carries the manifest's hash, so runs against different sets are never compared by accident.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./harness.ts";

const dir = path.join(import.meta.dir, "scenarios");
const scenarios = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
  const raw = readFileSync(path.join(dir, f));
  const sc = JSON.parse(raw.toString("utf8"));
  return { file: `scenarios/${f}`, id: sc.id, sha256: sha256(raw) };
});
const manifest = {
  schema: 1,
  note: "Frozen eval scenario set. evals/run.ts refuses to run when a file's SHA-256 differs, a listed file is missing, or an unlisted file is present.",
  scenarios,
};
writeFileSync(path.join(import.meta.dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Froze ${scenarios.length} scenarios into evals/manifest.json`);
