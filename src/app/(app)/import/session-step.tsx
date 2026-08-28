"use client";

// P3 — multi-batch onboarding session UI: per-chunk status, aggregate
// progress (GET /api/import/sessions/[id]), "Apply all" (drives each
// chunk's own /apply loop in turn), pending-row resolution sourced across
// every chunk, and revert-as-a-unit. Co-located with import-client.tsx,
// which owns all upload/session-creation state — this file only ever reads
// an existing sessionId and drives the session's own lifecycle from there.
//
// Deliberately duplicates import-client.tsx's tiny SummaryStat/status-chip
// markup (identical classes — see DESIGN.md's "one StatusChip pattern"
// contract) rather than importing them, so this file and import-client.tsx
// never import from each other in both directions.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { ActionDialog } from "@/components/action-dialog";
import { CLIENT_CHUNK_TARGET_ROWS } from "@/domains/import/constants";
import { buildChunkPlan, serializeChunk, sha256HexOfBytes } from "@/domains/import/csv-splitter";
import type { PreviewRow, PreviewSummary } from "@/domains/import/preview-service";
import type { BatchRow, ErrorRowEntry, RowOverrides } from "./import-client";

// ---------------------------------------------------------------------------
// Chunk plan / upload state, and the pure functions that drive the two
// network-heavy halves of the client-side auto-chunking flow (preview and
// confirm). import-client.tsx owns all of this feature's REACT STATE and
// wiring (the row-count precheck, when to call these, localStorage
// resume-on-mount) — this file is the chunked-upload "engine" plus the
// SessionStep UI, kept together so import-client.tsx stays a manageable
// size. Every function below is plain async/pure (no hooks), so it's
// callable from any handler regardless of React's render/commit timing.
// ---------------------------------------------------------------------------

export type ChunkPlanItem = { index: number; startRow: number; endRow: number; text: string };

export type ChunkedPlanState = {
  headerRecord: string;
  chunkTotal: number;
  chunks: ChunkPlanItem[];
  sourceSha256: string;
};

export type ChunkPreviewEntry = { index: number; startRow: number; endRow: number; summary: PreviewSummary };

export type ChunkedPreviewState = {
  summary: PreviewSummary;
  perChunk: ChunkPreviewEntry[];
  errorRows: ErrorRowEntry[];
};

// Round-5 audit finding 4: "skipped" is a purely CLIENT-SIDE terminal state
// — never sent to, or acknowledged by, the server (migrations are locked,
// there is no DB column for it). It means "the operator chose not to
// re-attempt this chunk," used to escape the permanent dead end a fully-
// valid duplicate_chunk_content chunk (no error rows, so no override to
// edit) would otherwise be — see ChunkUploadState.skippedDuplicateOfChunkIndex.
export type ChunkUploadStatus = "pending" | "waiting" | "uploading" | "confirmed" | "failed" | "skipped";
export type ChunkUploadState = {
  index: number;
  status: ChunkUploadStatus;
  batchId: string | null;
  error: string | null;
  /** Sol round-2 audit (2026-08-27) finding 3: the server's error CODE for a
   * "failed" chunk, when there is one — e.g. "chunk_content_mismatch",
   * which is TERMINAL (retrying re-sends the exact same content and will
   * fail again the same way). null for every non-error state, and for a
   * failure with no typed code (network error, generic upload failure). */
  code: string | null;
  /** Round-5 audit finding 3: the operator's override slice for THIS
   * chunk's rows (GLOBAL row numbers, same keying as RowOverrides).
   * exactly as it was included in the confirm attempt that failed with
   * duplicate_chunk_content — captured so the client can tell "an override
   * exists" (true forever after a single edit) apart from "the override
   * CHANGED since the collision" (the only thing that actually produces a
   * different content_sha256 and can plausibly resolve it on retry).
   * undefined until a duplicate_chunk_content failure actually occurs. */
  sentOverridesSnapshot?: RowOverrides;
  /** Round-5 audit finding 3/4: the sibling chunk index (body.chunkIndex
   * from the server's alreadyExists response) THIS chunk's content
   * collided with, when status is "failed" with code "duplicate_chunk_content"
   * — or, once the operator skips it, the same value carried onto
   * "skipped" so the session summary can name it. undefined otherwise. */
  duplicateOfChunkIndex?: number;
};

export const ZERO_SUMMARY: PreviewSummary = {
  totalRows: 0,
  validRows: 0,
  errorRows: 0,
  matchedRows: 0,
  unmatchedRows: 0,
  missingCostRows: 0,
  readyToApplyRows: 0,
  pendingResolutionRows: 0,
};

// Resume: sessionId persisted per-browser so a page reload mid-multi-chunk
// upload can reconcile against the server rather than starting over.
// try/catch on every access — never load-bearing if storage is unavailable.
const IMPORT_SESSION_STORAGE_KEY = "terroir-import-session-v1";

export type StoredSession = { sessionId: string; sourceSha256: string; label: string };

export function readStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(IMPORT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.sessionId !== "string") return null;
    return {
      sessionId: parsed.sessionId,
      sourceSha256: typeof parsed.sourceSha256 === "string" ? parsed.sourceSha256 : "",
      label: typeof parsed.label === "string" ? parsed.label : "cellar.csv",
    };
  } catch {
    return null;
  }
}

export function writeStoredSession(value: StoredSession | null) {
  try {
    if (value === null) window.localStorage.removeItem(IMPORT_SESSION_STORAGE_KEY);
    else window.localStorage.setItem(IMPORT_SESSION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // best-effort — resume is a convenience only, never load-bearing.
  }
}

// Client-side pacing, matching /api/import/batches' own CONFIRM_RATE_LIMIT
// (10/60s, src/app/api/import/batches/route.ts) with a one-request margin
// so a same-tab retry never itself trips the server's limiter.
const CONFIRM_RATE_LIMIT_MARGIN = 9;
const CONFIRM_RATE_WINDOW_MS = 60 * 1000;

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
    perChunk.push({ index: chunkEntry.index, startRow: chunkEntry.startRow, endRow: chunkEntry.endRow, summary: chunkSummary });
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
      }
    }
  }

  return {
    ok: true,
    plan: { headerRecord, chunkTotal: chunkEntries.length, chunks: planChunks, sourceSha256 },
    preview: { summary, perChunk, errorRows },
  };
}

export type ConfirmChunkedSessionParams = {
  plan: ChunkedPlanState;
  /** Prior chunkUpload state, if this is a retry — any chunk already
   * "confirmed" is skipped, never re-sent. */
  initialUpload: ChunkUploadState[];
  existingSessionId: string | null;
  fileLabel: string;
  timestampsRef: { current: number[] };
  /** Inline row-fix overrides, keyed by the GLOBAL row number shown in
   * the aggregated chunked preview — localizeRowOverrides translates
   * each chunk's own slice into the LOCAL row numbers that chunk's own
   * re-upload of buildImportPreview will assign. */
  rowOverrides?: RowOverrides;
  onSessionId: (sessionId: string) => void;
  onProgress: (upload: ChunkUploadState[]) => void;
};

/** Translates the operator's overrides (keyed by the GLOBAL row number
 * the aggregated chunked preview shows) into the LOCAL row numbers one
 * chunk's own re-upload will assign — a chunk is re-parsed from scratch
 * server-side (buildImportPreview), so row 1 of that upload is always
 * the chunk's own first data row, never the original file's. */
export function localizeRowOverrides(
  globalOverrides: RowOverrides,
  chunk: { startRow: number; endRow: number },
): Record<string, Partial<Record<string, string>>> {
  const local: Record<string, Partial<Record<string, string>>> = {};
  for (const [key, fields] of Object.entries(globalOverrides)) {
    const globalRowNumber = Number(key);
    if (globalRowNumber < chunk.startRow || globalRowNumber > chunk.endRow) continue;
    local[String(globalRowNumber - chunk.startRow + 1)] = fields;
  }
  return local;
}

export type ConfirmChunkedSessionResult =
  | { ok: true }
  /** conflictingSessionId is set when a chunk's content already belongs to
   * a DIFFERENT, unfinished session — the caller's job is to resume that
   * session, never to adopt the batch into the one being uploaded here. */
  | { ok: false; error: string; conflictingSessionId?: string };

/** Sequential, session-scoped chunk upload driver: creates the session (if
 * needed), then POSTs each chunk to /api/import/batches in order, pacing
 * itself under the server's rate limit. Never parallel. Safe to call again
 * after a failure with the same `plan` and the returned chunkUpload state
 * as `initialUpload` — already-confirmed chunks are skipped. */
export async function confirmChunkedSession(params: ConfirmChunkedSessionParams): Promise<ConfirmChunkedSessionResult> {
  const { plan, initialUpload, existingSessionId, fileLabel, timestampsRef, rowOverrides, onSessionId, onProgress } = params;
  let results = initialUpload;
  onProgress(results);

  let activeSessionId = existingSessionId;
  if (!activeSessionId) {
    try {
      const sessionResponse = await fetch("/api/import/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: fileLabel, sourceSha256: plan.sourceSha256, declaredChunkTotal: plan.chunkTotal }),
      });
      const sessionBody = await sessionResponse.json();
      if (!sessionResponse.ok) {
        return { ok: false, error: sessionBody?.error?.message ?? "Could not start the import session." };
      }
      activeSessionId = sessionBody.sessionId as string;
    } catch {
      return { ok: false, error: "Could not start the import session. Check your connection and try again." };
    }
  }
  onSessionId(activeSessionId);
  writeStoredSession({ sessionId: activeSessionId, sourceSha256: plan.sourceSha256, label: fileLabel });

  for (const chunk of plan.chunks) {
    const current = results.find((c) => c.index === chunk.index);
    // Round-5 audit finding 4: a "skipped" chunk is a deliberate, permanent
    // client-side terminal state — never re-attempted, exactly like a
    // "confirmed" one.
    if (current?.status === "confirmed" || current?.status === "skipped") continue;

    const now = Date.now();
    timestampsRef.current = timestampsRef.current.filter((t) => now - t < CONFIRM_RATE_WINDOW_MS);
    if (timestampsRef.current.length >= CONFIRM_RATE_LIMIT_MARGIN) {
      results = results.map((c) => (c.index === chunk.index ? { ...c, status: "waiting" } : c));
      onProgress(results);
      const waitMs = CONFIRM_RATE_WINDOW_MS - (now - timestampsRef.current[0]) + 250;
      await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
    }

    results = results.map((c) => (c.index === chunk.index ? { ...c, status: "uploading" } : c));
    onProgress(results);
    timestampsRef.current.push(Date.now());

    const form = new FormData();
    const chunkFile = new File([chunk.text], `${fileLabel.replace(/\.csv$/i, "")}.part${chunk.index}.csv`, { type: "text/csv" });
    form.append("file", chunkFile);
    form.append("sessionId", activeSessionId);
    form.append("chunkIndex", String(chunk.index));
    form.append("chunkTotal", String(plan.chunkTotal));
    form.append("sourceSha256", plan.sourceSha256);
    // Round-5 audit finding 3: this chunk's own override slice, keyed by
    // the GLOBAL row numbers PreviewStep shows — captured here (before
    // localizing to this chunk's own local row numbers for the request
    // body) so a duplicate_chunk_content failure below can snapshot
    // EXACTLY what was sent, for the "did the fix actually change" gate.
    const chunkGlobalOverridesSlice: RowOverrides = {};
    if (rowOverrides) {
      for (const [key, fields] of Object.entries(rowOverrides)) {
        const globalRowNumber = Number(key);
        if (globalRowNumber >= chunk.startRow && globalRowNumber <= chunk.endRow) {
          chunkGlobalOverridesSlice[globalRowNumber] = fields;
        }
      }
      const localOverrides = localizeRowOverrides(rowOverrides, chunk);
      if (Object.keys(localOverrides).length > 0) form.append("rowOverrides", JSON.stringify(localOverrides));
    }

    try {
      const response = await fetch("/api/import/batches", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) {
        const code: string | null = body?.error?.code ?? null;
        const message: string = body?.error?.message ?? "Upload failed.";
        results = results.map((c) => (c.index === chunk.index ? { ...c, status: "failed", error: message, code } : c));
        onProgress(results);
        // Sol round-2 audit (2026-08-27) finding 3: chunk_content_mismatch is
        // TERMINAL — retrying re-sends this exact chunk's content and
        // digest, so it fails the exact same way every time. The server's
        // own message already explains the revert path; the generic
        // "you can retry it below" wording is actively wrong for this one
        // code, so it's used only for every other (genuinely retryable)
        // failure.
        return {
          ok: false,
          error:
            code === "chunk_content_mismatch"
              ? message
              : `Chunk ${chunk.index} of ${plan.chunkTotal} failed to upload — you can retry it below.`,
        };
      }
      // 200 (alreadyExists) can point at a batch that belongs to a
      // DIFFERENT session than the one being uploaded here — this file's
      // upload was interrupted earlier and started fresh, and this chunk's
      // content collided by hash with the OLD session's chunk. Adopting it
      // into this new session would split one file across two incomplete
      // sessions; stop and hand the original session back to the caller.
      //
      // Sol round-3 audit (2026-08-27) finding 3: a same-session match
      // whose chunk_index does NOT equal the slot being confirmed right
      // now is a SIBLING chunk carrying identical bytes (e.g. a duplicated
      // export segment) — never this chunk's own confirmation. Requiring
      // BOTH sessionId AND chunkIndex to match before treating the
      // response as "this chunk is done" closes the gap where such a
      // sibling match would otherwise mark this slot "confirmed" while no
      // batch actually claims it, silently dropping this chunk's rows.
      if (body.alreadyExists && (body.sessionId !== activeSessionId || body.chunkIndex !== chunk.index)) {
        const sameSession = body.sessionId === activeSessionId;
        // Round-4 audit finding 2: the sameSession branch used to be a
        // dead end — marked "failed" with code null, so PreviewStep
        // offered "Retry upload," which deterministically re-hits the
        // exact same (restaurant_id, content_sha256) unique index and
        // fails the same way every time (migrations are locked — the DB
        // genuinely cannot hold two live batches with identical content
        // for this restaurant), while the conflicting sibling batch sits
        // at status 'created' — not eligible for the "completed"-only
        // batch-revert action, and the session isn't revertable either
        // until its rows settle. There was no way forward.
        //
        // The fix uses the existing overrides mechanism, which already
        // provides exactly the distinguishing signal this needs: ANY
        // rowOverride on this chunk namespaces its content_sha256
        // (confirmImportBatch's own overrides-v1:<h(overrides)>:<h(file)>
        // format), so it no longer collides with the sibling's bare-file
        // digest. Tagged with a distinct TERMINAL code — duplicate_chunk_
        // content — so PreviewStep never offers a "Retry upload" that
        // would just fail identically again, and the guidance below tells
        // the operator the actual way forward: edit a row so its fix
        // actually DIFFERS from the sibling's, or leave it alone (or skip
        // it — PreviewStep's own "Skip this chunk" control) if the
        // duplication was accidental. This chunk's rows are NOT locked by
        // this — isRowInConfirmedChunk only locks rows belonging to a
        // chunk whose status is 'confirmed', and this one is 'failed' —
        // so the operator can act on that guidance immediately, and a
        // subsequent confirm carrying a genuinely DIFFERENT override
        // reaches the create path normally (the same-session exclusion in
        // findLiveBatchByUnderlyingFile already keeps this sibling from
        // short-circuiting that retry as a false duplicate).
        //
        // Round-5 audit finding 3: the guidance used to say "edit any row
        // below (even re-entering the same value)" — that is actively
        // WRONG: re-entering the identical text produces the identical
        // canonical overrides JSON, hence the identical namespaced digest,
        // hence the identical collision, forever. Named explicitly below:
        // the fix must DIFFER from the sibling's own value for that row.
        const conflictError = !body.sessionId
          ? `Chunk ${chunk.index} was already imported as a standalone batch. Revert that batch under ` +
            "Recent imports before re-uploading this file."
          : sameSession
            ? `Chunk ${chunk.index}'s content is identical to chunk ${body.chunkIndex}, already imported in this ` +
              `session — the database can't hold two imports with identical content, so this can't be resolved by ` +
              "retrying unchanged. If this is a genuine repeated segment that needs to import again, edit a row " +
              `below so its fix actually DIFFERS from chunk ${body.chunkIndex}'s own value for that row — ` +
              "re-entering the identical text won't change anything — then confirm again. If it was an accidental " +
              `duplicate, no action is needed, or skip this chunk below — chunk ${body.chunkIndex} already imported ` +
              "these rows."
            : "This file was already partially uploaded as a different, unfinished import — resuming that import " +
              "instead of starting a second one.";
        const conflictCode = sameSession ? "duplicate_chunk_content" : null;
        results = results.map((c) =>
          c.index === chunk.index
            ? {
                ...c,
                status: "failed",
                error: conflictError,
                code: conflictCode,
                // Round-5 audit finding 3: only meaningful (and only ever
                // read) for duplicate_chunk_content — the exact override
                // slice this failed attempt sent, for the "did it actually
                // change" gate PreviewStep computes on retry.
                sentOverridesSnapshot: conflictCode === "duplicate_chunk_content" ? chunkGlobalOverridesSlice : c.sentOverridesSnapshot,
                duplicateOfChunkIndex: conflictCode === "duplicate_chunk_content" ? (body.chunkIndex as number) : c.duplicateOfChunkIndex,
              }
            : c,
        );
        onProgress(results);
        // sessionId null = the identical bytes were confirmed earlier as a
        // STANDALONE (sessionless) batch. There is no session to resume and
        // adopting the batch here would strand it outside this session.
        if (!body.sessionId) {
          return { ok: false, error: conflictError };
        }
        // Same session but the WRONG chunk slot — there is no "other
        // session" to resume, this is a hard stop the operator must
        // resolve directly, never a conflictingSessionId redirect.
        if (sameSession) {
          return { ok: false, error: conflictError };
        }
        return { ok: false, error: conflictError, conflictingSessionId: body.sessionId as string };
      }

      // 201 (new), or 200 (alreadyExists: THIS exact chunk slot, in THIS
      // session, was already confirmed) — either way this chunk is now
      // live server-side.
      results = results.map((c) =>
        c.index === chunk.index ? { ...c, status: "confirmed", batchId: body.batchId as string, error: null, code: null } : c,
      );
      onProgress(results);
    } catch {
      results = results.map((c) =>
        c.index === chunk.index ? { ...c, status: "failed", error: "Network error.", code: null } : c,
      );
      onProgress(results);
      return {
        ok: false,
        error: `Chunk ${chunk.index} of ${plan.chunkTotal} failed to upload — check your connection and retry.`,
      };
    }
  }

  return { ok: true };
}

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
 * it does not create, delete, or touch anything server-side. */
export function ChunkUploadProgress({
  chunks,
  chunkTotal,
  onSkipChunk,
}: {
  chunks: ChunkUploadState[];
  chunkTotal: number;
  onSkipChunk?: (index: number) => void;
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
            className="flex items-center justify-between gap-sm rounded-md bg-bridge-surface px-sm py-xs text-[13px] text-ink"
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
              {c.status === "failed" && c.code === "duplicate_chunk_content" && onSkipChunk && (
                <button
                  type="button"
                  onClick={() => onSkipChunk(c.index)}
                  className="min-h-11 rounded-pill border border-ink/25 bg-surface px-sm py-2xs text-caption font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
                >
                  Skip this chunk
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-caption text-grey">{label}</dt>
      <dd className="tabular text-[20px] font-medium text-ink">{value}</dd>
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
    <span className="inline-flex items-center gap-2xs rounded-pill bg-bridge-surface px-sm py-2xs text-caption font-medium text-ink">
      {status === "completed" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
      {label[status] ?? status}
    </span>
  );
}

type SessionChunkProgress = {
  batchId: string;
  chunkIndex: number | null;
  status: string;
  counts: { total: number; applied: number; excluded: number; pending: number; eligibleNotApplied: number };
};

type SessionProgress = {
  sessionId: string;
  status: string;
  declaredChunkTotal: number | null;
  chunks: SessionChunkProgress[];
  totals: SessionChunkProgress["counts"];
  allChunksPresent: boolean | null;
  allApplied: boolean;
};

/** Round-5 audit finding 4: one client-side-skipped chunk, for
 * SessionStep's own honest summary line. Sourced from ImportClient's
 * chunkUpload state (the server has no record of a skip at all — this is
 * never persisted, so it does not survive a page reload). */
export type SkippedChunkSummary = { index: number; duplicateOfChunkIndex: number | undefined };

export function SessionStep({
  sessionId,
  label,
  skippedChunks,
  onDone,
}: {
  sessionId: string;
  label: string;
  /** See SkippedChunkSummary. Omitted (or empty) renders nothing extra. */
  skippedChunks?: SkippedChunkSummary[];
  onDone: () => void;
}) {
  const [progress, setProgress] = useState<SessionProgress | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingRows, setPendingRows] = useState<Record<string, BatchRow[]>>({});
  const [applying, setApplying] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertDialogOpen, setRevertDialogOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [manualCostDrafts, setManualCostDrafts] = useState<Record<string, string>>({});

  // Never throws — a network/JSON failure here is common (this also runs
  // inside applyAllChunks' outer `finally`, where a throw would strand
  // `applying` permanently true) and instead surfaces as loadError with a
  // retry, distinct from the terminal "session not found" state.
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/import/sessions/${sessionId}`, { cache: "no-store" });
      if (!response.ok) {
        setNotFound(true);
        return;
      }
      setProgress(await response.json());
      setLoadError(null);
    } catch {
      setLoadError("Could not load this import session. Check your connection and try again.");
    }
  }, [sessionId]);

  useEffect(() => {
    // Deferred a tick so the initial fetch's state updates never run
    // synchronously inside the effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(refresh);
  }, [refresh]);

  // Pending-row resolution, sourced across every chunk that has one —
  // tagged with its own chunkIndex so the operator knows which upload it
  // came from (P3 §3.3, this lane's brief §6).
  const pendingKey = progress
    ? progress.chunks
        .filter((c) => c.counts.pending > 0)
        .map((c) => `${c.batchId}:${c.counts.pending}`)
        .join(",")
    : "";

  useEffect(() => {
    if (!progress) return;
    let active = true;
    const idsWithPending = progress.chunks.filter((c) => c.counts.pending > 0).map((c) => c.batchId);
    if (idsWithPending.length === 0) {
      // Deferred a tick: no synchronous setState inside the effect body.
      void Promise.resolve().then(() => {
        if (active) setPendingRows({});
      });
      return () => {
        active = false;
      };
    }
    Promise.all(
      idsWithPending.map(async (batchId) => {
        const response = await fetch(`/api/import/batches/${batchId}`, { cache: "no-store" });
        if (!response.ok) return [batchId, []] as const;
        const detail = (await response.json()) as { rows: BatchRow[] };
        return [batchId, detail.rows.filter((r) => r.resolution === "pending")] as const;
      }),
    )
      .then((entries) => {
        if (active) setPendingRows(Object.fromEntries(entries));
      })
      .catch(() => {
        // best-effort — pending rows still show once a later refresh succeeds.
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const applyAllChunks = useCallback(async () => {
    if (!progress) return;
    setApplying(true);
    setActionError(null);
    try {
      for (const chunk of progress.chunks) {
        let done = chunk.counts.eligibleNotApplied === 0;
        let guard = 0;
        while (!done && guard < 200) {
          guard += 1;
          const response = await fetch(`/api/import/batches/${chunk.batchId}/apply`, { method: "POST" });
          const body = await response.json();
          if (!response.ok) {
            setActionError(body?.error?.message ?? `Apply failed on chunk ${chunk.chunkIndex ?? chunk.batchId}.`);
            return;
          }
          done = body.done;
        }
      }
    } catch {
      setActionError("Apply failed. Your progress so far is saved — try again.");
    } finally {
      await refresh();
      setApplying(false);
    }
  }, [progress, refresh]);

  const resolveRow = useCallback(
    async (batchId: string, rowId: string, action: "include" | "exclude", manualUnitCost?: number) => {
      setActionError(null);
      try {
        const response = await fetch(`/api/import/batches/${batchId}/rows/${rowId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, manualUnitCost }),
        });
        const body = await response.json();
        if (!response.ok) {
          setActionError(body?.error?.message ?? "Could not resolve row.");
          return;
        }
        await refresh();
      } catch {
        setActionError("Could not resolve row. Check your connection and try again.");
      }
    },
    [refresh],
  );

  // Bulk resolution across every chunk with pending rows — one
  // POST /resolve-all per chunk, sequential like every other loop here.
  // `include` only ever covers cost-present rows server-side; missing-cost
  // rows stay pending and keep their per-row manual-cost path below.
  const [bulkResolving, setBulkResolving] = useState(false);
  const bulkResolve = useCallback(
    async (action: "include" | "exclude") => {
      if (!progress) return;
      setBulkResolving(true);
      setActionError(null);
      try {
        for (const chunk of progress.chunks) {
          if (chunk.counts.pending === 0) continue;
          const response = await fetch(`/api/import/batches/${chunk.batchId}/resolve-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as
              | { error?: { message?: string } }
              | null;
            setActionError(body?.error?.message ?? "Could not bulk-resolve rows.");
            return;
          }
        }
        await refresh();
      } catch {
        setActionError("Could not bulk-resolve rows. Check your connection and try again.");
      } finally {
        setBulkResolving(false);
      }
    },
    [progress, refresh],
  );

  const doRevert = useCallback(async () => {
    setReverting(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/import/sessions/${sessionId}/revert`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setActionError(body?.error?.message ?? "Revert failed.");
        return;
      }
      setRevertDialogOpen(false);
      onDone();
    } catch {
      setActionError("Revert failed. Check your connection and try again.");
    } finally {
      setReverting(false);
    }
  }, [sessionId, onDone]);

  if (notFound) {
    return (
      <div className="rounded-card card-surface p-lg">
        <p className="text-[14px] text-ink">This import session could not be found.</p>
        <button
          type="button"
          onClick={onDone}
          className="mt-md min-h-11 rounded-pill px-lg text-[14px] font-medium text-ink-muted underline underline-offset-4 hover:text-ink"
        >
          Start a new import
        </button>
      </div>
    );
  }

  if (!progress && loadError) {
    return (
      <div className="rounded-card card-surface p-lg">
        <p role="alert" className="flex items-start gap-xs text-[14px] text-accent">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {loadError}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-md min-h-11 rounded-pill bg-primary px-lg text-[14px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!progress) {
    return (
      <div className="flex min-h-11 items-center justify-center gap-xs rounded-card card-surface p-lg text-[14px] text-grey">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading session…
      </div>
    );
  }

  const allPendingRows = Object.entries(pendingRows).flatMap(([batchId, rows]) => {
    const chunkIndex = progress.chunks.find((c) => c.batchId === batchId)?.chunkIndex ?? null;
    return rows.map((row) => ({ batchId, chunkIndex, row }));
  });

  return (
    <div className="rounded-card card-surface p-lg">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-[20px] text-ink">{label}</h2>
        <span className="inline-flex items-center gap-2xs rounded-pill bg-bridge-surface px-sm py-2xs text-caption font-medium text-ink">
          {progress.status === "completed" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
          {progress.status === "in_progress" ? "In progress" : progress.status === "completed" ? "Completed" : "Reverted"}
        </span>
      </div>

      <dl className="mt-md grid grid-cols-2 gap-sm text-[13px]">
        <MiniStat label="Total rows" value={progress.totals.total} />
        <MiniStat label="Applied" value={progress.totals.applied} />
        <MiniStat label="Needs resolution" value={progress.totals.pending} />
        <MiniStat label="Ready, not yet applied" value={progress.totals.eligibleNotApplied} />
      </dl>

      <div className="mt-lg">
        <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
          Chunks ({progress.chunks.length}
          {progress.declaredChunkTotal ? ` of ${progress.declaredChunkTotal}` : ""})
        </h3>
        <ul className="mt-xs space-y-2xs">
          {progress.chunks.map((chunk) => (
            <li
              key={chunk.batchId}
              className="flex items-center justify-between rounded-md bg-bridge-surface px-sm py-xs text-[13px] text-ink"
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
            empty (and this block renders nothing) after a page reload. */}
        {skippedChunks && skippedChunks.length > 0 && (
          <p className="mt-xs text-caption text-grey">
            {skippedChunks
              .map((s) =>
                s.duplicateOfChunkIndex !== undefined
                  ? `Chunk ${s.index} skipped — byte-identical to chunk ${s.duplicateOfChunkIndex}, whose rows are already imported.`
                  : `Chunk ${s.index} skipped.`,
              )
              .join(" ")}
          </p>
        )}
      </div>

      {actionError && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-accent">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {actionError}
        </p>
      )}

      {progress.totals.pending > 1 && progress.status !== "reverted" && (
        <div className="mt-lg rounded-lg bg-bridge-surface px-md py-sm">
          <p className="text-[13px] text-ink">
            {progress.totals.pending.toLocaleString()} rows need a decision — most are simply
            wines outside the LWIN catalog.
          </p>
          <div className="mt-sm flex flex-wrap items-center gap-sm">
            <button
              type="button"
              disabled={bulkResolving}
              onClick={() => void bulkResolve("include")}
              className="flex min-h-11 items-center justify-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {bulkResolving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Include all with a cost
            </button>
            <button
              type="button"
              disabled={bulkResolving}
              onClick={() => void bulkResolve("exclude")}
              className="min-h-11 rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Exclude all pending
            </button>
          </div>
          <p className="mt-xs text-caption text-grey">
            Rows missing a unit cost are never bulk-included — they stay listed below for an
            explicit cost.
          </p>
        </div>
      )}

      {allPendingRows.length > 0 && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Needs your decision ({allPendingRows.length})
          </h3>
          <ul className="mt-xs space-y-sm">
            {allPendingRows.map(({ batchId, chunkIndex, row }) => (
              <li key={row.id} className="rounded-lg card-surface p-sm">
                <p className="text-[14px] text-ink">
                  Chunk {chunkIndex ?? "—"}, row {row.row_number}: {row.raw.producer ? `${row.raw.producer} — ` : ""}{row.raw.name}
                </p>
                <p className="mt-2xs text-caption text-grey">
                  {row.lwin_status === "unmatched" ? "No LWIN catalog match. " : ""}
                  {row.cost_status === "missing" ? "No unit cost provided." : ""}
                </p>
                <div className="mt-sm flex flex-wrap items-center gap-sm">
                  {row.cost_status === "missing" && (
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Unit cost"
                      value={manualCostDrafts[row.id] ?? ""}
                      onChange={(e) => setManualCostDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                      className="min-h-11 w-28 rounded-pill border border-hairline bg-surface px-sm text-[14px] focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const draft = manualCostDrafts[row.id];
                      const manualUnitCost = row.cost_status === "missing" && draft ? Number(draft) : undefined;
                      void resolveRow(batchId, row.id, "include", manualUnitCost);
                    }}
                    disabled={row.cost_status === "missing" && !manualCostDrafts[row.id]}
                    className="min-h-11 rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Include anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveRow(batchId, row.id, "exclude")}
                    className="min-h-11 rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
                  >
                    Exclude
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-lg flex flex-col gap-sm">
        {progress.totals.eligibleNotApplied > 0 && (
          <button
            type="button"
            disabled={applying}
            onClick={() => void applyAllChunks()}
            className="flex min-h-11 items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {applying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {applying
              ? `Applying… (${progress.totals.applied} of ${progress.totals.total})`
              : `Apply ${progress.totals.eligibleNotApplied} row(s)`}
          </button>
        )}

        {(progress.allApplied || progress.totals.applied > 0) && progress.status !== "reverted" && (
          <button
            type="button"
            onClick={() => setRevertDialogOpen(true)}
            className="flex min-h-11 items-center justify-center gap-xs rounded-pill border border-ink/25 bg-surface px-lg text-[14px] font-medium text-ink transition-colors hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Revert this import
          </button>
        )}

        <button
          type="button"
          onClick={onDone}
          className="min-h-11 rounded-pill px-lg text-[14px] font-medium text-ink-muted underline underline-offset-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
        >
          Start a new import
        </button>
      </div>

      <ActionDialog
        open={revertDialogOpen}
        title="Revert this import?"
        description={`This removes exactly the ${progress.totals.applied} inventory row(s) this session created, across every chunk. Nothing else in your cellar is touched.`}
        confirmLabel="Revert import"
        busy={reverting}
        onConfirm={() => void doRevert()}
        onClose={() => setRevertDialogOpen(false)}
      />
    </div>
  );
}
