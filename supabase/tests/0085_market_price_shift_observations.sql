begin;

do $$
declare
  v_restaurant_id uuid := '85000000-0000-4000-8000-000000000001';
  v_wine_id uuid := '85000000-0000-4000-8000-000000000002';
  v_wine public.wines%rowtype;
begin
  insert into public.restaurants (id, name)
  values (v_restaurant_id, 'TER-027 Market Shift Acceptance');

  insert into public.wines (
    id,
    restaurant_id,
    name,
    producer,
    retail_median,
    retail_refreshed_at
  ) values (
    v_wine_id,
    v_restaurant_id,
    'Shift Test',
    'TER-027',
    100,
    '2026-01-01T00:00:00Z'
  );

  select * into strict v_wine from public.wines where id = v_wine_id;
  if v_wine.retail_previous_median is not null then
    raise exception 'first observation unexpectedly has a previous median';
  end if;

  update public.wines
  set retail_median = 120,
      retail_refreshed_at = '2026-02-01T00:00:00Z'
  where id = v_wine_id;

  select * into strict v_wine from public.wines where id = v_wine_id;
  if v_wine.retail_previous_median <> 100
     or v_wine.retail_previous_refreshed_at <> '2026-01-01T00:00:00Z'::timestamptz then
    raise exception 'changed observation did not retain the prior median';
  end if;

  update public.wines
  set retail_median = 120,
      retail_refreshed_at = '2026-03-01T00:00:00Z'
  where id = v_wine_id;

  select * into strict v_wine from public.wines where id = v_wine_id;
  if v_wine.retail_previous_median <> 100
     or v_wine.retail_previous_refreshed_at <> '2026-01-01T00:00:00Z'::timestamptz then
    raise exception 'unchanged observation replaced the prior median';
  end if;
end;
$$;

rollback;
