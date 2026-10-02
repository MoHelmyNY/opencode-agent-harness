// bun test tests/evals-manifest.test.ts
// The eval's frozen scenario set: the committed manifest must match the scenario files byte for byte, and the runner's
// freeze check must refuse a changed, missing or unlisted scenario. (The eval itself runs with `bun run eval`.)
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyManifest } from "../evals/run.ts";

const EVALS = join(import.meta.dir, "..", "evals");

test("the committed manifest matches every scenario file, and the set holds at least 12 scenarios", () => {
  const { problems, manifest } = verifyManifest(EVALS);
  expect(problems).toEqual([]);
  expect(manifest.scenarios.length).toBeGreaterThanOrEqual(12);
  for (const entry of manifest.scenarios) {
    const sc = JSON.parse(readFileSync(join(EVALS, entry.file), "utf8"));
    expect(sc.id).toBe(entry.id);
    for (const key of ["plugins", "inputs", "timeline", "expected", "scoring"]) expect(sc[key], `${entry.id}.${key}`).toBeDefined();
    expect(sc.scoring.pass.length, `${entry.id} has pass rules`).toBeGreaterThan(0);
  }
});

test("the freeze check refuses a changed, a missing and an unlisted scenario", () => {
  const copy = mkdtempSync(join(tmpdir(), "evals-freeze-"));
  try {
    cpSync(join(EVALS, "manifest.json"), join(copy, "manifest.json"));
    cpSync(join(EVALS, "scenarios"), join(copy, "scenarios"), { recursive: true });
    expect(verifyManifest(copy).problems).toEqual([]);
    const first = verifyManifest(copy).manifest.scenarios[0].file;
    const second = verifyManifest(copy).manifest.scenarios[1].file;
    writeFileSync(join(copy, first), readFileSync(join(copy, first), "utf8").replace('"op": "=="', '"op": "!="'));
    rmSync(join(copy, second));
    writeFileSync(join(copy, "scenarios", "zz-unlisted.json"), "{}\n");
    const problems = verifyManifest(copy).problems.join("\n");
    expect(problems).toContain(`${first} sha256`);
    expect(problems).toContain(`${second} is listed but missing`);
    expect(problems).toContain("scenarios/zz-unlisted.json is not in the manifest");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
