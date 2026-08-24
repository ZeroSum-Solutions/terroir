-- 0103_import_batches_session_columns.sql
--
-- P3 §2.2/§3.2 — two independent, additive things on import_batches, both
-- nullable so a plain, non-chunked, single-file upload (the common case
-- for a small restaurant's routine CSV) remains completely valid with none
-- of these set:
--
--   1. content_sha256 (§2.2, re-upload idempotency): sha256 of the raw
--      uploaded Buffer, computed server-side BEFORE decodeCsvBuffer() ever
--      runs (never over decoded text — see create_import_batch, 0107, and
--      confirmImportBatch for why: a lossy UTF-8 decode could make two
--      byte-for-byte-different uploads collide, or the same file hash
--      differently across two decode passes). The partial unique index
--      below rejects re-confirming byte-identical content for the same
--      restaurant while the original batch is still live; a reverted
--      batch's hash is freed (`status <> 'reverted'`) so a legitimate
--      re-run after revert is never blocked.
--
--   2. session_id/chunk_index/chunk_total (§3.2, multi-batch session
--      grouping): links a batch to the import_sessions row (0102) it's
--      one chunk of. session_id is a plain nullable FK, not a composite
--      tenant-locking FK like import_batch_rows_batch_restaurant_fkey
--      (0082/C17) — create_import_batch (0107) validates the session's
--      restaurant_id against the caller's own restaurant_id explicitly
--      (RLS makes a foreign session simply invisible, the same fail-closed
--      idiom 0076 established), so a DB-level composite FK isn't needed
--      for the tenant boundary here, and would be actively wrong: ON
--      DELETE SET NULL on a composite (session_id, restaurant_id) FK would
--      try to null restaurant_id too, which is NOT NULL on this table.
--
--      The second partial unique index (session_id, chunk_index) enforces
--      "no two non-reverted batches in one session claim the same chunk
--      slot" as a hard schema invariant, not just an app-level check —
--      reverting a batch (C-new-1, 0109) frees its chunk_index for a
--      genuine corrective re-upload, mirroring content_sha256's own
--      status <> 'reverted' escape hatch exactly.
--
-- DOWN: drops both partial indexes and all four columns. Any batch rows
-- that carried a session_id lose that association (session_id existing
-- only as a nullable FK on this table, dropping the column is the correct
-- and only way to remove it — there is no data to "restore" a prior state
-- of, this is new columns added, not a body replaced).

alter table public.import_batches
  add column session_id      uuid references public.import_sessions(id) on delete set null,
  add column chunk_index     integer check (chunk_index is null or chunk_index > 0),
  add column chunk_total     integer check (chunk_total is null or chunk_total > 0),
  add column content_sha256  text;

comment on column public.import_batches.content_sha256 is
  'sha256 of the raw uploaded file bytes, computed server-side before any '
  'decode. Backs the partial unique index below (re-upload idempotency, '
  'P3 §2.2) — nullable because historic pre-P3 rows never computed one.';

comment on column public.import_batches.session_id is
  'Which multi-chunk onboarding session (import_sessions, 0102) this batch '
  'is one chunk of. Null for a plain, non-chunked single-file upload.';

-- §2.2: hard-reject re-confirming byte-identical content for the same
-- restaurant while the original batch is still live. Partial so historic
-- rows with content_sha256 = null never collide, and a reverted batch's
-- hash is freed for a legitimate re-run.
create unique index import_batches_content_sha256_idx
  on public.import_batches (restaurant_id, content_sha256)
  where content_sha256 is not null and status <> 'reverted';

-- §3.2: no two live (non-reverted) batches in one session can claim the
-- same chunk slot. Reverting a batch (0109) frees its chunk_index for a
-- genuine corrective re-upload of that chunk.
create unique index import_batches_session_chunk_idx
  on public.import_batches (session_id, chunk_index)
  where session_id is not null and chunk_index is not null and status <> 'reverted';

-- Supports create_import_batch's (0107) tier-2(b) cross-batch dedup check
-- (§1.5/§3.3), which joins import_batches to import_batch_rows by
-- session_id to find not-yet-applied sibling-batch rows.
create index import_batches_session_idx
  on public.import_batches (session_id)
  where session_id is not null;
