-- Focused acceptance for TER-021G service-role worker authority.
-- Run against an isolated migrated database only; rollback removes fixtures.

begin;

insert into auth.users (
  id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '84000000-0000-4000-8000-000000000001',
    'manager-0084@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '84000000-0000-4000-8000-000000000002',
    'staff-0084@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.restaurants (id, name) values
  ('84100000-0000-4000-8000-000000000001', 'Worker Tenant'),
  ('84100000-0000-4000-8000-000000000002', 'Foreign Tenant');

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '84000000-0000-4000-8000-000000000001',
    '84100000-0000-4000-8000-000000000001', 'manager'
  ),
  (
    '84000000-0000-4000-8000-000000000002',
    '84100000-0000-4000-8000-000000000001', 'staff'
  );

insert into public.wines (
  id, restaurant_id, name, producer, vintage, varietal, region, size_ml,
  drink_window_start, drink_window_end, peak_year, serving_temp_min,
  manual_overrides
) values
  (
    '84200000-0000-4000-8000-000000000001',
    '84100000-0000-4000-8000-000000000001',
    'Manual Window', 'Fixture Producer', 2020, 'Cabernet Sauvignon',
    'Napa', 750, 2025, 2040, 2032, 60, array['drink_window']::text[]
  ),
  (
    '84200000-0000-4000-8000-000000000002',
    '84100000-0000-4000-8000-000000000002',
    'Foreign Window', 'Fixture Producer', 2020, 'Merlot',
    'Bordeaux', 750, 2024, 2035, 2030, 60, array[]::text[]
  );

do $$
begin
  if not has_function_privilege(
    'service_role', 'public.match_lwin(text,text,double precision)', 'EXECUTE'
  ) then
    raise exception 'service worker cannot execute single LWIN matching';
  end if;
  if not has_function_privilege(
    'service_role', 'public.match_lwin_batch(uuid,uuid[])', 'EXECUTE'
  ) then
    raise exception 'service worker cannot execute batch LWIN matching';
  end if;
  if not has_function_privilege(
    'service_role', 'public.enrich_wines_batch(uuid,jsonb)', 'EXECUTE'
  ) then
    raise exception 'service worker cannot execute wine enrichment';
  end if;
  if has_function_privilege(
    'anon', 'public.enrich_wines_batch(uuid,jsonb)', 'EXECUTE'
  ) then
    raise exception 'anonymous caller can execute wine enrichment';
  end if;
  if has_function_privilege(
    'anon', 'public.match_lwin_batch(uuid,uuid[])', 'EXECUTE'
  ) then
    raise exception 'anonymous caller can execute batch LWIN matching';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '84000000-0000-4000-8000-000000000002',
  false
);
select set_config('request.jwt.claim.role', 'authenticated', false);
set local role authenticated;
do $$
begin
  begin
    perform public.enrich_wines_batch(
      '84100000-0000-4000-8000-000000000001',
      '[{"id":"84200000-0000-4000-8000-000000000001","serving_temp_min":77}]'::jsonb
    );
  exception when sqlstate '42501' then
    return;
  end;
  raise exception 'staff enrichment unexpectedly succeeded';
end;
$$;
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', 'service_role', false);
set local role service_role;
do $$
declare
  v_count integer;
begin
  select public.enrich_wines_batch(
    '84100000-0000-4000-8000-000000000001',
    '[{"id":"84200000-0000-4000-8000-000000000001","drink_window_start":2028,"drink_window_end":2038,"peak_year":2033,"serving_temp_min":62}]'::jsonb
  ) into v_count;
  if v_count <> 1 then
    raise exception 'service worker did not update its tenant wine';
  end if;

  select public.enrich_wines_batch(
    '84100000-0000-4000-8000-000000000001',
    '[{"id":"84200000-0000-4000-8000-000000000002","serving_temp_min":77}]'::jsonb
  ) into v_count;
  if v_count <> 0 then
    raise exception 'cross-tenant worker enrichment escaped';
  end if;
end;
$$;
reset role;

do $$
declare
  v_local public.wines%rowtype;
  v_foreign public.wines%rowtype;
begin
  select * into v_local from public.wines
  where id = '84200000-0000-4000-8000-000000000001';
  select * into v_foreign from public.wines
  where id = '84200000-0000-4000-8000-000000000002';
  if v_local.drink_window_start <> 2025
     or v_local.drink_window_end <> 2040
     or v_local.peak_year <> 2032
     or v_local.serving_temp_min <> 62 then
    raise exception 'worker overwrote manual fields or missed unlocked fields';
  end if;
  if v_foreign.serving_temp_min <> 60 then
    raise exception 'foreign tenant wine was mutated';
  end if;
end;
$$;

rollback;
