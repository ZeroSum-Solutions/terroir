"use client";

// Per-chunk upload status for the chunked (> MAX_ROWS) confirm path, with
// the three escape hatches a chunk stuck on duplicate_chunk_content needs.
// Extracted verbatim from session-step.tsx; session-step.tsx re-exports
// ChunkUploadProgress unchanged.

import { Loader2 } from "lucide-react";
import type { ChunkUploadState, ChunkUploadStatus } from "@/domains/import/chunked-upload-types";

function chunkUploadStatusLabel(status: ChunkUploadStatus): string {
  switch (status) {
    case "pending":
      return "Waiting to start";
    case "waiting":
      return "Waiting to avoid rate limit…";
    case "uploading":
      return "Uploading…";
    case "confirmed":
      return "Uploaded";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
  }
}

/** Round-5 audit finding 4: `onSkipChunk`, when given, renders a "Skip
 * this chunk" control on any chunk stuck on duplicate_chunk_content —
 * the escape hatch for the case that has no editable row at all (a fully
 * VALID duplicate chunk: no error rows, so no override editor, so no way
 * to ever make its content_sha256 differ). Skipping is client-side only:
 * it marks the chunk "skipped" so confirmChunkedSession never re-attempts
 * it and PreviewStep's Confirm/Retry button is no longer blocked by it —
 * it does not create, delete, or touch anything server-side.
 *
 * Round-6 audit finding 3: `onImportAnyway`, when given, renders "Import
 * anyway" alongside Skip — the mechanism for a GENUINE repeated segment,
 * as opposed to Skip's "this was accidental." It deterministically
 * generates a canonical no-op override (import-client.tsx's own
 * handleImportAnyway) from this chunk's own first data row, namespacing
 * the digest so a subsequent confirm reaches create instead of colliding
 * again — the only path that also works for a fully valid duplicate chunk
 * with no error row to ever edit.
 *
 * Round-6 audit finding 5: `onUndoSkip`, when given, renders "Undo skip"
 * on a chunk already marked "skipped" — restores it to its prior failed
 * duplicate_chunk_content state, with both Import anyway and Skip
 * available again. Skip is purely client state (import-client.tsx's own
 * comment), so undoing it touches nothing server-side either.
 *
 * Round-7 audit finding 4: `frozen`, when true, disables all three
 * buttons — the same TEMPORARY freeze RowFixItem's own `frozen` prop
 * already applies to row-edit inputs while a confirm attempt is in flight
 * (import-client.tsx's PreviewStep). A mid-retry Skip/Undo-skip/Import-
 * anyway click, while confirmChunkedSession's own driver loop is actively
 * re-writing chunkUpload via onProgress, would otherwise be immediately
 * overwritten by the driver's next progress write — a click that visibly
 * "worked" for a moment and then silently reverted. Disabling the buttons
 * for the duration removes that race entirely, exactly like the row-input
 * freeze. */
export function ChunkUploadProgress({
  chunks,
  chunkTotal,
  onSkipChunk,
  onImportAnyway,
  onUndoSkip,
  frozen,
}: {
  chunks: ChunkUploadState[];
  chunkTotal: number;
  onSkipChunk?: (index: number) => void;
  onImportAnyway?: (index: number) => void;
  onUndoSkip?: (index: number) => void;
  frozen?: boolean;
}) {
  const confirmedCount = chunks.filter((c) => c.status === "confirmed" || c.status === "skipped").length;
  return (
    <div className="mt-lg">
      <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
        Upload progress ({confirmedCount} of {chunkTotal} chunks)
      </h3>
      <ul className="mt-xs space-y-2xs">
        {chunks.map((c) => (
          <li
            key={c.index}
            className="flex items-center justify-between gap-sm rounded-md bg-wash px-sm py-xs text-[13px] text-ink"
          >
            <span>Chunk {c.index}</span>
            <span className="flex items-center gap-xs text-caption text-grey">
              {c.status === "uploading" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {c.status === "skipped"
                ? c.duplicateOfChunkIndex !== undefined
                  ? `Skipped — identical to chunk ${c.duplicateOfChunkIndex}, already imported`
                  : chunkUploadStatusLabel(c.status)
                : chunkUploadStatusLabel(c.status)}
              {c.status === "failed" && c.error ? `: ${c.error}` : ""}
              {c.status === "failed" && c.code === "duplicate_chunk_content" && onImportAnyway && (
                <button
                  type="button"
                  onClick={() => onImportAnyway(c.index)}
                  disabled={frozen}
                  title="Imports this chunk's identical rows as a separate tracked upload."
                  className="min-h-11 rounded-pill border border-edge bg-surface px-sm py-2xs text-caption font-medium text-ink hover:bg-wash focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Import anyway
                </button>
              )}
              {c.status === "failed" && c.code === "duplicate_chunk_content" && onSkipChunk && (
                <button
                  type="button"
                  onClick={() => onSkipChunk(c.index)}
                  disabled={frozen}
                  className="min-h-11 rounded-pill border border-edge bg-surface px-sm py-2xs text-caption font-medium text-ink hover:bg-wash focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Skip this chunk
                </button>
              )}
              {/* Round-6 audit finding 5: skip is trivially reversible —
                  client-side state only, nothing server-side was ever
                  touched — so undoing it just restores the failed state
                  with both actions available again. */}
              {c.status === "skipped" && onUndoSkip && (
                <button
                  type="button"
                  onClick={() => onUndoSkip(c.index)}
                  disabled={frozen}
                  className="min-h-11 rounded-pill border border-edge bg-surface px-sm py-2xs text-caption font-medium text-ink hover:bg-wash focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Undo skip
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
