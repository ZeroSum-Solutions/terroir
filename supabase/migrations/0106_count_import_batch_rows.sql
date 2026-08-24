-- 0106_count_import_batch_rows.sql
--
-- P3 §5 (C03) — countBatchRows (src/domains/import/batch-service.ts) did
-- `.select("apply_status, resolution").eq("batch_id", batchId)` with no
-- pagination. PostgREST's default max_rows (1000, supabase/config.toml)
-- silently truncates any response past that — verified reproduction
-- (V2-import.md): 1,500 rows, apply past the 1,000-row mark, and the
-- client-side count computed from the truncated 1,000-row response says
-- "completed" (settled === total, both wrongly computed from the SAME
-- truncated array) while 500 real rows were never applied. Worse: a later
-- apply call on that mis-marked-completed batch still succeeds (nothing
-- in apply_import_batch_chunk checked import_batches.status at all before
-- this migration's sibling, 0108), writing MORE inventory into a batch a
-- human believes is done — or, after 0108 ships, into a batch that was
-- reverted in the meantime.
--
-- Fix: an aggregate RPC. `select count(*) filter (...)` always returns
-- exactly ONE row regardless of how many import_batch_rows exist for the
-- batch — immune to PostgREST's row cap by construction, not by raising a
-- limit that could just be hit again at a larger scale.
--
-- SECURITY INVOKER, no p_restaurant_id parameter: RLS on import_batch_rows
-- (is_member(restaurant_id), 0076) already scopes the underlying SELECT to
-- rows the caller can see. A batch id belonging to another restaurant (or
-- a nonexistent one) simply contributes zero matching rows to every
-- filter — the caller distinguishes "batch not found" from "batch has
-- zero rows" the same way it already does today, via a separate
-- membership-scoped lookup on import_batches before calling this.
--
-- DOWN: drops the function. batch-service.ts's countBatchRows would need
-- to revert to the old uncapped .select() to keep working after this
-- down runs — see down/0106's header for the exact caveat.

create or replace function public.count_import_batch_rows(p_batch_id uuid)
returns table (
  total                integer,
  applied              integer,
  excluded             integer,
  pending              integer,
  eligible_not_applied integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::integer as total,
    count(*) filter (where apply_status = 'applied')::integer as applied,
    count(*) filter (where resolution = 'exclude')::integer as excluded,
    count(*) filter (where resolution = 'pending')::integer as pending,
    count(*) filter (
      where apply_status = 'not_applied' and resolution in ('auto', 'include')
    )::integer as eligible_not_applied
  from public.import_batch_rows
  where batch_id = p_batch_id;
$$;

comment on function public.count_import_batch_rows(uuid) is
  'C03 (db audit 2026-08-23): single-row aggregate replacing '
  'countBatchRows'' uncapped .select() — immune to PostgREST''s 1,000-row '
  'max_rows cap by construction, since count(*) filter (...) always '
  'returns exactly one row. SECURITY INVOKER: RLS on import_batch_rows is '
  'the tenant boundary, so a batch id from another restaurant (or a '
  'nonexistent one) contributes zero rows to every filter rather than '
  'erroring.';

revoke all on function public.count_import_batch_rows(uuid) from public;
grant execute on function public.count_import_batch_rows(uuid) to authenticated;
