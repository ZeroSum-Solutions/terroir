-- Executable acceptance for 0060_record_pour_idempotency.sql.
-- Run only against an isolated database with migrations through 0060 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v dblink_port=54322 \
--     -f supabase/tests/0060_record_pour_idempotency.sql
--
-- This test commits its fixture setup so two dblink sessions can exercise a
-- genuinely overlapping command. It removes every fixture before success.

create extension if not exists dblink with schema extensions;

\if :{?dblink_port}
\else
\set dblink_port 54322
\endif

select set_config(
  'terroir.test_dblink_port',
  :'dblink_port',
  false
);

create or replace function pg_temp.expect_failure(
  p_sql text,
  p_sqlstate text
) returns void
language plpgsql
as $$
declare
  v_sqlstate text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> p_sqlstate then
      raise exception
        'unexpected failure for "%": expected %, received %',
        p_sql,
        p_sqlstate,
        v_sqlstate;
    end if;
    return;
  end;

  raise exception using
    errcode = 'P0001',
    message = 'expected statement to fail: ' || p_sql;
end;
$$;

create or replace function pg_temp.pour_hash(
  p_wine_id uuid,
  p_ml int,
  p_kind text,
  p_note text
) returns text
language plpgsql
as $$
declare
  v_note text := nullif(btrim(p_note), '');
  v_identity text;
begin
  v_identity :=
    '{"kind":' || pg_catalog.to_json(p_kind)::text ||
    ',"ml":' || p_ml::text ||
    ',"note":' || coalesce(pg_catalog.to_json(v_note)::text, 'null') ||
    ',"wine_id":' || pg_catalog.to_json(p_wine_id::text)::text || '}';
  return pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
end;
$$;

do $$
begin
  if pg_temp.pour_hash(
    'a1b2c3d4-e5f6-4789-8abc-def012345678',
    148,
    'pour',
    null
  ) <> 'f248332dcde6453002b0d15f3db6b5ce5b94c7755bcd03970bb0bd117ba9b678' then
    raise exception
      'database canonical hash does not match createIdempotencyRequestHash';
  end if;
end;
$$;

begin;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '60000000-0000-4000-8000-000000000001',
    'staff-0060@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    'outsider-0060@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '60100000-0000-4000-8000-000000000001',
    'Atomic Pour Restaurant A'
  ),
  (
    '60100000-0000-4000-8000-000000000002',
    'Atomic Pour Restaurant B'
  );

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '60000000-0000-4000-8000-000000000001',
    '60100000-0000-4000-8000-000000000001',
    'staff'
  ),
  (
    '60000000-0000-4000-8000-000000000001',
    '60100000-0000-4000-8000-000000000002',
    'staff'
  );

insert into public.wines (
  id,
  restaurant_id,
  name,
  producer,
  size_ml
) values
  (
    '60200000-0000-4000-8000-000000000001',
    '60100000-0000-4000-8000-000000000001',
    'Replay Pour',
    '0060 Producer',
    750
  ),
  (
    '60200000-0000-4000-8000-000000000002',
    '60100000-0000-4000-8000-000000000001',
    'Rollback Pour',
    '0060 Producer',
    375
  ),
  (
    '60200000-0000-4000-8000-000000000003',
    '60100000-0000-4000-8000-000000000001',
    'No Stock Pour',
    '0060 Producer',
    750
  ),
  (
    '60200000-0000-4000-8000-000000000004',
    '60100000-0000-4000-8000-000000000002',
    'Other Tenant Pour',
    '0060 Producer',
    750
  ),
  (
    '60200000-0000-4000-8000-000000000005',
    '60100000-0000-4000-8000-000000000001',
    'Concurrent Pour',
    '0060 Producer',
    750
  );

insert into public.inventory_items (
  id,
  wine_id,
  restaurant_id,
  quantity,
  unit_cost,
  added_at
) values
  (
    '60300000-0000-4000-8000-000000000001',
    '60200000-0000-4000-8000-000000000001',
    '60100000-0000-4000-8000-000000000001',
    2,
    20,
    now() - interval '5 days'
  ),
  (
    '60300000-0000-4000-8000-000000000002',
    '60200000-0000-4000-8000-000000000002',
    '60100000-0000-4000-8000-000000000001',
    2,
    21,
    now() - interval '4 days'
  ),
  (
    '60300000-0000-4000-8000-000000000003',
    '60200000-0000-4000-8000-000000000003',
    '60100000-0000-4000-8000-000000000001',
    0,
    22,
    now() - interval '3 days'
  ),
  (
    '60300000-0000-4000-8000-000000000004',
    '60200000-0000-4000-8000-000000000004',
    '60100000-0000-4000-8000-000000000002',
    2,
    23,
    now() - interval '2 days'
  ),
  (
    '60300000-0000-4000-8000-000000000005',
    '60200000-0000-4000-8000-000000000005',
    '60100000-0000-4000-8000-000000000001',
    2,
    24,
    now() - interval '1 day'
  );

-- The RPC is caller-bound, authenticated-only, and uses a hardened definer.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.record_pour_idempotent(uuid,uuid,int,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains record-pour idempotency execution';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.record_pour_idempotent(uuid,uuid,int,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks record-pour idempotency execution';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid = to_regprocedure(
      'public.record_pour_idempotent(uuid,uuid,int,text,text,text,text)'
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception
      'record-pour idempotency lacks SECURITY DEFINER empty search_path';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.record_pour_idempotent(
      '60100000-0000-4000-8000-000000000001',
      '60200000-0000-4000-8000-000000000001',
      148,
      'pour',
      null,
      'unauth_key_0060',
      repeat('0', 64)
    )
  $sql$,
  '42501'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.record_pour_idempotent(
      '60100000-0000-4000-8000-000000000001',
      '60200000-0000-4000-8000-000000000001',
      148,
      'pour',
      null
    )
  $sql$,
  '42501'
);

reset role;

-- Missing-key compatibility maps deterministic business errors without
-- creating a claim.
select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
begin
  select * into strict v_result
  from public.record_pour_idempotent(
    '60100000-0000-4000-8000-000000000001',
    '60200000-0000-4000-8000-000000000003',
    148,
    'pour',
    null
  );

  if v_result.outcome <> 'no_inventory'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}' <> 'no_inventory'
     or v_result.replayed then
    raise exception 'unkeyed no-stock response is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

do $$
begin
  if exists (
    select 1
    from public.api_idempotency
    where user_id = '60000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'unkeyed pour created an idempotency claim';
  end if;
end;
$$;

-- A successful keyed pour stores its exact response and normalized note.
select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_hash text := pg_temp.pour_hash(
    '60200000-0000-4000-8000-000000000001',
    148,
    'pour',
    '  shift pour  '
  );
  v_fresh record;
  v_replay record;
begin
  select * into strict v_fresh
  from public.record_pour_idempotent(
    '60100000-0000-4000-8000-000000000001',
    '60200000-0000-4000-8000-000000000001',
    148,
    'pour',
    '  shift pour  ',
    'pour_replay_key_0060',
    v_hash
  );

  select * into strict v_replay
  from public.record_pour_idempotent(
    '60100000-0000-4000-8000-000000000001',
    '60200000-0000-4000-8000-000000000001',
    148,
    'pour',
    'shift pour',
    'pour_replay_key_0060',
    v_hash
  );

  if v_fresh.outcome <> 'poured'
     or v_fresh.response_status <> 200
     or v_fresh.response_body #>> '{open_bottle,wine_id}'
          <> '60200000-0000-4000-8000-000000000001'
     or (v_fresh.response_body #>> '{open_bottle,remaining_ml}')::int <> 602
     or v_fresh.replayed
     or v_fresh.execution_started_at is null then
    raise exception 'fresh pour response is malformed: %',
      row_to_json(v_fresh);
  end if;

  if v_replay.outcome <> 'replay'
     or v_replay.response_status <> 200
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed
     or v_replay.execution_started_at <> v_fresh.execution_started_at then
    raise exception 'pour replay is not exact: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;

reset role;

do $$
declare
  v_claim public.api_idempotency%rowtype;
begin
  if (
    select quantity
    from public.inventory_items
    where id = '60300000-0000-4000-8000-000000000001'
  ) <> 1 then
    raise exception 'replay decremented sealed inventory more than once';
  end if;

  if (
    select count(*)
    from public.pour_events
    where wine_id = '60200000-0000-4000-8000-000000000001'
  ) <> 2 then
    raise exception 'replay duplicated pour ledger events';
  end if;

  if (
    select count(*)
    from public.pour_events
    where wine_id = '60200000-0000-4000-8000-000000000001'
      and note = 'shift pour'
  ) <> 2 then
    raise exception 'pour note was not normalized before business effects';
  end if;

  select * into strict v_claim
  from public.api_idempotency
  where user_id = '60000000-0000-4000-8000-000000000001'
    and idempotency_key = 'pour_replay_key_0060';

  if v_claim.restaurant_id
       <> '60100000-0000-4000-8000-000000000001'
     or v_claim.operation_id <> 'api:POST:/api/pour'
     or v_claim.request_hash <> pg_temp.pour_hash(
          '60200000-0000-4000-8000-000000000001',
          148,
          'pour',
          'shift pour'
        )
     or v_claim.state <> 'completed'
     or v_claim.response_status <> 200
     or v_claim.completed_at is null then
    raise exception 'stored pour claim is malformed: %', row_to_json(v_claim);
  end if;
end;
$$;

-- Corrected body identity uses a different canonical hash and is rejected
-- before mutation. Reusing the key in another tenant is also rejected.
select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
begin
  select * into strict v_result
  from public.record_pour_idempotent(
    '60100000-0000-4000-8000-000000000001',
    '60200000-0000-4000-8000-000000000001',
    125,
    'pour',
    'shift pour',
    'pour_replay_key_0060',
    pg_temp.pour_hash(
      '60200000-0000-4000-8000-000000000001',
      125,
      'pour',
      'shift pour'
    )
  );

  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused'
     or v_result.replayed then
    raise exception 'body mismatch response is malformed: %',
      row_to_json(v_result);
  end if;

  select * into strict v_result
  from public.record_pour_idempotent(
    '60100000-0000-4000-8000-000000000002',
    '60200000-0000-4000-8000-000000000004',
    148,
    'pour',
    null,
    'pour_replay_key_0060',
    pg_temp.pour_hash(
      '60200000-0000-4000-8000-000000000004',
      148,
      'pour',
      null
    )
  );

  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused' then
    raise exception 'tenant mismatch response is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select quantity
    from public.inventory_items
    where id = '60300000-0000-4000-8000-000000000001'
  ) <> 1 or (
    select quantity
    from public.inventory_items
    where id = '60300000-0000-4000-8000-000000000004'
  ) <> 2 then
    raise exception 'key conflict crossed a business boundary';
  end if;
end;
$$;

-- A final completion failure rolls back the claim and every record_pour side
-- effect. The same key can then execute and replay after the fault is removed.
create or replace function pg_temp.reject_pour_completion_0060()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0060 idempotency completion failure';
end;
$$;

create trigger reject_pour_completion_0060
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'pour_rollback_key_0060')
execute function pg_temp.reject_pour_completion_0060();

select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

select pg_temp.expect_failure(
  format(
    $sql$
      select * from public.record_pour_idempotent(
        '60100000-0000-4000-8000-000000000001',
        '60200000-0000-4000-8000-000000000002',
        100,
        'spill',
        null,
        'pour_rollback_key_0060',
        %L
      )
    $sql$,
    pg_temp.pour_hash(
      '60200000-0000-4000-8000-000000000002',
      100,
      'spill',
      null
    )
  ),
  'XX000'
);

reset role;
drop trigger reject_pour_completion_0060 on public.api_idempotency;

do $$
begin
  if (
    select quantity
    from public.inventory_items
    where id = '60300000-0000-4000-8000-000000000002'
  ) <> 2 then
    raise exception 'completion failure leaked its inventory decrement';
  end if;

  if exists (
    select 1
    from public.open_bottles
    where wine_id = '60200000-0000-4000-8000-000000000002'
  ) or exists (
    select 1
    from public.pour_events
    where wine_id = '60200000-0000-4000-8000-000000000002'
  ) or exists (
    select 1
    from public.api_idempotency
    where user_id = '60000000-0000-4000-8000-000000000001'
      and idempotency_key = 'pour_rollback_key_0060'
  ) then
    raise exception 'completion failure leaked transactional state';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_hash text := pg_temp.pour_hash(
    '60200000-0000-4000-8000-000000000002',
    100,
    'spill',
    null
  );
  v_fresh record;
  v_replay record;
begin
  select * into strict v_fresh
  from public.record_pour_idempotent(
    '60100000-0000-4000-8000-000000000001',
    '60200000-0000-4000-8000-000000000002',
    100,
    'spill',
    null,
    'pour_rollback_key_0060',
    v_hash
  );

  select * into strict v_replay
  from public.record_pour_idempotent(
    '60100000-0000-4000-8000-000000000001',
    '60200000-0000-4000-8000-000000000002',
    100,
    'spill',
    null,
    'pour_rollback_key_0060',
    v_hash
  );

  if v_fresh.outcome <> 'poured'
     or v_fresh.replayed
     or v_replay.outcome <> 'replay'
     or not v_replay.replayed
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'retry/replay after rollback is malformed';
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select quantity
    from public.inventory_items
    where id = '60300000-0000-4000-8000-000000000002'
  ) <> 1 or (
    select count(*)
    from public.pour_events
    where wine_id = '60200000-0000-4000-8000-000000000002'
  ) <> 2 then
    raise exception 'post-rollback replay duplicated business effects';
  end if;
end;
$$;

-- Commit the fixtures so independent sessions can observe them.
commit;

-- Slow the first event for the concurrency wine. The second session reaches
-- the same advisory lock while the winner still owns the transaction.
create or replace function public.test_delay_pour_0060()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.wine_id = '60200000-0000-4000-8000-000000000005' then
    perform pg_catalog.pg_sleep(0.75);
  end if;
  return new;
end;
$$;

create trigger test_delay_pour_0060
before insert on public.pour_events
for each row execute function public.test_delay_pour_0060();

do $$
declare
  v_conn text :=
    'host=host.docker.internal port=' ||
    current_setting('terroir.test_dblink_port') ||
    ' dbname=' || current_database() ||
    ' user=postgres password=postgres';
  v_hash text := pg_temp.pour_hash(
    '60200000-0000-4000-8000-000000000005',
    148,
    'pour',
    null
  );
  v_query text;
  v_first record;
  v_second record;
begin
  perform extensions.dblink_connect('pour_0060_a', v_conn);
  perform extensions.dblink_connect('pour_0060_b', v_conn);
  perform extensions.dblink_exec(
    'pour_0060_a',
    'set request.jwt.claim.sub = ''60000000-0000-4000-8000-000000000001'''
  );
  perform extensions.dblink_exec(
    'pour_0060_b',
    'set request.jwt.claim.sub = ''60000000-0000-4000-8000-000000000001'''
  );
  perform extensions.dblink_exec('pour_0060_a', 'set role authenticated');
  perform extensions.dblink_exec('pour_0060_b', 'set role authenticated');

  v_query := format(
    $query$
      select *
      from public.record_pour_idempotent(
        '60100000-0000-4000-8000-000000000001',
        '60200000-0000-4000-8000-000000000005',
        148,
        'pour',
        null,
        'pour_concurrent_key_0060',
        %L
      )
    $query$,
    v_hash
  );

  perform extensions.dblink_send_query('pour_0060_a', v_query);
  perform pg_catalog.pg_sleep(0.10);
  perform extensions.dblink_send_query('pour_0060_b', v_query);

  select * into strict v_first
  from extensions.dblink_get_result('pour_0060_a') as result(
    outcome text,
    response_status integer,
    response_body jsonb,
    replayed boolean,
    execution_started_at timestamptz
  );
  select * into strict v_second
  from extensions.dblink_get_result('pour_0060_b') as result(
    outcome text,
    response_status integer,
    response_body jsonb,
    replayed boolean,
    execution_started_at timestamptz
  );

  if v_first.outcome <> 'poured'
     or v_first.replayed
     or v_second.outcome <> 'replay'
     or not v_second.replayed
     or v_second.response_body <> v_first.response_body
     or v_second.execution_started_at <> v_first.execution_started_at then
    raise exception 'concurrent results are malformed: first=%, second=%',
      row_to_json(v_first),
      row_to_json(v_second);
  end if;

  perform extensions.dblink_disconnect('pour_0060_a');
  perform extensions.dblink_disconnect('pour_0060_b');
exception when others then
  begin
    perform extensions.dblink_disconnect('pour_0060_a');
  exception when others then
    null;
  end;
  begin
    perform extensions.dblink_disconnect('pour_0060_b');
  exception when others then
    null;
  end;
  raise;
end;
$$;

do $$
begin
  if (
    select quantity
    from public.inventory_items
    where id = '60300000-0000-4000-8000-000000000005'
  ) <> 1 or (
    select count(*)
    from public.pour_events
    where wine_id = '60200000-0000-4000-8000-000000000005'
  ) <> 2 or (
    select count(*)
    from public.api_idempotency
    where user_id = '60000000-0000-4000-8000-000000000001'
      and idempotency_key = 'pour_concurrent_key_0060'
      and state = 'completed'
  ) <> 1 then
    raise exception 'concurrent retry duplicated business or claim state';
  end if;
end;
$$;

drop trigger test_delay_pour_0060 on public.pour_events;
drop function public.test_delay_pour_0060();

-- Remove all committed acceptance fixtures.
delete from public.api_idempotency
where user_id = '60000000-0000-4000-8000-000000000001';
delete from public.pour_events
where wine_id::text like '60200000-0000-4000-8000-%';
delete from public.open_bottles
where wine_id::text like '60200000-0000-4000-8000-%';
delete from public.inventory_items
where wine_id::text like '60200000-0000-4000-8000-%';
delete from public.wines
where id::text like '60200000-0000-4000-8000-%';
delete from public.memberships
where user_id::text like '60000000-0000-4000-8000-%';
delete from public.restaurants
where id::text like '60100000-0000-4000-8000-%';
delete from auth.users
where id::text like '60000000-0000-4000-8000-%';

select '0060 record-pour idempotency acceptance passed' as result;
