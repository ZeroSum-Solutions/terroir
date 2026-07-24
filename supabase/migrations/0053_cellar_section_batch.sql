-- BND-064 / TER-020B15
-- Tenant-scoped cellar inventory discovery and atomic section assignment.

create or replace function public.cellar_inventory_wine_ids(
  p_restaurant_id uuid,
  p_wine_ids uuid[]
) returns uuid[]
language sql
security invoker
set search_path = ''
stable
as $$
  select coalesce(
    array_agg(distinct inventory_items.wine_id),
    '{}'::uuid[]
  )
  from public.inventory_items
  where inventory_items.restaurant_id = p_restaurant_id
    and inventory_items.wine_id = any(p_wine_ids);
$$;

revoke execute on function public.cellar_inventory_wine_ids(uuid, uuid[])
  from public;
grant execute on function public.cellar_inventory_wine_ids(uuid, uuid[])
  to authenticated;

create or replace function public.assign_cellar_section_batch(
  p_restaurant_id uuid,
  p_wine_ids uuid[],
  p_section text
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated_wine_ids uuid[];
begin
  if cardinality(p_wine_ids) < 1 or cardinality(p_wine_ids) > 200 then
    raise exception using
      errcode = 'P0001',
      message = 'cellar_batch_invalid_size';
  end if;

  if (
    select count(*) <> count(distinct wine_id)
    from unnest(p_wine_ids) as requested(wine_id)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'cellar_batch_duplicate_wine';
  end if;

  if not exists (
    select 1
    from public.cellar_config
    cross join lateral jsonb_array_elements(
      coalesce(cellar_config.labels -> 'sections', '[]'::jsonb)
    ) as configured(section)
    where cellar_config.restaurant_id = p_restaurant_id
      and configured.section ->> 'name' = p_section
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'cellar_section_not_configured';
  end if;

  with updated as (
    update public.inventory_items
    set section = p_section
    where inventory_items.restaurant_id = p_restaurant_id
      and inventory_items.wine_id = any(p_wine_ids)
    returning inventory_items.wine_id
  )
  select coalesce(
    array_agg(distinct updated.wine_id),
    '{}'::uuid[]
  )
  into v_updated_wine_ids
  from updated;

  if cardinality(v_updated_wine_ids) <> cardinality(p_wine_ids) then
    raise exception using
      errcode = 'P0001',
      message = 'cellar_inventory_missing';
  end if;

  return;
end;
$$;

revoke execute on function public.assign_cellar_section_batch(
  uuid,
  uuid[],
  text
) from public;
grant execute on function public.assign_cellar_section_batch(
  uuid,
  uuid[],
  text
) to authenticated;

comment on function public.cellar_inventory_wine_ids(uuid, uuid[]) is
  'Returns distinct tenant-scoped inventory wine IDs for the requested wines.';
comment on function public.assign_cellar_section_batch(uuid, uuid[], text) is
  'Atomically validates and assigns tenant cellar inventory wines to a configured section; raises on any incomplete batch.';
