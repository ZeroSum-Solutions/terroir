// P1/P3 — browser-safe CSV chunk-splitting primitives.
//
// Extracted from scripts/validate-bulk-import.ts (a Node-only script) so the
// SAME quote-aware record splitter, chunk planner, and chunk serializer used
// to validate + plan a partner CSV on the command line can also run inside
// the browser bundle that drives /import's client-side auto-chunking upload
// flow — one implementation, two call sites, so the script and the browser
// can never silently disagree about where a chunk boundary falls. See
// scripts/validate-bulk-import.ts's own module doc for the full quoting
// rationale; only the "why extracted here" delta is documented below.
//
// This file must stay free of Node-only imports ('fs', 'url', 'node:crypto',
// ...) — it ships in the 'use client' import bundle for src/app/(app)/import.

import { parseCsv } from "./csv-parser";

// ---------------------------------------------------------------------------
// Quote-state-aware logical record splitter.
//
// Mirrors csv-parser.ts's own row-boundary rule exactly (a `"` only opens a
// quoted field when it is the very first character of that field — see
// parseCsv's `char === '"' && field === ""` check) but does NOT enforce
// MAX_ROWS or MAX_FIELD_LENGTH: its only job is finding where each logical
// CSV record starts and ends in the raw text, so a chunk of raw text handed
// to the real parseCsv() always begins and ends on a true record boundary —
// even when a quoted field embeds a literal newline. This never chunks on
// raw physical lines: a naive `text.split("\n")` before parsing would cut a
// multi-line quoted field in half at whatever chunk boundary it happens to
// cross, corrupting that record and shifting every row number after it. If
// the splitter can't resolve where a record ends (an unterminated quote
// through EOF, or a bare `\r` outside quotes not followed by `\n`), it fails
// CLOSED — throws — rather than guessing.
//
// A bare `\r` (not followed by `\n`) outside quotes gets the same fail-
// closed treatment as an unterminated quote. csv-parser.ts's own `\r`
// handling — inherited here on purpose — treats EVERY `\r` as invisible
// whitespace and relies on `\n` alone to end a record. That is correct for
// CRLF, but a file using lone-CR line endings (classic pre-OS X Excel/Mac
// export) has NO `\n` at all: every intended record break would be silently
// swallowed and the whole file would collapse into one giant "record" — so
// this splitter refuses the file outright the moment it sees a `\r` outside
// quotes that isn't immediately followed by `\n`.
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
 * is empty)? Rather than reimplement that field-parsing rule a second time,
 * this asks the real parser itself: a standalone record that parseCsv()
 * would drop as blank is, when parsed completely alone, indistinguishable
 * from an empty file (its `rows` array ends up empty), which is the one
 * condition parseCsv() reports as the "empty_file" error. A non-blank
 * record, standalone, always parses `ok`.
 */
export function isBlankRecord(record: string): boolean {
  const probe = parseCsv(`${record}\n`);
  return !probe.ok && probe.error.code === "empty_file";
}

// ---------------------------------------------------------------------------
// Chunk plan — partitions already-split data records into upload-sized
// chunks, by ARRAY SLICING — never by re-joining and re-splitting text.
// Every element of dataRecords is already a complete, self-contained
// logical record (guaranteed by splitLogicalRecords()'s own quote-tracking),
// so slicing this array can never bisect one — the "a chunk boundary must
// never cut a record" property holds by construction, not by luck.
//
// CLIENT_CHUNK_TARGET_ROWS (src/domains/import/constants.ts) is the single
// shared row-count both scripts/validate-bulk-import.ts's chunk plan and
// this browser splitter build from, so the CLI-produced chunk files and the
// browser's own auto-split can never drift on chunk size.
// ---------------------------------------------------------------------------

export interface ChunkPlanEntry {
  /** 1-indexed, in upload order. */
  index: number;
  /** Raw logical data records (blank lines included), in original file order. */
  records: string[];
  /** 1-indexed row number (every physical row a human would see in their
   * spreadsheet, blank lines included) of the first record in this chunk. */
  startRow: number;
  /** 1-indexed row number of the last record in this chunk. */
  endRow: number;
}

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

// ---------------------------------------------------------------------------
// Browser-safe SHA-256, via the Web Crypto API (crypto.subtle) — available
// in every browser over a secure context (HTTPS, or localhost for local
// dev). Node's `crypto.createHash` (used by validate-bulk-import.ts's own
// sha256HexOfBuffer) is not reachable from a 'use client' bundle, so this is
// a separate implementation — both hash the identical algorithm over raw
// bytes, so they always agree on output for the same input.
// ---------------------------------------------------------------------------

export class SubtleCryptoUnavailableError extends Error {}

export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new SubtleCryptoUnavailableError(
      "Web Crypto (crypto.subtle) is not available in this browser — the CSV cannot be hashed client-side. " +
        "crypto.subtle requires a secure context (HTTPS, or localhost for local development); if this page is " +
        "served over plain HTTP on a non-localhost host, that is why.",
    );
  }
  // Copy into a fresh ArrayBuffer-backed view: the parameter's
  // Uint8Array<ArrayBufferLike> could wrap a SharedArrayBuffer, which
  // BufferSource (and crypto.subtle) rejects at the type level.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
