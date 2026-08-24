-- down for 0082_import_batch_rows_tenant_fk.sql
--
-- Restores apply_import_batch_chunk's pre-fix body (0076's version, no
-- batch-tenant re-validation), drops the composite FK and the
-- import_batches uniqueness constraint, and restores the two independent
-- FKs on import_batch_rows. Re-introduces C17's cross-tenant poison-row
-- hole — only for a rollback of this specific fix, never as a normal
-- operation.

begin;

create or replace function public.apply_import_batch_chunk(p_batch_id uuid, p_limit integer default 50)
returns table (
  row_id            uuid,
  row_number        integer,
  outcome           text,
  inventory_item_id uuid,
  error_message     text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.import_batch_rows%rowtype;
  v_unit_cost numeric(10,2);
  v_wine_id uuid;
  v_inventory_id uuid;
begin
  for v_row in
    select r.*
    from public.import_batch_rows r
    where r.batch_id = p_batch_id
      and r.apply_status = 'not_applied'
      and r.row_state = 'valid'
      and r.resolution in ('auto', 'include')
    order by r.row_number
    limit least(greatest(p_limit, 1), 500)
    for update skip locked
  loop
    begin
      if v_row.cost_status = 'missing' then
        if v_row.manual_unit_cost is null then
          row_id := v_row.id;
          row_number := v_row.row_number;
          outcome := 'blocked';
          inventory_item_id := null;
          error_message := 'Missing unit cost has no operator-provided value.';
          return next;
          continue;
        end if;
        v_unit_cost := v_row.manual_unit_cost;
      else
        v_unit_cost := nullif(v_row.raw ->> 'unit_cost', '')::numeric(10,2);
      end if;

      if v_unit_cost is null then
        row_id := v_row.id;
        row_number := v_row.row_number;
        outcome := 'blocked';
        inventory_item_id := null;
        error_message := 'Row has no usable unit cost.';
        return next;
        continue;
      end if;

      insert into public.wines (
        restaurant_id, name, producer, vintage, varietal, region, country, size_ml, lwin_id
      ) values (
        v_row.restaurant_id,
        v_row.raw ->> 'name',
        v_row.raw ->> 'producer',
        nullif(v_row.raw ->> 'vintage', '')::int,
        nullif(v_row.raw ->> 'varietal', ''),
        nullif(v_row.raw ->> 'region', ''),
        nullif(v_row.raw ->> 'country', ''),
        coalesce(nullif(v_row.raw ->> 'size_ml', '')::int, 750),
        v_row.lwin_id
      )
      on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
      do update set
        varietal = coalesce(public.wines.varietal, excluded.varietal),
        region   = coalesce(public.wines.region, excluded.region),
        country  = coalesce(public.wines.country, excluded.country),
        lwin_id  = coalesce(public.wines.lwin_id, excluded.lwin_id)
      returning id into v_wine_id;

      if v_wine_id is null then
        raise exception 'wine insert/lookup returned no row for import_batch_row %', v_row.id;
      end if;

      insert into public.inventory_items (
        wine_id, restaurant_id, quantity, unit_cost, bin_location, section, format, currency, added_via
      ) values (
        v_wine_id,
        v_row.restaurant_id,
        coalesce(nullif(v_row.raw ->> 'quantity', '')::int, 0),
        v_unit_cost,
        nullif(v_row.raw ->> 'bin', ''),
        nullif(v_row.raw ->> 'section', ''),
        nullif(v_row.raw ->> 'format', ''),
        nullif(v_row.raw ->> 'currency', ''),
        'manual'
      )
      returning id into v_inventory_id;

      if v_inventory_id is null then
        raise exception 'inventory_items insert returned no row for import_batch_row %', v_row.id;
      end if;

      update public.import_batch_rows
      set apply_status = 'applied',
          applied_inventory_item_id = v_inventory_id,
          applied_wine_id = v_wine_id,
          updated_at = now()
      where id = v_row.id;

      row_id := v_row.id;
      row_number := v_row.row_number;
      outcome := 'applied';
      inventory_item_id := v_inventory_id;
      error_message := null;
      return next;
    exception when others then
      row_id := v_row.id;
      row_number := v_row.row_number;
      outcome := 'error';
      inventory_item_id := null;
      error_message := sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

revoke all on function public.apply_import_batch_chunk(uuid, integer) from public;
grant execute on function public.apply_import_batch_chunk(uuid, integer) to authenticated;

alter table public.import_batch_rows
  drop constraint import_batch_rows_batch_restaurant_fkey,
  add constraint import_batch_rows_batch_id_fkey
    foreign key (batch_id) references public.import_batches(id) on delete cascade,
  add constraint import_batch_rows_restaurant_id_fkey
    foreign key (restaurant_id) references public.restaurants(id) on delete cascade;

alter table public.import_batches
  drop constraint import_batches_id_restaurant_id_key;

commit;
