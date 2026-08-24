-- Reverse of 0109_revert_import_batch_v2.sql
--
-- Restores the exact pre-P3 (0076) guard and body. Proof this down
-- actually restores the pre-fix behaviour: apply 60% of a batch, stop
-- (status sits at 'applying'), call revert_import_batch — after this down,
-- it fails with P0001 ("is not completed"); before this down (i.e. with
-- 0109 forward applied), the same call succeeds. That flip is exactly
-- what src/domains/import/batch-service.test.ts's C-new-1 regression test
-- asserts in both directions.

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
    raise exception 'import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  if v_status <> 'completed' then
    raise exception 'import batch % is not completed (status=%)', p_batch_id, v_status
      using errcode = 'P0001';
  end if;

  for v_row in
    select id, applied_inventory_item_id
    from public.import_batch_rows
    where batch_id = p_batch_id and apply_status = 'applied'
    for update
  loop
    update public.import_batch_rows
    set apply_status = 'reverted',
        applied_inventory_item_id = null,
        updated_at = now()
    where id = v_row.id;

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
  'Reverts one completed batch: deletes exactly the inventory_items rows '
  'recorded in applied_inventory_item_id for this batch''s applied rows '
  '(never wines, never another batch''s or another source''s inventory '
  'rows), flips those rows to reverted, and the batch to reverted. Only '
  'callable on a batch in status = completed. Returns the count of rows '
  'reverted. reverted_by is auth.uid() — the invoking session''s own '
  'identity, never a client-supplied value.';

revoke all on function public.revert_import_batch(uuid) from public;
grant execute on function public.revert_import_batch(uuid) to authenticated;
