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
 * If manifest-path IS given explicitly, it must exist and must be a
 * genuine partner-cellar manifest — see PASS_PRECONDITIONS below.
 *
 * A note on MAX_ROWS and the CHUNK PLAN (round-5 amendment): the current
 * importer's csv-parser rejects any file with more than MAX_ROWS (5000)
 * data rows in a single parseCsv() call — that is the real, live limit a
 * real upload hits today (enforced INSIDE parseCsv itself, not in a
 * separate upload/preview layer). Product decision: that cap is NOT being
 * raised. The supported path for a file over it is N sequential chunks,
 * each <= MAX_ROWS, each applied through the EXISTING resumable apply path
 * (APPLY_CHUNK_SIZE rows per apply_import_batch_chunk() call, re-called
 * until done:true — see docs/runbooks/csv-import.md).
 *
 * This script's job for such a file is therefore to PLAN, VERIFY, and EMIT
 * that exact chunk split — see CHUNK_TARGET_ROWS, buildChunkPlan(), and the
 * chunk_plan_* entries in PASS_PRECONDITIONS below — not to reject the file
 * outright. A PASS now means "this file will import successfully and
 * faithfully AS THIS CHUNK PLAN": every planned chunk fits under MAX_ROWS
 * and MAX_UPLOAD_BYTES (measured on the real serialized bytes, not
 * estimated), no chunk boundary ever alters a record, and concatenating the
 * chunks' data rows reproduces the original file's data section
 * byte-for-byte. The chunk files themselves are written to
 * "<csv-without-ext>.chunks/" alongside the input, plus a
 * "<csv-without-ext>.chunks.manifest.json" recording each chunk's row
 * range, row count, byte size, and sha256 — see writeChunkPlanToDisk()
 * below — so the SAME command that validates a real partner file also
 * produces the exact files an operator uploads, one at a time, in order.
 *
 * What a PASS does NOT cover: whether the real importer's duplicate/matching
 * logic catches a duplicate that straddles two DIFFERENT chunks (the same
 * wine, uploaded in batch 1 and again, differently spelled, in batch 4).
 * That is a question about src/domains/import/** internals this script may
 * not edit this round, so it is never folded into PASS_PRECONDITIONS — see
 * the "Cross-chunk duplicate risk" report section and printDuplicateRisk()
 * below, which report it as an explicit, unmissable, UNPROVEN finding
 * instead of staying silent about it.
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
 * EOF, or a bare `\r` outside quotes not followed by `\n` — see
 * UnsupportedLineEndingError below), it fails CLOSED — throws, and this
 * script exits non-zero rather than guessing.
 *
 * The 1:1 contract this script depends on: every chunk of raw text handed
 * to parseCsv() must produce exactly one output row per non-blank record
 * splitLogicalRecords() found in it (parseCsv() itself silently drops any
 * fully-blank record — see isBlankRecord() below).
 *
 * ---------------------------------------------------------------------
 * Round-4 note on WHY the exit-code logic below looks the way it does.
 *
 * Three straight rounds of review found the same class of bug: this script
 * printed "=== RESULT: PASS ===" on a file it had not actually, meaningfully
 * read (a corrupted chunk boundary; a lone-CR file that parsed zero rows; a
 * valid header followed only by blank lines, also zero rows). Each fix
 * closed one specific door instead of asking "what is the COMPLETE set of
 * things that must be true for a PASS to mean anything?".
 *
 * This version answers that question once, in one place: see
 * PASS_PRECONDITIONS and evaluateVerdict() below. Every reason this script
 * can print "=== RESULT: FAIL ===" is a named entry in that list, checked
 * by evaluateVerdict() — the ONLY function in this file that decides
 * pass/fail and the ONLY call to process.exit() with a validation-derived
 * code. Nothing upstream of it may print "PASS"; nothing upstream of it may
 * suppress a reason it would otherwise report. If you are adding a new
 * check, add it to PASS_PRECONDITIONS — not as a one-off condition
 * elsewhere in this file.
 *
 * The full, current list (see PASS_PRECONDITIONS for the authoritative,
 * literal set) covers: the CSV path exists and is readable; its line
 * endings are ones we understand; its logical record boundaries are
 * resolvable; the file is not empty; the header parses and maps every
 * required column; the file has at least one NON-BLANK data record (not
 * merely a non-zero logical-record count — a header followed only by blank
 * lines must fail, see has_nonblank_data_records); every chunk's real-parser
 * row count matches the non-blank record count this script expected; every
 * manifest-tagged dirty-row category is recognized; every row NOT tagged as
 * expected-invalid actually validated; every manifest-tagged group's
 * observed count and outcomes match what the manifest promised; the total
 * row count matches the manifest; every barcode's EAN-13 check digit is
 * correct and agrees with the manifest; and — when a manifest is supplied,
 * whether via an explicit argument or an auto-detected sibling file — that
 * the manifest path exists (an EXPLICITLY specified path that is missing is
 * a hard failure, not "no manifest"), that it is valid JSON, that it is
 * genuinely a partner-cellar manifest (not just any JSON file — see
 * isValidManifestShape()), and that its csv_sha256 matches the file's
 * actual bytes.
 *
 * (This prose list predates several rounds of additions — see
 * PASS_PRECONDITIONS itself for the authoritative, literal, currently
 * complete set; it is the one thing this file guarantees never drifts from
 * what it actually checks, since it is also the only thing evaluateVerdict()
 * reads.)
 *
 * Deliberately OUT of PASS_PRECONDITIONS: whether this script's own
 * <csv>.failures.json report artifact could be written or cleaned up (see
 * syncFailuresReport()). That is bookkeeping about this tool's own output
 * file, not about whether the CSV was validated correctly, so an I/O
 * problem there is reported as a warning AFTER the verdict — never as an
 * unhandled crash, and never by silently swallowing the validation result
 * that already finished (round-4 defect: an unwritable failures.json used
 * to throw mid-report and lose the whole completed summary).
 *
 * With NO manifest (a real file with no ground truth), there are no tagged
 * groups, so ANY parse or validation failure is "untagged" and fails the
 * run. That is a deliberate, documented stance for now — a later piece can
 * relax this for real-world files that legitimately contain some bad rows;
 * today this script's job is a strict self-test of the fixture + importer
 * pairing, not a lenient real-file reviewer. When there are untagged
 * failures, the terminal prints only the first ten; the complete list is
 * always written to "<csv-without-ext>.failures.json" alongside the input
 * (and that file is removed if a later rerun has none — see
 * syncFailuresReport()).
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCsvBuffer, parseCsv } from "../src/domains/import/csv-parser";
import { mapHeader, validateRow, type ValidatedRow } from "../src/domains/import/row-validator";
import { MAX_ROWS, MAX_UPLOAD_BYTES, HEADER_SYNONYMS, type CanonicalHeader } from "../src/domains/import/constants";

type DirtyRowEntry = { row_index: number; category: string; detail?: string };
type NvLiteralRowEntry = { row_index: number; producer?: string; name?: string };
type BarcodeManifest = {
  enabled: boolean;
  rows_with_barcode: number;
  total_rows: number;
  coverage_pct: number;
  all_check_digits_valid: boolean;
} | null;

export type DuplicateSpellingGroup = { id: string; canonical_row_indexes: number[]; alt_row_indexes: number[] };

type Manifest = {
  expected_unique_variant_count?: number;
  category_summary?: Record<string, number>;
  total_rows?: number;
  clean_row_count?: number;
  dirty_row_count?: number;
  csv_sha256?: string;
  columns?: string[];
  dirty_rows?: DirtyRowEntry[];
  nv_literal_rows?: NvLiteralRowEntry[];
  barcode?: BarcodeManifest;
  duplicate_spelling_groups?: DuplicateSpellingGroup[];
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
//
// A bare `\r` (not followed by `\n`) outside quotes gets the same fail-
// closed treatment as an unterminated quote. csv-parser.ts's own `\r`
// handling — inherited here on purpose, see the `\r` branch below — treats
// EVERY `\r` as invisible whitespace and relies on `\n` alone to end a
// record. That is correct for CRLF, but a file using lone-CR line endings
// (classic pre-OS X Excel/Mac export — a real thing partners send) has NO
// `\n` at all: every intended record break is silently swallowed and the
// whole file collapses into one giant "record", which upstream would then
// get misread as a header with zero data rows and a false PASS. Splitting
// still agreeing with the real parser about this degenerate case is not a
// defense of it — so this splitter refuses the file outright the moment it
// sees a `\r` outside quotes that isn't immediately followed by `\n`,
// instead of ever handing that ambiguous text to the chunker.
// ---------------------------------------------------------------------------

export class AmbiguousRecordSplitError extends Error {}
export class UnsupportedLineEndingError extends Error {}

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
      if (text[i + 1] !== "\n") {
        throw new UnsupportedLineEndingError(
          "A bare carriage return (\\r) was found outside any quoted field, not followed by a line " +
            "feed (\\n). This is a classic pre-OS X Excel/Mac line ending — the importer's CSV parser " +
            "does not treat a lone \\r as a record break, so it would silently merge every logical " +
            "record after this point into one. Convert this file to Unix (LF) or Windows (CRLF) line " +
            "endings before validating or importing it.",
        );
      }
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

/**
 * Is this logical record one the real parseCsv() silently drops as a fully
 * blank line (its own `pushRow()` rule): exactly one field, and that field
 * is empty)? Rather than reimplement that field-parsing rule a second time
 * — which is exactly how the splitter/parser disagreement this fix is
 * closing happened in the first place — this asks the real parser itself:
 * a standalone record that parseCsv() would drop as blank is, when parsed
 * completely alone, indistinguishable from an empty file (its `rows` array
 * ends up empty), which is the one condition parseCsv() reports as the
 * "empty_file" error. A non-blank record, standalone, always parses `ok`
 * (it is simply treated as a one-row "header" with no data rows).
 */
export function isBlankRecord(record: string): boolean {
  const probe = parseCsv(`${record}\n`);
  return !probe.ok && probe.error.code === "empty_file";
}

function sha256HexOfBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Encoding fidelity (round-5 CRITICAL fix).
//
// decodeCsvBuffer() (src/domains/import/csv-parser.ts) decodes UTF-8
// NON-FATALLY: any byte sequence that isn't valid UTF-8 is silently replaced
// with a U+FFFD replacement character. That turns the partner's actual bytes
// into DIFFERENT cellar data (a mangled vintage digit, a truncated producer
// name, ...) and this tool used to certify the result as good. This section
// re-decodes the raw bytes ourselves, BEFORE calling decodeCsvBuffer, to
// catch that — this file may not edit csv-parser.ts, so the only lever
// available is to predict its lossy behavior and refuse to certify it.
//
// The FATAL decode below is deliberately the test, rather than counting
// U+FFFD characters in decodeCsvBuffer's own output: a source file that
// genuinely, validly contains the U+FFFD character encodes it as valid UTF-8
// bytes (EF BF BD), and a fatal decode of THOSE bytes never throws. Only a
// byte sequence that is not valid UTF-8 at all — the case decodeCsvBuffer
// would silently mangle — makes the fatal decoder throw. This is what
// distinguishes "decoding introduced a U+FFFD" from "the source genuinely
// contains one" without ever inspecting the (already-mangled) decoded text.
// ---------------------------------------------------------------------------

export type EncodingIssue = { kind: "utf16le_bom" | "utf16be_bom" | "invalid_utf8"; message: string };

export function detectEncodingIssue(buffer: Buffer): EncodingIssue | null {
  // UTF-16 (with a BOM) is the other encoding a real export plausibly
  // arrives in. It is NOT caught by the fatal-UTF-8 check below for
  // pure-ASCII content: UTF-16LE text like "Acme" is the byte sequence
  // 41 00 63 00 6D 00 65 00 — every one of those bytes is independently
  // valid UTF-8 (ASCII 'A', NUL, 'c', NUL, ...), so a fatal UTF-8 decode
  // would NOT throw. It would just silently interleave a NUL byte after
  // every character, corrupting every field without ever raising an error.
  // The BOM itself is the only reliable signal, so it is checked explicitly,
  // first, at the byte level.
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return {
      kind: "utf16le_bom",
      message:
        "File begins with a UTF-16LE byte-order mark (bytes FF FE) — this is a UTF-16-encoded file, not UTF-8. " +
        "Decoding UTF-16 bytes as UTF-8 does not fail loudly: for plain-ASCII content it silently produces " +
        "readable-looking text with a NUL byte spliced in after every character, corrupting every field. " +
        "Re-export this file as UTF-8 before importing.",
    };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return {
      kind: "utf16be_bom",
      message:
        "File begins with a UTF-16BE byte-order mark (bytes FE FF) — this is a UTF-16-encoded file, not UTF-8. " +
        "Decoding UTF-16 bytes as UTF-8 does not fail loudly: for plain-ASCII content it silently produces " +
        "readable-looking text with a NUL byte spliced in after every character, corrupting every field. " +
        "Re-export this file as UTF-8 before importing.",
    };
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return null; // Byte-for-byte valid UTF-8 — decodeCsvBuffer cannot lose or alter anything here.
  } catch {
    // At least one byte sequence is not valid UTF-8. decodeCsvBuffer() would
    // silently replace it with U+FFFD and this run would certify a file
    // that is no longer byte-identical to what the partner sent. Windows-1252
    // (a WHATWG-legacy single-byte encoding with a mapping for every byte
    // value) never fails to decode, so it is used here only as an
    // informational HINT for the operator, never as a second detector.
    const hasHighBytes = buffer.some((b) => b >= 0x80);
    const latin1Hint = hasHighBytes
      ? " If this file was actually exported as Latin-1/Windows-1252 (a common spreadsheet default), " +
        `re-interpreting these exact bytes that way reads: ${JSON.stringify(
          new TextDecoder("windows-1252").decode(buffer).slice(0, 200),
        )}`
      : "";
    return {
      kind: "invalid_utf8",
      message:
        "File contains at least one byte sequence that is not valid UTF-8. Decoding it anyway (as the current " +
        "importer does) silently replaces every such sequence with a U+FFFD replacement character, changing the " +
        "partner's actual data into DIFFERENT data and certifying the result as good. Re-export this file as " +
        `UTF-8.${latin1Hint}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Duplicate canonical-header detection (round-5 HIGH fix).
//
// mapHeader() (src/domains/import/row-validator.ts) silently keeps only the
// FIRST column that maps to a given canonical field and discards every later
// column mapping to the same field — see its `if (field && !seen.has(field))`
// guard. Two columns both named e.g. "cost" and "price" (both synonyms for
// unit_cost) is an ambiguous file: which one did the partner actually mean?
// Silently picking "whichever came first" is a guess this tool must not
// rubber-stamp. row-validator.ts may not be edited, so this independently
// re-derives the same column->field mapping (via the same exported
// HEADER_SYNONYMS table) purely to detect the collision mapHeader() itself
// stays silent about.
// ---------------------------------------------------------------------------

export function detectDuplicateHeaderMappings(header: string[]): { field: CanonicalHeader; columns: string[] }[] {
  const byField = new Map<CanonicalHeader, string[]>();
  header.forEach((rawName) => {
    const key = rawName.trim().toLowerCase();
    const field = HEADER_SYNONYMS[key];
    if (!field) return;
    const columns = byField.get(field) ?? [];
    columns.push(rawName);
    byField.set(field, columns);
  });
  const duplicates: { field: CanonicalHeader; columns: string[] }[] = [];
  for (const [field, columns] of byField) {
    if (columns.length > 1) duplicates.push({ field, columns });
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// Silent numeric-text coercion detection (round-5 CRITICAL fix).
//
// row-validator.ts's vintage/size_ml/quantity fields use Number.parseInt()
// and unit_cost uses Number.parseFloat() — both accept a numeric PREFIX and
// silently ignore trailing garbage ("2015xyz" -> 2015, "750ml" -> 750,
// "3abc" -> 3, "12.34USD" -> 12.34). When the coerced value also happens to
// satisfy that field's range check, validateRow() returns the row as
// state: "valid" with NO indication anywhere that the cell's literal text
// was not a clean number — this tool used to certify that row as good.
//
// This is checked ONLY on rows validateRow() returns as "valid": that is
// the exact condition under which the coercion is silently ACCEPTED into a
// PASS. A row that ends up "invalid" for any reason (including this same
// field coincidentally failing ITS range check, e.g. dirty_vintage_text's
// "202X" -> 202, which is below MIN_VINTAGE) already fails loudly through
// the existing tagged/untagged-failure machinery — flagging it a second time
// here would only conflict with categories this file already tags correctly
// (see DIRTY_CATEGORY_EXPECTATION) without catching anything new.
//
// row-validator.ts's own `cell()` helper (unexported) is reimplemented here
// verbatim rather than guessed at, so this reads the exact same raw value
// validateRow() itself parses.
// ---------------------------------------------------------------------------

type NumericFieldKind = "int" | "float";
const NUMERIC_FIELDS: { field: CanonicalHeader; kind: NumericFieldKind }[] = [
  { field: "vintage", kind: "int" },
  { field: "size_ml", kind: "int" },
  { field: "quantity", kind: "int" },
  { field: "unit_cost", kind: "float" },
];
const INTEGER_LITERAL = /^[+-]?\d+$/;
const FLOAT_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function rawCellFor(cells: string[], columnToField: Map<number, CanonicalHeader>, field: CanonicalHeader): string {
  for (const [index, mapped] of columnToField) {
    if (mapped === field) return (cells[index] ?? "").trim();
  }
  return "";
}

export type NumericCoercionRisk = { field: CanonicalHeader; raw: string; coercedTo: string };

export function detectNumericCoercions(
  cells: string[],
  columnToField: Map<number, CanonicalHeader>,
): NumericCoercionRisk[] {
  const risks: NumericCoercionRisk[] = [];
  for (const spec of NUMERIC_FIELDS) {
    const raw = rawCellFor(cells, columnToField, spec.field);
    if (!raw) continue;
    const literalOk = spec.kind === "int" ? INTEGER_LITERAL.test(raw) : FLOAT_LITERAL.test(raw);
    if (literalOk) continue;
    const parsed = spec.kind === "int" ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    if (Number.isFinite(parsed)) risks.push({ field: spec.field, raw, coercedTo: String(parsed) });
  }
  return risks;
}

// ---------------------------------------------------------------------------
// Chunk plan (round-5 amendment).
//
// MAX_ROWS is a hard, live, product-level cap this script may not raise —
// see the module doc above. The supported path for a file over it is N
// sequential chunks, each independently uploaded through the existing
// resumable apply path. This section builds that plan, deterministically,
// from the SAME dataRecords array splitLogicalRecords() already produced —
// never by re-splitting raw text — so a chunk boundary can only ever fall
// between two already-correctly-delimited logical records, never inside
// one.
//
// CHUNK_TARGET_ROWS (4000) is THIS TOOL's own planning choice, not a
// product constant — it lives here, not in constants.ts, and is
// deliberately smaller than MAX_ROWS (5000) to leave headroom: a plan built
// with margin stays valid even if MAX_ROWS is ever tightened, or a
// particular chunk's rows happen to be unusually wide in bytes. Every chunk
// is still independently, actually verified against the REAL MAX_ROWS and
// MAX_UPLOAD_BYTES constants below (see evaluateChunkPlan()) rather than
// trusted to fit just because it targets a smaller row count.
// ---------------------------------------------------------------------------

export const CHUNK_TARGET_ROWS = 4000;

export interface ChunkPlanEntry {
  /** 1-indexed, in upload order. */
  index: number;
  /** Raw logical data records (blank lines included), in original file order. */
  records: string[];
  /** 1-indexed row number (matches this file's rowIndex numbering — every physical row a human would see in
   * their spreadsheet, blank lines included) of the first record in this chunk. */
  startRow: number;
  /** 1-indexed row number of the last record in this chunk. */
  endRow: number;
}

/** Partition dataRecords into chunks of at most chunkTargetRows records
 * each, by ARRAY SLICING — never by re-joining and re-splitting text. Every
 * element of dataRecords is already a complete, self-contained logical
 * record (guaranteed by splitLogicalRecords()'s own quote-tracking), so
 * slicing this array can never bisect one — the "a chunk boundary must
 * never cut a record" property holds by construction, not by luck. */
export function buildChunkPlan(dataRecords: string[], chunkTargetRows: number): ChunkPlanEntry[] {
  const chunks: ChunkPlanEntry[] = [];
  for (let offset = 0; offset < dataRecords.length; offset += chunkTargetRows) {
    const records = dataRecords.slice(offset, offset + chunkTargetRows);
    chunks.push({ index: chunks.length + 1, records, startRow: offset + 1, endRow: offset + records.length });
  }
  return chunks;
}

/** Exactly the format the real product would see for one uploaded chunk:
 * the shared header line, then this chunk's records, one per line. */
export function serializeChunk(headerRecord: string, records: string[]): string {
  return [headerRecord, ...records].join("\n") + "\n";
}

export type ChunkPlanCheck = {
  index: number;
  rowCount: number;
  byteSize: number;
  boundaryOk: boolean;
  boundaryDetail: string | null;
  headerOk: boolean;
};

/** Proves a chunk boundary never altered a record, by comparing the real
 * parser's output for the WHOLE chunk against parsing each of that chunk's
 * records completely alone. This is the same "1:1 record<->row contract"
 * already proven generically (see the property test in
 * validate-bulk-import.test.ts) and at the OLD MAX_ROWS-sized boundaries —
 * re-applied here at the ACTUAL planned chunk boundaries this tool now
 * emits.
 *
 * If the whole-chunk parse fails outright (e.g. one record's field exceeds
 * MAX_FIELD_LENGTH) or its row count doesn't match the non-blank record
 * count, that is NOT attributed to the chunk boundary: buildChunkPlan()
 * only ever slices dataRecords between records, so a whole-chunk parse
 * failure can only be caused by a record's OWN content (independent of
 * which chunk it landed in) or by the chunk's row count — both already
 * surfaced elsewhere (per-record unparseable attribution;
 * chunk_plan_within_row_limit). Double-reporting that here as a "boundary"
 * defect would misattribute an already-explained finding to the wrong
 * cause, so this falls back to counting how many records parse in
 * isolation instead of failing the boundary proof for a reason this
 * function did not actually observe.
 */
function verifyChunkBoundary(
  headerRecord: string,
  chunkRecords: string[],
): { ok: boolean; detail: string | null; rowCount: number } {
  const nonBlank = chunkRecords.filter((r) => !isBlankRecord(r));
  const chunkText = serializeChunk(headerRecord, chunkRecords);
  const whole = parseCsv(chunkText);

  if (!whole.ok || whole.rows.length !== nonBlank.length) {
    let isolatedRowCount = 0;
    for (const record of nonBlank) {
      if (parseCsv(`${headerRecord}\n${record}\n`).ok) isolatedRowCount += 1;
    }
    return { ok: true, rowCount: isolatedRowCount, detail: null };
  }

  for (let i = 0; i < nonBlank.length; i++) {
    const isolated = parseCsv(`${headerRecord}\n${nonBlank[i]}\n`);
    if (isolated.ok && JSON.stringify(whole.rows[i]) !== JSON.stringify(isolated.rows[0])) {
      return {
        ok: false,
        rowCount: whole.rows.length,
        detail: `record at chunk-local position ${i} parses differently as part of the chunk than in isolation — the chunk boundary altered it`,
      };
    }
  }
  return { ok: true, rowCount: whole.rows.length, detail: null };
}

/** Runs every per-chunk check the chunk_plan_* preconditions read from,
 * once, so each precondition is a cheap scan over already-computed results
 * rather than re-parsing every chunk multiple times. */
export function evaluateChunkPlan(headerRecord: string, chunkPlan: ChunkPlanEntry[]): ChunkPlanCheck[] {
  return chunkPlan.map((chunk) => {
    const chunkText = serializeChunk(headerRecord, chunk.records);
    const byteSize = Buffer.byteLength(chunkText, "utf8");
    const boundary = verifyChunkBoundary(headerRecord, chunk.records);
    const firstLine = chunkText.split("\n", 1)[0];
    return {
      index: chunk.index,
      rowCount: boundary.rowCount,
      byteSize,
      boundaryOk: boundary.ok,
      boundaryDetail: boundary.detail,
      headerOk: firstLine === headerRecord,
    };
  });
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

/**
 * Does this parsed value look like a manifest THIS generator produced,
 * rather than just any syntactically valid JSON file (round-4 defect: a
 * critic pointed this script at package.json and every ground-truth check
 * silently no-oped)? Every manifest this repo's fixture generator has ever
 * written — base, --extras, --dirty, the 500-row sample — carries all of
 * these fields with these exact types (see
 * scripts/fixtures/generate-partner-cellar.mjs); package.json, or any other
 * unrelated JSON file, does not.
 */
function isValidManifestShape(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.generator_seed === "number" &&
    typeof v.generator_version === "string" &&
    typeof v.total_rows === "number" &&
    typeof v.clean_row_count === "number" &&
    typeof v.dirty_row_count === "number" &&
    typeof v.csv_sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(v.csv_sha256) &&
    Array.isArray(v.columns) &&
    v.columns.every((c) => typeof c === "string")
  );
}

// ---------------------------------------------------------------------------
// RunState — everything this script observed about one (csv, manifest)
// pair. buildRunState() below NEVER calls process.exit() and NEVER lets an
// exception escape for a condition this file is meant to validate against;
// it only ever returns a RunState, as far as it was able to get. Deciding
// what that means for pass/fail is entirely evaluateVerdict()'s job — see
// PASS_PRECONDITIONS. This separation is the whole point: there is exactly
// one place downstream of here that can print "PASS".
// ---------------------------------------------------------------------------

interface RunState {
  csvPath: string;
  manifestPathArg: string | null;

  csvExists: boolean;
  csvReadError: string | null;
  buffer: Buffer | null;

  encodingIssue: EncodingIssue | null;

  splitErrorReason: "unsupported_line_ending" | "ambiguous_record_split" | null;
  splitErrorMessage: string | null;

  allRecords: string[] | null;
  headerRecord: string | null;
  dataRecords: string[];

  headerParseErrorReason: string | null;
  headerCells: string[] | null;
  missingRequiredHeaders: string[];
  duplicateHeaderMappings: { field: CanonicalHeader; columns: string[] }[];
  barcodeColumnIndex: number;

  blankFlags: boolean[];
  nonBlankDataRecordCount: number;

  chunkMismatch: { offset: number; expected: number; actual: number } | null;

  chunkPlan: ChunkPlanEntry[];
  chunkPlanChecks: ChunkPlanCheck[];
  chunkPlanReassemblyOk: boolean;

  manifestPath: string | null;
  manifestExplicitPathMissing: boolean;
  manifestJsonError: string | null;
  manifestShapeInvalid: boolean;
  manifest: Manifest | null;
  manifestFieldTypeErrors: string[];

  rowsParsed: number;
  rowsUnparseable: number;
  rowsValid: number;
  rowsInvalid: number;
  blankLinesSkipped: number;
  distinctRawVariantKeys: Set<string>;
  sampleInvalidReasons: string[];
  untaggedFailures: { rowIndex: number; outcome: RowOutcome; detail: string }[];
  unknownDirtyCategories: string[];
  numericCoercionRisks: (NumericCoercionRisk & { rowIndex: number })[];
  groupStats: Map<string, GroupStat>;
  groupExpectations: Map<string, GroupExpectation>;

  barcodeSeen: number;
  barcodeValid: number;
  barcodeMismatches: number[];

  wallClockMs: number;
}

function initState(csvPath: string, manifestPathArg: string | null): RunState {
  return {
    csvPath,
    manifestPathArg,
    csvExists: false,
    csvReadError: null,
    buffer: null,
    encodingIssue: null,
    splitErrorReason: null,
    splitErrorMessage: null,
    allRecords: null,
    headerRecord: null,
    dataRecords: [],
    headerParseErrorReason: null,
    headerCells: null,
    missingRequiredHeaders: [],
    duplicateHeaderMappings: [],
    barcodeColumnIndex: -1,
    blankFlags: [],
    nonBlankDataRecordCount: 0,
    chunkMismatch: null,
    chunkPlan: [],
    chunkPlanChecks: [],
    chunkPlanReassemblyOk: true,
    manifestPath: null,
    manifestExplicitPathMissing: false,
    manifestJsonError: null,
    manifestShapeInvalid: false,
    manifest: null,
    manifestFieldTypeErrors: [],
    rowsParsed: 0,
    rowsUnparseable: 0,
    rowsValid: 0,
    rowsInvalid: 0,
    blankLinesSkipped: 0,
    distinctRawVariantKeys: new Set(),
    sampleInvalidReasons: [],
    untaggedFailures: [],
    unknownDirtyCategories: [],
    numericCoercionRisks: [],
    groupStats: new Map(),
    groupExpectations: new Map(),
    barcodeSeen: 0,
    barcodeValid: 0,
    barcodeMismatches: [],
    wallClockMs: 0,
  };
}

/**
 * Resolve + load the manifest, independent of whether the CSV itself could
 * be read at all — a broken CSV path and a broken manifest path are two
 * separate facts and both must be reported. Fail-CLOSED at every step (an
 * unreadable file, invalid JSON, or the wrong shape all stop here and leave
 * state.manifest === null) rather than let a raw exception escape (round-4
 * defect: malformed JSON used to produce an unhandled stack trace).
 */
function loadManifest(state: RunState): void {
  let resolvedPath: string | null = null;
  if (state.manifestPathArg) {
    if (!existsSync(state.manifestPathArg)) {
      // An EXPLICITLY specified manifest path that doesn't exist is a hard
      // error, not "no manifest supplied" — the user asked for ground-truth
      // verification and silently getting none is exactly the trust defect
      // round-4 named (round-4 defect #2).
      state.manifestExplicitPathMissing = true;
      return;
    }
    resolvedPath = state.manifestPathArg;
  } else {
    const guess = state.csvPath.replace(/\.csv$/, ".manifest.json");
    if (guess !== state.csvPath && existsSync(guess)) resolvedPath = guess;
  }
  if (!resolvedPath) return; // no manifest in play at all — a documented, valid state.
  state.manifestPath = resolvedPath;

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    state.manifestJsonError = `Could not read manifest file "${resolvedPath}": ${(err as Error).message}`;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    state.manifestJsonError = `Manifest "${resolvedPath}" is not valid JSON: ${(err as Error).message}`;
    return;
  }

  if (!isValidManifestShape(parsed)) {
    state.manifestShapeInvalid = true;
    return;
  }

  state.manifest = parsed;
}

function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/** True once the header has been read AND successfully parsed — the point
 * past which every later stage (required-headers, blank accounting, the
 * chunk loop) has data worth looking at. */
function reachedHeader(state: RunState): boolean {
  return (
    state.csvExists &&
    !state.csvReadError &&
    state.splitErrorReason === null &&
    state.allRecords !== null &&
    state.allRecords.length > 0 &&
    state.headerParseErrorReason === null
  );
}

function buildRunState(csvPath: string, manifestPathArg: string | null): RunState {
  const state = initState(csvPath, manifestPathArg);
  const startMs = performance.now();

  state.csvExists = existsSync(csvPath);
  // Manifest resolution is independent of the CSV file's own fate — both
  // are checked regardless of the other's outcome.
  loadManifest(state);

  if (!state.csvExists) {
    state.wallClockMs = roundMs(performance.now() - startMs);
    return state;
  }

  try {
    state.buffer = readFileSync(csvPath);
  } catch (err) {
    state.csvReadError = `Could not read CSV file "${csvPath}": ${(err as Error).message}`;
    state.wallClockMs = roundMs(performance.now() - startMs);
    return state;
  }

  // Checked BEFORE decodeCsvBuffer() ever runs: once that non-fatal UTF-8
  // decode has happened, the information needed to detect its own lossiness
  // (which bytes were invalid) is already gone. See detectEncodingIssue()
  // above for why this predicts decodeCsvBuffer's behavior instead of
  // editing it (src/domains/import/** is off-limits this round).
  state.encodingIssue = detectEncodingIssue(state.buffer);
  if (state.encodingIssue) {
    state.wallClockMs = roundMs(performance.now() - startMs);
    return state;
  }

  const text = decodeCsvBuffer(state.buffer);

  try {
    state.allRecords = splitLogicalRecords(text);
  } catch (err) {
    if (err instanceof UnsupportedLineEndingError) {
      state.splitErrorReason = "unsupported_line_ending";
      state.splitErrorMessage = err.message;
    } else if (err instanceof AmbiguousRecordSplitError) {
      state.splitErrorReason = "ambiguous_record_split";
      state.splitErrorMessage = err.message;
    } else {
      throw err; // a genuine programmer error, not a validation-domain condition.
    }
    state.wallClockMs = roundMs(performance.now() - startMs);
    return state;
  }

  if (state.allRecords.length === 0) {
    state.wallClockMs = roundMs(performance.now() - startMs);
    return state; // empty file — has no header at all.
  }

  const [headerRecord, ...dataRecords] = state.allRecords;
  state.headerRecord = headerRecord;
  state.dataRecords = dataRecords;

  const headerParse = parseCsv(`${headerRecord}\n`);
  if (!headerParse.ok) {
    state.headerParseErrorReason = `${headerParse.error.code}: ${headerParse.error.message}`;
    state.wallClockMs = roundMs(performance.now() - startMs);
    return state;
  }
  const mapped = mapHeader(headerParse.header);
  const columnToField = mapped.columnToField;
  state.headerCells = headerParse.header;
  state.missingRequiredHeaders = mapped.missingRequired;
  state.duplicateHeaderMappings = detectDuplicateHeaderMappings(headerParse.header);
  state.barcodeColumnIndex = headerParse.header.findIndex((h) => h.trim().toLowerCase() === "barcode");

  // The real parseCsv() silently drops any fully-blank logical record (its
  // own `pushRow()` rule), so its `rows` output is not 1:1 with
  // `dataRecords` the moment a blank line appears anywhere but at EOF.
  // Precomputing which records are blank — via the real parser itself, see
  // isBlankRecord() — lets rowIndex always mean "the Nth data row counting
  // every physical row a human would see in their spreadsheet, blank lines
  // included" instead of drifting off by one after each blank line. It also
  // gives an exact expected non-blank count, both per chunk (an explicit,
  // checked invariant — see parser_row_counts_match) and across the WHOLE
  // file (nonBlankDataRecordCount — see has_nonblank_data_records, the
  // round-4 critical fix: dataRecords.length alone is NOT this number).
  state.blankFlags = dataRecords.map(isBlankRecord);
  state.nonBlankDataRecordCount = state.blankFlags.filter((isBlank) => !isBlank).length;

  // The chunk plan drives BOTH the per-row stats loop below AND the
  // chunk_plan_* preconditions — one plan, so what gets validated is
  // exactly what would be emitted (see writeChunkPlanToDisk()) and
  // uploaded. A file well under CHUNK_TARGET_ROWS still gets a one-chunk
  // plan (itself, whole) so every check below applies uniformly.
  state.chunkPlan = buildChunkPlan(dataRecords, CHUNK_TARGET_ROWS);
  state.chunkPlanChecks = evaluateChunkPlan(headerRecord, state.chunkPlan);
  const reassembledDataSection = state.chunkPlan.flatMap((c) => c.records).join("\n");
  const originalDataSection = dataRecords.join("\n");
  state.chunkPlanReassemblyOk = Buffer.from(reassembledDataSection, "utf8").equals(
    Buffer.from(originalDataSection, "utf8"),
  );

  // --- Manifest-driven "expected invalid" classification ------------------
  const knownBad = new Map<number, { group: string; expectation: GroupExpectation }>();
  function registerExpected(group: string, rowIndex: number, expectation: GroupExpectation) {
    knownBad.set(rowIndex, { group, expectation });
    state.groupExpectations.set(group, expectation);
    const stat = state.groupStats.get(group) ?? { expectedCount: 0, seenCount: 0, matchedCount: 0, mismatches: [] };
    stat.expectedCount += 1;
    state.groupStats.set(group, stat);
  }
  // Guarded with Array.isArray(): isValidManifestShape() does not (and
  // cannot cheaply) check the element type of these two OPTIONAL arrays, so
  // a shape-valid manifest can still carry a `dirty_rows` or
  // `nv_literal_rows` field that isn't an array at all (e.g. a number or a
  // string). A bare `for...of` over that used to throw a raw TypeError here
  // — before evaluateVerdict() ever ran — exiting 1 by crashing instead of
  // by verdict (round-5 MEDIUM fix). Skipping the loop and recording a
  // named reason (see manifest_optional_arrays_well_typed) keeps this
  // failing closed without ever letting an exception escape.
  if (state.manifest?.dirty_rows !== undefined) {
    if (Array.isArray(state.manifest.dirty_rows)) {
      for (const dr of state.manifest.dirty_rows) {
        const expectation = DIRTY_CATEGORY_EXPECTATION[dr.category];
        if (!expectation) {
          state.unknownDirtyCategories.push(dr.category);
          continue;
        }
        registerExpected(dr.category, dr.row_index, expectation);
      }
    } else {
      state.manifestFieldTypeErrors.push(
        `manifest.dirty_rows is present but is not an array (got ${typeof state.manifest.dirty_rows}).`,
      );
    }
  }
  if (state.manifest?.nv_literal_rows !== undefined) {
    if (Array.isArray(state.manifest.nv_literal_rows)) {
      for (const nv of state.manifest.nv_literal_rows) {
        registerExpected("nv_literal", nv.row_index, { outcome: "invalid", field: "vintage" });
      }
    } else {
      state.manifestFieldTypeErrors.push(
        `manifest.nv_literal_rows is present but is not an array (got ${typeof state.manifest.nv_literal_rows}).`,
      );
    }
  }

  function classifyOutcome(rowIndex: number, outcome: RowOutcome, detail: string) {
    const tag = knownBad.get(rowIndex);
    if (!tag) {
      if (outcome !== "valid") state.untaggedFailures.push({ rowIndex, outcome, detail });
      return;
    }
    const stat = state.groupStats.get(tag.group)!;
    stat.seenCount += 1;
    const outcomeMatches =
      outcome === tag.expectation.outcome && (!tag.expectation.field || detail.includes(tag.expectation.field));
    if (outcomeMatches) stat.matchedCount += 1;
    else stat.mismatches.push({ rowIndex, outcome, detail });
  }

  function checkBarcode(rowIndex: number, cells: string[]) {
    if (state.barcodeColumnIndex < 0) return;
    const barcode = (cells[state.barcodeColumnIndex] ?? "").trim();
    if (!barcode) return;
    state.barcodeSeen += 1;
    const twelve = barcode.slice(0, 12);
    const check = barcode.slice(12);
    if (!/^\d{12}$/.test(twelve) || !/^\d$/.test(check)) {
      state.barcodeMismatches.push(rowIndex);
      return;
    }
    let sum = 0;
    for (let d = 0; d < 12; d++) {
      const digit = Number(twelve[d]);
      sum += d % 2 === 0 ? digit : digit * 3;
    }
    const mod = sum % 10;
    const expectedCheck = mod === 0 ? 0 : 10 - mod;
    if (String(expectedCheck) === check) state.barcodeValid += 1;
    else state.barcodeMismatches.push(rowIndex);
  }

  function processRow(rowIndex: number, cells: string[]) {
    state.rowsParsed += 1;
    const validated: ValidatedRow = validateRow(cells, columnToField);
    let detail = "";
    if (validated.state === "valid") {
      state.rowsValid += 1;
      classifyOutcome(rowIndex, "valid", "");
      // Only checked on rows the real validator accepts as "valid" — see
      // detectNumericCoercions()'s module doc for why that is exactly the
      // condition under which a coerced value is silently ACCEPTED.
      for (const risk of detectNumericCoercions(cells, columnToField)) {
        state.numericCoercionRisks.push({ rowIndex, ...risk });
      }
    } else {
      state.rowsInvalid += 1;
      detail = validated.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      if (state.sampleInvalidReasons.length < 5) state.sampleInvalidReasons.push(detail);
      classifyOutcome(rowIndex, "invalid", detail);
    }
    const key = `${validated.raw.producer}|${validated.raw.name}|${validated.raw.vintage ?? "NV"}|${validated.raw.size_ml}`;
    state.distinctRawVariantKeys.add(key);
    checkBarcode(rowIndex, cells);
  }

  function recordUnparseable(rowIndex: number, reason: string) {
    state.rowsUnparseable += 1;
    classifyOutcome(rowIndex, "unparseable", reason);
  }

  for (const chunk of state.chunkPlan) {
    const offset = chunk.startRow - 1;
    const chunkRecords = chunk.records;
    const chunkBlankFlags = state.blankFlags.slice(offset, offset + chunkRecords.length);
    const nonBlankOriginalOffsets: number[] = [];
    chunkBlankFlags.forEach((isBlank, k) => {
      if (isBlank) state.blankLinesSkipped += 1;
      else nonBlankOriginalOffsets.push(k);
    });

    const chunkText = [headerRecord, ...chunkRecords].join("\n") + "\n";
    const result = parseCsv(chunkText);

    if (result.ok) {
      if (result.rows.length !== nonBlankOriginalOffsets.length) {
        // The 1:1 record<->row contract this whole chunking strategy
        // depends on has broken: the real parser did not emit exactly one
        // row per non-blank record this script expected. Trusting row
        // numbers past this point would be a guess, not a fact — stop
        // here and let parser_row_counts_match (PASS_PRECONDITIONS) fail
        // the run, instead of reporting numbers that might be wrong.
        //
        // As of round 4, this remains a DRIFT TRIPWIRE, not a live
        // guarantee: splitLogicalRecords() and parseCsv() share the exact
        // same quote-tracking rule by construction (see the module doc on
        // the splitter above), and isBlankRecord() determines blankness by
        // asking the real parser itself — so there is no known input for
        // which this branch is reachable today. A ~12,000-case
        // differential fuzz (see the "1:1 record<->row contract" test in
        // validate-bulk-import.test.ts) plus a manual state-machine
        // argument both back this. It stays wired to a hard failure so
        // that if the two implementations ever DO drift apart, this script
        // fails closed instead of silently mis-attributing row numbers.
        state.chunkMismatch = { offset, expected: nonBlankOriginalOffsets.length, actual: result.rows.length };
        break;
      }
      result.rows.forEach((cells, k) => processRow(offset + nonBlankOriginalOffsets[k] + 1, cells));
      continue;
    }

    // Chunk-level failure: fall back to per-record isolation so ONE
    // poisoned record (e.g. an oversized field) doesn't mark every sibling
    // record in the chunk unparseable.
    for (let k = 0; k < chunkRecords.length; k++) {
      if (chunkBlankFlags[k]) continue; // a blank line is never a row the real importer would see.
      const rowIndex = offset + k + 1;
      const singleText = `${headerRecord}\n${chunkRecords[k]}\n`;
      const singleResult = parseCsv(singleText);
      if (!singleResult.ok) {
        recordUnparseable(rowIndex, `${singleResult.error.code}: ${singleResult.error.message}`);
        continue;
      }
      processRow(rowIndex, singleResult.rows[0]);
    }
  }

  state.wallClockMs = roundMs(performance.now() - startMs);
  return state;
}

// ---------------------------------------------------------------------------
// PASS_PRECONDITIONS — the complete, single source of truth for this
// script's verdict.
//
// Every entry below must hold (its check() must return null) for
// evaluateVerdict() to report a PASS. Nothing outside this list may cause a
// PASS to print; nothing outside this list may suppress a reason it found.
// This is the single guard function/list the round-4 review asked for: read
// this array top to bottom and you have the complete, exact answer to
// "under what circumstances can this tool print PASS?"
//
// Each check(state) returns either `null` (satisfied — including "not
// applicable to this run", e.g. a barcode check when there is no barcode
// column) or a human-readable string explaining exactly what failed.
// ---------------------------------------------------------------------------

interface Precondition {
  id: string;
  check: (state: RunState) => string | null;
}

export const PASS_PRECONDITIONS: Precondition[] = [
  {
    id: "csv_exists",
    check: (s) => (s.csvExists ? null : `CSV file not found: ${s.csvPath}`),
  },
  {
    id: "csv_readable",
    check: (s) => s.csvReadError,
  },
  {
    id: "encoding_is_faithful",
    check: (s) => s.encodingIssue?.message ?? null,
  },
  {
    id: "line_endings_supported",
    check: (s) => (s.splitErrorReason === "unsupported_line_ending" ? s.splitErrorMessage : null),
  },
  {
    id: "record_boundaries_resolvable",
    check: (s) => (s.splitErrorReason === "ambiguous_record_split" ? s.splitErrorMessage : null),
  },
  {
    id: "file_not_empty",
    check: (s) =>
      s.csvExists && !s.csvReadError && s.splitErrorReason === null && s.allRecords !== null && s.allRecords.length === 0
        ? "File is empty (no header row)."
        : null,
  },
  {
    id: "header_parses",
    check: (s) => (s.headerParseErrorReason ? `Header row failed to parse: ${s.headerParseErrorReason}` : null),
  },
  {
    id: "required_headers_present",
    check: (s) =>
      reachedHeader(s) && s.missingRequiredHeaders.length > 0
        ? `Missing required headers: ${s.missingRequiredHeaders.join(", ")}`
        : null,
  },
  {
    id: "no_ambiguous_duplicate_header_mapping",
    check: (s) => {
      if (!reachedHeader(s) || s.duplicateHeaderMappings.length === 0) return null;
      const detail = s.duplicateHeaderMappings
        .map((d) => `"${d.field}" <- columns [${d.columns.map((c) => `"${c}"`).join(", ")}]`)
        .join("; ");
      return (
        "Header row maps more than one column to the same canonical field. The importer's header-mapping logic " +
        "silently keeps only the FIRST matching column for a field and discards every later column's data — an " +
        `ambiguous file a human must resolve, not a guess this tool will make: ${detail}.`
      );
    },
  },
  {
    id: "has_nonblank_data_records",
    // THE round-4 critical fix. A header followed only by blank lines has
    // dataRecords.length > 0 (raw logical records) but ZERO rows the real
    // importer would ever see — checking dataRecords.length alone (as
    // round 3 did) is exactly the bug: it guarantees a non-zero LOGICAL
    // record count, not a non-zero DATA record count. Only
    // nonBlankDataRecordCount answers "is there anything here to rehearse
    // the import against."
    check: (s) => {
      if (!reachedHeader(s)) return null;
      if (s.nonBlankDataRecordCount > 0) return null;
      if (s.dataRecords.length === 0) return "File has a header row but no data rows.";
      return (
        `File has a header row but ${s.dataRecords.length} data row(s), all of which are blank — a header ` +
        "followed only by blank lines is not a pass (there is nothing here to rehearse the import against)."
      );
    },
  },
  {
    id: "chunk_plan_within_row_limit",
    // Round-5 amendment: MAX_ROWS (5000) is NOT being raised — Devin's
    // product decision is that the supported path for an oversized file is
    // N chunks, each independently uploaded. A PASS therefore no longer
    // means "this file fits in one upload"; it means "every chunk in the
    // plan below fits." Checked against the REAL parser's row count per
    // chunk (see evaluateChunkPlan()), not just the target chunk size —
    // CHUNK_TARGET_ROWS (4000) is comfortably under MAX_ROWS by
    // construction, but this still verifies it rather than assuming it.
    check: (s) => {
      const bad = s.chunkPlanChecks.filter((c) => c.rowCount > MAX_ROWS);
      if (bad.length === 0) return null;
      return (
        `${bad.length} planned chunk(s) exceed the importer's MAX_ROWS=${MAX_ROWS}: ` +
        bad.map((c) => `chunk ${c.index} has ${c.rowCount} rows`).join("; ") +
        "."
      );
    },
  },
  {
    id: "chunk_plan_within_byte_limit",
    // The server-side upload cap (MAX_UPLOAD_BYTES) was never checked by
    // this tool at all before round 5 — a file safely under MAX_ROWS but
    // with unusually wide cells could still be rejected on size. Measured
    // on the ACTUAL serialized bytes of each planned chunk (header
    // included), not estimated from an average row length.
    check: (s) => {
      const bad = s.chunkPlanChecks.filter((c) => c.byteSize > MAX_UPLOAD_BYTES);
      if (bad.length === 0) return null;
      return (
        `${bad.length} planned chunk(s) exceed the server's MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES} as actually ` +
        `serialized (header included): ` +
        bad.map((c) => `chunk ${c.index} is ${c.byteSize} bytes`).join("; ") +
        "."
      );
    },
  },
  {
    id: "chunk_boundaries_preserve_records",
    // Proves, at the ACTUAL planned chunk boundaries, that concatenating
    // records with "\n" and re-parsing never altered one of them — the
    // chunk-emitter twin of the record<->row contract already proven at
    // arbitrary boundaries by the property test. See verifyChunkBoundary()
    // for why a whole-chunk parse failure (an oversized field, say) is
    // deliberately NOT attributed to the boundary itself.
    check: (s) => {
      const bad = s.chunkPlanChecks.filter((c) => !c.boundaryOk);
      if (bad.length === 0) return null;
      return (
        `${bad.length} planned chunk(s) failed the boundary-preservation proof — a record's cells differed ` +
        "between whole-chunk parsing and isolated parsing, meaning the chunk boundary altered it: " +
        bad.map((c) => `chunk ${c.index}: ${c.boundaryDetail}`).join("; ") +
        "."
      );
    },
  },
  {
    id: "chunk_plan_reassembles_byte_identically",
    // The chunk-level twin of the byte-to-field fidelity invariant
    // (encoding_is_faithful): concatenating every planned chunk's data
    // records must reproduce the original file's data section
    // byte-for-byte — proof that no row was dropped, duplicated,
    // reordered, or altered while building the plan.
    check: (s) =>
      s.chunkPlanReassemblyOk
        ? null
        : "Concatenating the planned chunks' data rows does not reproduce the original file's data section " +
          "byte-for-byte — a row was dropped, duplicated, reordered, or altered while building the chunk plan.",
  },
  {
    id: "chunk_plan_headers_identical",
    check: (s) => {
      const bad = s.chunkPlanChecks.filter((c) => !c.headerOk);
      if (bad.length === 0) return null;
      return (
        `${bad.length} planned chunk(s) do not carry the identical header line: chunks ${bad
          .map((c) => c.index)
          .join(", ")}.`
      );
    },
  },
  {
    id: "parser_row_counts_match",
    check: (s) =>
      s.chunkMismatch
        ? `Chunk at data-row offset ${s.chunkMismatch.offset}: expected ${s.chunkMismatch.expected} non-blank ` +
          `record(s) but the real parser emitted ${s.chunkMismatch.actual} row(s). Row-number attribution past ` +
          "this point cannot be trusted."
        : null,
  },
  {
    id: "no_unknown_manifest_dirty_categories",
    check: (s) => {
      if (s.unknownDirtyCategories.length === 0) return null;
      const uniq = [...new Set(s.unknownDirtyCategories)];
      return `Manifest dirty_rows contains unknown categor${uniq.length === 1 ? "y" : "ies"} (no expectation defined): ${uniq.join(", ")}.`;
    },
  },
  {
    id: "no_untagged_failures",
    check: (s) =>
      s.untaggedFailures.length > 0
        ? `${s.untaggedFailures.length} row(s) outside any expected-invalid tagged group failed to parse or validate.`
        : null,
  },
  {
    id: "tagged_group_counts_match",
    check: (s) => {
      const bad: string[] = [];
      for (const [group, stat] of s.groupStats) {
        if (stat.seenCount !== stat.expectedCount) {
          bad.push(`group "${group}": expected ${stat.expectedCount} tagged row(s) but saw ${stat.seenCount}`);
        }
      }
      return bad.length > 0 ? bad.join("; ") + "." : null;
    },
  },
  {
    id: "tagged_group_outcomes_match",
    check: (s) => {
      const bad: string[] = [];
      for (const [group, stat] of s.groupStats) {
        for (const m of stat.mismatches) {
          bad.push(
            `group "${group}" row ${m.rowIndex} expected ${s.groupExpectations.get(group)?.outcome}, got ${m.outcome} (${m.detail})`,
          );
        }
      }
      return bad.length > 0 ? bad.join("; ") + "." : null;
    },
  },
  {
    id: "no_silent_numeric_coercion",
    check: (s) => {
      if (s.numericCoercionRisks.length === 0) return null;
      const sample = s.numericCoercionRisks
        .slice(0, 10)
        .map((r) => `row ${r.rowIndex} ${r.field}: "${r.raw}" -> ${r.coercedTo}`)
        .join("; ");
      return (
        `${s.numericCoercionRisks.length} row(s) validate as clean only because Number.parseInt/parseFloat ` +
        "silently truncated non-numeric trailing text instead of rejecting it outright — the row is otherwise " +
        "valid, so today's importer would silently store a DIFFERENT value than the partner's file literally " +
        `contains: ${sample}.`
      );
    },
  },
  {
    id: "total_rows_match_manifest",
    check: (s) => {
      if (!s.manifest || typeof s.manifest.total_rows !== "number") return null;
      const totalRowsSeen = s.rowsParsed + s.rowsUnparseable;
      return totalRowsSeen !== s.manifest.total_rows
        ? `Total rows seen (${totalRowsSeen}) does not match manifest.total_rows (${s.manifest.total_rows}).`
        : null;
    },
  },
  {
    id: "manifest_row_counts_sum_to_total",
    check: (s) => {
      if (!s.manifest) return null;
      const { clean_row_count: clean, dirty_row_count: dirty, total_rows: total } = s.manifest;
      if (typeof clean !== "number" || typeof dirty !== "number" || typeof total !== "number") return null;
      return clean + dirty !== total
        ? `manifest.clean_row_count (${clean}) + manifest.dirty_row_count (${dirty}) = ${clean + dirty}, which ` +
          `does not equal manifest.total_rows (${total}).`
        : null;
    },
  },
  {
    id: "manifest_dirty_row_count_matches_dirty_rows_array",
    check: (s) => {
      if (!s.manifest || typeof s.manifest.dirty_row_count !== "number") return null;
      // A non-array dirty_rows is reported by manifest_optional_arrays_well_typed instead — this check only
      // reconciles the count when there is an actual array to reconcile it against.
      if (s.manifest.dirty_rows !== undefined && !Array.isArray(s.manifest.dirty_rows)) return null;
      const actual = s.manifest.dirty_rows?.length ?? 0;
      return s.manifest.dirty_row_count !== actual
        ? `manifest.dirty_row_count (${s.manifest.dirty_row_count}) does not match the length of manifest.dirty_rows (${actual}).`
        : null;
    },
  },
  {
    id: "manifest_columns_match_actual_header",
    check: (s) => {
      if (!s.manifest?.columns || !reachedHeader(s) || !s.headerCells) return null;
      const actualHeader = s.headerCells.map((h) => h.trim());
      const expected = s.manifest.columns;
      const matches = actualHeader.length === expected.length && actualHeader.every((h, i) => h === expected[i]);
      return matches
        ? null
        : `manifest.columns (${JSON.stringify(expected)}) does not match the CSV's actual header row (${JSON.stringify(actualHeader)}).`;
    },
  },
  {
    id: "manifest_optional_arrays_well_typed",
    check: (s) => (s.manifestFieldTypeErrors.length > 0 ? s.manifestFieldTypeErrors.join(" ") : null),
  },
  {
    id: "barcodes_pass_check_digit",
    check: (s) =>
      s.barcodeMismatches.length > 0
        ? `${s.barcodeMismatches.length} barcode(s) failed EAN-13 check-digit verification (rows: ${s.barcodeMismatches.slice(0, 10).join(", ")}).`
        : null,
  },
  {
    id: "barcode_manifest_cross_check",
    check: (s) => {
      if (!s.manifest?.barcode) return null;
      const mb = s.manifest.barcode;
      const reasons: string[] = [];
      if (s.barcodeSeen !== mb.rows_with_barcode) {
        reasons.push(
          `barcode row count (${s.barcodeSeen}) does not match manifest.barcode.rows_with_barcode (${mb.rows_with_barcode})`,
        );
      }
      if (mb.all_check_digits_valid && s.barcodeMismatches.length > 0) {
        reasons.push("manifest claims all_check_digits_valid=true but this run found mismatches");
      }
      return reasons.length > 0 ? reasons.join("; ") + "." : null;
    },
  },
  {
    id: "manifest_explicit_path_exists",
    check: (s) =>
      s.manifestExplicitPathMissing
        ? `Manifest path was explicitly specified but does not exist: ${s.manifestPathArg}`
        : null,
  },
  {
    id: "manifest_is_valid_json",
    check: (s) => s.manifestJsonError,
  },
  {
    id: "manifest_is_genuinely_ours",
    check: (s) =>
      s.manifestShapeInvalid
        ? `Manifest "${s.manifestPath}" parsed as JSON but is not a recognized partner-cellar manifest ` +
          "(missing/invalid required fields such as generator_seed, csv_sha256, columns) — refusing to run " +
          "ground-truth checks against an arbitrary JSON file."
        : null,
  },
  {
    id: "csv_sha256_matches_manifest",
    check: (s) => {
      if (!s.manifest?.csv_sha256 || !s.buffer) return null;
      const actual = sha256HexOfBuffer(s.buffer);
      return actual !== s.manifest.csv_sha256
        ? `CSV sha256 (${actual}) does not match manifest.csv_sha256 (${s.manifest.csv_sha256}) — file may be corrupted or stale.`
        : null;
    },
  },
];

/** The single guard: runs every precondition above and returns the
 * complete verdict. This is the ONLY function in this file that decides
 * pass/fail. */
function evaluateVerdict(state: RunState): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const p of PASS_PRECONDITIONS) {
    const reason = p.check(state);
    if (reason) reasons.push(reason);
  }
  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Reporting — pure presentation over a RunState. Prints nothing that
// influences evaluateVerdict(); influenced BY the state evaluateVerdict()
// also reads, never the other way around.
// ---------------------------------------------------------------------------

function manifestStatusLine(state: RunState): string {
  if (state.manifestExplicitPathMissing) {
    return `Manifest: ${state.manifestPathArg} (explicitly specified but not found)`;
  }
  if (!state.manifestPath) {
    return "Manifest: (none found — skipping ground-truth assertions)";
  }
  if (state.manifestJsonError) {
    return `Manifest: ${state.manifestPath} (found, but invalid JSON)`;
  }
  if (state.manifestShapeInvalid) {
    return `Manifest: ${state.manifestPath} (found, but not a recognized partner-cellar manifest)`;
  }
  return `Manifest: ${state.manifestPath}`;
}

// ---------------------------------------------------------------------------
// Cross-chunk duplicate risk (round-5 amendment, REPORT ONLY).
//
// Chunking newly puts duplicate detection at risk: the importer's
// duplicate/matching logic — whatever it does — has, at most, only ever
// been proven to work WITHIN one batch. The partner's actual duplicates
// (the same wine, spelled two different ways — see the fixture's
// duplicate_spelling_groups, which is exactly the "same real-world bottle,
// different string" ground truth this generator builds for this purpose)
// will straddle chunks: the same wine in chunk 1 and chunk 4. If chunk 4
// cannot see what chunk 1 already applied, the cellar silently
// double-counts.
//
// This is NEVER folded into PASS_PRECONDITIONS: whether cross-batch dedup
// actually works is a question about src/domains/import/** internals this
// piece may not edit or verify this round — see the module doc's "What a
// PASS does NOT cover" note. But "I cannot fix it" has never meant "I may
// stay silent about it" (the whole ruling against round 4), so this prints
// an explicit, unmissable count instead.
// ---------------------------------------------------------------------------

export function computeDuplicatePairStraddle(
  chunkPlan: ChunkPlanEntry[],
  groups: DuplicateSpellingGroup[],
): {
  totalPairs: number;
  withinChunk: number;
  straddling: number;
  straddlingExamples: { groupId: string; canonicalRow: number; altRow: number; canonicalChunk: number; altChunk: number }[];
} {
  function chunkIndexForRow(row: number): number | null {
    return chunkPlan.find((c) => row >= c.startRow && row <= c.endRow)?.index ?? null;
  }
  let totalPairs = 0;
  let withinChunk = 0;
  let straddling = 0;
  const straddlingExamples: {
    groupId: string;
    canonicalRow: number;
    altRow: number;
    canonicalChunk: number;
    altChunk: number;
  }[] = [];
  for (const group of groups) {
    if (!Array.isArray(group.canonical_row_indexes) || !Array.isArray(group.alt_row_indexes)) continue;
    for (const canonicalRow of group.canonical_row_indexes) {
      for (const altRow of group.alt_row_indexes) {
        totalPairs += 1;
        const canonicalChunk = chunkIndexForRow(canonicalRow);
        const altChunk = chunkIndexForRow(altRow);
        if (canonicalChunk !== null && canonicalChunk === altChunk) {
          withinChunk += 1;
        } else {
          straddling += 1;
          if (straddlingExamples.length < 5) {
            straddlingExamples.push({
              groupId: group.id,
              canonicalRow,
              altRow,
              canonicalChunk: canonicalChunk ?? -1,
              altChunk: altChunk ?? -1,
            });
          }
        }
      }
    }
  }
  return { totalPairs, withinChunk, straddling, straddlingExamples };
}

function printDuplicateRisk(state: RunState): void {
  console.log("");
  console.log("--- Cross-chunk duplicate risk (chunk plan) ---");
  if (state.chunkPlan.length <= 1) {
    console.log("Only one chunk planned — there is no cross-batch boundary, so this risk does not apply.");
    return;
  }

  const groups = state.manifest?.duplicate_spelling_groups;
  if (!Array.isArray(groups)) {
    console.log(
      "Cannot assess: no duplicate_spelling_groups ground truth is available (no manifest was supplied, or the " +
        "supplied manifest does not carry it — expected and normal for a real partner file, which has no such " +
        "ground truth).",
    );
    console.log(
      "IMPORTANT: this run's PASS/FAIL verdict covers per-chunk parse/validation faithfulness ONLY. Whether the " +
        "real importer's duplicate/matching logic catches a duplicate that straddles two different chunks is " +
        "UNPROVEN and NOT certified by this PASS.",
    );
    return;
  }

  const { totalPairs, withinChunk, straddling, straddlingExamples } = computeDuplicatePairStraddle(
    state.chunkPlan,
    groups,
  );
  console.log(`Duplicate spelling-variant pairs (from manifest ground truth): ${totalPairs}`);
  console.log(
    `  within a single chunk:           ${withinChunk}  (existing importer duplicate/matching logic, if any, has a chance to catch these)`,
  );
  console.log(
    `  STRADDLING two different chunks: ${straddling}  <-- UNPROVEN: cross-batch duplicate detection is not something this tool can verify (src/domains/import/** is out of scope this round)`,
  );
  if (straddlingExamples.length > 0) {
    console.log("  example straddling pairs:");
    for (const ex of straddlingExamples) {
      console.log(
        `    group ${ex.groupId}: row ${ex.canonicalRow} (chunk ${ex.canonicalChunk}) vs row ${ex.altRow} (chunk ${ex.altChunk})`,
      );
    }
  }
  console.log(
    "IMPORTANT: this run's PASS/FAIL verdict covers per-chunk parse/validation faithfulness ONLY. It does NOT " +
      "certify that duplicates spanning two chunks will be caught by the real import pipeline — that is P3's to " +
      "establish, not this tool's.",
  );
}

function printReport(state: RunState): void {
  console.log("=== P1 bulk-import validation runner ===");
  console.log("(This entry point will grow to cover import + enrichment in later pieces.)");
  console.log(`CSV:      ${state.csvPath}`);

  if (!state.csvExists) {
    console.error(`File not found: ${state.csvPath}`);
    return;
  }

  console.log(manifestStatusLine(state));
  console.log("");

  if (state.csvReadError) {
    console.error("");
    console.error("--- FATAL: could not read CSV file ---");
    console.error(state.csvReadError);
    return;
  }

  if (state.encodingIssue) {
    console.error("");
    console.error("--- FATAL: encoding problem ---");
    console.error(state.encodingIssue.message);
    return;
  }

  if (state.splitErrorReason === "unsupported_line_ending") {
    console.error("");
    console.error("--- FATAL: unsupported line endings ---");
    console.error(state.splitErrorMessage);
    return;
  }
  if (state.splitErrorReason === "ambiguous_record_split") {
    console.error("");
    console.error("--- FATAL: cannot determine record boundaries ---");
    console.error(state.splitErrorMessage);
    return;
  }
  if (state.allRecords !== null && state.allRecords.length === 0) {
    console.error("File is empty (no header row).");
    return;
  }
  if (state.headerParseErrorReason) {
    console.error("");
    console.error("--- FATAL: header row failed to parse ---");
    console.error(state.headerParseErrorReason);
    return;
  }

  // Header parsed successfully — full report from here on.
  if (state.chunkPlan.length > 1) {
    console.log("");
    console.log("=== CHUNK PLAN: this file uploads as multiple sequential chunks ===");
    console.log(
      `File has ${state.dataRecords.length} data rows; the live importer's MAX_ROWS is ${MAX_ROWS}, so this ` +
        `plan splits it into ${state.chunkPlan.length} chunks of up to ${CHUNK_TARGET_ROWS} rows each (see ` +
        "chunk_plan_* below for what is verified about this plan). Upload each chunk file in order, one at a " +
        "time, through the existing resumable apply path — see writeChunkPlanToDisk() output below for the " +
        "actual files.",
    );
  }

  console.log("");
  console.log("--- Chunk plan ---");
  console.log(`Target chunk size: ${CHUNK_TARGET_ROWS} rows (MAX_ROWS is ${MAX_ROWS}; MAX_UPLOAD_BYTES is ${MAX_UPLOAD_BYTES}).`);
  console.log(`Chunks planned:    ${state.chunkPlan.length}`);
  for (const chunk of state.chunkPlan) {
    const check = state.chunkPlanChecks.find((c) => c.index === chunk.index);
    const ok = check && check.rowCount <= MAX_ROWS && check.byteSize <= MAX_UPLOAD_BYTES && check.boundaryOk && check.headerOk;
    console.log(
      `  chunk ${chunk.index}: rows ${chunk.startRow}-${chunk.endRow} (${check?.rowCount ?? "?"} parsed rows, ` +
        `${check?.byteSize ?? "?"} bytes) ${ok ? "OK" : "SEE FAILURE REASONS BELOW"}`,
    );
  }
  console.log(
    state.chunkPlanReassemblyOk
      ? "Reassembly check: chunk data rows concatenate back to the original file's data section byte-for-byte. OK"
      : "Reassembly check: FAILED — see chunk_plan_reassembles_byte_identically below.",
  );

  printDuplicateRisk(state);

  console.log("--- Header mapping ---");
  if (state.missingRequiredHeaders.length > 0) {
    console.log(`Missing required headers: ${state.missingRequiredHeaders.join(", ")}`);
  } else {
    console.log("All required headers present.");
  }

  console.log("");
  console.log("--- Results ---");
  console.log(`Rows parsed:              ${state.rowsParsed}`);
  console.log(
    `Rows unparseable:         ${state.rowsUnparseable}${state.rowsUnparseable > 0 ? "  (parser-level rejection)" : ""}`,
  );
  console.log(`Rows valid:               ${state.rowsValid}`);
  console.log(`Rows invalid:             ${state.rowsInvalid}`);
  console.log(
    `Blank lines skipped:      ${state.blankLinesSkipped}${
      state.blankLinesSkipped > 0 ? "  (dropped by parser, like the real importer — row numbers below still count them)" : ""
    }`,
  );
  console.log(`Distinct raw variant keys: ${state.distinctRawVariantKeys.size}`);
  console.log(`Wall-clock:               ${state.wallClockMs} ms`);

  if (state.chunkMismatch) {
    console.log("");
    console.log("--- FATAL: record<->row count mismatch between splitter and real parser ---");
    console.log(
      `Chunk at data-row offset ${state.chunkMismatch.offset}: expected ${state.chunkMismatch.expected} non-blank ` +
        `record(s) but the real parser emitted ${state.chunkMismatch.actual} row(s). Processing stopped; row-number ` +
        "attribution past this point cannot be trusted.",
    );
  }

  if (state.sampleInvalidReasons.length > 0) {
    console.log("");
    console.log("--- Sample invalid-row reasons ---");
    for (const r of state.sampleInvalidReasons) console.log(`  ${r}`);
  }

  // Small crafted/test files only: dump every distinct variant key so a
  // regression test can assert byte-exact preservation of a field (e.g. an
  // embedded newline) without reimplementing the parser itself. The real
  // 20k-row fixture has thousands of distinct keys, so this section is
  // silent for it.
  if (state.distinctRawVariantKeys.size > 0 && state.distinctRawVariantKeys.size <= 20) {
    console.log("");
    console.log("--- Distinct variant keys (small file — showing all) ---");
    for (const key of state.distinctRawVariantKeys) console.log(`  ${key}`);
  }

  if (state.groupStats.size > 0) {
    console.log("");
    console.log("--- Expected-invalid groups (manifest-tagged) ---");
    for (const [group, stat] of state.groupStats) {
      const ok = stat.seenCount === stat.expectedCount && stat.mismatches.length === 0;
      console.log(
        `  ${group}: expected=${stat.expectedCount} seen=${stat.seenCount} matched=${stat.matchedCount} ${
          ok ? "(OK — expected-invalid-under-current-importer)" : "(MISMATCH)"
        }`,
      );
      for (const m of stat.mismatches.slice(0, 5)) {
        console.log(`    row ${m.rowIndex}: expected ${state.groupExpectations.get(group)?.outcome}, got ${m.outcome} (${m.detail})`);
      }
    }
  }

  if (state.untaggedFailures.length > 0) {
    console.log("");
    console.log("--- Unexpected failures (rows NOT tagged as expected-invalid) ---");
    for (const u of state.untaggedFailures.slice(0, 10)) {
      console.log(`  row ${u.rowIndex}: ${u.outcome} — ${u.detail}`);
    }
    if (state.untaggedFailures.length > 10) console.log(`  ... and ${state.untaggedFailures.length - 10} more`);
  }

  if (state.barcodeColumnIndex >= 0) {
    console.log("");
    console.log("--- Barcode (EAN-13) ---");
    console.log(`Rows with barcode:        ${state.barcodeSeen}`);
    console.log(`Valid check digits:       ${state.barcodeValid}`);
    if (state.barcodeMismatches.length > 0) {
      console.log(
        `Invalid check digits:     ${state.barcodeMismatches.length} (rows: ${state.barcodeMismatches.slice(0, 10).join(", ")})`,
      );
    }
    if (state.manifest?.barcode) {
      const mb = state.manifest.barcode;
      console.log(`Manifest expects:         ${mb.rows_with_barcode} rows with barcode, all_check_digits_valid=${mb.all_check_digits_valid}`);
    }
  }

  if (state.manifest) {
    console.log("");
    console.log("--- Manifest cross-check ---");
    if (typeof state.manifest.expected_unique_variant_count === "number") {
      const naive = state.distinctRawVariantKeys.size;
      const expected = state.manifest.expected_unique_variant_count;
      console.log(`Ground-truth unique variants:     ${expected}`);
      console.log(`Naive distinct raw variant keys:  ${naive}`);
      console.log(
        naive === expected
          ? "  (equal — no spelling noise in this file, or it happened to cancel out)"
          : `  (raw count is ${naive > expected ? "higher" : "lower"} than ground truth by ${Math.abs(naive - expected)} — expected when spelling-noise groups are present; a real dedup pass must close this gap; informational only, not a failure)`,
      );
    }
    if (state.manifest.category_summary) {
      console.log(`Category summary (from manifest): ${JSON.stringify(state.manifest.category_summary)}`);
    }

    console.log("");
    console.log("--- sha256 integrity check ---");
    const actualSha = state.buffer ? sha256HexOfBuffer(state.buffer) : "(unavailable)";
    console.log(`Computed csv_sha256:  ${actualSha}`);
    if (state.manifest.csv_sha256) {
      console.log(`Manifest csv_sha256:  ${state.manifest.csv_sha256}`);
      console.log(actualSha === state.manifest.csv_sha256 ? "  MATCH" : "  MISMATCH");
    } else {
      console.log("  (manifest has no csv_sha256 field — skipping)");
    }
  } else if (state.manifestJsonError || state.manifestShapeInvalid || state.manifestExplicitPathMissing) {
    console.log("");
    console.log("--- Manifest cross-check ---");
    console.log("  SKIPPED — the supplied manifest failed validation (see failure reasons below); no ground-truth assertions were run.");
  }
}

/**
 * Keep "<csv>.failures.json" in sync with THIS run's untagged failures —
 * written when there are any, removed when there are none (round-4 defect:
 * a stale failures.json from a previous bad run used to survive next to a
 * now-passing CSV, so a machine reading the directory would see failures
 * that no longer exist).
 *
 * Deliberately called AFTER the verdict has already been printed, and
 * deliberately never throws: this is bookkeeping about this script's own
 * report artifact, not about the CSV's validity (see the module doc's
 * "Deliberately OUT of PASS_PRECONDITIONS" note). Round-4 defect: an
 * unwritable path here used to throw mid-report and lose the whole
 * completed validation summary — now it can only ever print a warning
 * after that summary has already been reported in full.
 */
function syncFailuresReport(state: RunState): void {
  if (!state.csvExists) return;
  const failuresPath = (state.csvPath.endsWith(".csv") ? state.csvPath.slice(0, -4) : state.csvPath) + ".failures.json";

  if (state.untaggedFailures.length > 0) {
    try {
      writeFileSync(
        failuresPath,
        JSON.stringify(
          { csv: state.csvPath, total_untagged_failures: state.untaggedFailures.length, failures: state.untaggedFailures },
          null,
          2,
        ) + "\n",
      );
      console.log(`Full failure list (${state.untaggedFailures.length} rows) written to: ${failuresPath}`);
    } catch (err) {
      console.error(
        `WARNING: could not write failure report to ${failuresPath}: ${(err as Error).message}. ` +
          "The validation result above is unaffected — only this on-disk report is missing.",
      );
    }
    return;
  }

  if (existsSync(failuresPath)) {
    try {
      unlinkSync(failuresPath);
      console.log(`Removed stale failure report from a previous run: ${failuresPath}`);
    } catch (err) {
      console.error(
        `WARNING: a stale failure report exists at ${failuresPath} but could not be removed: ${(err as Error).message}.`,
      );
    }
  }
}

function chunksDirFor(csvPath: string): string {
  return (csvPath.endsWith(".csv") ? csvPath.slice(0, -4) : csvPath) + ".chunks";
}
function chunksManifestPathFor(csvPath: string): string {
  return (csvPath.endsWith(".csv") ? csvPath.slice(0, -4) : csvPath) + ".chunks.manifest.json";
}
function chunkManifestFileName(index: number): string {
  return `part-${String(index).padStart(4, "0")}.manifest.json`;
}
function chunkCsvFileName(index: number): string {
  return `part-${String(index).padStart(4, "0")}.csv`;
}

/** The exact per-chunk manifest shape P3's resumable apply path consumes —
 * pinned by contract, do not rename these fields. `chunk_sha256` and
 * `source_csv_sha256` are load-bearing (P3 uses source_csv_sha256 to reject
 * a chunk from the wrong file being mixed into a session, and chunk_sha256
 * to recognize a re-uploaded chunk as a no-op resume); row_count/byte_size
 * are informational only. */
export type PerChunkManifest = {
  chunk_index: number;
  chunk_total: number;
  row_start: number;
  row_end: number;
  row_count: number | null;
  byte_size: number;
  chunk_sha256: string;
  source_csv_sha256: string;
};

/**
 * Actually emits the chunk plan: one CSV file per chunk (deterministic
 * names, upload order), a per-chunk sidecar manifest next to each one (the
 * exact PerChunkManifest shape above — P3's contract), and one combined
 * "<csv>.chunks.manifest.json" for the human-readable overview — the
 * "one-command path" that reruns the identical, deterministic split
 * against a real partner CSV.
 *
 * Every hash here is computed over RAW BYTES ON DISK, never over a string
 * obtained by decoding those bytes first: `source_csv_sha256` is hashed
 * from state.buffer (a plain readFileSync() of the original file in
 * buildRunState(), never decoded), and each `chunk_sha256` is hashed from
 * re-reading the chunk file THIS FUNCTION JUST WROTE, not from the
 * in-memory buffer that produced it — so it is provably a hash of "this
 * chunk file's raw bytes on disk," not of a string that merely produced
 * them. A hash computed over decoded TEXT would agree with a raw-byte hash
 * only by coincidence on clean UTF-8 files, and could silently diverge on
 * exactly the malformed-encoding files this whole piece exists to catch —
 * the same principle as encoding_is_faithful, applied one level up.
 *
 * Deliberately OUT of PASS_PRECONDITIONS, same rationale as
 * syncFailuresReport(): this is bookkeeping about this tool's own output
 * files, not about whether the CHUNK PLAN ITSELF is correct (that's what
 * the chunk_plan_* preconditions, computed in-memory, already proved before
 * this ever runs) — an unwritable directory is an environment problem, not
 * a fact about the CSV, so it warns after the verdict rather than crashing
 * or changing the result.
 */
/**
 * Writes one CSV file + one PerChunkManifest sidecar per chunk into
 * outputDir (which the caller must already have created/cleaned), and
 * returns the entries written. Pulled out of writeChunkPlanToDisk() as its
 * own exported, directly-testable function that takes explicit inputs
 * (never a full RunState) — this is what the P3 interface pin's file-level
 * test exercises directly, at any chunk size, without needing to drive the
 * full CLI or fake a RunState.
 */
export function writeChunkFiles(
  outputDir: string,
  headerRecord: string,
  chunkPlan: ChunkPlanEntry[],
  chunkPlanChecks: ChunkPlanCheck[],
  sourceCsvSha256: string,
): { chunkEntries: (PerChunkManifest & { file: string })[] } {
  const chunkTotal = chunkPlan.length;
  const chunkEntries = chunkPlan.map((chunk) => {
    const fileName = chunkCsvFileName(chunk.index);
    const chunkPath = join(outputDir, fileName);
    const chunkText = serializeChunk(headerRecord, chunk.records);
    writeFileSync(chunkPath, Buffer.from(chunkText, "utf8"));
    // Re-read the file just written and hash THOSE bytes — never the
    // in-memory buffer/string that produced it. See writeChunkPlanToDisk()'s
    // doc for why: a hash computed over decoded TEXT would agree with a
    // raw-byte hash only by coincidence on clean UTF-8 files.
    const chunkBytes = readFileSync(chunkPath);
    const chunkSha256 = sha256HexOfBuffer(chunkBytes);
    const rowCount = chunkPlanChecks.find((c) => c.index === chunk.index)?.rowCount ?? null;

    const perChunkManifest: PerChunkManifest = {
      chunk_index: chunk.index,
      chunk_total: chunkTotal,
      row_start: chunk.startRow,
      row_end: chunk.endRow,
      row_count: rowCount,
      byte_size: chunkBytes.length,
      chunk_sha256: chunkSha256,
      source_csv_sha256: sourceCsvSha256,
    };
    writeFileSync(join(outputDir, chunkManifestFileName(chunk.index)), JSON.stringify(perChunkManifest, null, 2) + "\n");

    return { ...perChunkManifest, file: fileName };
  });
  return { chunkEntries };
}

/**
 * Actually emits the chunk plan for a real validator run: cleans and
 * (re)creates "<csv-without-ext>.chunks/", delegates the per-chunk file
 * writing to writeChunkFiles(), then writes the combined
 * "<csv-without-ext>.chunks.manifest.json" overview.
 *
 * Deliberately OUT of PASS_PRECONDITIONS, same rationale as
 * syncFailuresReport(): this is bookkeeping about this tool's own output
 * files, not about whether the CHUNK PLAN ITSELF is correct (that's what
 * the chunk_plan_* preconditions, computed in-memory, already proved before
 * this ever runs) — an unwritable directory is an environment problem, not
 * a fact about the CSV, so it warns after the verdict rather than crashing
 * or changing the result.
 */
function writeChunkPlanToDisk(state: RunState): void {
  if (!state.csvExists || state.headerRecord === null || state.chunkPlan.length === 0 || !state.buffer) return;
  const chunksDir = chunksDirFor(state.csvPath);
  const manifestPath = chunksManifestPathFor(state.csvPath);

  try {
    // Always start from a clean directory so a rerun against a file that
    // shrank (fewer chunks now needed) never leaves a stale, orphaned
    // chunk file behind — mirrors syncFailuresReport()'s stale-cleanup
    // rationale, applied here at directory granularity.
    rmSync(chunksDir, { recursive: true, force: true });
    mkdirSync(chunksDir, { recursive: true });

    // Hashed from the ORIGINAL file's raw bytes as read from disk —
    // state.buffer is populated by a plain readFileSync() in
    // buildRunState(), never decoded — so this can never diverge from a
    // byte-level re-check of the source file.
    const sourceCsvSha256 = sha256HexOfBuffer(state.buffer);
    const { chunkEntries } = writeChunkFiles(chunksDir, state.headerRecord, state.chunkPlan, state.chunkPlanChecks, sourceCsvSha256);

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          csv: state.csvPath,
          chunk_target_rows: CHUNK_TARGET_ROWS,
          chunk_total: state.chunkPlan.length,
          source_csv_sha256: sourceCsvSha256,
          chunks: chunkEntries,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`Chunk plan written: ${state.chunkPlan.length} file(s) in ${chunksDir}/, manifest at ${manifestPath}`);
  } catch (err) {
    console.error(
      `WARNING: could not write the chunk plan to disk (${chunksDir}/, ${manifestPath}): ${(err as Error).message}. ` +
        "The validation result above is unaffected — only these on-disk chunk files are missing.",
    );
  }
}

function main() {
  const [, , csvPathArg, manifestPathArg] = process.argv;
  const csvPath = csvPathArg ?? "fixtures/generated/partner-cellar-20k.csv";

  const state = buildRunState(csvPath, manifestPathArg ?? null);
  printReport(state);

  const verdict = evaluateVerdict(state);
  console.log("");
  if (!verdict.pass) {
    console.log("--- Failure reasons ---");
    for (const r of verdict.reasons) console.log(`  - ${r}`);
    console.log("");
    console.log("=== RESULT: FAIL ===");
  } else {
    console.log("=== RESULT: PASS ===");
  }
  console.log("=== done ===");

  syncFailuresReport(state);
  writeChunkPlanToDisk(state);

  process.exit(verdict.pass ? 0 : 1);
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
