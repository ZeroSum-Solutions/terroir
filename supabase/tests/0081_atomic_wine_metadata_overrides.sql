-- Focused acceptance for 0081_atomic_wine_metadata_overrides.sql.
-- Run against an isolated migrated database only:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0081_atomic_wine_metadata_overrides.sql

begin;

insert into auth.users (
  id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '81000000-0000-4000-8000-000000000001',
    'manager-0081@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '81000000-0000-4000-8000-000000000002',
    'staff-0081@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  ('81100000-0000-4000-8000-000000000001', 'Wine Intelligence Acceptance'),
  ('81100000-0000-4000-8000-000000000002', 'Foreign Wine Tenant');

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '81000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001',
    'manager'
  ),
  (
    '81000000-0000-4000-8000-000000000002',
    '81100000-0000-4000-8000-000000000001',
    'staff'
  );

insert into public.wines (
  id, restaurant_id, name, producer, vintage, varietal, region, size_ml,
  drink_window_start, drink_window_end, peak_year, serving_temp_min
) values
  (
    '81200000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001',
    'Manual Window',
    'Fixture Producer',
    2020,
    'Cabernet Sauvignon',
    'Napa',
    750,
    2025,
    2040,
    2032,
    60
  ),
  (
    '81200000-0000-4000-8000-000000000002',
    '81100000-0000-4000-8000-000000000002',
    'Foreign Window',
    'Fixture Producer',
    2020,
    'Merlot',
    'Bordeaux',
    750,
    2024,
    2035,
    2030,
    60
  );

do $$
begin
  if has_function_privilege(
    'anon',
    'public.update_wine_metadata_atomic(uuid,uuid,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'anonymous callers can execute atomic metadata writes';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.update_wine_metadata_atomic(uuid,uuid,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'authenticated callers cannot execute atomic metadata writes';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '81000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_updated record;
begin
  select * into v_updated
  from public.update_wine_metadata_atomic(
    '81100000-0000-4000-8000-000000000001',
    '81200000-0000-4000-8000-000000000001',
    '{"region":"Howell Mountain","drink_window_start":2027,"drink_window_end":2042,"peak_year":2035}'::jsonb
  );
  if v_updated.region <> 'Howell Mountain'
     or v_updated.drink_window_start <> 2027
     or v_updated.drink_window_end <> 2042
     or v_updated.peak_year <> 2035 then
    raise exception 'atomic metadata result was malformed: %', row_to_json(v_updated);
  end if;
end;
$$;

do $$
declare
  v_count integer;
begin
  select public.enrich_wines_batch(
    '81100000-0000-4000-8000-000000000001',
    '[{"id":"81200000-0000-4000-8000-000000000001","region":"Provider Region","drink_window_start":2024,"drink_window_end":2032,"peak_year":2028,"serving_temp_min":62}]'::jsonb
  ) into v_count;
  if v_count <> 1 then
    raise exception 'enrichment did not target the fixture wine';
  end if;
end;
$$;

reset role;

do $$
declare
  v_wine public.wines%rowtype;
begin
  select * into v_wine
  from public.wines
  where id = '81200000-0000-4000-8000-000000000001';
  if v_wine.region <> 'Howell Mountain'
     or v_wine.drink_window_start <> 2027
     or v_wine.drink_window_end <> 2042
     or v_wine.peak_year <> 2035
     or v_wine.serving_temp_min <> 62
     or v_wine.manual_overrides <> array['drink_window', 'region']::text[] then
    raise exception 'manual values were overwritten or locks were missing: %', row_to_json(v_wine);
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '81000000-0000-4000-8000-000000000002',
  false
);
set role authenticated;
do $$
begin
  begin
    perform * from public.update_wine_metadata_atomic(
      '81100000-0000-4000-8000-000000000001',
      '81200000-0000-4000-8000-000000000001',
      '{"region":"Blocked staff region"}'::jsonb
    );
  exception when sqlstate '42501' then
    return;
  end;
  raise exception 'staff metadata write was allowed';
end;
$$;
reset role;

select set_config(
  'request.jwt.claim.sub',
  '81000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.update_wine_metadata_atomic(
    '81100000-0000-4000-8000-000000000001',
    '81200000-0000-4000-8000-000000000002',
    '{"region":"Cross-tenant mutation"}'::jsonb
  );
  if v_count <> 0 then
    raise exception 'cross-tenant wine was disclosed or updated';
  end if;
end;
$$;

do $$
begin
  begin
    perform * from public.update_wine_metadata_atomic(
      '81100000-0000-4000-8000-000000000001',
      '81200000-0000-4000-8000-000000000001',
      '{"restaurant_id":"81100000-0000-4000-8000-000000000002"}'::jsonb
    );
  exception when sqlstate '22023' then
    return;
  end;
  raise exception 'unsupported metadata field was accepted';
end;
$$;
reset role;

do $$
begin
  if (
    select region from public.wines
    where id = '81200000-0000-4000-8000-000000000002'
  ) <> 'Bordeaux' then
    raise exception 'cross-tenant wine was mutated';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', false);
rollback;
