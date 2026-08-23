/**
 * P1 — validate a partner-cellar CSV against the repo's OWN csv-parser +
 * row-validator (src/domains/import/*). This is the "validation" half of
 * scripts/run-bulk-import-test.sh: no DB, no network, just parse+validate
 * and report numbers.
 *
 * Usage:
 *   npx tsx scripts/validate-bulk-import.ts <csv-path> [manifest-path]
 *
 * If manifest-path is omitted, the script looks for a sibling
 * "<csv-without-ext>.manifest.json" and uses it if present; otherwise it
 * skips the manifest cross-check (this is what lets the same entry point
 * run against a real partner file later, with no ground-truth manifest).
 *
 * A note on MAX_ROWS: the current importer's csv-parser rejects any file
 * with more than MAX_ROWS (5000) data rows in a single parseCsv() call —
 * that is the real, live limit a real upload hits today. The 20k fixture
 * this script is usually pointed at deliberately EXCEEDS that limit (it
 * represents future bulk-import work, see constants.ts's G1-6 comment on
 * the not-yet-wired background_jobs runner). To still get row-level
 * parse/validate statistics across the whole file, this script chunks the
 * data rows into MAX_ROWS-sized groups and calls the real parseCsv() once
 * per chunk — each chunk is parsed and validated exactly as the product
 * would, just MAX_ROWS rows at a time instead of one request. A file that
 * already fits in a single chunk (<= MAX_ROWS rows, e.g. eventually the
 * real partner file) takes exactly the same single-call path the product
 * uses today, with zero extra behavior.
 *
 * Caveat: this chunking assumes no field contains an embedded newline
 * (true for every fixture this generator produces). A hostile/real file
 * with a quoted multi-line field that happens to straddle a chunk boundary
 * would misparse at that boundary; this script cannot detect that case
 * without fully parsing the file in one pass first (which is exactly the
 * MAX_ROWS-limited path it's working around). Flagged here rather than
 * silently assumed.
 */

import { readFileSync, existsSync } from "node:fs";
import { decodeCsvBuffer, parseCsv } from "../src/domains/import/csv-parser";
import { mapHeader, validateRow, type ValidatedRow } from "../src/domains/import/row-validator";
import { MAX_ROWS } from "../src/domains/import/constants";

type Manifest = {
  expected_unique_variant_count?: number;
  category_summary?: Record<string, number>;
  total_rows?: number;
  clean_row_count?: number;
  dirty_row_count?: number;
};

function splitLines(text: string): { header: string; dataLines: string[] } {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const [header, ...dataLines] = lines;
  return { header: header ?? "", dataLines };
}

function main() {
  const [, , csvPathArg, manifestPathArg] = process.argv;
  const csvPath = csvPathArg ?? "fixtures/generated/partner-cellar-20k.csv";

  console.log("=== P1 bulk-import validation runner ===");
  console.log("(This entry point will grow to cover import + enrichment in later pieces.)");
  console.log(`CSV:      ${csvPath}`);

  if (!existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`);
    process.exit(1);
  }

  let manifestPath = manifestPathArg ?? null;
  if (!manifestPath) {
    const guess = csvPath.replace(/\.csv$/, ".manifest.json");
    if (guess !== csvPath && existsSync(guess)) manifestPath = guess;
  }
  let manifest: Manifest | null = null;
  if (manifestPath && existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    console.log(`Manifest: ${manifestPath}`);
  } else {
    console.log("Manifest: (none found — skipping ground-truth assertions)");
  }
  console.log("");

  const startMs = performance.now();

  const buffer = readFileSync(csvPath);
  const text = decodeCsvBuffer(buffer);
  const { header, dataLines } = splitLines(text);

  if (dataLines.length > MAX_ROWS) {
    console.log(
      `NOTE: file has ${dataLines.length} data rows, exceeding the current importer's ` +
        `MAX_ROWS=${MAX_ROWS}. A single real upload would be rejected outright ` +
        `(too_many_rows). Chunking into groups of ${MAX_ROWS} to still get full-file ` +
        `parse/validate statistics from the real csv-parser + row-validator.`,
    );
  }

  let columnToField: Map<number, string> | null = null;
  let missingRequired: string[] = [];
  let rowsParsed = 0;
  let rowsUnparseable = 0;
  let rowsValid = 0;
  let rowsInvalid = 0;
  const distinctRawVariantKeys = new Set<string>();
  const unparseableChunks: { fromLine: number; toLine: number; reason: string }[] = [];
  const sampleInvalidReasons: string[] = [];

  for (let offset = 0; offset < dataLines.length; offset += MAX_ROWS) {
    const chunkLines = dataLines.slice(offset, offset + MAX_ROWS);
    const chunkText = [header, ...chunkLines].join("\n") + "\n";
    const result = parseCsv(chunkText);

    if (!result.ok) {
      rowsUnparseable += chunkLines.length;
      unparseableChunks.push({
        fromLine: offset + 1,
        toLine: offset + chunkLines.length,
        reason: `${result.error.code}: ${result.error.message}`,
      });
      continue;
    }

    if (!columnToField) {
      const mapped = mapHeader(result.header);
      columnToField = mapped.columnToField as unknown as Map<number, string>;
      missingRequired = mapped.missingRequired;
    }

    for (const cells of result.rows) {
      rowsParsed++;
      const validated: ValidatedRow = validateRow(cells, columnToField as any);
      if (validated.state === "valid") {
        rowsValid++;
      } else {
        rowsInvalid++;
        if (sampleInvalidReasons.length < 5) {
          sampleInvalidReasons.push(validated.errors.map((e) => `${e.field}: ${e.message}`).join("; "));
        }
      }
      const key = `${validated.raw.producer}|${validated.raw.name}|${validated.raw.vintage ?? "NV"}|${validated.raw.size_ml}`;
      distinctRawVariantKeys.add(key);
    }
  }

  const wallClockMs = Math.round((performance.now() - startMs) * 100) / 100;

  console.log("");
  console.log("--- Header mapping ---");
  if (missingRequired.length > 0) {
    console.log(`Missing required headers: ${missingRequired.join(", ")}`);
  } else {
    console.log("All required headers present.");
  }

  console.log("");
  console.log("--- Results ---");
  console.log(`Rows parsed:              ${rowsParsed}`);
  console.log(`Rows unparseable:         ${rowsUnparseable}${rowsUnparseable > 0 ? "  (parser-level rejection, see below)" : ""}`);
  console.log(`Rows valid:               ${rowsValid}`);
  console.log(`Rows invalid:             ${rowsInvalid}`);
  console.log(`Distinct raw variant keys: ${distinctRawVariantKeys.size}`);
  console.log(`Wall-clock:               ${wallClockMs} ms`);

  if (unparseableChunks.length > 0) {
    console.log("");
    console.log("--- Unparseable chunks ---");
    for (const c of unparseableChunks) {
      console.log(`  lines ${c.fromLine}-${c.toLine}: ${c.reason}`);
    }
  }

  if (sampleInvalidReasons.length > 0) {
    console.log("");
    console.log("--- Sample invalid-row reasons ---");
    for (const r of sampleInvalidReasons) console.log(`  ${r}`);
  }

  if (manifest) {
    console.log("");
    console.log("--- Manifest cross-check ---");
    if (typeof manifest.expected_unique_variant_count === "number") {
      const naive = distinctRawVariantKeys.size;
      const expected = manifest.expected_unique_variant_count;
      console.log(`Ground-truth unique variants:     ${expected}`);
      console.log(`Naive distinct raw variant keys:  ${naive}`);
      console.log(
        naive === expected
          ? "  (equal — no spelling noise in this file, or it happened to cancel out)"
          : `  (raw count is ${naive > expected ? "higher" : "lower"} than ground truth by ${Math.abs(naive - expected)} — expected when spelling-noise groups are present; a real dedup pass must close this gap)`,
      );
    }
    if (manifest.category_summary) {
      console.log(`Category summary (from manifest): ${JSON.stringify(manifest.category_summary)}`);
    }
  }

  console.log("");
  console.log("=== done ===");
}

main();
