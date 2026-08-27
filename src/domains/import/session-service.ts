// P3 (2026-08-23-p3-chunked-import.md §3) — multi-batch onboarding session
// lifecycle: create, aggregate progress across child batches, revert as a
// unit. Mirrors batch-service.ts's own conventions (session-scoped
// supabase client, explicit restaurantId filters alongside — never
// instead of — RLS).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { BatchCounts } from "./batch-service";

export type CreateSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: { code: string; message: string } };

/**
 * Create a new import session (§3.1). A plain INSERT is sufficient here —
 * unlike create_import_batch (0107), there is no multi-row/atomicity
 * concern: one session row, no child rows to insert alongside it.
 */
export async function createImportSession(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  userId: string,
  options: { label?: string; sourceSha256?: string; declaredChunkTotal?: number } = {},
): Promise<CreateSessionResult> {
  const { data, error } = await supabase
    .from("import_sessions")
    .insert({
      restaurant_id: restaurantId,
      created_by: userId,
      label: options.label ?? null,
      source_sha256: options.sourceSha256 ?? null,
      declared_chunk_total: options.declaredChunkTotal ?? null,
    } as never)
    .select("id")
    .single();

  if (error || !data) {
    throw error ?? new Error("import_sessions insert returned no row and no error.");
  }
  return { ok: true, sessionId: (data as { id: string }).id };
}

export type SessionChunkProgress = {
  batchId: string;
  chunkIndex: number | null;
  status: string;
  counts: BatchCounts;
};

export type SessionProgress = {
  sessionId: string;
  status: string;
  declaredChunkTotal: number | null;
  /** The source file hash the session was created with (null for legacy
   * sessions) — lets a client verify an adopted/resumed session actually
   * belongs to the file it is holding. */
  sourceSha256: string | null;
  chunks: SessionChunkProgress[];
  totals: BatchCounts;
  /** Every declared chunk_index 1..declaredChunkTotal has at least one
   * non-reverted batch — informational only (§3.1: never a hard gate, a
   * 6th corrective chunk must still be addable). Null when
   * declaredChunkTotal isn't set (nothing to check against). */
  allChunksPresent: boolean | null;
  /** Every batch's counts show zero eligibleNotApplied and zero pending —
   * i.e. every child batch is at status 'completed' (or has nothing left
   * to apply). */
  allApplied: boolean;
};

/**
 * P3 §3.3: aggregates every child batch's count_import_batch_rows (0106)
 * result into one session-level payload — total rows, per-chunk status,
 * and the two derived flags a progress UI needs. Deliberately a plain
 * per-batch loop calling the SAME count_import_batch_rows RPC batch-
 * service.ts's own recomputeBatchStatus uses (never a raw uncapped
 * .select() — that's exactly C03's mistake, and it would be just as wrong
 * here as it was for a single batch).
 */
export async function getImportSessionProgress(
  supabase: SupabaseClient<Database>,
  sessionId: string,
): Promise<SessionProgress | null> {
  const { data: session, error: sessionError } = await supabase
    .from("import_sessions")
    .select("id, status, declared_chunk_total, source_sha256")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return null;

  const { data: batches, error: batchesError } = await supabase
    .from("import_batches")
    .select("id, chunk_index, status")
    .eq("session_id", sessionId)
    .order("chunk_index", { ascending: true });
  if (batchesError) throw batchesError;

  const chunkRows = (batches ?? []) as Array<{ id: string; chunk_index: number | null; status: string }>;

  const chunks: SessionChunkProgress[] = [];
  for (const batch of chunkRows) {
    const { data: countData, error: countError } = await supabase.rpc("count_import_batch_rows", {
      p_batch_id: batch.id,
    } as never);
    if (countError) throw countError;
    const row = (Array.isArray(countData) ? countData[0] : countData) as
      | { total: number; applied: number; excluded: number; pending: number; eligible_not_applied: number }
      | undefined;
    chunks.push({
      batchId: batch.id,
      chunkIndex: batch.chunk_index,
      status: batch.status,
      counts: {
        total: row?.total ?? 0,
        applied: row?.applied ?? 0,
        excluded: row?.excluded ?? 0,
        pending: row?.pending ?? 0,
        eligibleNotApplied: row?.eligible_not_applied ?? 0,
      },
    });
  }

  const totals = chunks.reduce<BatchCounts>(
    (sum, chunk) => ({
      total: sum.total + chunk.counts.total,
      applied: sum.applied + chunk.counts.applied,
      excluded: sum.excluded + chunk.counts.excluded,
      pending: sum.pending + chunk.counts.pending,
      eligibleNotApplied: sum.eligibleNotApplied + chunk.counts.eligibleNotApplied,
    }),
    { total: 0, applied: 0, excluded: 0, pending: 0, eligibleNotApplied: 0 },
  );

  const sessionRow = session as {
    id: string;
    status: string;
    declared_chunk_total: number | null;
    source_sha256: string | null;
  };

  let allChunksPresent: boolean | null = null;
  if (sessionRow.declared_chunk_total !== null) {
    const presentIndices = new Set(
      chunks.filter((c) => c.status !== "reverted").map((c) => c.chunkIndex).filter((i): i is number => i !== null),
    );
    allChunksPresent = true;
    for (let i = 1; i <= sessionRow.declared_chunk_total; i++) {
      if (!presentIndices.has(i)) {
        allChunksPresent = false;
        break;
      }
    }
  }

  const allApplied = chunks.every((c) => c.counts.eligibleNotApplied === 0 && c.counts.pending === 0);

  // Nothing ever promotes import_sessions.status out of its default
  // 'in_progress' — only revert_import_session (0110) writes a session
  // status, and only to 'reverted'. Derive 'completed' here instead of
  // writing it: every expected chunk has arrived and every child batch is
  // fully settled. Purely a reporting derivation — never overrides a
  // 'reverted' session, and chunks.length === 0 (no batches yet) never
  // reports 'completed' even though `.every()` on an empty array is
  // vacuously true.
  const status =
    sessionRow.status === "in_progress" && chunks.length > 0 && allChunksPresent !== false && allApplied
      ? "completed"
      : sessionRow.status;

  return {
    sessionId: sessionRow.id,
    status,
    declaredChunkTotal: sessionRow.declared_chunk_total,
    sourceSha256: sessionRow.source_sha256,
    chunks,
    totals,
    allChunksPresent,
    allApplied,
  };
}

export type RevertSessionBatchResult =
  | { batchId: string; chunkIndex: number | null; skipped: false; revertedCount: number }
  | { batchId: string; chunkIndex: number | null; skipped: true; reason: string };

export type RevertSessionResult =
  | { ok: true; sessionId: string; batches: RevertSessionBatchResult[] }
  | { ok: false; error: { code: string; message: string } };

/** P3 §3.4: reverts every non-reverted batch in a session, in reverse
 * chunk order, via the revert_import_session RPC (0110). */
export async function revertImportSession(
  supabase: SupabaseClient<Database>,
  sessionId: string,
): Promise<RevertSessionResult> {
  const { data, error } = await supabase.rpc("revert_import_session", {
    p_session_id: sessionId,
  } as never);

  if (error) {
    const pgError = error as { code?: string; message?: string };
    if (pgError.code === "P0002") {
      return { ok: false, error: { code: "not_found", message: "Import session not found." } };
    }
    throw error;
  }

  const result = data as { sessionId: string; batches: Array<Record<string, unknown>> };
  const batches: RevertSessionBatchResult[] = result.batches.map((b) => {
    const batchId = b.batchId as string;
    const chunkIndex = (b.chunkIndex as number | null) ?? null;
    if (b.skipped) {
      return { batchId, chunkIndex, skipped: true, reason: b.reason as string };
    }
    return { batchId, chunkIndex, skipped: false, revertedCount: b.revertedCount as number };
  });

  return { ok: true, sessionId: result.sessionId, batches };
}
