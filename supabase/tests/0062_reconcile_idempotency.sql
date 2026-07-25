-- Focused acceptance test for 0062_reconcile_idempotency.sql.
-- Run only against an isolated database with migrations through 0062 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v dblink_conn="$DATABASE_URL" \
--     -f supabase/tests/0062_reconcile_idempotency.sql
--
-- Fixtures are committed so independent dblink sessions can overlap. Every
-- fixed-ID fixture and temporary trigger/function is removed before and after.

\if :{?dblink_conn}
\else
\echo '0062 acceptance requires -v dblink_conn=<password-authenticated database URL>'
\quit 2
\endif

create extension if not exists dblink with schema extensions;

drop trigger if exists reject_reconcile_completion_0062
  on public.api_idempotency;
drop trigger if exists delay_reconcile_completion_0062
  on public.api_idempotency;
drop function if exists public.reject_reconcile_completion_0062();
drop function if exists public.delay_reconcile_completion_0062();

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

-- Independent test-side implementation of the route's canonical JSON framing.
create or replace function pg_temp.reconcile_hash(p_entries jsonb)
returns text
language plpgsql
as $$
declare
  v_entry jsonb;
  v_items text := '';
  v_item text;
  v_body text;
begin
  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    v_item :=
      '{"new_remaining_ml":'
      || ((v_entry ->> 'new_remaining_ml')::integer)::text;
    if v_entry ? 'note' then
      v_item := v_item || ',"note":' || to_jsonb(v_entry ->> 'note')::text;
    end if;
    v_item :=
      v_item
      || ',"wine_id":'
      || to_jsonb(lower((v_entry ->> 'wine_id')::uuid::text))::text
      || '}';
    v_items :=
      v_items || case when v_items = '' then '' else ',' end || v_item;
  end loop;
  v_body := '{"entries":[' || v_items || ']}';
  return encode(
    extensions.digest(
      decode(
        lpad(to_hex(octet_length(convert_to(v_body, 'UTF8'))), 16, '0'),
        'hex'
      ) || convert_to(v_body, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
end;
$$;

delete from public.restaurants
where id in (
  '62100000-0000-4000-8000-000000000001',
  '62100000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  '62000000-0000-4000-8000-000000000001',
  '62000000-0000-4000-8000-000000000002',
  '62000000-0000-4000-8000-000000000003'
);

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '62000000-0000-4000-8000-000000000001',
    'manager-0062@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '62000000-0000-4000-8000-000000000002',
    'staff-0062@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '62000000-0000-4000-8000-000000000003',
    'outsider-0062@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '62100000-0000-4000-8000-000000000001',
    'Atomic Reconcile Restaurant A'
  ),
  (
    '62100000-0000-4000-8000-000000000002',
    'Atomic Reconcile Restaurant B'
  );

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '62000000-0000-4000-8000-000000000001',
    '62100000-0000-4000-8000-000000000001',
    'manager'
  ),
  (
    '62000000-0000-4000-8000-000000000002',
    '62100000-0000-4000-8000-000000000001',
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
    '62200000-0000-4000-8000-000000000001',
    '62100000-0000-4000-8000-000000000001',
    'Successful Batch A',
    '0062 Producer',
    750
  ),
  (
    '62200000-0000-4000-8000-000000000002',
    '62100000-0000-4000-8000-000000000001',
    'Successful Batch B',
    '0062 Producer',
    750
  ),
  (
    '62200000-0000-4000-8000-000000000003',
    '62100000-0000-4000-8000-000000000001',
    'Exceeds Size',
    '0062 Producer',
    750
  ),
  (
    '62200000-0000-4000-8000-000000000004',
    '62100000-0000-4000-8000-000000000001',
    'Concurrent Batch',
    '0062 Producer',
    750
  ),
  (
    '62200000-0000-4000-8000-000000000005',
    '62100000-0000-4000-8000-000000000001',
    'Completion Rollback',
    '0062 Producer',
    750
  ),
  (
    '62200000-0000-4000-8000-000000000006',
    '62100000-0000-4000-8000-000000000002',
    'Other Tenant',
    '0062 Producer',
    750
  ),
  (
    '62200000-0000-4000-8000-000000000007',
    '62100000-0000-4000-8000-000000000001',
    'Ordered Duplicate Entries',
    '0062 Producer',
    750
  );

insert into public.open_bottles (
  id,
  wine_id,
  restaurant_id,
  remaining_ml,
  opened_at,
  opened_by
) values
  (
    '62300000-0000-4000-8000-000000000001',
    '62200000-0000-4000-8000-000000000001',
    '62100000-0000-4000-8000-000000000001',
    650,
    '2026-07-24 18:00:00+00',
    '62000000-0000-4000-8000-000000000001'
  ),
  (
    '62300000-0000-4000-8000-000000000002',
    '62200000-0000-4000-8000-000000000002',
    '62100000-0000-4000-8000-000000000001',
    600,
    '2026-07-24 18:01:00+00',
    '62000000-0000-4000-8000-000000000001'
  ),
  (
    '62300000-0000-4000-8000-000000000003',
    '62200000-0000-4000-8000-000000000003',
    '62100000-0000-4000-8000-000000000001',
    700,
    '2026-07-24 18:02:00+00',
    '62000000-0000-4000-8000-000000000001'
  ),
  (
    '62300000-0000-4000-8000-000000000004',
    '62200000-0000-4000-8000-000000000004',
    '62100000-0000-4000-8000-000000000001',
    500,
    '2026-07-24 18:03:00+00',
    '62000000-0000-4000-8000-000000000001'
  ),
  (
    '62300000-0000-4000-8000-000000000005',
    '62200000-0000-4000-8000-000000000005',
    '62100000-0000-4000-8000-000000000001',
    400,
    '2026-07-24 18:04:00+00',
    '62000000-0000-4000-8000-000000000001'
  ),
  (
    '62300000-0000-4000-8000-000000000006',
    '62200000-0000-4000-8000-000000000006',
    '62100000-0000-4000-8000-000000000002',
    550,
    '2026-07-24 18:05:00+00',
    null
  ),
  (
    '62300000-0000-4000-8000-000000000007',
    '62200000-0000-4000-8000-000000000007',
    '62100000-0000-4000-8000-000000000001',
    500,
    '2026-07-24 18:06:00+00',
    '62000000-0000-4000-8000-000000000001'
  );

-- The boundary is authenticated-only, manager/tenant checked, SECURITY
-- DEFINER with an empty search_path, and exposes no public/anon execution.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.reconcile_open_bottles_idempotent(uuid,jsonb,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains reconcile idempotency execution';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.reconcile_open_bottles_idempotent(uuid,jsonb,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks reconcile idempotency execution';
  end if;
  if exists (
    select 1
    from pg_proc
    where oid = to_regprocedure(
      'public.reconcile_open_bottles_idempotent(uuid,jsonb,text,text)'
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'reconcile idempotency boundary is not hardened';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', false);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.reconcile_open_bottles_idempotent(
      '62100000-0000-4000-8000-000000000001',
      '[{"wine_id":"62200000-0000-4000-8000-000000000001","new_remaining_ml":500}]',
      'reconcile_unauth_0062',
      repeat('0', 64)
    )
  $sql$,
  '42501'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '62000000-0000-4000-8000-000000000002',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.reconcile_open_bottles_idempotent(
      '62100000-0000-4000-8000-000000000001',
      '[{"wine_id":"62200000-0000-4000-8000-000000000001","new_remaining_ml":500}]'
    )
  $sql$,
  '42501'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '62000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.reconcile_open_bottles_idempotent(
      '62100000-0000-4000-8000-000000000002',
      '[{"wine_id":"62200000-0000-4000-8000-000000000006","new_remaining_ml":500}]'
    )
  $sql$,
  '42501'
);
reset role;

-- This known value was produced by the TypeScript framed canonical JSON
-- contract, proving SQL includes array order, optional note presence, and all
-- normalized fields rather than trusting an arbitrary client hash.
do $$
declare
  v_entries jsonb := '[
    {
      "wine_id":"62200000-0000-4000-8000-000000000001",
      "new_remaining_ml":500,
      "note":"counted"
    },
    {
      "wine_id":"62200000-0000-4000-8000-000000000002",
      "new_remaining_ml":0
    }
  ]'::jsonb;
begin
  if pg_temp.reconcile_hash(v_entries)
       <> 'a168e46c455a9e14ee35743012da4310696854d4407af73567293d78ea2c8c98' then
    raise exception 'test-side canonical framed hash drifted';
  end if;
  if pg_temp.reconcile_hash(v_entries) = pg_temp.reconcile_hash(
    jsonb_build_array(v_entries -> 1, v_entries -> 0)
  ) then
    raise exception 'ordered request identity ignored array order';
  end if;
end;
$$;

-- A successful multi-entry command commits every mutation, pour event,
-- availability event, and exact response once. A lost-response retry replays.
select set_config(
  'request.jwt.claim.sub',
  '62000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_rpc_entries jsonb := '[
    {
      "wine_id":"62200000-0000-4000-8000-000000000001",
      "new_remaining_ml":500,
      "note":"  counted  "
    },
    {
      "wine_id":"62200000-0000-4000-8000-000000000002",
      "new_remaining_ml":0
    }
  ]'::jsonb;
  v_hash_entries jsonb := '[
    {
      "wine_id":"62200000-0000-4000-8000-000000000001",
      "new_remaining_ml":500,
      "note":"counted"
    },
    {
      "wine_id":"62200000-0000-4000-8000-000000000002",
      "new_remaining_ml":0
    }
  ]'::jsonb;
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_rpc_entries,
    'reconcile_success_key_0062',
    pg_temp.reconcile_hash(v_hash_entries)
  );
  select * into v_replay
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_rpc_entries,
    'reconcile_success_key_0062',
    pg_temp.reconcile_hash(v_hash_entries)
  );

  if v_fresh.outcome <> 'reconciled'
     or v_fresh.response_status <> 200
     or v_fresh.response_body <> '{"updated":2}'::jsonb
     or v_fresh.replayed
     or v_replay.outcome <> 'replay'
     or v_replay.response_status <> 200
     or v_replay.response_body <> v_fresh.response_body
     or v_replay.execution_started_at <> v_fresh.execution_started_at
     or not v_replay.replayed then
    raise exception 'success/replay responses are malformed: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select remaining_ml from public.open_bottles
    where wine_id = '62200000-0000-4000-8000-000000000001'
  ) <> 500 or (
    select remaining_ml from public.open_bottles
    where wine_id = '62200000-0000-4000-8000-000000000002'
  ) <> 0 then
    raise exception 'successful reconcile did not apply both entries';
  end if;
  if (
    select count(*) from public.pour_events
    where wine_id in (
      '62200000-0000-4000-8000-000000000001',
      '62200000-0000-4000-8000-000000000002'
    )
      and kind = 'reconcile'
  ) <> 2 or (
    select count(*) from public.availability_events
    where wine_id in (
      '62200000-0000-4000-8000-000000000001',
      '62200000-0000-4000-8000-000000000002'
    )
      and direction = 'reconcile'
  ) <> 2 then
    raise exception 'replay duplicated or omitted reconcile side effects';
  end if;
  if not exists (
    select 1 from public.pour_events
    where wine_id = '62200000-0000-4000-8000-000000000001'
      and kind = 'reconcile'
      and ml_delta = 150
      and note = 'counted'
  ) or not exists (
    select 1 from public.availability_events
    where wine_id = '62200000-0000-4000-8000-000000000002'
      and direction = 'reconcile'
      and delta = 600
  ) then
    raise exception 'reconcile side-effect values are incorrect';
  end if;
end;
$$;

-- Duplicate wine IDs are distinct ordered commands, not a set. Both entries
-- execute in array order and contribute to the reported count.
do $$
declare
  v_entries jsonb := '[
    {
      "wine_id":"62200000-0000-4000-8000-000000000007",
      "new_remaining_ml":400,
      "note":"first duplicate"
    },
    {
      "wine_id":"62200000-0000-4000-8000-000000000007",
      "new_remaining_ml":350,
      "note":"second duplicate"
    }
  ]'::jsonb;
  v_result record;
begin
  select * into v_result
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_entries,
    'reconcile_duplicate_key_0062',
    pg_temp.reconcile_hash(v_entries)
  );
  if v_result.outcome <> 'reconciled'
     or v_result.response_body <> '{"updated":2}'::jsonb
     or (
       select remaining_ml from public.open_bottles
       where wine_id = '62200000-0000-4000-8000-000000000007'
     ) <> 350 or (
       select count(*) from public.pour_events
       where wine_id = '62200000-0000-4000-8000-000000000007'
         and kind = 'reconcile'
     ) <> 2 or not exists (
       select 1 from public.pour_events
       where wine_id = '62200000-0000-4000-8000-000000000007'
         and note = 'first duplicate'
         and ml_delta = 100
     ) or not exists (
       select 1 from public.pour_events
       where wine_id = '62200000-0000-4000-8000-000000000007'
         and note = 'second duplicate'
         and ml_delta = 50
     ) then
    raise exception 'ordered duplicate entries were deduplicated or reordered';
  end if;
end;
$$;

-- Same key with a newly hashed changed ordered body is a 409 conflict. An
-- arbitrary hash that does not match the supplied body is rejected pre-claim.
select set_config(
  'request.jwt.claim.sub',
  '62000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_changed jsonb := '[
    {
      "wine_id":"62200000-0000-4000-8000-000000000001",
      "new_remaining_ml":450,
      "note":"second"
    }
  ]'::jsonb;
  v_result record;
begin
  select * into v_result
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_changed,
    'reconcile_success_key_0062',
    pg_temp.reconcile_hash(v_changed)
  );
  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused'
     or v_result.replayed then
    raise exception 'changed request did not conflict: %',
      row_to_json(v_result);
  end if;
end;
$$;

select pg_temp.expect_failure(
  $sql$
    select * from public.reconcile_open_bottles_idempotent(
      '62100000-0000-4000-8000-000000000001',
      '[{"wine_id":"62200000-0000-4000-8000-000000000003","new_remaining_ml":751}]',
      'reconcile_bad_hash_0062',
      repeat('f', 64)
    )
  $sql$,
  '22023'
);
reset role;

-- Deterministic size and missing-target responses are completed and replayed
-- exactly. The two-entry missing-target batch proves earlier work rolls back.
select set_config(
  'request.jwt.claim.sub',
  '62000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_entries jsonb := '[
    {
      "wine_id":"62200000-0000-4000-8000-000000000003",
      "new_remaining_ml":751
    }
  ]'::jsonb;
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_entries,
    'reconcile_400_key_0062',
    pg_temp.reconcile_hash(v_entries)
  );
  select * into v_replay
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_entries,
    'reconcile_400_key_0062',
    pg_temp.reconcile_hash(v_entries)
  );
  if v_fresh.outcome <> 'exceeds_size'
     or v_fresh.response_status <> 400
     or v_fresh.response_body <> '{
       "error":{
         "code":"EXCEEDS_SIZE",
         "message":"new_remaining_ml exceeds bottle size."
       }
     }'::jsonb
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed then
    raise exception '400 response/replay is malformed';
  end if;
end;
$$;

reset role;

do $$
declare
  v_entries jsonb := '[
    {
      "wine_id":"62200000-0000-4000-8000-000000000001",
      "new_remaining_ml":450
    },
    {
      "wine_id":"62200000-0000-4000-8000-000000000099",
      "new_remaining_ml":10
    }
  ]'::jsonb;
  v_before_events integer;
  v_fresh record;
  v_replay record;
begin
  select count(*) into v_before_events
  from public.pour_events
  where wine_id = '62200000-0000-4000-8000-000000000001';

  select * into v_fresh
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_entries,
    'reconcile_404_key_0062',
    pg_temp.reconcile_hash(v_entries)
  );
  select * into v_replay
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_entries,
    'reconcile_404_key_0062',
    pg_temp.reconcile_hash(v_entries)
  );
  if v_fresh.outcome <> 'not_found'
     or v_fresh.response_status <> 404
     or v_fresh.response_body <> '{
       "error":{
         "code":"not_found",
         "message":"Open bottle not found."
       }
     }'::jsonb
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed then
    raise exception '404 response/replay is malformed';
  end if;
  if (
    select remaining_ml from public.open_bottles
    where wine_id = '62200000-0000-4000-8000-000000000001'
  ) <> 500 or (
    select count(*) from public.pour_events
    where wine_id = '62200000-0000-4000-8000-000000000001'
  ) <> v_before_events then
    raise exception 'failed multi-entry batch leaked its earlier mutation';
  end if;
end;
$$;

reset role;

-- Force completion failure after business work. The entire claim and batch
-- must roll back, then the same request/key may execute and replay once.
create or replace function public.reject_reconcile_completion_0062()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0062 reconcile completion failure';
end;
$$;

create trigger reject_reconcile_completion_0062
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'reconcile_rollback_key_0062')
execute function public.reject_reconcile_completion_0062();

select set_config(
  'request.jwt.claim.sub',
  '62000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.reconcile_open_bottles_idempotent(
      '62100000-0000-4000-8000-000000000001',
      '[{"wine_id":"62200000-0000-4000-8000-000000000005","new_remaining_ml":250,"note":"rollback"}]',
      'reconcile_rollback_key_0062',
      '8f279d65a37d8d2fe806601afe1b99763347c680e303452279c90dcd1c650725'
    )
  $sql$,
  'XX000'
);
reset role;

drop trigger reject_reconcile_completion_0062
  on public.api_idempotency;

do $$
begin
  if (
    select remaining_ml from public.open_bottles
    where wine_id = '62200000-0000-4000-8000-000000000005'
  ) <> 400 or exists (
    select 1 from public.pour_events
    where wine_id = '62200000-0000-4000-8000-000000000005'
      and kind = 'reconcile'
  ) or exists (
    select 1 from public.availability_events
    where wine_id = '62200000-0000-4000-8000-000000000005'
      and direction = 'reconcile'
  ) or exists (
    select 1 from public.api_idempotency
    where user_id = '62000000-0000-4000-8000-000000000001'
      and idempotency_key = 'reconcile_rollback_key_0062'
  ) then
    raise exception 'completion failure leaked business or claim state';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '62000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_entries jsonb := '[
    {
      "wine_id":"62200000-0000-4000-8000-000000000005",
      "new_remaining_ml":250,
      "note":"rollback"
    }
  ]'::jsonb;
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_entries,
    'reconcile_rollback_key_0062',
    pg_temp.reconcile_hash(v_entries)
  );
  select * into v_replay
  from public.reconcile_open_bottles_idempotent(
    '62100000-0000-4000-8000-000000000001',
    v_entries,
    'reconcile_rollback_key_0062',
    pg_temp.reconcile_hash(v_entries)
  );
  if v_fresh.outcome <> 'reconciled'
     or v_fresh.response_body <> '{"updated":1}'::jsonb
     or v_fresh.replayed
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed then
    raise exception 'post-rollback retry/replay is malformed';
  end if;
end;
$$;
reset role;

do $$
begin
  if (
    select remaining_ml from public.open_bottles
    where wine_id = '62200000-0000-4000-8000-000000000005'
  ) <> 250 or (
    select count(*) from public.pour_events
    where wine_id = '62200000-0000-4000-8000-000000000005'
      and kind = 'reconcile'
  ) <> 1 or (
    select count(*) from public.availability_events
    where wine_id = '62200000-0000-4000-8000-000000000005'
      and direction = 'reconcile'
  ) <> 1 then
    raise exception 'post-rollback replay duplicated business effects';
  end if;
end;
$$;

-- Delay first completion and overlap two real authenticated sessions. The
-- second caller waits on the caller/key lock and replays the exact response.
create or replace function public.delay_reconcile_completion_0062()
returns trigger
language plpgsql
as $$
begin
  perform pg_sleep(0.75);
  return new;
end;
$$;

create trigger delay_reconcile_completion_0062
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'reconcile_concurrent_key_0062')
execute function public.delay_reconcile_completion_0062();

select extensions.dblink_connect('reconcile_0062_a', :'dblink_conn');
select extensions.dblink_connect('reconcile_0062_b', :'dblink_conn');
select extensions.dblink_exec(
  'reconcile_0062_a',
  $sql$
    set "request.jwt.claim.sub" =
      '62000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec(
  'reconcile_0062_b',
  $sql$
    set "request.jwt.claim.sub" =
      '62000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec('reconcile_0062_a', 'set role authenticated');
select extensions.dblink_exec('reconcile_0062_b', 'set role authenticated');

select extensions.dblink_send_query(
  'reconcile_0062_a',
  $sql$
    select row_to_json(result)::text
    from public.reconcile_open_bottles_idempotent(
      '62100000-0000-4000-8000-000000000001',
      '[{"wine_id":"62200000-0000-4000-8000-000000000004","new_remaining_ml":300}]',
      'reconcile_concurrent_key_0062',
      '4d027b6e515dd83274806ff257b82d7e8780a64e6e25ccefdc53bd60f008cd80'
    ) as result
  $sql$
);
select extensions.dblink_send_query(
  'reconcile_0062_b',
  $sql$
    select row_to_json(result)::text
    from public.reconcile_open_bottles_idempotent(
      '62100000-0000-4000-8000-000000000001',
      '[{"wine_id":"62200000-0000-4000-8000-000000000004","new_remaining_ml":300}]',
      'reconcile_concurrent_key_0062',
      '4d027b6e515dd83274806ff257b82d7e8780a64e6e25ccefdc53bd60f008cd80'
    ) as result
  $sql$
);

create temporary table reconcile_0062_concurrency_results (
  payload jsonb not null
);
insert into reconcile_0062_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('reconcile_0062_a')
  as result(payload text);
insert into reconcile_0062_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('reconcile_0062_b')
  as result(payload text);

select extensions.dblink_disconnect('reconcile_0062_a');
select extensions.dblink_disconnect('reconcile_0062_b');
drop trigger delay_reconcile_completion_0062
  on public.api_idempotency;

do $$
declare
  v_fresh jsonb;
  v_replay jsonb;
begin
  if (
    select count(*) from reconcile_0062_concurrency_results
  ) <> 2 or (
    select count(*) from reconcile_0062_concurrency_results
    where payload ->> 'outcome' = 'reconciled'
      and not (payload ->> 'replayed')::boolean
  ) <> 1 or (
    select count(*) from reconcile_0062_concurrency_results
    where payload ->> 'outcome' = 'replay'
      and (payload ->> 'replayed')::boolean
  ) <> 1 then
    raise exception 'concurrent outcomes are malformed: %',
      (select jsonb_agg(payload) from reconcile_0062_concurrency_results);
  end if;
  select payload into strict v_fresh
  from reconcile_0062_concurrency_results
  where payload ->> 'outcome' = 'reconciled';
  select payload into strict v_replay
  from reconcile_0062_concurrency_results
  where payload ->> 'outcome' = 'replay';
  if v_fresh -> 'response_body' <> v_replay -> 'response_body' then
    raise exception 'concurrent replay changed the exact response';
  end if;
  if v_fresh ->> 'execution_started_at'
       <> v_replay ->> 'execution_started_at' then
    raise exception 'concurrent replay changed the execution timestamp';
  end if;
  if (
    select remaining_ml from public.open_bottles
    where wine_id = '62200000-0000-4000-8000-000000000004'
  ) <> 300 or (
    select count(*) from public.pour_events
    where wine_id = '62200000-0000-4000-8000-000000000004'
      and kind = 'reconcile'
  ) <> 1 or (
    select count(*) from public.availability_events
    where wine_id = '62200000-0000-4000-8000-000000000004'
      and direction = 'reconcile'
  ) <> 1 then
    raise exception 'concurrent retry duplicated reconcile effects';
  end if;
end;
$$;

drop function public.reject_reconcile_completion_0062();
drop function public.delay_reconcile_completion_0062();

delete from public.restaurants
where id in (
  '62100000-0000-4000-8000-000000000001',
  '62100000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  '62000000-0000-4000-8000-000000000001',
  '62000000-0000-4000-8000-000000000002',
  '62000000-0000-4000-8000-000000000003'
);

select '0062 reconcile idempotency acceptance passed' as result;
