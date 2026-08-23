// P1 — tests for scripts/validate-bulk-import.ts (the real command-line
// runner scripts/run-bulk-import-test.sh drives) and for
// splitLogicalRecords(), its quote-state-aware chunk-boundary splitter.
//
// Every end-to-end assertion here drives the SHIPPED CLI as a subprocess
// (via tsx, exactly how run-bulk-import-test.sh invokes it) rather than
// reimplementing its chunking/classification logic — that reimplementation
// is exactly what let the original chunk-on-raw-lines bug ship undetected.
// Colocated under src/test (like src/test/fixtures/generate-partner-cellar.test.ts)
// so it runs under the repo's normal `pnpm test`.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { splitLogicalRecords, AmbiguousRecordSplitError } from "../../../scripts/validate-bulk-import";

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const VALIDATOR_CLI = join(process.cwd(), "scripts", "validate-bulk-import.ts");
const GENERATOR_CLI = join(process.cwd(), "scripts", "fixtures", "generate-partner-cellar.mjs");
const RUNNER_SH = join(process.cwd(), "scripts", "run-bulk-import-test.sh");

function runValidator(csvPath: string, manifestPath?: string) {
  const args = manifestPath ? [VALIDATOR_CLI, csvPath, manifestPath] : [VALIDATOR_CLI, csvPath];
  return spawnSync(TSX, args, { encoding: "utf8" });
}

function runGenerator(args: string[]) {
  const result = spawnSync(process.execPath, [GENERATOR_CLI, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`generator CLI failed (status ${result.status}): ${result.stderr}`);
  }
  return result;
}

const tempDirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "validate-bulk-import-"));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("splitLogicalRecords (quote-state-aware chunk boundary splitter)", () => {
  it("splits simple rows on plain newlines", () => {
    expect(splitLogicalRecords("a,b\nc,d\ne,f\n")).toEqual(["a,b", "c,d", "e,f"]);
  });

  it("does NOT split inside a quoted field that embeds a literal newline", () => {
    const text = 'producer,name\n"Domaine A","Cuvee\nLine 2"\nDomaine B,Cuvee 2\n';
    const records = splitLogicalRecords(text);
    expect(records).toEqual(["producer,name", '"Domaine A","Cuvee\nLine 2"', "Domaine B,Cuvee 2"]);
  });

  it("fails CLOSED (throws) on an unterminated quote instead of guessing a boundary", () => {
    expect(() => splitLogicalRecords('producer,name\n"Domaine A,Cuvee 1\n')).toThrow(AmbiguousRecordSplitError);
  });
});

describe("validate-bulk-import.ts — multiline-record chunk-boundary regression (fix item 1)", () => {
  it("parses a record whose embedded newline straddles the old 5,000-line chunk boundary, byte-exact, exit 0", () => {
    // Row 5000 (1-indexed data row) carries a quoted "name" field with a
    // literal embedded newline. With the OLD naive `text.split("\n")`
    // chunker this would land right at the physical-line-5000 cut: the
    // chunk would see an unterminated quote (or, worse, silently splice a
    // stray fragment into a new "row"). All the filler rows share one
    // producer/name so any corruption of the boundary row would also show
    // up as a THIRD distinct variant key instead of exactly two.
    const d = tmp();
    const header = "producer,name,vintage,varietal,region,country,size_ml,format,currency,quantity,unit_cost,bin,section";
    const filler = "Bulk Filler,Case Lot,,,,,,,,1,,,";
    const lines = [header];
    for (let i = 0; i < 4999; i++) lines.push(filler);
    lines.push('P5000,"Special Reserve\nSecond Line",,,,,,,,1,,,');
    for (let i = 0; i < 10; i++) lines.push(filler);
    const csvText = lines.join("\n") + "\n";
    const csvPath = join(d, "multiline-boundary.csv");
    writeFileSync(csvPath, csvText);

    const result = runValidator(csvPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Rows parsed:\s+5010/);
    expect(result.stdout).toMatch(/Rows unparseable:\s+0\b/);
    expect(result.stdout).toMatch(/Rows valid:\s+5010/);
    expect(result.stdout).toMatch(/Rows invalid:\s+0\b/);
    expect(result.stdout).toMatch(/Distinct raw variant keys:\s+2\b/);
    // Byte-exact preservation of the multiline field, straight from the
    // shipped runner's own diagnostic output (not reconstructed by the test).
    expect(result.stdout).toContain("P5000|Special Reserve\nSecond Line|NV|750");
    expect(result.stdout).toContain("=== RESULT: PASS ===");
  });
});

describe("validate-bulk-import.ts — nv_literal group (fix item 3)", () => {
  const d = tmp();
  runGenerator(["--out-dir", d]);
  const manifest = JSON.parse(readFileSync(join(d, "partner-cellar-20k.manifest.json"), "utf8"));

  it("reports the manifest's nv_literal group as its own expected-invalid category, and everything else valid", () => {
    const result = runValidator(join(d, "partner-cellar-20k.csv"), join(d, "partner-cellar-20k.manifest.json"));
    expect(result.status).toBe(0);
    const nvLiteralCount = manifest.nv_literal_rows.length;
    expect(nvLiteralCount).toBeGreaterThan(0);
    expect(result.stdout).toMatch(new RegExp(`Rows invalid:\\s+${nvLiteralCount}\\b`));
    expect(result.stdout).toMatch(/Rows unparseable:\s+0\b/);
    expect(result.stdout).toContain(
      `nv_literal: expected=${nvLiteralCount} seen=${nvLiteralCount} matched=${nvLiteralCount} (OK — expected-invalid-under-current-importer)`,
    );
    expect(result.stdout).toContain("=== RESULT: PASS ===");
  });
});

describe("validate-bulk-import.ts — per-record dirty attribution (fix item 5)", () => {
  const d = tmp();
  runGenerator(["--dirty", "--out-dir", d]);
  const manifest = JSON.parse(readFileSync(join(d, "partner-cellar-20k.manifest.json"), "utf8"));

  it("attributes each dirty category its own exact count instead of one oversized field poisoning a whole 5,000-row chunk", () => {
    const result = runValidator(join(d, "partner-cellar-20k.csv"), join(d, "partner-cellar-20k.manifest.json"));
    expect(result.status).toBe(0);

    const byCategory: Record<string, number> = {};
    for (const dr of manifest.dirty_rows as { category: string }[]) {
      byCategory[dr.category] = (byCategory[dr.category] ?? 0) + 1;
    }
    expect(byCategory.oversized_field).toBeGreaterThan(0);

    // The bug this regression guards: an oversized field failing the
    // *chunk-level* parseCsv() call used to mark every sibling row in that
    // 5,000-row chunk unparseable. Correct per-record attribution means
    // "Rows unparseable" equals exactly the oversized_field count — not
    // thousands.
    expect(result.stdout).toMatch(new RegExp(`Rows unparseable:\\s+${byCategory.oversized_field}\\b`));

    for (const [category, count] of Object.entries(byCategory)) {
      expect(result.stdout).toContain(
        `${category}: expected=${count} seen=${count} matched=${count} (OK — expected-invalid-under-current-importer)`,
      );
    }
    expect(result.stdout).toContain("=== RESULT: PASS ===");
  });
});

describe("validate-bulk-import.ts — --extras barcode/EAN-13 path (fix item 4)", () => {
  const d = tmp();
  runGenerator(["--extras", "--out-dir", d]);
  const manifest = JSON.parse(readFileSync(join(d, "partner-cellar-20k-extras.manifest.json"), "utf8"));

  it("verifies every barcode's EAN-13 check digit end to end and matches the manifest's coverage", () => {
    expect(manifest.barcode.enabled).toBe(true);
    expect(manifest.barcode.rows_with_barcode).toBeGreaterThan(0);

    const result = runValidator(
      join(d, "partner-cellar-20k-extras.csv"),
      join(d, "partner-cellar-20k-extras.manifest.json"),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`Rows with barcode:\\s+${manifest.barcode.rows_with_barcode}\\b`));
    expect(result.stdout).toMatch(new RegExp(`Valid check digits:\\s+${manifest.barcode.rows_with_barcode}\\b`));
    expect(result.stdout).not.toContain("Invalid check digits:");
    expect(result.stdout).toContain("=== RESULT: PASS ===");
  });
});

describe("validate-bulk-import.ts — sha256 integrity check (fix item 2)", () => {
  it("exits non-zero when the CSV's sha256 no longer matches the manifest (corrupted/stale file)", () => {
    const d = tmp();
    runGenerator(["--sample-only", "--out-dir", d]);
    const csvPath = join(d, "partner-cellar-sample-500.csv");
    const manifestPath = join(d, "partner-cellar-sample-500.manifest.json");

    const bytes = readFileSync(csvPath);
    const corrupted = Buffer.from(bytes);
    // Flip one bit deep in the file body — enough to change the sha256
    // without necessarily breaking CSV syntax.
    const idx = Math.floor(corrupted.length / 2);
    corrupted[idx] = corrupted[idx] ^ 0x01;
    writeFileSync(csvPath, corrupted);

    const result = runValidator(csvPath, manifestPath);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("MISMATCH");
    expect(result.stdout).toContain("=== RESULT: FAIL ===");
  });
});

describe("run-bulk-import-test.sh — default no-arg flow (fix item 4)", () => {
  it("generates base + extras, validates both, and exits 0 with a final PASS line", () => {
    const result = spawnSync("bash", [RUNNER_SH], { encoding: "utf8", cwd: process.cwd() });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nv_literal:");
    expect(result.stdout).toContain("--- Barcode (EAN-13) ---");
    expect(result.stdout).toContain("=== run-bulk-import-test: PASS (base + extras) ===");
  }, 30_000);
});
