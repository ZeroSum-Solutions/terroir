-- 0110_revert_import_session.sql
--
-- P3 §3.4 — revert an entire multi-chunk session as a unit: loops the
-- session's batches in REVERSE chunk order (5, 4, 3, 2, 1) and calls the
-- existing per-batch revert_import_batch (0109) for each, with per-batch
-- exception isolation (same philosophy as apply_import_batch_chunk's
-- per-row exception blocks — one batch's revert failure must never block
-- the other four). A batch already 'reverted' is skipped and reported,
-- never treated as an error.
--
-- Reverse order is chosen for operator intuition ("last thing in, first
-- thing out") and so an interrupted revert always leaves the EARLIEST,
-- most-likely-correct chunks still applied rather than the LATEST,
-- least-reviewed ones — it is NOT required for correctness:
-- revert_import_batch only ever deletes the inventory_items rows ITS OWN
-- applied_inventory_item_id column names, so no batch's revert can touch
-- another batch's rows regardless of order.
--
-- FK-direction note (§3.4): session revert deliberately does NOT attempt
-- to clean up wines rows, for the same reason single-batch revert_import_
-- batch doesn't (docs/runbooks/csv-import.md's "Reversibility" section) —
-- a wine created during this session may legitimately still be referenced
-- by inventory outside the reverted scope (a sibling chunk not reverted, a
-- manual entry, or a completely different session), and
-- inventory_items.wine_id references wines(id) ON DELETE RESTRICT would
-- correctly fail the moment anything still points at it. This function
-- attempts no wine deletion of any kind.
--
-- DOWN: drops the function. Nothing else depends on it existing.

create or replace function public.revert_import_session(p_session_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch record;
  v_results jsonb := '[]'::jsonb;
  v_reverted_count integer;
  v_session_exists boolean := false;
begin
  select true into v_session_exists from public.import_sessions where id = p_session_id;
  if not v_session_exists then
    -- RLS already filtered this to "sessions I'm a member of" — same
    -- fail-closed idiom revert_import_batch (0076) established.
    raise exception 'import session % not found', p_session_id using errcode = 'P0002';
  end if;

  for v_batch in
    select id, status, chunk_index
    from public.import_batches
    where session_id = p_session_id
    order by coalesce(chunk_index, 0) desc, created_at desc
  loop
    if v_batch.status = 'reverted' then
      v_results := v_results || jsonb_build_object(
        'batchId', v_batch.id, 'chunkIndex', v_batch.chunk_index,
        'skipped', true, 'reason', 'already reverted'
      );
      continue;
    end if;

    begin
      select public.revert_import_batch(v_batch.id) into v_reverted_count;
      v_results := v_results || jsonb_build_object(
        'batchId', v_batch.id, 'chunkIndex', v_batch.chunk_index,
        'skipped', false, 'revertedCount', v_reverted_count
      );
    exception when others then
      -- Per-batch exception isolation: one batch's revert failure must
      -- never block the other four (same philosophy as
      -- apply_import_batch_chunk's per-row exception blocks).
      v_results := v_results || jsonb_build_object(
        'batchId', v_batch.id, 'chunkIndex', v_batch.chunk_index,
        'skipped', true, 'reason', sqlerrm
      );
    end;
  end loop;

  update public.import_sessions
  set status = 'reverted', updated_at = now()
  where id = p_session_id;

  return jsonb_build_object('sessionId', p_session_id, 'batches', v_results);
end;
$$;

comment on function public.revert_import_session(uuid) is
  'P3 §3.4: reverts every non-reverted batch in a session, in reverse '
  'chunk order, with per-batch exception isolation — one stuck/failing '
  'batch is skipped and reported, never blocks the rest. Never deletes '
  'wines rows (see migration header for the FK-direction reasoning). '
  'SECURITY INVOKER: RLS on import_sessions/import_batches/'
  'import_batch_rows is the tenant boundary.';

revoke all on function public.revert_import_session(uuid) from public;
grant execute on function public.revert_import_session(uuid) to authenticated;
