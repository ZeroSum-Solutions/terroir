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

import {
  splitLogicalRecords,
  AmbiguousRecordSplitError,
  UnsupportedLineEndingError,
  isBlankRecord,
} from "../../../scripts/validate-bulk-import";
import { mulberry32 } from "../../../scripts/fixtures/generate-partner-cellar.mjs";
import { parseCsv } from "@/domains/import/csv-parser";

// Canonical 13-column header + a minimal-but-valid data row, shared by the
// line-ending-matrix and contract tests below (they only care about
// structural parsing, not the fixture's dedup/spelling-noise logic).
const CANONICAL_HEADER =
  "producer,name,vintage,varietal,region,country,size_ml,format,currency,quantity,unit_cost,bin,section";

function validRow(producer: string, name: string, qty: number | string = 1): string {
  return `${producer},${name},,,,,,,,${qty},,,`;
}

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

  it("fails CLOSED (throws UnsupportedLineEndingError) on a bare \\r outside quotes, not followed by \\n", () => {
    // Classic pre-OS X Excel/Mac export: lone \r as the only line terminator.
    // Silently treating this the way \r is treated inside CRLF (invisible)
    // would collapse the whole file into one "record" — see round-3 critic
    // fix item 1.
    expect(() => splitLogicalRecords("producer,name\ra,b\r")).toThrow(UnsupportedLineEndingError);
  });

  it("does NOT flag a \\r that is part of a proper CRLF pair", () => {
    // The trailing \r stays part of the sliced record text (unchanged,
    // pre-existing behavior) — the real parseCsv() skips it the same way
    // wherever it appears, so this is harmless; the point of this test is
    // only that CRLF must NOT throw.
    expect(splitLogicalRecords("a,b\r\nc,d\r\n")).toEqual(["a,b\r", "c,d\r"]);
  });

  it("does NOT flag a literal \\r inside a quoted field (it is data, not a line ending)", () => {
    const text = 'producer,name\n"Domaine A","line1\rline2"\n';
    expect(splitLogicalRecords(text)).toEqual(["producer,name", '"Domaine A","line1\rline2"']);
  });
});

describe("isBlankRecord (parser-as-oracle blank-line detection)", () => {
  it("treats a genuinely empty record as blank", () => {
    expect(isBlankRecord("")).toBe(true);
  });

  it("treats a record of only commas (multiple empty fields) as NOT blank", () => {
    expect(isBlankRecord(",,")).toBe(false);
  });

  it("treats an ordinary data record as NOT blank", () => {
    expect(isBlankRecord("Producer A,Wine A,,,,,,,,1,,,")).toBe(false);
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

// ---------------------------------------------------------------------------
// Round-3 gauntlet critic fixes. Every regression below drives the SHIPPED
// CLI as a subprocess (via runValidator()/tsx) with the exit code asserted —
// never the internal splitLogicalRecords()/isBlankRecord() functions alone —
// per the round-3 requirement that these be proven at the CLI boundary a
// human/CI actually runs.
// ---------------------------------------------------------------------------

describe("validate-bulk-import.ts — bare-CR line endings refuse loudly instead of a false PASS (round-3 critic fix item 1, CRITICAL)", () => {
  it("a file using only lone \\r (pre-OS X Excel/Mac) line endings exits non-zero and never reports a false PASS", () => {
    const d = tmp();
    const rows = [
      CANONICAL_HEADER,
      validRow("Producer A", "Wine A"),
      validRow("Producer B", "Wine B"),
      validRow("Producer C", "Wine C"),
    ];
    // Bare CR only — no \n anywhere in the file.
    const csvPath = join(d, "lone-cr.csv");
    writeFileSync(csvPath, rows.join("\r"));

    const result = runValidator(csvPath);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("=== RESULT: PASS ===");
    // The pre-fix bug reported this as a header with 0 data rows and PASSed.
    expect(result.stdout).not.toMatch(/Rows parsed:\s+0\b/);
    expect(result.stderr).toContain("--- FATAL: unsupported line endings ---");
    expect(result.stderr).toContain("pre-OS X Excel/Mac line ending");
  });
});

describe("validate-bulk-import.ts — header-only file is never a PASS (round-3 critic fix item 2, HIGH)", () => {
  it("completely invalid header columns with zero data rows exits non-zero and reports the missing headers", () => {
    const d = tmp();
    const csvPath = join(d, "bad-header-only.csv");
    writeFileSync(csvPath, "foo,bar,baz\n");

    const result = runValidator(csvPath);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Missing required headers:");
    expect(result.stdout).not.toContain("All required headers present.");
    expect(result.stdout).not.toContain("=== RESULT: PASS ===");
    expect(result.stdout).toContain("=== RESULT: FAIL ===");
  });

  it("valid header columns with zero data rows still fails — there is nothing to rehearse the import against", () => {
    const d = tmp();
    const csvPath = join(d, "good-header-only.csv");
    writeFileSync(csvPath, `${CANONICAL_HEADER}\n`);

    const result = runValidator(csvPath);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("All required headers present.");
    expect(result.stdout).toContain("File has a header row but no data rows.");
    expect(result.stdout).not.toContain("=== RESULT: PASS ===");
  });
});

describe("validate-bulk-import.ts — blank-line row-number attribution (round-3 critic fix item 3, HIGH)", () => {
  it("attributes the correct spreadsheet row number to a failure AFTER a blank line, not the parser's post-drop index", () => {
    const d = tmp();
    const lines = [
      CANONICAL_HEADER,
      validRow("Producer One", "Wine One"), // data row 1 — valid
      "", // data row 2 — blank line, dropped by the real parser
      validRow("", "Missing Producer Wine"), // data row 3 — INVALID (empty producer)
      validRow("Producer Four", "Wine Four"), // data row 4 — valid
    ];
    const csvPath = join(d, "blank-interleaved.csv");
    writeFileSync(csvPath, lines.join("\n") + "\n");

    const result = runValidator(csvPath);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/Rows parsed:\s+3\b/);
    expect(result.stdout).toMatch(/Blank lines skipped:\s+1\b/);
    // Correct: data row 3, counting the blank line as its own row (what a
    // human sees in their spreadsheet). The pre-fix bug reported "row 2"
    // (the parser's post-blank-drop output index).
    expect(result.stdout).toContain("row 3: invalid");
    expect(result.stdout).not.toContain("row 2: invalid");
  });
});

describe("validate-bulk-import.ts — full failure diagnostics written to file (round-3 critic fix item 4, MEDIUM)", () => {
  it("writes the complete untagged-failure list to <csv>.failures.json even though the terminal truncates to 10", () => {
    const d = tmp();
    const invalidCount = 15;
    const lines = [CANONICAL_HEADER];
    for (let i = 0; i < invalidCount; i++) {
      lines.push(validRow("", `Bad Wine ${i}`)); // empty producer -> invalid, untagged (no manifest)
    }
    const csvPath = join(d, "dirty-real-file.csv");
    writeFileSync(csvPath, lines.join("\n") + "\n");

    const result = runValidator(csvPath);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/Rows invalid:\s+15\b/);
    // Terminal still only summarizes the first ten.
    expect(result.stdout).toContain("... and 5 more");

    const failuresPath = join(d, "dirty-real-file.failures.json");
    expect(result.stdout).toContain(`Full failure list (15 rows) written to: ${failuresPath}`);

    const report = JSON.parse(readFileSync(failuresPath, "utf8"));
    expect(report.total_untagged_failures).toBe(15);
    expect(report.failures).toHaveLength(15);
    expect(report.failures.every((f: { outcome: string }) => f.outcome === "invalid")).toBe(true);
    // The complete list must include rows beyond the terminal's cutoff.
    expect(report.failures.map((f: { rowIndex: number }) => f.rowIndex)).toContain(15);
  });
});

describe("validate-bulk-import.ts — line-ending matrix", () => {
  const rows3 = [validRow("P1", "Wine One"), validRow("P2", "Wine Two"), validRow("P3", "Wine Three")];

  it("LF-only line endings parse and validate cleanly", () => {
    const d = tmp();
    const csvPath = join(d, "lf.csv");
    writeFileSync(csvPath, [CANONICAL_HEADER, ...rows3].join("\n") + "\n");
    const result = runValidator(csvPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Rows parsed:\s+3\b/);
    expect(result.stdout).toContain("=== RESULT: PASS ===");
  });

  it("CRLF line endings parse and validate cleanly", () => {
    const d = tmp();
    const csvPath = join(d, "crlf.csv");
    writeFileSync(csvPath, [CANONICAL_HEADER, ...rows3].join("\r\n") + "\r\n");
    const result = runValidator(csvPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Rows parsed:\s+3\b/);
    expect(result.stdout).toContain("=== RESULT: PASS ===");
  });

  it("mixed CRLF and LF line endings (different tools touched the same file) parse and validate cleanly", () => {
    const d = tmp();
    const csvPath = join(d, "mixed.csv");
    const csvText = `${CANONICAL_HEADER}\r\n${rows3[0]}\n${rows3[1]}\r\n${rows3[2]}\n`;
    writeFileSync(csvPath, csvText);
    const result = runValidator(csvPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Rows parsed:\s+3\b/);
    expect(result.stdout).toContain("=== RESULT: PASS ===");
  });

  it("a file with no trailing newline still parses its final row", () => {
    const d = tmp();
    const csvPath = join(d, "no-trailing-newline.csv");
    writeFileSync(csvPath, [CANONICAL_HEADER, ...rows3].join("\n"));
    const result = runValidator(csvPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Rows parsed:\s+3\b/);
    expect(result.stdout).toContain("=== RESULT: PASS ===");
  });

  it("a UTF-8 BOM at the start of the file is stripped and does not corrupt the first header cell", () => {
    const d = tmp();
    const csvPath = join(d, "bom.csv");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from([CANONICAL_HEADER, ...rows3].join("\n") + "\n", "utf8");
    writeFileSync(csvPath, Buffer.concat([bom, body]));
    const result = runValidator(csvPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All required headers present.");
    expect(result.stdout).toMatch(/Rows parsed:\s+3\b/);
    expect(result.stdout).toContain("=== RESULT: PASS ===");
  });

  it("a completely empty file fails closed rather than crashing", () => {
    const d = tmp();
    const csvPath = join(d, "empty.csv");
    writeFileSync(csvPath, "");
    const result = runValidator(csvPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("File is empty (no header row).");
    expect(result.stdout).not.toContain("=== RESULT: PASS ===");
  });

  it("an unterminated quote at EOF fails closed via the shipped CLI, not just the internal splitter", () => {
    const d = tmp();
    const csvPath = join(d, "unterminated-quote.csv");
    writeFileSync(csvPath, `${CANONICAL_HEADER}\n"Domaine Open,Cuvee 1\n`);
    const result = runValidator(csvPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot determine record boundaries");
    expect(result.stdout).not.toContain("=== RESULT: PASS ===");
  });
});

describe("validate-bulk-import.ts — 1:1 record<->row contract against the real parser (property test)", () => {
  // The critic's named root cause: there is no reliable one-to-one contract
  // between the records splitLogicalRecords() emits and the rows the real
  // parseCsv() emits. This generates deterministic, seeded, adversarially-
  // shaped (but well-formed — no bare CR, no unterminated quotes; those are
  // covered as their own fail-closed cases above) CSV texts and checks the
  // real parser's output against the splitter's own record boundaries.
  const ALPHABET = "abcdefghij ABCDEFGHIJ01234567";

  function randomWord(rng: () => number): string {
    const len = 1 + Math.floor(rng() * 6);
    let s = "";
    for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    return s;
  }

  function randomCell(rng: () => number): string {
    const kind = Math.floor(rng() * 5);
    if (kind === 0) return "";
    if (kind === 1) return randomWord(rng);
    if (kind === 2) return `"${randomWord(rng)},${randomWord(rng)}"`;
    if (kind === 3) return `"He said ""${randomWord(rng)}"" ok"`;
    return `"${randomWord(rng)}\n${randomWord(rng)}"`;
  }

  function randomRecord(rng: () => number, blankChance: number): string {
    if (rng() < blankChance) return "";
    const numCols = 1 + Math.floor(rng() * 4);
    const cells: string[] = [];
    for (let c = 0; c < numCols; c++) cells.push(randomCell(rng));
    return cells.join(",");
  }

  function randomCsvText(seed: number): string {
    const rng = mulberry32(seed);
    const headerCols = 2 + Math.floor(rng() * 3);
    const header: string[] = [];
    for (let c = 0; c < headerCols; c++) header.push(randomWord(rng));
    const numRecords = Math.floor(rng() * 25);
    const records: string[] = [];
    for (let i = 0; i < numRecords; i++) records.push(randomRecord(rng, 0.15));
    const trailingNewline = rng() < 0.5;
    return [header.join(","), ...records].join("\n") + (trailingNewline ? "\n" : "");
  }

  const SEED_BASE = 987654321;
  const CASES = 200;

  it(`holds across ${CASES} deterministic randomized adversarial inputs`, () => {
    for (let caseIndex = 0; caseIndex < CASES; caseIndex++) {
      const text = randomCsvText(SEED_BASE + caseIndex);

      // Guard: this generator never emits bare CR or unterminated quotes,
      // so the splitter must never throw for these cases.
      const records = splitLogicalRecords(text);
      expect(records.length).toBeGreaterThan(0);
      const [header, ...dataRecords] = records;
      const nonBlankRecords = dataRecords.filter((r) => !isBlankRecord(r));

      const result = parseCsv(text);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      // The core invariant: exactly one real-parser output row per
      // non-blank record the splitter found.
      expect(result.rows.length).toBe(nonBlankRecords.length);

      // A stronger check: each surviving record, parsed completely alone
      // (header + just that one record), must produce byte-identical cells
      // to what the joint whole-text parse produced for it — the exact
      // property the chunk/per-record-fallback dual path in main() relies
      // on to ever be safe.
      for (let k = 0; k < nonBlankRecords.length; k++) {
        const isolated = parseCsv(`${header}\n${nonBlankRecords[k]}\n`);
        expect(isolated.ok).toBe(true);
        if (isolated.ok) {
          expect(result.rows[k]).toEqual(isolated.rows[0]);
        }
      }
    }
  });
});

describe("run-bulk-import-test.sh — default no-arg flow (fix item 4)", () => {
  it("generates base + extras, validates both, and exits 0 with a final PASS line", () => {
    const result = spawnSync("bash", [RUNNER_SH], { encoding: "utf8", cwd: process.cwd() });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nv_literal:");
    expect(result.stdout).toContain("--- Barcode (EAN-13) ---");
    expect(result.stdout).toContain("=== run-bulk-import-test: PASS (base + extras + dirty) ===");
  }, 30_000);

  it("also generates + validates the --dirty variant, exercising poisoned-chunk isolation end to end (round-3 critic fix item 5, MEDIUM)", () => {
    const result = spawnSync("bash", [RUNNER_SH], { encoding: "utf8", cwd: process.cwd() });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fixtures/generated/dirty/partner-cellar-20k.csv");
    expect(result.stdout).toContain(
      "oversized_field: expected=16 seen=16 matched=16 (OK — expected-invalid-under-current-importer)",
    );
    expect(result.stdout).toContain(
      "bad_vintage_text: expected=17 seen=17 matched=17 (OK — expected-invalid-under-current-importer)",
    );
    expect(result.stdout).toContain(
      "negative_quantity: expected=17 seen=17 matched=17 (OK — expected-invalid-under-current-importer)",
    );
  }, 30_000);
});
