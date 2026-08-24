-- Reverse of 0103_import_batches_session_columns.sql
--
-- Must run before down/0102 (import_sessions table drop) — session_id's
-- FK target must still exist while this column is dropped, though in
-- practice `alter table ... drop column` doesn't require the FK target to
-- exist at all (dropping a column removes its constraints with it), so
-- ordering here is a belt-and-suspenders convention, not a hard
-- requirement.

drop index if exists public.import_batches_session_idx;
drop index if exists public.import_batches_session_chunk_idx;
drop index if exists public.import_batches_content_sha256_idx;

alter table public.import_batches
  drop column if exists content_sha256,
  drop column if exists chunk_total,
  drop column if exists chunk_index,
  drop column if exists session_id;
