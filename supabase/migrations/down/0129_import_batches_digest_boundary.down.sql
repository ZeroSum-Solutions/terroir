-- Reverses 0129. Adds and removes no data, so it cannot fail on existing rows.
drop trigger if exists import_batch_rows_require_lockable_parent on public.import_batch_rows;
drop function if exists public.import_batch_rows_require_lockable_parent();
drop trigger if exists import_batches_guard_digest on public.import_batches;
drop function if exists public.import_batches_guard_digest();
