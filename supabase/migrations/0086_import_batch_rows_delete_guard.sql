-- 0086_import_batch_rows_delete_guard.sql
--
-- C13 (db audit 2026-08-23, verified V2-import.md) — import_batch_rows'
-- CHECK constraint import_batch_rows_applied_has_inventory_id (0076)
-- requires applied_inventory_item_id IS NOT NULL whenever
-- apply_status = 'applied', but applied_inventory_item_id's FK is
-- ON DELETE SET NULL. Verified reproduction: applied one real row via
-- apply_import_batch_chunk, then deleted the resulting inventory_items
-- row through the NORMAL member-facing delete policy ("members can
-- delete their inventory", 0002 — any restaurant member, not
-- revert_import_batch). The delete failed outright with SQLSTATE 23514
-- (fails safe — no partial state) because the FK's SET NULL action tries
-- to null the column while apply_status is still 'applied', which the
-- CHECK then rejects.
--
-- Blast radius (verified): the only legal way to remove any imported row
-- is revert_import_batch, which reverts the ENTIRE batch — for a
-- 20,000-row import, correcting one bad row means either living with it
-- forever or reverting and re-importing all 20,000.
--
-- Fix: a BEFORE DELETE trigger on inventory_items that flips the
-- referencing import_batch_rows row(s) to apply_status = 'reverted' (and
-- nulls applied_inventory_item_id itself) before the row is removed —
-- exactly the ordering revert_import_batch (0076) already uses for its
-- own bulk deletes ("Order matters here..." comment there), just applied
-- to the ad hoc single-row delete path too. 'reverted' is the correct
-- terminal state (this row's applied inventory genuinely no longer
-- exists), not a new state invented for this fix. BEFORE DELETE (not
-- AFTER) so this update commits before the FK's own SET NULL action
-- fires, satisfying the CHECK by the time it's evaluated.
--
-- RLS note: the trigger function is left SECURITY INVOKER (the default —
-- no `security definer` clause) on purpose. is_member_with_role(rid,
-- 'staff') (required by "members can update import batch rows") and
-- is_member(rid) (required by "members can delete their inventory") are
-- equivalent in this schema's 3-role hierarchy (owner/manager/staff — see
-- is_member_with_role, 0001): every role that can pass the delete policy
-- also passes the update policy. No elevated privilege is needed, and
-- none is granted.
--
-- Does not affect revert_import_batch (0076): it already manually sets
-- apply_status = 'reverted' and applied_inventory_item_id = null BEFORE
-- deleting each inventory_items row, so this trigger's
-- `and apply_status = 'applied'` guard finds nothing left to do on that
-- path — it only fires for a direct delete that skipped that manual step.
--
-- DOWN: drops the trigger and its function; restores the pre-fix
-- fail-closed (opaque 23514) behavior. See
-- down/0086_import_batch_rows_delete_guard.down.sql.

create or replace function public.import_batch_rows_reflect_inventory_delete()
returns trigger
language plpgsql
as $$
begin
  update public.import_batch_rows
    set apply_status = 'reverted',
        applied_inventory_item_id = null,
        updated_at = now()
    where applied_inventory_item_id = OLD.id
      and apply_status = 'applied';
  return OLD;
end;
$$;

comment on function public.import_batch_rows_reflect_inventory_delete() is
  'C13 (db audit 2026-08-23): before an inventory_items row is deleted, '
  'flip any import_batch_rows row that still names it applied to '
  'reverted (and null its applied_inventory_item_id itself) so the '
  'import_batch_rows_applied_has_inventory_id CHECK (0076) is already '
  'satisfied by the time the FK''s ON DELETE SET NULL action runs. '
  'Without this, deleting an applied import row through the ordinary '
  'member-delete policy fails outright with SQLSTATE 23514.';

create trigger inventory_items_reflect_import_delete
  before delete on public.inventory_items
  for each row execute function public.import_batch_rows_reflect_inventory_delete();
