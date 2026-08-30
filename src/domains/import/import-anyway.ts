// "Import anyway": the deterministic, distinct-per-chunk no-op override
// that namespaces a duplicate chunk's content_sha256 away from the sibling
// it collided with. Extracted verbatim from import-client.tsx, which
// re-exports buildImportAnywayOverride and its two types unchanged.

import { CANONICAL_HEADERS, type CanonicalHeader } from "./constants";
import type { RowOverrides } from "./review-types";

/** One row this chunk has full parsed text for — the chunk's own first
 * data row, or one of its error rows (see buildImportAnywayOverride's own
 * comment for why these are the only rows available without a heavier,
 * whole-chunk data-retention change). */
export type ImportAnywayGridRow = { rowNumber: number; rawText: Record<CanonicalHeader, string> };

export type ImportAnywayOutcome =
  | { ok: true; overridePatch: RowOverrides }
  /** Round-7 audit finding 2: the deterministic scheme's variation space
   * for THIS chunk is exhausted — gridSize non-empty cells were not
   * enough to give chunkIndex its own distinct subset. `gridSize` is
   * surfaced so the caller's guidance can be concrete. */
  | { ok: false; reason: "exhausted"; gridSize: number };

/** Round-6 audit finding 3, made distinct-per-chunk by round-7 audit
 * finding 2: the pure logic behind "Import anyway" — builds a canonical
 * no-op override from this chunk's own known rows (never a fabricated
 * value; every cell is a row's existing, already-parsed text).
 *
 * Round-6's version always picked the SAME single cell (chunk.startRow,
 * CANONICAL_HEADERS[0]) regardless of chunkIndex — so two identical
 * sibling chunks produced the IDENTICAL no-op override, which hashes to
 * the IDENTICAL namespaced content_sha256, which 23505s again exactly like
 * the original collision: clicking "Import anyway" a second time on the
 * second sibling was a dead end (Retry stays hidden — the regenerated
 * override slice equals sentOverridesSnapshot).
 *
 * The fix: enumerate every (row, non-blank-field) cell across this chunk's
 * KNOWN rows — its first data row (global row number = firstRow.rowNumber,
 * captured even for a fully-valid duplicate chunk with zero error rows —
 * see ChunkPreviewEntry.firstRowRawText's own comment in session-step.tsx)
 * plus every one of its OWN error rows (chunkedPreview.errorRows already
 * carries full rawText for these at no extra retention cost — this
 * deliberately does NOT require capturing every row of a
 * CLIENT_CHUNK_TARGET_ROWS-sized chunk, which would multiply this
 * feature's memory footprint by chunk size for no benefit: a fully valid
 * duplicate chunk's grid is necessarily just its first row's non-blank
 * fields, which is already enough headroom that exhausting it requires
 * more identical siblings than CANONICAL_HEADERS has fields — "absurd in
 * practice" is a deliberate, accepted bound, not an oversight). Rows are
 * deduped by rowNumber first (the first row CAN also be an error row), in
 * a fixed order — first row, then error rows in their given order — and
 * each row's fields are enumerated in CANONICAL_HEADERS order, skipping
 * any blank one (nothing to meaningfully "override" there).
 *
 * The resulting flat cell list has length `gridSize`. chunkIndex (always
 * >= 1, unique per chunk within a session) selects a subset by TAKING THE
 * FIRST chunkIndex CELLS — a trivially injective map from chunkIndex to a
 * distinct subset SIZE for every chunkIndex in [1, gridSize]: two
 * different chunkIndex values can never produce the same cell COUNT, and
 * canonicalizeRowOverrides (batch-service.ts) sorts its output by row then
 * field, so a different cell count is always a different canonicalized
 * JSON array length — never the same digest. Every value in the resulting
 * override is the row's OWN existing text (a content no-op, exactly as
 * before). When chunkIndex EXCEEDS gridSize, the scheme has run out of
 * distinct subsets for this chunk (chunkIndex would wrap onto a size
 * already used by some other chunk in [1, gridSize]) — reported as
 * `{ ok: false, reason: "exhausted" }` rather than silently generating an
 * override already known to collide again, exactly the round-6 dead end
 * this fix exists to close. Exported so the scheme can be pinned directly,
 * without exercising the full ImportClient component tree. */
export function buildImportAnywayOverride(
  chunkIndex: number,
  firstRow: ImportAnywayGridRow | null,
  errorRowsInChunk: ImportAnywayGridRow[],
): ImportAnywayOutcome | null {
  if (!firstRow) return null;

  const seenRows = new Set<number>();
  const gridRows: ImportAnywayGridRow[] = [];
  for (const row of [firstRow, ...errorRowsInChunk]) {
    if (seenRows.has(row.rowNumber)) continue;
    seenRows.add(row.rowNumber);
    gridRows.push(row);
  }

  const cells: { rowNumber: number; field: CanonicalHeader }[] = [];
  for (const row of gridRows) {
    for (const field of CANONICAL_HEADERS) {
      if (row.rawText[field]) cells.push({ rowNumber: row.rowNumber, field });
    }
  }

  const gridSize = cells.length;
  if (gridSize === 0 || chunkIndex > gridSize) {
    return { ok: false, reason: "exhausted", gridSize };
  }

  const subset = cells.slice(0, chunkIndex);
  const overridePatch: RowOverrides = {};
  for (const cell of subset) {
    const row = gridRows.find((r) => r.rowNumber === cell.rowNumber)!;
    overridePatch[cell.rowNumber] = { ...overridePatch[cell.rowNumber], [cell.field]: row.rawText[cell.field] };
  }

  return { ok: true, overridePatch };
}
