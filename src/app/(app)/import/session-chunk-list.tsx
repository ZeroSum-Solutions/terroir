"use client";

// The session's per-chunk roster: one line per chunk with its
// import_batches status, plus the two honest "why isn't everything here"
// notices (an interrupted upload, and client-side-skipped chunks).
// Extracted verbatim from session-step.tsx's own JSX.

import { CheckCircle2 } from "lucide-react";
import type { SessionProgress } from "./session-progress-types";

/** Round-5 audit finding 4: one client-side-skipped chunk, for
 * SessionStep's own honest summary line. Sourced from ImportClient's
 * chunkUpload state (the server has no record of a skip at all — this is
 * never persisted, so it does not survive a page reload). */
export type SkippedChunkSummary = { index: number; duplicateOfChunkIndex: number | undefined };

export function SessionChunkList({
  progress,
  skippedChunks,
}: {
  progress: SessionProgress;
  skippedChunks?: SkippedChunkSummary[];
}) {
  return (
    <div className="mt-lg">
      <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
        Chunks ({progress.chunks.length}
        {progress.declaredChunkTotal ? ` of ${progress.declaredChunkTotal}` : ""})
      </h3>
      <ul className="mt-xs space-y-2xs">
        {progress.chunks.map((chunk) => (
          <li
            key={chunk.batchId}
            className="flex items-center justify-between rounded-md bg-wash px-sm py-xs text-[13px] text-ink"
          >
            <span>Chunk {chunk.chunkIndex ?? "—"} ({chunk.counts.applied}/{chunk.counts.total} applied)</span>
            <ChunkStatusChip status={chunk.status} />
          </li>
        ))}
      </ul>
      {progress.allChunksPresent === false && (
        <p className="mt-xs text-caption text-grey">
          Not every expected chunk has arrived yet — if the upload was interrupted, start a new import with the
          same file to finish it.
        </p>
      )}
      {/* Round-5 audit finding 4: reports honestly WHY a skipped chunk's
          rows never arrived, distinct from the generic "interrupted
          upload" message above — client-side only, so this list is
          empty (and this block renders nothing) after a page reload.

          Round-6 audit finding 4(a): a skipped chunk means this session
          can NEVER reach status='completed' — skip has no server
          record at all (import_sessions has no client-writable column
          to persist it — migrations are locked), so getImportSessionProgress's
          allChunksPresent stays permanently false for this session's
          declared_chunk_total. Reaching this block at all guarantees
          every OTHER chunk already got a server-confirmed batch (the
          confirm loop this session was created from only ever reaches
          "session" once every chunk in the plan is confirmed or
          skipped) — so the honest, always-true summary is "all other
          chunks are in; this one specific chunk isn't, on purpose; the
          session stays in progress forever, and that's fine." */}
      {skippedChunks && skippedChunks.length > 0 && (
        <p className="mt-xs text-caption text-grey">
          {skippedChunks
            .map((s) =>
              s.duplicateOfChunkIndex !== undefined
                ? `Chunk ${s.index} skipped — byte-identical to chunk ${s.duplicateOfChunkIndex}, whose rows are already imported.`
                : `Chunk ${s.index} skipped.`,
            )
            .join(" ")}{" "}
          Every other chunk was imported. Because skipping happens only in your browser, with no record on the
          server, this session stays marked &ldquo;In progress&rdquo; here permanently — that is expected and
          safe, and there is nothing further to do.
        </p>
      )}
    </div>
  );
}

/** import_batches.status values a chunk can carry (identical set BatchStep's
 * own StatusBadge renders — see DESIGN.md's one-StatusChip-pattern rule). */
function ChunkStatusChip({ status }: { status: string }) {
  const label: Record<string, string> = {
    created: "Not yet applied",
    applying: "In progress",
    completed: "Completed",
    reverted: "Reverted",
  };
  return (
    <span className="inline-flex items-center gap-2xs rounded-pill bg-wash px-sm py-2xs text-caption font-medium text-ink">
      {status === "completed" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
      {label[status] ?? status}
    </span>
  );
}
