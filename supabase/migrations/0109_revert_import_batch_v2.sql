-- 0109_revert_import_batch_v2.sql
--
-- P3 §5 (C-new-1) — same "create or replace in place, no new function
-- name" reasoning as 0108 (see its header): the design doc's §4 table says
-- "create or replace" for this file despite the "_v2" filename.
--
-- C-new-1 (found while designing §3.4, not in the original audit):
-- revert_import_batch's guard (`if v_status <> 'completed' then raise...`)
-- meant a batch that got PARTIALLY applied and then abandoned (a pending
-- row nobody resolved, an operator who walked away mid-apply) sat at
-- status = 'applying' forever and could NEVER be reverted — the guard
-- accepted nothing but 'completed'. With one batch this was a narrow edge
-- case; with a five-chunk session, it's five independent chances for one
-- chunk to get stuck, and it directly blocks §3.4's "revert a session as a
-- unit" requirement the moment any single chunk in that session is stuck
-- mid-flight.
--
-- Fix, and ONE explicit deviation from the design doc's literal
-- instruction: the doc's §4 table says relax the guard to
-- `status in ('applying', 'completed')`. This migration instead relaxes it
-- to `status <> 'reverted'` (i.e. also allows 'created'). Justification:
-- §2.2/§3.2's OWN new partial unique index (import_batches_session_chunk_
-- idx, 0103) blocks a second non-reverted batch from claiming the same
-- (session_id, chunk_index) — including a batch still sitting at
-- 'created' (confirmed, apply never even started). §2.2's own stated
-- recovery path for "the operator found a data error and needs to replace
-- a chunk" is "revert the existing batch first ... which frees the hash
-- [or chunk slot], and then re-upload" — but a batch at 'created' has zero
-- applied rows, so under the doc's OWN narrower `in ('applying',
-- 'completed')` guard, reverting it would still be rejected, leaving no
-- sanctioned way to free that chunk_index before ever applying anything.
-- The function body is unconditionally safe on a 'created' batch: its loop
-- is scoped to `apply_status = 'applied'` (0 rows for a never-applied
-- batch), so this is a strict widening with zero added risk, and it is
-- the only guard value that actually satisfies the recovery path the
-- design doc itself specifies in §2.2.
--
-- DOWN: restores the original `<> 'completed'` guard, verbatim function
-- body otherwise unchanged — see down/0109's header for the observable
-- proof.

create or replace function public.revert_import_batch(p_batch_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_status text;
  v_row record;
  v_count integer := 0;
begin
  select restaurant_id, status into v_restaurant_id, v_status
  from public.import_batches
  where id = p_batch_id
  for update;

  if not found then
    -- RLS already filtered this to "batches I'm a member of" — a
    -- cross-tenant batch id lands here indistinguishable from a
    -- nonexistent one, which is the point.
    raise exception 'import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  -- C-new-1: relaxed from "= 'completed'" to "<> 'reverted'" (see this
  -- migration's header for why this is slightly wider than the design
  -- doc's literal `in ('applying', 'completed')`, and why that's a
  -- deliberate, justified deviation rather than a scope-creep). The loop
  -- below only ever touches apply_status = 'applied' rows regardless of
  -- the batch's convenience status label — this is a pure guard
  -- relaxation, not a change to what gets deleted.
  if v_status = 'reverted' then
    raise exception 'import batch % is already reverted', p_batch_id
      using errcode = 'P0001';
  end if;

  for v_row in
    select id, applied_inventory_item_id
    from public.import_batch_rows
    where batch_id = p_batch_id and apply_status = 'applied'
    for update
  loop
    -- Order matters here. import_batch_rows_applied_has_inventory_id
    -- (0076) requires applied_inventory_item_id IS NOT NULL whenever
    -- apply_status = 'applied'. applied_inventory_item_id references
    -- inventory_items ON DELETE SET NULL, so deleting the inventory row
    -- FIRST fires that FK action immediately — nulling the column while
    -- apply_status here is STILL 'applied' — and violates the very
    -- constraint that's supposed to prevent this state. Flipping
    -- apply_status to 'reverted' (and nulling the column ourselves)
    -- first means the constraint's exception is already satisfied
    -- before the delete's FK action can touch the row at all.
    update public.import_batch_rows
    set apply_status = 'reverted',
        applied_inventory_item_id = null,
        updated_at = now()
    where id = v_row.id;

    -- Deletes only the inventory_items row THIS row created — never
    -- touches any other row, including pre-existing inventory for the
    -- same wine or same restaurant.
    delete from public.inventory_items
    where id = v_row.applied_inventory_item_id
      and restaurant_id = v_restaurant_id;

    v_count := v_count + 1;
  end loop;

  update public.import_batches
  set status = 'reverted', reverted_at = now(), reverted_by = auth.uid()
  where id = p_batch_id;

  return v_count;
end;
$$;

comment on function public.revert_import_batch(uuid) is
  'Reverts one non-reverted batch (C-new-1, db audit 2026-08-23: '
  'relaxed from completed-only so a partially-applied, abandoned batch — '
  'or one that never got past created — can be reverted too): deletes '
  'exactly the inventory_items rows recorded in applied_inventory_item_id '
  'for this batch''s applied rows (never wines, never another batch''s or '
  'another source''s inventory rows), flips those rows to reverted, and '
  'the batch to reverted. Returns the count of rows reverted. reverted_by '
  'is auth.uid() — the invoking session''s own identity, never a '
  'client-supplied value.';

revoke all on function public.revert_import_batch(uuid) from public;
grant execute on function public.revert_import_batch(uuid) to authenticated;
