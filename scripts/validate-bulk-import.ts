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
 * that is the real, live limit a real upload hits today (enforced INSIDE
 * parseCsv itself, not in a separate upload/preview layer — so parseCsv()
 * cannot simply be called once on an oversized file). The 20k fixture this
 * script is usually pointed at deliberately EXCEEDS that limit (it
 * represents future bulk-import work, see constants.ts's G1-6 comment on
 * the not-yet-wired background_jobs runner). To still get row-level
 * parse/validate statistics across the whole file, this script chunks the
 * data into MAX_ROWS-sized groups and calls the real parseCsv() once per
 * chunk — each chunk is parsed and validated exactly as the product would,
 * just MAX_ROWS rows at a time instead of one request.
 *
 * Chunk boundaries are found by splitLogicalRecords() below — a
 * quote-state-aware scan of the RAW TEXT that tracks RFC-4180 quoting
 * (mirroring csv-parser.ts's own quote-start rule) to find where each
 * logical record actually starts and ends, INCLUDING a record whose quoted
 * field embeds a literal newline. This script never chunks on raw physical
 * lines: a naive `text.split("\n")` before parsing would cut a multi-line
 * quoted field in half at whatever chunk boundary it happens to cross,
 * corrupting that record and shifting every row number after it. If the
 * splitter can't resolve where a record ends (an unterminated quote through
 * EOF), it fails CLOSED — throws, and this script exits non-zero rather
 * than guessing.
 *
 * Exit code: this script is intentionally strict. It exits non-zero when:
 *   - any record fails to parse (unparseable) — unless a manifest tags that
 *     exact row index as an expected-invalid row (see below) whose expected
 *     outcome is "unparseable" (e.g. the --dirty oversized_field group);
 *   - any row NOT tagged by the manifest as expected-invalid fails
 *     row-validator validation;
 *   - a manifest-tagged expected-invalid row unexpectedly validates fine
 *     (the fixture's dirty-injection or the importer's behavior drifted);
 *   - a manifest-tagged group's observed row count doesn't match the
 *     manifest's count for that group;
 *   - the file's total row count doesn't match manifest.total_rows;
 *   - the CSV's sha256 doesn't match manifest.csv_sha256 (computed over the
 *     raw file bytes and actually compared — not just printed);
 *   - any --extras barcode fails its EAN-13 check digit.
 * With NO manifest (a real file with no ground truth), there are no tagged
 * groups, so ANY parse or validation failure is "untagged" and fails the
 * run. That is a deliberate, documented stance for now — a later piece can
 * relax this for real-world files that legitimately contain some bad rows;
 * today this script's job is a strict self-test of the fixture + importer
 * pairing, not a lenient real-file reviewer.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeCsvBuffer, parseCsv } from "../src/domains/import/csv-parser";
import { mapHeader, validateRow, type ValidatedRow } from "../src/domains/import/row-validator";
import { MAX_ROWS } from "../src/domains/import/constants";

type DirtyRowEntry = { row_index: number; category: string; detail?: string };
type NvLiteralRowEntry = { row_index: number; producer?: string; name?: string };
type BarcodeManifest = {
  enabled: boolean;
  rows_with_barcode: number;
  total_rows: number;
  coverage_pct: number;
  all_check_digits_valid: boolean;
} | null;

type Manifest = {
  expected_unique_variant_count?: number;
  category_summary?: Record<string, number>;
  total_rows?: number;
  clean_row_count?: number;
  dirty_row_count?: number;
  csv_sha256?: string;
  dirty_rows?: DirtyRowEntry[];
  nv_literal_rows?: NvLiteralRowEntry[];
  barcode?: BarcodeManifest;
};

// ---------------------------------------------------------------------------
// Quote-state-aware logical record splitter.
//
// Mirrors csv-parser.ts's own row-boundary rule exactly (a `"` only opens a
// quoted field when it is the very first character of that field — see
// parseCsv's `char === '"' && field === ""` check) but does NOT enforce
// MAX_ROWS or MAX_FIELD_LENGTH: its only job is finding where each logical
// CSV record starts and ends in the raw text, so a chunk of raw text handed
// to the real parseCsv() always begins and ends on a true record boundary —
// even when a quoted field embeds a literal newline. If the two state
// machines ever disagreed about what counts as "inside quotes", a chunk
// boundary could still land mid-field; keeping the exact same start-of-field
// rule is what guarantees they don't.
// ---------------------------------------------------------------------------

export class AmbiguousRecordSplitError extends Error {}

export function splitLogicalRecords(text: string): string[] {
  const records: string[] = [];
  let recordStart = 0;
  let inQuotes = false;
  let fieldEmpty = true;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          i += 2;
          fieldEmpty = false;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      i += 1;
      fieldEmpty = false;
      continue;
    }

    if (char === '"' && fieldEmpty) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      fieldEmpty = true;
      i += 1;
      continue;
    }
    if (char === "\r") {
      i += 1;
      continue;
    }
    if (char === "\n") {
      records.push(text.slice(recordStart, i));
      i += 1;
      recordStart = i;
      fieldEmpty = true;
      continue;
    }
    fieldEmpty = false;
    i += 1;
  }

  if (inQuotes) {
    throw new AmbiguousRecordSplitError(
      "A quoted field is never closed (unterminated quote through EOF) — cannot determine logical record boundaries.",
    );
  }

  if (recordStart < len) {
    records.push(text.slice(recordStart));
  }
  // Drop one fully-blank trailing record (a file that ends with a newline).
  if (records.length > 0 && records[records.length - 1] === "") records.pop();
  return records;
}

function sha256HexOfBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

type RowOutcome = "valid" | "invalid" | "unparseable";

type GroupExpectation = { outcome: RowOutcome; field?: string };

const DIRTY_CATEGORY_EXPECTATION: Record<string, GroupExpectation> = {
  bad_vintage_text: { outcome: "invalid", field: "vintage" },
  negative_quantity: { outcome: "invalid", field: "quantity" },
  oversized_field: { outcome: "unparseable" },
};

type GroupStat = {
  expectedCount: number;
  seenCount: number;
  matchedCount: number;
  mismatches: { rowIndex: number; outcome: RowOutcome; detail: string }[];
};

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

  let hasFailure = false;
  const failureReasons: string[] = [];
  function fail(reason: string) {
    hasFailure = true;
    failureReasons.push(reason);
  }

  const startMs = performance.now();

  const buffer = readFileSync(csvPath);
  const text = decodeCsvBuffer(buffer);

  let allRecords: string[];
  try {
    allRecords = splitLogicalRecords(text);
  } catch (err) {
    if (err instanceof AmbiguousRecordSplitError) {
      console.error("");
      console.error("--- FATAL: cannot determine record boundaries ---");
      console.error(err.message);
      console.error("");
      console.error("=== RESULT: FAIL ===");
      process.exit(1);
    }
    throw err;
  }

  if (allRecords.length === 0) {
    console.error("File is empty (no header row).");
    console.error("=== RESULT: FAIL ===");
    process.exit(1);
  }

  const [headerRecord, ...dataRecords] = allRecords;

  if (dataRecords.length > MAX_ROWS) {
    console.log(
      `NOTE: file has ${dataRecords.length} data rows, exceeding the current importer's ` +
        `MAX_ROWS=${MAX_ROWS}. A single real upload would be rejected outright ` +
        `(too_many_rows). Chunking into groups of ${MAX_ROWS} logical records (never raw ` +
        `lines) to still get full-file parse/validate statistics from the real ` +
        `csv-parser + row-validator.`,
    );
  }

  // --- Manifest-driven "expected invalid" classification --------------------
  const knownBad = new Map<number, { group: string; expectation: GroupExpectation }>();
  const groupStats = new Map<string, GroupStat>();
  const groupExpectations = new Map<string, GroupExpectation>();

  function registerExpected(group: string, rowIndex: number, expectation: GroupExpectation) {
    knownBad.set(rowIndex, { group, expectation });
    groupExpectations.set(group, expectation);
    const stat = groupStats.get(group) ?? { expectedCount: 0, seenCount: 0, matchedCount: 0, mismatches: [] };
    stat.expectedCount += 1;
    groupStats.set(group, stat);
  }

  if (manifest?.dirty_rows) {
    for (const dr of manifest.dirty_rows) {
      const expectation = DIRTY_CATEGORY_EXPECTATION[dr.category];
      if (!expectation) {
        fail(`Manifest dirty_rows contains unknown category "${dr.category}" — no expectation defined for it.`);
        continue;
      }
      registerExpected(dr.category, dr.row_index, expectation);
    }
  }
  if (manifest?.nv_literal_rows) {
    for (const nv of manifest.nv_literal_rows) {
      registerExpected("nv_literal", nv.row_index, { outcome: "invalid", field: "vintage" });
    }
  }

  // --- Header / column mapping ------------------------------------------
  let columnToField: ReturnType<typeof mapHeader>["columnToField"] | null = null;
  let missingRequired: ReturnType<typeof mapHeader>["missingRequired"] = [];
  let barcodeColumnIndex = -1;

  let rowsParsed = 0;
  let rowsUnparseable = 0;
  let rowsValid = 0;
  let rowsInvalid = 0;
  const distinctRawVariantKeys = new Set<string>();
  const sampleInvalidReasons: string[] = [];
  const untaggedFailures: { rowIndex: number; outcome: RowOutcome; detail: string }[] = [];

  let barcodeSeen = 0;
  let barcodeValid = 0;
  const barcodeMismatches: number[] = [];

  function ensureHeaderMapped(header: string[]) {
    if (columnToField) return;
    const mapped = mapHeader(header);
    columnToField = mapped.columnToField;
    missingRequired = mapped.missingRequired;
    barcodeColumnIndex = header.findIndex((h) => h.trim().toLowerCase() === "barcode");
  }

  function classifyOutcome(rowIndex: number, outcome: RowOutcome, detail: string) {
    const tag = knownBad.get(rowIndex);
    if (!tag) {
      if (outcome !== "valid") {
        untaggedFailures.push({ rowIndex, outcome, detail });
      }
      return;
    }
    const stat = groupStats.get(tag.group)!;
    stat.seenCount += 1;
    const outcomeMatches =
      outcome === tag.expectation.outcome && (!tag.expectation.field || detail.includes(tag.expectation.field));
    if (outcomeMatches) {
      stat.matchedCount += 1;
    } else {
      stat.mismatches.push({ rowIndex, outcome, detail });
    }
  }

  function checkBarcode(rowIndex: number, cells: string[]) {
    if (barcodeColumnIndex < 0) return;
    const barcode = (cells[barcodeColumnIndex] ?? "").trim();
    if (!barcode) return;
    barcodeSeen += 1;
    const twelve = barcode.slice(0, 12);
    const check = barcode.slice(12);
    if (!/^\d{12}$/.test(twelve) || !/^\d$/.test(check)) {
      barcodeMismatches.push(rowIndex);
      return;
    }
    let sum = 0;
    for (let d = 0; d < 12; d++) {
      const digit = Number(twelve[d]);
      sum += d % 2 === 0 ? digit : digit * 3;
    }
    const mod = sum % 10;
    const expectedCheck = mod === 0 ? 0 : 10 - mod;
    if (String(expectedCheck) === check) {
      barcodeValid += 1;
    } else {
      barcodeMismatches.push(rowIndex);
    }
  }

  function processRow(rowIndex: number, cells: string[]) {
    rowsParsed += 1;
    const validated: ValidatedRow = validateRow(cells, columnToField!);
    let detail = "";
    if (validated.state === "valid") {
      rowsValid += 1;
      classifyOutcome(rowIndex, "valid", "");
    } else {
      rowsInvalid += 1;
      detail = validated.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      if (sampleInvalidReasons.length < 5) sampleInvalidReasons.push(detail);
      classifyOutcome(rowIndex, "invalid", detail);
    }
    const key = `${validated.raw.producer}|${validated.raw.name}|${validated.raw.vintage ?? "NV"}|${validated.raw.size_ml}`;
    distinctRawVariantKeys.add(key);
    checkBarcode(rowIndex, cells);
  }

  function recordUnparseable(rowIndex: number, reason: string) {
    rowsUnparseable += 1;
    classifyOutcome(rowIndex, "unparseable", reason);
  }

  for (let offset = 0; offset < dataRecords.length; offset += MAX_ROWS) {
    const chunkRecords = dataRecords.slice(offset, offset + MAX_ROWS);
    const chunkText = [headerRecord, ...chunkRecords].join("\n") + "\n";
    const result = parseCsv(chunkText);

    if (result.ok) {
      ensureHeaderMapped(result.header);
      result.rows.forEach((cells, k) => processRow(offset + k + 1, cells));
      continue;
    }

    // Chunk-level failure: fall back to per-record isolation so ONE
    // poisoned record (e.g. an oversized field) doesn't mark every sibling
    // record in the chunk unparseable (see module doc + fix item 5).
    for (let k = 0; k < chunkRecords.length; k++) {
      const rowIndex = offset + k + 1;
      const singleText = `${headerRecord}\n${chunkRecords[k]}\n`;
      const singleResult = parseCsv(singleText);
      if (!singleResult.ok) {
        recordUnparseable(rowIndex, `${singleResult.error.code}: ${singleResult.error.message}`);
        continue;
      }
      ensureHeaderMapped(singleResult.header);
      processRow(rowIndex, singleResult.rows[0]);
    }
  }

  const wallClockMs = Math.round((performance.now() - startMs) * 100) / 100;

  // --- Reporting ----------------------------------------------------------
  console.log("--- Header mapping ---");
  if (missingRequired.length > 0) {
    console.log(`Missing required headers: ${missingRequired.join(", ")}`);
    fail(`Missing required headers: ${missingRequired.join(", ")}`);
  } else {
    console.log("All required headers present.");
  }

  console.log("");
  console.log("--- Results ---");
  console.log(`Rows parsed:              ${rowsParsed}`);
  console.log(`Rows unparseable:         ${rowsUnparseable}${rowsUnparseable > 0 ? "  (parser-level rejection)" : ""}`);
  console.log(`Rows valid:               ${rowsValid}`);
  console.log(`Rows invalid:             ${rowsInvalid}`);
  console.log(`Distinct raw variant keys: ${distinctRawVariantKeys.size}`);
  console.log(`Wall-clock:               ${wallClockMs} ms`);

  const totalRowsSeen = rowsParsed + rowsUnparseable;
  if (manifest && typeof manifest.total_rows === "number" && totalRowsSeen !== manifest.total_rows) {
    fail(`Total rows seen (${totalRowsSeen}) does not match manifest.total_rows (${manifest.total_rows}).`);
  }

  if (sampleInvalidReasons.length > 0) {
    console.log("");
    console.log("--- Sample invalid-row reasons ---");
    for (const r of sampleInvalidReasons) console.log(`  ${r}`);
  }

  // Small crafted/test files only: dump every distinct variant key so a
  // regression test can assert byte-exact preservation of a field (e.g. an
  // embedded newline) without reimplementing the parser itself. The real
  // 20k-row fixture has thousands of distinct keys, so this section is
  // silent for it.
  if (distinctRawVariantKeys.size > 0 && distinctRawVariantKeys.size <= 20) {
    console.log("");
    console.log("--- Distinct variant keys (small file — showing all) ---");
    for (const key of distinctRawVariantKeys) console.log(`  ${key}`);
  }

  if (groupStats.size > 0) {
    console.log("");
    console.log("--- Expected-invalid groups (manifest-tagged) ---");
    for (const [group, stat] of groupStats) {
      const ok = stat.seenCount === stat.expectedCount && stat.mismatches.length === 0;
      console.log(
        `  ${group}: expected=${stat.expectedCount} seen=${stat.seenCount} matched=${stat.matchedCount} ${
          ok ? "(OK — expected-invalid-under-current-importer)" : "(MISMATCH)"
        }`,
      );
      if (stat.seenCount !== stat.expectedCount) {
        fail(`Group "${group}": expected ${stat.expectedCount} tagged rows but saw ${stat.seenCount}.`);
      }
      for (const m of stat.mismatches.slice(0, 5)) {
        console.log(`    row ${m.rowIndex}: expected ${groupExpectations.get(group)?.outcome}, got ${m.outcome} (${m.detail})`);
        fail(`Group "${group}" row ${m.rowIndex} did not match its expected outcome (got ${m.outcome}: ${m.detail}).`);
      }
    }
  }

  if (untaggedFailures.length > 0) {
    console.log("");
    console.log("--- Unexpected failures (rows NOT tagged as expected-invalid) ---");
    for (const u of untaggedFailures.slice(0, 10)) {
      console.log(`  row ${u.rowIndex}: ${u.outcome} — ${u.detail}`);
    }
    if (untaggedFailures.length > 10) console.log(`  ... and ${untaggedFailures.length - 10} more`);
    fail(`${untaggedFailures.length} row(s) outside any expected-invalid tagged group failed to parse or validate.`);
  }

  if (barcodeColumnIndex >= 0) {
    console.log("");
    console.log("--- Barcode (EAN-13) ---");
    console.log(`Rows with barcode:        ${barcodeSeen}`);
    console.log(`Valid check digits:       ${barcodeValid}`);
    if (barcodeMismatches.length > 0) {
      console.log(`Invalid check digits:     ${barcodeMismatches.length} (rows: ${barcodeMismatches.slice(0, 10).join(", ")})`);
      fail(`${barcodeMismatches.length} barcode(s) failed EAN-13 check-digit verification.`);
    }
    if (manifest?.barcode) {
      const mb = manifest.barcode;
      console.log(`Manifest expects:         ${mb.rows_with_barcode} rows with barcode, all_check_digits_valid=${mb.all_check_digits_valid}`);
      if (barcodeSeen !== mb.rows_with_barcode) {
        fail(`Barcode row count (${barcodeSeen}) does not match manifest.barcode.rows_with_barcode (${mb.rows_with_barcode}).`);
      }
      if (mb.all_check_digits_valid && barcodeMismatches.length > 0) {
        fail("Manifest claims all_check_digits_valid=true but this run found mismatches.");
      }
    }
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
          : `  (raw count is ${naive > expected ? "higher" : "lower"} than ground truth by ${Math.abs(naive - expected)} — expected when spelling-noise groups are present; a real dedup pass must close this gap; informational only, not a failure)`,
      );
    }
    if (manifest.category_summary) {
      console.log(`Category summary (from manifest): ${JSON.stringify(manifest.category_summary)}`);
    }

    console.log("");
    console.log("--- sha256 integrity check ---");
    const actualSha = sha256HexOfBuffer(buffer);
    console.log(`Computed csv_sha256:  ${actualSha}`);
    if (manifest.csv_sha256) {
      console.log(`Manifest csv_sha256:  ${manifest.csv_sha256}`);
      if (actualSha === manifest.csv_sha256) {
        console.log("  MATCH");
      } else {
        console.log("  MISMATCH");
        fail(`CSV sha256 (${actualSha}) does not match manifest.csv_sha256 (${manifest.csv_sha256}) — file may be corrupted or stale.`);
      }
    } else {
      console.log("  (manifest has no csv_sha256 field — skipping)");
    }
  }

  console.log("");
  if (hasFailure) {
    console.log("--- Failure reasons ---");
    for (const r of failureReasons) console.log(`  - ${r}`);
    console.log("");
    console.log("=== RESULT: FAIL ===");
  } else {
    console.log("=== RESULT: PASS ===");
  }
  console.log("=== done ===");

  process.exit(hasFailure ? 1 : 0);
}

// Guarded like scripts/fixtures/generate-partner-cellar.mjs's isMain check —
// lets a test import splitLogicalRecords()/AmbiguousRecordSplitError for
// focused unit coverage without main()'s process.exit() firing as an
// import side effect. End-to-end assertions still drive this file as a
// subprocess (see src/test/fixtures/validate-bulk-import.test.ts) so they
// exercise the real CLI, not a reimplementation.
const isMain = process.argv[1] && (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) main();
