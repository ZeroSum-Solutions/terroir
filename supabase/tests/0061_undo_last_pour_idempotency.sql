-- Focused acceptance test for 0061_undo_last_pour_idempotency.sql.
-- Run only against an isolated database with migrations through 0061 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v dblink_conn="$DATABASE_URL" \
--     -f supabase/tests/0061_undo_last_pour_idempotency.sql
--
-- This test commits its fixtures so independent dblink sessions can exercise
-- real concurrency. It removes all fixed-ID fixtures before and after.

\if :{?dblink_conn}
\else
\echo '0061 acceptance requires -v dblink_conn=<password-authenticated database URL>'
\quit 2
\endif

create extension if not exists dblink with schema extensions;

drop trigger if exists reject_undo_completion_0061
  on public.api_idempotency;
drop trigger if exists delay_undo_completion_0061
  on public.api_idempotency;
drop function if exists public.reject_undo_completion_0061();
drop function if exists public.delay_undo_completion_0061();

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

delete from public.restaurants
where id in (
  '61100000-0000-4000-8000-000000000001',
  '61100000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000002'
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
    '61000000-0000-4000-8000-000000000001',
    'staff-0061@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '61000000-0000-4000-8000-000000000002',
    'outsider-0061@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '61100000-0000-4000-8000-000000000001',
    'Atomic Undo Restaurant A'
  ),
  (
    '61100000-0000-4000-8000-000000000002',
    'Atomic Undo Restaurant B'
  );

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '61000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'staff'
  ),
  (
    '61000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000002',
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
    '61200000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'Dropped Response Undo',
    '0061 Producer',
    750
  ),
  (
    '61200000-0000-4000-8000-000000000002',
    '61100000-0000-4000-8000-000000000001',
    'Rollback Undo',
    '0061 Producer',
    750
  ),
  (
    '61200000-0000-4000-8000-000000000003',
    '61100000-0000-4000-8000-000000000001',
    'Concurrent Undo',
    '0061 Producer',
    750
  ),
  (
    '61200000-0000-4000-8000-000000000004',
    '61100000-0000-4000-8000-000000000001',
    'No Pour Undo',
    '0061 Producer',
    750
  ),
  (
    '61200000-0000-4000-8000-000000000005',
    '61100000-0000-4000-8000-000000000002',
    'Other Tenant Undo',
    '0061 Producer',
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
    '61300000-0000-4000-8000-000000000001',
    '61200000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    1,
    20,
    now()
  ),
  (
    '61300000-0000-4000-8000-000000000002',
    '61200000-0000-4000-8000-000000000002',
    '61100000-0000-4000-8000-000000000001',
    1,
    21,
    now()
  ),
  (
    '61300000-0000-4000-8000-000000000003',
    '61200000-0000-4000-8000-000000000003',
    '61100000-0000-4000-8000-000000000001',
    1,
    22,
    now()
  ),
  (
    '61300000-0000-4000-8000-000000000005',
    '61200000-0000-4000-8000-000000000005',
    '61100000-0000-4000-8000-000000000002',
    1,
    23,
    now()
  );

-- Seed multiple historical pours through the canonical RPC.
select set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

select public.record_pour(
  '61100000-0000-4000-8000-000000000001',
  '61200000-0000-4000-8000-000000000001',
  100,
  'pour',
  '0061-main-older'
);
select public.record_pour(
  '61100000-0000-4000-8000-000000000001',
  '61200000-0000-4000-8000-000000000001',
  50,
  'pour',
  '0061-main-latest'
);
select public.record_pour(
  '61100000-0000-4000-8000-000000000001',
  '61200000-0000-4000-8000-000000000002',
  40,
  'pour',
  '0061-rollback'
);
select public.record_pour(
  '61100000-0000-4000-8000-000000000001',
  '61200000-0000-4000-8000-000000000003',
  25,
  'pour',
  '0061-concurrent-older'
);
select public.record_pour(
  '61100000-0000-4000-8000-000000000001',
  '61200000-0000-4000-8000-000000000003',
  15,
  'pour',
  '0061-concurrent-latest'
);
select public.record_pour(
  '61100000-0000-4000-8000-000000000002',
  '61200000-0000-4000-8000-000000000005',
  30,
  'pour',
  '0061-other-tenant'
);

reset role;

update public.pour_events
set occurred_at = case note
  when '0061-main-older' then '2026-07-24 18:00:00+00'::timestamptz
  when '0061-main-latest' then '2026-07-24 18:01:00+00'::timestamptz
  when '0061-concurrent-older' then '2026-07-24 18:02:00+00'::timestamptz
  when '0061-concurrent-latest' then '2026-07-24 18:03:00+00'::timestamptz
  else occurred_at
end
where note like '0061-%'
  and kind in ('pour', 'spill');

-- The boundary remains caller-authenticated, tenant-checked, and executable
-- only by authenticated clients. Neither function changes role or uses
-- dynamic execution.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.undo_last_pour_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains undo idempotency execution';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.undo_last_pour_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks undo idempotency execution';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid in (
      to_regprocedure('public.undo_last_pour(uuid,uuid)'),
      to_regprocedure(
        'public.undo_last_pour_idempotent(uuid,uuid,text,text)'
      )
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'undo boundary lacks hardened execution context';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', false);
set role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.undo_last_pour_idempotent(
      '61100000-0000-4000-8000-000000000001',
      '61200000-0000-4000-8000-000000000001',
      'undo_unauth_key_0061',
      '3c2e5c7d3678231044efb7c0c97f85ce43b406eb88cb0d44f2fbd23c8174426e'
    )
  $sql$,
  '42501'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000002',
  false
);
set role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.undo_last_pour_idempotent(
      '61100000-0000-4000-8000-000000000001',
      '61200000-0000-4000-8000-000000000001',
      'undo_outsider_key_0061',
      '3c2e5c7d3678231044efb7c0c97f85ce43b406eb88cb0d44f2fbd23c8174426e'
    )
  $sql$,
  '42501'
);

reset role;

-- Missing-key compatibility returns the exact existing not-found envelope and
-- creates no idempotency row.
select set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.undo_last_pour_idempotent(
    '61100000-0000-4000-8000-000000000001',
    '61200000-0000-4000-8000-000000000004'
  );

  if v_result.outcome <> 'not_found'
     or v_result.response_status <> 404
     or v_result.response_body <> jsonb_build_object(
       'error',
       jsonb_build_object(
         'code', 'not_found',
         'message', 'Pour to undo not found.'
       )
     )
     or v_result.replayed then
    raise exception 'keyless undo response is malformed: %',
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
    where user_id = '61000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'keyless undo created an idempotency claim';
  end if;
end;
$$;

-- A keyed undo restores the latest 50 ml exactly once, stores its complete
-- response, and replays it without touching the older 100 ml pour. This is
-- the dropped-response retry guarantee.
select set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.undo_last_pour_idempotent(
    '61100000-0000-4000-8000-000000000001',
    '61200000-0000-4000-8000-000000000001',
    'undo_replay_key_0061',
    '3c2e5c7d3678231044efb7c0c97f85ce43b406eb88cb0d44f2fbd23c8174426e'
  );

  if v_fresh.outcome <> 'undone'
     or v_fresh.response_status <> 200
     or v_fresh.response_body #>> '{open_bottle,wine_id}'
          <> '61200000-0000-4000-8000-000000000001'
     or (v_fresh.response_body #>> '{open_bottle,remaining_ml}')::integer
          <> 650
     or v_fresh.response_body #>> '{open_bottle,id}' is null
     or v_fresh.replayed then
    raise exception 'fresh undo response is malformed: %',
      row_to_json(v_fresh);
  end if;

  select * into v_replay
  from public.undo_last_pour_idempotent(
    '61100000-0000-4000-8000-000000000001',
    '61200000-0000-4000-8000-000000000001',
    'undo_replay_key_0061',
    '3c2e5c7d3678231044efb7c0c97f85ce43b406eb88cb0d44f2fbd23c8174426e'
  );

  if v_replay.outcome <> 'replay'
     or v_replay.response_status <> 200
     or v_replay.response_body <> v_fresh.response_body
     or v_replay.execution_started_at <> v_fresh.execution_started_at
     or not v_replay.replayed then
    raise exception 'undo replay is not exact: fresh=%, replay=%',
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
    select remaining_ml
    from public.open_bottles
    where wine_id = '61200000-0000-4000-8000-000000000001'
  ) <> 650 then
    raise exception 'undo replay restored bottle volume more than once';
  end if;

  if (
    select count(*)
    from public.pour_events
    where wine_id = '61200000-0000-4000-8000-000000000001'
      and kind in ('pour', 'spill')
  ) <> 1 or not exists (
    select 1
    from public.pour_events
    where wine_id = '61200000-0000-4000-8000-000000000001'
      and note = '0061-main-older'
  ) then
    raise exception 'dropped-response replay consumed the older pour';
  end if;

  if (
    select count(*)
    from public.availability_events
    where wine_id = '61200000-0000-4000-8000-000000000001'
      and note = 'undo pour: 50ml restored'
  ) <> 1 then
    raise exception 'undo replay duplicated its availability event';
  end if;

  select * into strict v_claim
  from public.api_idempotency
  where user_id = '61000000-0000-4000-8000-000000000001'
    and idempotency_key = 'undo_replay_key_0061';

  if v_claim.restaurant_id
       <> '61100000-0000-4000-8000-000000000001'
     or v_claim.operation_id <> 'api:POST:/api/pour/undo'
     or v_claim.request_hash
          <> '3c2e5c7d3678231044efb7c0c97f85ce43b406eb88cb0d44f2fbd23c8174426e'
     or v_claim.state <> 'completed'
     or v_claim.response_status <> 200
     or v_claim.response_body #>> '{open_bottle,wine_id}'
          <> '61200000-0000-4000-8000-000000000001'
     or v_claim.completed_at is null then
    raise exception 'stored undo claim is malformed: %', row_to_json(v_claim);
  end if;
end;
$$;

-- A dishonest caller-supplied hash is rejected before claiming or mutating.
-- The same caller key cannot change the canonical body or cross tenants, even
-- when the caller is a valid staff member in both restaurants.
select set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.undo_last_pour_idempotent(
      '61100000-0000-4000-8000-000000000001',
      '61200000-0000-4000-8000-000000000001',
      'undo_dishonest_hash_0061',
      repeat('b', 64)
    )
  $sql$,
  '22023'
);

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.undo_last_pour_idempotent(
    '61100000-0000-4000-8000-000000000001',
    '61200000-0000-4000-8000-000000000002',
    'undo_replay_key_0061',
    '1c897c8e4ebd7175f90fda270d2c6d5b123dd4224bdce849f2f654ef5f258187'
  );

  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused'
     or v_result.replayed then
    raise exception 'canonical-body conflict response is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.undo_last_pour_idempotent(
    '61100000-0000-4000-8000-000000000002',
    '61200000-0000-4000-8000-000000000005',
    'undo_replay_key_0061',
    '5d1c3808cdcfdddc3a1cf40a8dff388a6b058dd7d4979f2ee888cd2b84f32e67'
  );

  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused'
     or v_result.replayed then
    raise exception 'cross-tenant key conflict response is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select remaining_ml
    from public.open_bottles
    where wine_id = '61200000-0000-4000-8000-000000000005'
  ) <> 720 or (
    select count(*)
    from public.pour_events
    where wine_id = '61200000-0000-4000-8000-000000000005'
      and kind in ('pour', 'spill')
  ) <> 1 then
    raise exception 'cross-tenant key conflict mutated restaurant B';
  end if;
end;
$$;

-- A failure while completing the idempotency row rolls back the event delete,
-- bottle restoration, availability event, and new claim. Removing the induced
-- failure lets the exact same key execute once and replay.
create or replace function public.reject_undo_completion_0061()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0061 idempotency completion failure';
end;
$$;

create trigger reject_undo_completion_0061
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'undo_rollback_key_0061')
execute function public.reject_undo_completion_0061();

select set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.undo_last_pour_idempotent(
      '61100000-0000-4000-8000-000000000001',
      '61200000-0000-4000-8000-000000000002',
      'undo_rollback_key_0061',
      '1c897c8e4ebd7175f90fda270d2c6d5b123dd4224bdce849f2f654ef5f258187'
    )
  $sql$,
  'XX000'
);

reset role;
drop trigger reject_undo_completion_0061 on public.api_idempotency;

do $$
begin
  if (
    select remaining_ml
    from public.open_bottles
    where wine_id = '61200000-0000-4000-8000-000000000002'
  ) <> 710 or (
    select count(*)
    from public.pour_events
    where wine_id = '61200000-0000-4000-8000-000000000002'
      and kind in ('pour', 'spill')
  ) <> 1 or exists (
    select 1
    from public.availability_events
    where wine_id = '61200000-0000-4000-8000-000000000002'
      and note = 'undo pour: 40ml restored'
  ) or exists (
    select 1
    from public.api_idempotency
    where user_id = '61000000-0000-4000-8000-000000000001'
      and idempotency_key = 'undo_rollback_key_0061'
  ) then
    raise exception 'completion failure leaked part of the undo transaction';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.undo_last_pour_idempotent(
    '61100000-0000-4000-8000-000000000001',
    '61200000-0000-4000-8000-000000000002',
    'undo_rollback_key_0061',
    '1c897c8e4ebd7175f90fda270d2c6d5b123dd4224bdce849f2f654ef5f258187'
  );

  select * into v_replay
  from public.undo_last_pour_idempotent(
    '61100000-0000-4000-8000-000000000001',
    '61200000-0000-4000-8000-000000000002',
    'undo_rollback_key_0061',
    '1c897c8e4ebd7175f90fda270d2c6d5b123dd4224bdce849f2f654ef5f258187'
  );

  if v_fresh.outcome <> 'undone'
     or v_fresh.response_status <> 200
     or (v_fresh.response_body #>> '{open_bottle,remaining_ml}')::integer
          <> 750
     or v_fresh.replayed
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed then
    raise exception 'post-rollback retry/replay is malformed: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;

reset role;

-- Delay the first completion so two independent authenticated sessions
-- overlap. The caller/key advisory lock makes the second transaction wait and
-- replay the first response instead of deleting the older pour.
create or replace function public.delay_undo_completion_0061()
returns trigger
language plpgsql
as $$
begin
  perform pg_sleep(0.75);
  return new;
end;
$$;

create trigger delay_undo_completion_0061
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'undo_concurrent_key_0061')
execute function public.delay_undo_completion_0061();

select extensions.dblink_connect(
  'undo_0061_a',
  :'dblink_conn'
);
select extensions.dblink_connect(
  'undo_0061_b',
  :'dblink_conn'
);
select extensions.dblink_exec(
  'undo_0061_a',
  $sql$
    set "request.jwt.claim.sub" =
      '61000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec(
  'undo_0061_b',
  $sql$
    set "request.jwt.claim.sub" =
      '61000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec('undo_0061_a', 'set role authenticated');
select extensions.dblink_exec('undo_0061_b', 'set role authenticated');

select extensions.dblink_send_query(
  'undo_0061_a',
  $sql$
    select row_to_json(result)::text
    from public.undo_last_pour_idempotent(
      '61100000-0000-4000-8000-000000000001',
      '61200000-0000-4000-8000-000000000003',
      'undo_concurrent_key_0061',
      '23687c58d1e78c40562ea93888fd5cb0e5807179fd5de1555f0cde9ee73b80ae'
    ) as result
  $sql$
);
select extensions.dblink_send_query(
  'undo_0061_b',
  $sql$
    select row_to_json(result)::text
    from public.undo_last_pour_idempotent(
      '61100000-0000-4000-8000-000000000001',
      '61200000-0000-4000-8000-000000000003',
      'undo_concurrent_key_0061',
      '23687c58d1e78c40562ea93888fd5cb0e5807179fd5de1555f0cde9ee73b80ae'
    ) as result
  $sql$
);

create temporary table undo_0061_concurrency_results (
  payload jsonb not null
);
insert into undo_0061_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('undo_0061_a') as result(payload text);
insert into undo_0061_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('undo_0061_b') as result(payload text);

select extensions.dblink_disconnect('undo_0061_a');
select extensions.dblink_disconnect('undo_0061_b');
drop trigger delay_undo_completion_0061 on public.api_idempotency;

do $$
declare
  v_fresh jsonb;
  v_replay jsonb;
begin
  if (
    select count(*)
    from undo_0061_concurrency_results
  ) <> 2 or (
    select count(*)
    from undo_0061_concurrency_results
    where payload ->> 'outcome' = 'undone'
      and (payload ->> 'replayed')::boolean = false
  ) <> 1 or (
    select count(*)
    from undo_0061_concurrency_results
    where payload ->> 'outcome' = 'replay'
      and (payload ->> 'replayed')::boolean = true
  ) <> 1 then
    raise exception 'concurrent outcomes are malformed: %',
      (select jsonb_agg(payload) from undo_0061_concurrency_results);
  end if;

  select payload into strict v_fresh
  from undo_0061_concurrency_results
  where payload ->> 'outcome' = 'undone';
  select payload into strict v_replay
  from undo_0061_concurrency_results
  where payload ->> 'outcome' = 'replay';

  if v_fresh -> 'response_body' <> v_replay -> 'response_body'
     or v_fresh ->> 'execution_started_at'
          <> v_replay ->> 'execution_started_at' then
    raise exception 'concurrent replay did not preserve the exact response';
  end if;

  if (
    select remaining_ml
    from public.open_bottles
    where wine_id = '61200000-0000-4000-8000-000000000003'
  ) <> 725 or (
    select count(*)
    from public.pour_events
    where wine_id = '61200000-0000-4000-8000-000000000003'
      and kind in ('pour', 'spill')
  ) <> 1 or not exists (
    select 1
    from public.pour_events
    where wine_id = '61200000-0000-4000-8000-000000000003'
      and note = '0061-concurrent-older'
  ) then
    raise exception 'concurrent retry performed more than one undo';
  end if;
end;
$$;

drop function public.reject_undo_completion_0061();
drop function public.delay_undo_completion_0061();

delete from public.restaurants
where id in (
  '61100000-0000-4000-8000-000000000001',
  '61100000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000002'
);

select '0061 pour-undo idempotency acceptance passed' as result;
