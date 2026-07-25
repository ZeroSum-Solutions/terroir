-- Focused acceptance for 0066_confirm_bottle_scan_idempotency.sql.
-- Run only against an isolated database with migrations through 0066:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v dblink_conn="$DATABASE_URL" \
--     -f supabase/tests/0066_confirm_bottle_scan_idempotency.sql

\if :{?dblink_conn}
\else
\echo '0066 acceptance requires -v dblink_conn=<password-authenticated database URL>'
\quit 2
\endif

create extension if not exists dblink with schema extensions;

drop trigger if exists reject_bottle_confirmation_0066
  on public.api_idempotency;
drop trigger if exists delay_bottle_confirmation_0066
  on public.api_idempotency;
drop function if exists public.reject_bottle_confirmation_0066();
drop function if exists public.delay_bottle_confirmation_0066();

delete from public.restaurants
where id in (
  '64100000-0000-4000-8000-000000000001',
  '64100000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  '64000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000002'
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

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '64000000-0000-4000-8000-000000000001',
    'staff-0066@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '64000000-0000-4000-8000-000000000002',
    'outsider-0066@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '64100000-0000-4000-8000-000000000001',
    'Atomic Bottle Confirmation A'
  ),
  (
    '64100000-0000-4000-8000-000000000002',
    'Atomic Bottle Confirmation B'
  );

insert into public.memberships (
  user_id,
  restaurant_id,
  role
) values (
  '64000000-0000-4000-8000-000000000001',
  '64100000-0000-4000-8000-000000000001',
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
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000001',
    'Keyless Confirmation',
    '0066 Producer',
    750
  ),
  (
    '64200000-0000-4000-8000-000000000002',
    '64100000-0000-4000-8000-000000000002',
    'Foreign Confirmation',
    '0066 Producer',
    750
  ),
  (
    '64200000-0000-4000-8000-000000000003',
    '64100000-0000-4000-8000-000000000001',
    'Replay Confirmation',
    '0066 Producer',
    750
  ),
  (
    '64200000-0000-4000-8000-000000000004',
    '64100000-0000-4000-8000-000000000001',
    'Rollback Confirmation',
    '0066 Producer',
    750
  ),
  (
    '64200000-0000-4000-8000-000000000005',
    '64100000-0000-4000-8000-000000000001',
    'Concurrent Confirmation',
    '0066 Producer',
    750
  ),
  (
    '64200000-0000-4000-8000-00000000000a',
    '64100000-0000-4000-8000-000000000001',
    'Canonical UUID Confirmation',
    '0066 Producer',
    750
  );

-- Exact privileges and hardened execution context.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.confirm_bottle_scan_idempotent(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains bottle confirmation execution';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.confirm_bottle_scan_idempotent(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks bottle confirmation execution';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid = to_regprocedure(
      'public.confirm_bottle_scan_idempotent(uuid,uuid,text,text,text,text)'
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'bottle confirmation execution context is not hardened';
  end if;
end;
$$;

-- Unauthenticated and non-member callers cannot create or classify claims.
select set_config('request.jwt.claim.sub', '', false);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.confirm_bottle_scan_idempotent(
      '64100000-0000-4000-8000-000000000001',
      '64200000-0000-4000-8000-000000000001',
      'Reds',
      'A-1'
    )
  $sql$,
  '42501'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000002',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.confirm_bottle_scan_idempotent(
      '64100000-0000-4000-8000-000000000001',
      '64200000-0000-4000-8000-000000000001',
      'Reds',
      'A-1',
      'outsider_key_0066',
      'fc1bb0b4d8227a969933ff34dc7d0b5ba035446e45bfc27926ded32c4b646f33'
    )
  $sql$,
  '42501'
);
reset role;

-- Keyless behavior preserves the 201 shape and creates no idempotency claim.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into strict v_result
  from public.confirm_bottle_scan_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-000000000001',
    'Reds',
    'A-1'
  );

  if v_result.outcome <> 'confirmed'
     or v_result.response_status <> 201
     or v_result.replayed
     or v_result.response_body ->> 'wine_id'
          <> '64200000-0000-4000-8000-000000000001'
     or v_result.response_body ->> 'section' <> 'Reds'
     or v_result.response_body ->> 'bin_location' <> 'A-1' then
    raise exception 'keyless confirmation is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;
reset role;

do $$
begin
  if (
    select count(*)
    from public.inventory_items
    where wine_id = '64200000-0000-4000-8000-000000000001'
      and restaurant_id = '64100000-0000-4000-8000-000000000001'
  ) <> 1 or exists (
    select 1
    from public.api_idempotency
    where user_id = '64000000-0000-4000-8000-000000000001'
      and operation_id = 'api:POST:/api/scan-bottle/confirm'
  ) then
    raise exception 'keyless confirmation created the wrong state';
  end if;
end;
$$;

-- The route lowercases UUID text before hashing, matching PostgreSQL's
-- canonical uuid::text reconstruction even when the inbound spelling is upper-case.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into strict v_result
  from public.confirm_bottle_scan_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-00000000000A',
    'Reds',
    'A-2',
    'uppercase_uuid_key_0066',
    'b887473548f03c60b80f4e75d54f0390dbb943956b445fb70e2882b4d1bce6c9'
  );

  if v_result.outcome <> 'confirmed'
     or v_result.response_status <> 201
     or v_result.response_body ->> 'wine_id'
          <> '64200000-0000-4000-8000-00000000000a' then
    raise exception 'upper-case UUID canonicalization drifted: %',
      row_to_json(v_result);
  end if;
end;
$$;
reset role;

-- A foreign wine is an opaque, replayable 404 with no inventory write.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into strict v_fresh
  from public.confirm_bottle_scan_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-000000000002',
    'Reds',
    'A-1',
    'foreign_key_0066',
    '7d8f66f9ebec022a8567fa98ddca2c881c16c72bb0a4e99febea90126b185f0c'
  );
  select * into strict v_replay
  from public.confirm_bottle_scan_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-000000000002',
    'Reds',
    'A-1',
    'foreign_key_0066',
    '7d8f66f9ebec022a8567fa98ddca2c881c16c72bb0a4e99febea90126b185f0c'
  );
  if v_fresh.outcome <> 'wine_not_found'
     or v_fresh.response_status <> 404
     or v_fresh.response_body #>> '{error,code}' <> 'wine_not_found'
     or v_replay.outcome <> 'replay'
     or not v_replay.replayed
     or v_replay.response_body <> v_fresh.response_body
     or v_replay.execution_started_at <> v_fresh.execution_started_at then
    raise exception 'foreign confirmation/replay leaked or drifted';
  end if;
end;
$$;
reset role;

-- Exact success replay stores one row and rejects a different identity.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_fresh record;
  v_replay record;
  v_mismatch record;
begin
  select * into strict v_fresh
  from public.confirm_bottle_scan_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-000000000003',
    'Vault',
    'B-2',
    'confirm_replay_key_0066',
    '118421104a883997f7b9c253cf12f78c747b1fa4acb2dcb2909858c7793a546a'
  );
  select * into strict v_replay
  from public.confirm_bottle_scan_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-000000000003',
    'Vault',
    'B-2',
    'confirm_replay_key_0066',
    '118421104a883997f7b9c253cf12f78c747b1fa4acb2dcb2909858c7793a546a'
  );
  select * into strict v_mismatch
  from public.confirm_bottle_scan_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-000000000001',
    'Vault',
    'B-2',
    'confirm_replay_key_0066',
    'b05098f407446bf712b25af039a47c0afd29ce5d13527deb9cf090bf93554396'
  );

  if v_fresh.outcome <> 'confirmed'
     or v_fresh.response_status <> 201
     or v_replay.outcome <> 'replay'
     or not v_replay.replayed
     or v_replay.response_body <> v_fresh.response_body
     or v_replay.execution_started_at <> v_fresh.execution_started_at
     or v_mismatch.outcome <> 'idempotency_key_reused'
     or v_mismatch.response_status <> 409 then
    raise exception 'exact replay or mismatch classification failed';
  end if;
end;
$$;
reset role;

do $$
begin
  if (
    select count(*)
    from public.inventory_items
    where wine_id = '64200000-0000-4000-8000-000000000003'
      and restaurant_id = '64100000-0000-4000-8000-000000000001'
  ) <> 1 then
    raise exception 'exact replay duplicated confirmation inventory';
  end if;
end;
$$;

-- Completion failure rolls back both the inventory insert and its claim.
create or replace function public.reject_bottle_confirmation_0066()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0066 idempotency completion failure';
end;
$$;

create trigger reject_bottle_confirmation_0066
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'confirm_rollback_key_0066')
execute function public.reject_bottle_confirmation_0066();

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.confirm_bottle_scan_idempotent(
      '64100000-0000-4000-8000-000000000001',
      '64200000-0000-4000-8000-000000000004',
      'Rollback',
      'R-1',
      'confirm_rollback_key_0066',
      '9c2e8c70ea2bea1efcfba649852384622caabb6398de8f897239fbf458f923ed'
    )
  $sql$,
  'XX000'
);
reset role;

drop trigger reject_bottle_confirmation_0066
  on public.api_idempotency;

do $$
begin
  if exists (
    select 1
    from public.inventory_items
    where wine_id = '64200000-0000-4000-8000-000000000004'
  ) or exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'confirm_rollback_key_0066'
  ) then
    raise exception 'completion failure leaked inventory or claim';
  end if;
end;
$$;

-- Real same-key concurrency: one statement commits the insert, the other
-- waits on the key and returns the exact stored response.
create or replace function public.delay_bottle_confirmation_0066()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_sleep(0.75);
  return new;
end;
$$;

create trigger delay_bottle_confirmation_0066
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'confirm_concurrent_key_0066')
execute function public.delay_bottle_confirmation_0066();

select extensions.dblink_connect('confirm_0066_a', :'dblink_conn');
select extensions.dblink_connect('confirm_0066_b', :'dblink_conn');
select extensions.dblink_exec(
  'confirm_0066_a',
  $sql$
    set "request.jwt.claim.sub" =
      '64000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec(
  'confirm_0066_b',
  $sql$
    set "request.jwt.claim.sub" =
      '64000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec('confirm_0066_a', 'set role authenticated');
select extensions.dblink_exec('confirm_0066_b', 'set role authenticated');
select extensions.dblink_send_query(
  'confirm_0066_a',
  $sql$
    select row_to_json(result)::text
    from public.confirm_bottle_scan_idempotent(
      '64100000-0000-4000-8000-000000000001',
      '64200000-0000-4000-8000-000000000005',
      'Concurrency',
      'C-3',
      'confirm_concurrent_key_0066',
      '767b64ef48e6112c03654b5b802e3299f44e48db60233fdc3b3c4e5acca7c3a0'
    ) as result
  $sql$
);
select extensions.dblink_send_query(
  'confirm_0066_b',
  $sql$
    select row_to_json(result)::text
    from public.confirm_bottle_scan_idempotent(
      '64100000-0000-4000-8000-000000000001',
      '64200000-0000-4000-8000-000000000005',
      'Concurrency',
      'C-3',
      'confirm_concurrent_key_0066',
      '767b64ef48e6112c03654b5b802e3299f44e48db60233fdc3b3c4e5acca7c3a0'
    ) as result
  $sql$
);

create temporary table confirm_0066_concurrency_results (
  payload jsonb not null
);
insert into confirm_0066_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('confirm_0066_a')
  as result(payload text);
insert into confirm_0066_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('confirm_0066_b')
  as result(payload text);
select extensions.dblink_disconnect('confirm_0066_a');
select extensions.dblink_disconnect('confirm_0066_b');

drop trigger delay_bottle_confirmation_0066
  on public.api_idempotency;

do $$
declare
  v_fresh jsonb;
  v_replay jsonb;
begin
  if (
    select count(*)
    from confirm_0066_concurrency_results
    where payload ->> 'outcome' = 'confirmed'
  ) <> 1 or (
    select count(*)
    from confirm_0066_concurrency_results
    where payload ->> 'outcome' = 'replay'
  ) <> 1 or (
    select count(*)
    from public.inventory_items
    where wine_id = '64200000-0000-4000-8000-000000000005'
      and restaurant_id = '64100000-0000-4000-8000-000000000001'
  ) <> 1 then
    raise exception 'same-key concurrency duplicated confirmation: %',
      (select jsonb_agg(payload)
       from confirm_0066_concurrency_results);
  end if;

  select payload into strict v_fresh
  from confirm_0066_concurrency_results
  where payload ->> 'outcome' = 'confirmed';
  select payload into strict v_replay
  from confirm_0066_concurrency_results
  where payload ->> 'outcome' = 'replay';
  if v_fresh -> 'response_body' <> v_replay -> 'response_body'
     or v_fresh ->> 'execution_started_at'
          <> v_replay ->> 'execution_started_at' then
    raise exception 'concurrent confirmation replay was not exact';
  end if;
end;
$$;

drop function public.reject_bottle_confirmation_0066();
drop function public.delay_bottle_confirmation_0066();

delete from public.restaurants
where id in (
  '64100000-0000-4000-8000-000000000001',
  '64100000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  '64000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000002'
);

select '0066 bottle confirmation idempotency acceptance passed' as result;
