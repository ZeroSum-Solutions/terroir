-- Focused acceptance for 0080_audited_cellar_quantity_adjustments.sql.
-- Run against an isolated migrated database only:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0080_audited_cellar_quantity_adjustments.sql

begin;

create or replace function pg_temp.request_hash(p_identity text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(pg_catalog.convert_to(p_identity, 'UTF8'))::bigint
      ) || pg_catalog.convert_to(p_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '80000000-0000-4000-8000-000000000001',
    'manager-0080@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '80000000-0000-4000-8000-000000000002',
    'staff-0080@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  ('80100000-0000-4000-8000-000000000001', 'Quantity Audit Acceptance'),
  ('80100000-0000-4000-8000-000000000002', 'Foreign Quantity Tenant');

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '80000000-0000-4000-8000-000000000001',
    '80100000-0000-4000-8000-000000000001',
    'manager'
  ),
  (
    '80000000-0000-4000-8000-000000000002',
    '80100000-0000-4000-8000-000000000001',
    'staff'
  );

insert into public.wines (id, restaurant_id, name, producer, size_ml) values
  (
    '80200000-0000-4000-8000-000000000001',
    '80100000-0000-4000-8000-000000000001',
    'Audited Quantity',
    'Fixture Producer',
    750
  ),
  (
    '80200000-0000-4000-8000-000000000002',
    '80100000-0000-4000-8000-000000000002',
    'Foreign Quantity',
    'Fixture Producer',
    750
  );

insert into public.inventory_items (
  id,
  wine_id,
  restaurant_id,
  quantity,
  unit_cost,
  added_via,
  format,
  added_at
) values
  (
    '80300000-0000-4000-8000-000000000001',
    '80200000-0000-4000-8000-000000000001',
    '80100000-0000-4000-8000-000000000001',
    1,
    20,
    'manual',
    '750ml',
    now() - interval '1 day'
  ),
  (
    '80300000-0000-4000-8000-000000000002',
    '80200000-0000-4000-8000-000000000001',
    '80100000-0000-4000-8000-000000000001',
    2,
    30,
    'manual',
    'magnum',
    now()
  );

do $$
begin
  if has_function_privilege(
    'anon',
    'public.adjust_cellar_quantity_idempotent(uuid,uuid,integer,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anonymous callers can execute quantity adjustments';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.adjust_cellar_quantity_idempotent(uuid,uuid,integer,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated callers cannot execute quantity adjustments';
  end if;
end;
$$;

-- A manager can adjust the tenant wine once. Replaying the exact command
-- returns the stored response without changing stock or duplicating the audit.
select set_config(
  'request.jwt.claim.sub',
  '80000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_hash text := pg_temp.request_hash(
    '{"id":"80200000-0000-4000-8000-000000000001","quantity":5,"reason":"Physical count"}'
  );
  v_first record;
  v_replay record;
begin
  select * into v_first
  from public.adjust_cellar_quantity_idempotent(
    '80100000-0000-4000-8000-000000000001',
    '80200000-0000-4000-8000-000000000001',
    5,
    'Physical count',
    'quantity_adjustment_0080',
    v_hash
  );
  select * into v_replay
  from public.adjust_cellar_quantity_idempotent(
    '80100000-0000-4000-8000-000000000001',
    '80200000-0000-4000-8000-000000000001',
    5,
    'Physical count',
    'quantity_adjustment_0080',
    v_hash
  );

  if v_first.outcome <> 'adjusted'
     or v_first.response_status <> 200
     or v_first.replayed
     or v_first.response_body->>'previousQuantity' <> '3'
     or v_first.response_body->>'quantity' <> '5'
     or v_first.response_body->>'delta' <> '2'
     or v_replay.outcome <> 'replay'
     or not v_replay.replayed
     or v_replay.response_body <> v_first.response_body then
    raise exception 'quantity adjustment/replay malformed: first=%, replay=%',
      row_to_json(v_first), row_to_json(v_replay);
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select coalesce(sum(quantity), 0)
    from public.inventory_items
    where wine_id = '80200000-0000-4000-8000-000000000001'
      and restaurant_id = '80100000-0000-4000-8000-000000000001'
  ) <> 5 then
    raise exception 'quantity adjustment did not produce the requested total';
  end if;
  if (
    select count(*)
    from public.availability_events
    where wine_id = '80200000-0000-4000-8000-000000000001'
      and restaurant_id = '80100000-0000-4000-8000-000000000001'
      and direction = 'adjustment'
      and delta = 2
      and note = 'Physical count'
      and user_id = '80000000-0000-4000-8000-000000000001'
  ) <> 1 then
    raise exception 'quantity adjustment audit was missing or duplicated';
  end if;
end;
$$;

-- A no-op confirms the total but must not fabricate an availability event.
select set_config(
  'request.jwt.claim.sub',
  '80000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into v_result
  from public.adjust_cellar_quantity_idempotent(
    '80100000-0000-4000-8000-000000000001',
    '80200000-0000-4000-8000-000000000001',
    5,
    'No-op confirmation'
  );
  if v_result.outcome <> 'unchanged'
     or v_result.response_body->>'delta' <> '0' then
    raise exception 'no-op adjustment result malformed: %', row_to_json(v_result);
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (
    select 1
    from public.availability_events
    where wine_id = '80200000-0000-4000-8000-000000000001'
      and note = 'No-op confirmation'
  ) then
    raise exception 'no-op quantity confirmation created an audit event';
  end if;
end;
$$;

-- Staff cannot adjust stock, and a valid manager cannot observe or mutate a
-- wine through the wrong tenant identity.
select set_config(
  'request.jwt.claim.sub',
  '80000000-0000-4000-8000-000000000002',
  false
);
set role authenticated;
do $$
begin
  begin
    perform *
    from public.adjust_cellar_quantity_idempotent(
      '80100000-0000-4000-8000-000000000001',
      '80200000-0000-4000-8000-000000000001',
      1,
      'Blocked staff adjustment'
    );
  exception when sqlstate '42501' then
    return;
  end;
  raise exception 'staff quantity adjustment was allowed';
end;
$$;
reset role;

select set_config(
  'request.jwt.claim.sub',
  '80000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into v_result
  from public.adjust_cellar_quantity_idempotent(
    '80100000-0000-4000-8000-000000000001',
    '80200000-0000-4000-8000-000000000002',
    1,
    'Cross-tenant attempt'
  );
  if v_result.outcome <> 'not_found' or v_result.response_status <> 404 then
    raise exception 'cross-tenant wine did not stay hidden: %', row_to_json(v_result);
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (
    select 1
    from public.availability_events
    where wine_id = '80200000-0000-4000-8000-000000000002'
  ) then
    raise exception 'cross-tenant attempt created an audit event';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', false);
rollback;
