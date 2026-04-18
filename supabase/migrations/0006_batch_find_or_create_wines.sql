-- 0006_batch_find_or_create_wines.sql
-- Batch version of find_or_create_wine to avoid N sequential RPC calls.
-- Accepts a JSONB array, returns wine UUIDs in input order.

create or replace function public.find_or_create_wines_batch(
  p_restaurant_id uuid,
  p_wines         jsonb
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  wine_ids uuid[];
  wine_record jsonb;
  wine_id uuid;
  i int;
begin
  wine_ids := array[]::uuid[];

  for i in 0 .. jsonb_array_length(p_wines) - 1 loop
    wine_record := p_wines -> i;

    -- Try to find existing wine
    select w.id into wine_id
    from public.wines w
    where w.restaurant_id = p_restaurant_id
      and lower(w.producer) = lower(wine_record ->> 'producer')
      and lower(w.name)     = lower(wine_record ->> 'name')
      and coalesce(w.vintage, 0) = coalesce((wine_record ->> 'vintage')::int, 0)
      and w.size_ml = coalesce((wine_record ->> 'size_ml')::int, 750)
    limit 1;

    if wine_id is not null then
      -- Fill in missing fields
      update public.wines
      set varietal = coalesce(wines.varietal, wine_record ->> 'varietal'),
          region   = coalesce(wines.region, wine_record ->> 'region'),
          country  = coalesce(wines.country, wine_record ->> 'country')
      where id = wine_id
        and (wines.varietal is null or wines.region is null or wines.country is null);
    else
      -- Insert new wine
      insert into public.wines (restaurant_id, name, producer, vintage, varietal, region, country, size_ml)
      values (
        p_restaurant_id,
        wine_record ->> 'name',
        wine_record ->> 'producer',
        (wine_record ->> 'vintage')::int,
        wine_record ->> 'varietal',
        wine_record ->> 'region',
        wine_record ->> 'country',
        coalesce((wine_record ->> 'size_ml')::int, 750)
      )
      on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
      do update set
        varietal = coalesce(excluded.varietal, wines.varietal),
        region   = coalesce(excluded.region, wines.region),
        country  = coalesce(excluded.country, wines.country)
      returning id into wine_id;
    end if;

    wine_ids := wine_ids || wine_id;
  end loop;

  return wine_ids;
end;
$$;

revoke all on function public.find_or_create_wines_batch(uuid, jsonb) from public;
grant execute on function public.find_or_create_wines_batch(uuid, jsonb) to authenticated;
