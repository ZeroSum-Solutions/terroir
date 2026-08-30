// The chunked PREVIEW half of the client-side auto-chunking flow: split an
// already-parsed, over-MAX_ROWS file into upload chunks and preview each
// one sequentially against POST /api/import/preview (read-only — no
// session or batch is created here), aggregating the per-chunk summaries.
//
// Extracted verbatim from session-step.tsx, which re-exports
// planChunkedPreview/ChunkedPreviewResult unchanged. Plain async, no
// hooks, so it is callable from any handler regardless of React's
// render/commit timing.

import { CLIENT_CHUNK_TARGET_ROWS } from "./constants";
import { buildChunkPlan, serializeChunk, sha256HexOfBytes } from "./csv-splitter";
import type { PreviewRow, PreviewSummary } from "./preview-service";
import {
  ZERO_SUMMARY,
  type ChunkPlanItem,
  type ChunkPreviewEntry,
  type ChunkedPlanState,
  type ChunkedPreviewState,
} from "./chunked-upload-types";

// /api/import/preview's own PREVIEW_RATE_WINDOW_MS (src/app/api/import/
// preview/route.ts) — used as the wait fallback on a 429 that arrives
// without a Retry-After header. Unlike confirm, preview isn't paced
// proactively (every chunk is read-only and idempotent to retry), so a
// large file can legitimately hit the window; on 429 this loop honors
// Retry-After and resumes at the failed chunk, capped, rather than
// discarding every chunk previewed so far.
const PREVIEW_RATE_WINDOW_MS = 60 * 1000;
const PREVIEW_MAX_RETRIES_PER_CHUNK = 5;

export type ChunkedPreviewResult = { ok: true; plan: ChunkedPlanState; preview: ChunkedPreviewState } | { ok: false; error: string };

/** Splits an already-parsed, over-MAX_ROWS file into upload chunks and
 * previews every chunk sequentially against the existing, unmodified
 * POST /api/import/preview (read-only — no session/batch created here),
 * aggregating the per-chunk PreviewSummary objects into one combined view. */
export async function planChunkedPreview(
  selectedFile: File,
  headerRecord: string,
  dataRecords: string[],
  bytes: Uint8Array,
): Promise<ChunkedPreviewResult> {
  const chunkEntries = buildChunkPlan(dataRecords, CLIENT_CHUNK_TARGET_ROWS);

  let sourceSha256: string;
  try {
    sourceSha256 = await sha256HexOfBytes(bytes);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not hash this file." };
  }

  const planChunks: ChunkPlanItem[] = [];
  const perChunk: ChunkPreviewEntry[] = [];
  const errorRows: ChunkedPreviewState["errorRows"] = [];
  // Item 2: mirrors errorRows above exactly.
  const matchedRows: ChunkedPreviewState["matchedRows"] = [];
  const summary: PreviewSummary = { ...ZERO_SUMMARY };

  for (const chunkEntry of chunkEntries) {
    const text = serializeChunk(headerRecord, chunkEntry.records);
    planChunks.push({ index: chunkEntry.index, startRow: chunkEntry.startRow, endRow: chunkEntry.endRow, text });

    const chunkFile = new File([text], `${selectedFile.name.replace(/\.csv$/i, "")}.part${chunkEntry.index}.csv`, {
      type: "text/csv",
    });

    // Retries THIS chunk only — every prior chunk's summary/errorRows are
    // already accumulated above and untouched, so a 429 partway through a
    // large file resumes at the failed chunk rather than discarding
    // everything previewed so far.
    let body: { summary: PreviewSummary; rows: PreviewRow[] } | null = null;
    for (let attempt = 0; body === null; attempt += 1) {
      const form = new FormData();
      form.append("file", chunkFile);
      let response: Response;
      try {
        response = await fetch("/api/import/preview", { method: "POST", body: form });
      } catch {
        return {
          ok: false,
          error: `Chunk ${chunkEntry.index} of ${chunkEntries.length} failed to preview — check your connection and try again.`,
        };
      }

      if (response.status === 429) {
        if (attempt >= PREVIEW_MAX_RETRIES_PER_CHUNK) {
          return {
            ok: false,
            error: `Chunk ${chunkEntry.index} of ${chunkEntries.length} is still rate-limited after ${PREVIEW_MAX_RETRIES_PER_CHUNK} retries — wait a minute and try again.`,
          };
        }
        const retryAfterSeconds = Number(response.headers.get("Retry-After"));
        const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : PREVIEW_RATE_WINDOW_MS;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      const parsedBody = await response.json();
      if (!response.ok) {
        return {
          ok: false,
          error: `Chunk ${chunkEntry.index} of ${chunkEntries.length} failed to preview: ${parsedBody?.error?.message ?? "Preview failed."}`,
        };
      }
      body = parsedBody;
    }

    const chunkSummary = body.summary;
    const chunkRows = body.rows;
    perChunk.push({
      index: chunkEntry.index,
      startRow: chunkEntry.startRow,
      endRow: chunkEntry.endRow,
      summary: chunkSummary,
      // Round-6 audit finding 3: captured regardless of this row's own
      // validity — "Import anyway" needs a real, existing field value to
      // build a deterministic no-op override from, even for a chunk with
      // zero error rows.
      firstRowRawText: chunkRows[0]?.rawText ?? null,
    });
    for (const key of Object.keys(summary) as (keyof PreviewSummary)[]) summary[key] += chunkSummary[key];
    for (const row of chunkRows) {
      // Sol audit (2026-08-27) finding 6: row.rowNumber is this chunk's
      // own DENSE data-row count exactly as the server (buildImportPreview)
      // assigns it — 1 = this chunk's first NON-BLANK data row, because
      // parseCsv silently drops blank lines before numbering anything.
      // chunkEntry.startRow, by contrast, counts every record INCLUDING
      // blanks (buildChunkPlan / csv-splitter.ts) — so `startRow - 1 +
      // row.rowNumber` is NOT guaranteed to equal this row's true physical
      // line number in the original file whenever a blank record precedes
      // it within this same chunk. Read the result as "row N of this
      // chunk's own data rows," never as an exact original-file line
      // count. What it MUST stay exact for is round-tripping through
      // localizeRowOverrides back to this same dense local row number
      // (`globalRowNumber - chunk.startRow + 1 === row.rowNumber`, which
      // holds regardless of blanks) — that's the only property an inline
      // fix actually depends on to land on the right row. `rowNumber`
      // itself is therefore NEVER changed for display — it stays exactly
      // this override-targeting value.
      //
      // Sol round-2 audit (2026-08-27) finding 5: chunkIndex/chunkRowNumber carry
      // the HONEST label instead — row.rowNumber, unmodified, IS already
      // this chunk's own dense data-row count (that's what the comment
      // above is describing), so no extra arithmetic is needed to surface
      // it. import-client.tsx's RowFixItem renders "Chunk N, data row M"
      // from these two fields when present, rather than presenting
      // `rowNumber` (a startRow-adjusted number that can look like — but
      // is not — a true physical spreadsheet row) as if it were one.
      if (row.rowState === "error") {
        errorRows.push({
          rowNumber: chunkEntry.startRow - 1 + row.rowNumber,
          chunkIndex: chunkEntry.index,
          chunkRowNumber: row.rowNumber,
          errors: row.errors,
          rawText: row.rawText,
        });
      } else if (row.lwinStatus === "matched" && row.lwinId !== null) {
        // Item 2 (per-row LWIN match visibility): same GLOBAL-row-number
        // convention as errorRows above.
        matchedRows.push({
          rowNumber: chunkEntry.startRow - 1 + row.rowNumber,
          chunkIndex: chunkEntry.index,
          chunkRowNumber: row.rowNumber,
          lwinId: row.lwinId,
          lwinDisplayName: row.lwinDisplayName,
          lwinScore: row.lwinScore ?? 0,
        });
      }
    }
  }

  return {
    ok: true,
    plan: { headerRecord, chunkTotal: chunkEntries.length, chunks: planChunks, sourceSha256 },
    preview: { summary, perChunk, errorRows, matchedRows },
  };
}
