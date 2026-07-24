-- Focused acceptance test for 0059_close_open_bottle_idempotency.sql.
-- Run only against an isolated database with migrations through 0059 applied.

create extension if not exists dblink with schema extensions;

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
    '59000000-0000-4000-8000-000000000001',
    'staff-0059@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '59000000-0000-4000-8000-000000000002',
    'outsider-0059@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (
  id,
  name,
  auto_eightysix_from_inventory,
  eightysix_ml_threshold
) values
  (
    '59100000-0000-4000-8000-000000000001',
    'Atomic Close Idempotency Restaurant',
    true,
    148
  ),
  (
    '59100000-0000-4000-8000-000000000002',
    'Atomic Close Idempotency Restaurant B',
    false,
    148
  );

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '59000000-0000-4000-8000-000000000001',
    '59100000-0000-4000-8000-000000000001',
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
    '59200000-0000-4000-8000-000000000001',
    '59100000-0000-4000-8000-000000000001',
    'Unkeyed Close',
    '0059 Producer',
    750
  ),
  (
    '59200000-0000-4000-8000-000000000002',
    '59100000-0000-4000-8000-000000000001',
    'Replay Close',
    '0059 Producer',
    750
  ),
  (
    '59200000-0000-4000-8000-000000000003',
    '59100000-0000-4000-8000-000000000001',
    'Stale Close',
    '0059 Producer',
    750
  ),
  (
    '59200000-0000-4000-8000-000000000004',
    '59100000-0000-4000-8000-000000000001',
    'Already Closed',
    '0059 Producer',
    750
  ),
  (
    '59200000-0000-4000-8000-000000000005',
    '59100000-0000-4000-8000-000000000001',
    'Completion Rollback',
    '0059 Producer',
    750
  ),
  (
    '59200000-0000-4000-8000-000000000006',
    '59100000-0000-4000-8000-000000000001',
    'Concurrent Close',
    '0059 Producer',
    750
  ),
  (
    '59200000-0000-4000-8000-000000000007',
    '59100000-0000-4000-8000-000000000001',
    'Claim Classification',
    '0059 Producer',
    750
  ),
  (
    '59200000-0000-4000-8000-000000000008',
    '59100000-0000-4000-8000-000000000002',
    'Other Tenant Close',
    '0059 Producer',
    750
  );

insert into public.open_bottles (
  id,
  wine_id,
  restaurant_id,
  remaining_ml,
  opened_at,
  opened_by,
  closed_at
) values
  (
    '59300000-0000-4000-8000-000000000001',
    '59200000-0000-4000-8000-000000000001',
    '59100000-0000-4000-8000-000000000001',
    125,
    '2026-07-24T08:00:00Z',
    '59000000-0000-4000-8000-000000000001',
    null
  ),
  (
    '59300000-0000-4000-8000-000000000002',
    '59200000-0000-4000-8000-000000000002',
    '59100000-0000-4000-8000-000000000001',
    250,
    '2026-07-24T08:10:00Z',
    '59000000-0000-4000-8000-000000000001',
    null
  ),
  (
    '59300000-0000-4000-8000-000000000003',
    '59200000-0000-4000-8000-000000000003',
    '59100000-0000-4000-8000-000000000001',
    300,
    '2026-07-24T08:20:00Z',
    '59000000-0000-4000-8000-000000000001',
    null
  ),
  (
    '59300000-0000-4000-8000-000000000004',
    '59200000-0000-4000-8000-000000000004',
    '59100000-0000-4000-8000-000000000001',
    0,
    '2026-07-24T08:30:00Z',
    '59000000-0000-4000-8000-000000000001',
    '2026-07-24T08:40:00Z'
  ),
  (
    '59300000-0000-4000-8000-000000000005',
    '59200000-0000-4000-8000-000000000005',
    '59100000-0000-4000-8000-000000000001',
    375,
    '2026-07-24T08:50:00Z',
    '59000000-0000-4000-8000-000000000001',
    null
  ),
  (
    '59300000-0000-4000-8000-000000000006',
    '59200000-0000-4000-8000-000000000006',
    '59100000-0000-4000-8000-000000000001',
    500,
    '2026-07-24T09:00:00Z',
    '59000000-0000-4000-8000-000000000001',
    null
  ),
  (
    '59300000-0000-4000-8000-000000000007',
    '59200000-0000-4000-8000-000000000007',
    '59100000-0000-4000-8000-000000000001',
    600,
    '2026-07-24T09:10:00Z',
    '59000000-0000-4000-8000-000000000001',
    null
  ),
  (
    '59300000-0000-4000-8000-000000000008',
    '59200000-0000-4000-8000-000000000008',
    '59100000-0000-4000-8000-000000000002',
    700,
    '2026-07-24T09:20:00Z',
    '59000000-0000-4000-8000-000000000001',
    null
  );

-- The boundary is authenticated-only, caller-bound, and hardened.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.close_open_bottle_idempotent(uuid,uuid,timestamptz,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains close-bottle execution';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.close_open_bottle_idempotent(uuid,uuid,timestamptz,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks close-bottle execution';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid = to_regprocedure(
      'public.close_open_bottle_idempotent(uuid,uuid,timestamptz,text,text)'
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
      'close-bottle boundary lacks SECURITY DEFINER empty search_path';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', false);
set role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.close_open_bottle_idempotent(
      '59100000-0000-4000-8000-000000000001',
      '59300000-0000-4000-8000-000000000001',
      '2026-07-24T08:00:00Z',
      'unauth_key_0059',
      repeat('0', 64)
    )
  $sql$,
  '42501'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  '59000000-0000-4000-8000-000000000002',
  false
);
set role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.close_open_bottle_idempotent(
      '59100000-0000-4000-8000-000000000001',
      '59300000-0000-4000-8000-000000000001',
      '2026-07-24T08:00:00Z',
      'outsider_key_0059',
      repeat('1', 64)
    )
  $sql$,
  '42501'
);

reset role;

-- Unkeyed compatibility uses the same atomic command without a claim.
select set_config(
  'request.jwt.claim.sub',
  '59000000-0000-4000-8000-000000000001',
  false
);

do $$
declare
  v_result record;
  v_closed_at timestamptz;
begin
  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000001',
    '2026-07-24T08:00:00Z'
  );

  select closed_at into v_closed_at
  from public.open_bottles
  where id = '59300000-0000-4000-8000-000000000001';

  if v_result.outcome <> 'closed'
     or v_result.response_status <> 200
     or v_result.replayed
     or v_result.response_body #>> '{closed,id}'
          <> '59300000-0000-4000-8000-000000000001'
     or v_result.response_body #>> '{closed,wine_id}'
          <> '59200000-0000-4000-8000-000000000001'
     or (v_result.response_body #>> '{closed,closed_at}')::timestamptz
          <> v_closed_at then
    raise exception 'unkeyed close response is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from public.api_idempotency
    where user_id = '59000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'unkeyed close created an idempotency claim';
  end if;

  if (
    select count(*)
    from public.pour_events
    where open_bottle_id = '59300000-0000-4000-8000-000000000001'
      and wine_id = '59200000-0000-4000-8000-000000000001'
      and restaurant_id = '59100000-0000-4000-8000-000000000001'
      and ml_delta = 125
      and kind = 'spill'
      and actor_user_id = '59000000-0000-4000-8000-000000000001'
      and note = 'Bottle closed (discard remaining)'
  ) <> 1 then
    raise exception 'unkeyed close did not record exactly one exact spill';
  end if;
end;
$$;

-- A keyed close stores the real database timestamp and replay cannot add a
-- second spill or availability event.
select set_config(
  'request.jwt.claim.sub',
  '59000000-0000-4000-8000-000000000001',
  false
);

do $$
declare
  v_fresh record;
  v_replay record;
  v_closed_at timestamptz;
begin
  select * into v_fresh
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000002',
    '2026-07-24T08:10:00Z',
    'close_replay_key_0059',
    repeat('a', 64)
  );

  select closed_at into v_closed_at
  from public.open_bottles
  where id = '59300000-0000-4000-8000-000000000002';

  select * into v_replay
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000002',
    '2026-07-24T08:10:00Z',
    'close_replay_key_0059',
    repeat('a', 64)
  );

  if v_fresh.outcome <> 'closed'
     or v_fresh.response_status <> 200
     or v_fresh.replayed
     or (v_fresh.response_body #>> '{closed,closed_at}')::timestamptz
          <> v_closed_at
     or v_replay.outcome <> 'replay'
     or v_replay.response_status <> 200
     or not v_replay.replayed
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'close execution/replay is malformed: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;

do $$
declare
  v_claim public.api_idempotency%rowtype;
begin
  if (
    select count(*)
    from public.pour_events
    where open_bottle_id = '59300000-0000-4000-8000-000000000002'
      and kind = 'spill'
      and ml_delta = 250
  ) <> 1 then
    raise exception 'replay duplicated or changed the exact spill';
  end if;

  if (
    select count(*)
    from public.availability_events
    where wine_id = '59200000-0000-4000-8000-000000000002'
      and direction = 'eightysixed'
  ) <> 1 then
    raise exception 'replay duplicated or omitted auto-availability';
  end if;

  select * into strict v_claim
  from public.api_idempotency
  where user_id = '59000000-0000-4000-8000-000000000001'
    and idempotency_key = 'close_replay_key_0059';

  if v_claim.restaurant_id
       <> '59100000-0000-4000-8000-000000000001'
     or v_claim.operation_id
          <> 'api:POST:/api/open-bottles/{param}/close'
     or v_claim.request_hash <> repeat('a', 64)
     or v_claim.state <> 'completed'
     or v_claim.response_status <> 200
     or v_claim.completed_at is null then
    raise exception 'stored close claim is malformed: %', row_to_json(v_claim);
  end if;
end;
$$;

-- Mismatch, missing, stale generation, already-closed, and cross-tenant
-- results are deterministic, stored, and non-mutating. Generation mismatch is
-- evaluated before closed_at so a recycled row cannot masquerade as the old
-- closed generation.
select set_config(
  'request.jwt.claim.sub',
  '59000000-0000-4000-8000-000000000001',
  false
);

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000002',
    '2026-07-24T08:10:00Z',
    'close_replay_key_0059',
    repeat('b', 64)
  );
  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused' then
    raise exception 'request mismatch was not rejected: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000099',
    '2026-07-24T08:00:00Z',
    'close_missing_key_0059',
    repeat('c', 64)
  );
  if v_result.outcome <> 'not_found'
     or v_result.response_status <> 404
     or v_result.response_body #>> '{error,code}' <> 'not_found' then
    raise exception 'missing result is malformed: %', row_to_json(v_result);
  end if;

  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000008',
    '2026-07-24T09:20:00Z',
    'close_tenant_key_0059',
    repeat('d', 64)
  );
  if v_result.outcome <> 'not_found'
     or v_result.response_status <> 404 then
    raise exception 'cross-tenant close was not opaque: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000003',
    '2026-07-24T08:19:59Z',
    'close_stale_key_0059',
    repeat('e', 64)
  );
  if v_result.outcome <> 'stale_open_bottle'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}' <> 'stale_open_bottle' then
    raise exception 'stale generation result is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000004',
    '2026-07-24T08:29:59Z',
    'close_closed_stale_key_0059',
    repeat('f', 64)
  );
  if v_result.outcome <> 'stale_open_bottle' then
    raise exception 'generation was not checked before closed state: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000004',
    '2026-07-24T08:30:00Z',
    'close_already_key_0059',
    repeat('9', 64)
  );
  if v_result.outcome <> 'already_closed'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}' <> 'already_closed' then
    raise exception 'already-closed result is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from public.pour_events
    where open_bottle_id in (
      '59300000-0000-4000-8000-000000000003',
      '59300000-0000-4000-8000-000000000004',
      '59300000-0000-4000-8000-000000000008'
    )
  ) then
    raise exception 'deterministic conflict mutated a bottle';
  end if;

  if (
    select count(*)
    from public.api_idempotency
    where idempotency_key in (
      'close_missing_key_0059',
      'close_tenant_key_0059',
      'close_stale_key_0059',
      'close_closed_stale_key_0059',
      'close_already_key_0059'
    )
      and state = 'completed'
  ) <> 5 then
    raise exception 'deterministic outcomes were not completed';
  end if;
end;
$$;

-- Existing claim states remain serialized and non-mutating.
insert into public.api_idempotency (
  restaurant_id,
  user_id,
  operation_id,
  idempotency_key,
  request_hash,
  state,
  created_at,
  updated_at
) values
  (
    '59100000-0000-4000-8000-000000000001',
    '59000000-0000-4000-8000-000000000001',
    'api:POST:/api/open-bottles/{param}/close',
    'close_progress_key_0059',
    repeat('3', 64),
    'in_progress',
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '59100000-0000-4000-8000-000000000001',
    '59000000-0000-4000-8000-000000000001',
    'api:POST:/api/open-bottles/{param}/close',
    'close_expired_key_0059',
    repeat('4', 64),
    'in_progress',
    clock_timestamp() - interval '25 hours',
    clock_timestamp() - interval '25 hours'
  ),
  (
    '59100000-0000-4000-8000-000000000001',
    '59000000-0000-4000-8000-000000000001',
    'api:POST:/api/open-bottles/{param}/close',
    'close_unknown_key_0059',
    repeat('5', 64),
    'failed_unknown',
    clock_timestamp(),
    clock_timestamp()
  );

select set_config(
  'request.jwt.claim.sub',
  '59000000-0000-4000-8000-000000000001',
  false
);

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000007',
    '2026-07-24T09:10:00Z',
    'close_progress_key_0059',
    repeat('3', 64)
  );
  if v_result.outcome <> 'idempotency_in_progress'
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_in_progress' then
    raise exception 'in-progress classification is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000007',
    '2026-07-24T09:10:00Z',
    'close_expired_key_0059',
    repeat('4', 64)
  );
  if v_result.outcome <> 'idempotency_key_expired'
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_expired' then
    raise exception 'expired classification is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000007',
    '2026-07-24T09:10:00Z',
    'close_unknown_key_0059',
    repeat('5', 64)
  );
  if v_result.outcome <> 'idempotency_outcome_unknown'
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_outcome_unknown' then
    raise exception 'unknown classification is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

-- A forced completion failure rolls back the spill, bottle, auto-availability,
-- and the newly inserted claim.
create or replace function pg_temp.reject_close_completion_0059()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0059 idempotency completion failure';
end;
$$;

create trigger reject_close_completion_0059
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'close_rollback_key_0059')
execute function pg_temp.reject_close_completion_0059();

select set_config(
  'request.jwt.claim.sub',
  '59000000-0000-4000-8000-000000000001',
  false
);

select pg_temp.expect_failure(
  $sql$
    select * from public.close_open_bottle_idempotent(
      '59100000-0000-4000-8000-000000000001',
      '59300000-0000-4000-8000-000000000005',
      '2026-07-24T08:50:00Z',
      'close_rollback_key_0059',
      repeat('6', 64)
    )
  $sql$,
  'XX000'
);

drop trigger reject_close_completion_0059 on public.api_idempotency;

do $$
begin
  if not exists (
    select 1
    from public.open_bottles
    where id = '59300000-0000-4000-8000-000000000005'
      and remaining_ml = 375
      and closed_at is null
  ) then
    raise exception 'completion failure leaked bottle state';
  end if;

  if exists (
    select 1
    from public.pour_events
    where open_bottle_id = '59300000-0000-4000-8000-000000000005'
  ) then
    raise exception 'completion failure leaked its spill';
  end if;

  if exists (
    select 1
    from public.wines
    where id = '59200000-0000-4000-8000-000000000005'
      and is_eightysixed
  ) or exists (
    select 1
    from public.availability_events
    where wine_id = '59200000-0000-4000-8000-000000000005'
  ) then
    raise exception 'completion failure leaked availability state';
  end if;

  if exists (
    select 1
    from public.api_idempotency
    where user_id = '59000000-0000-4000-8000-000000000001'
      and idempotency_key = 'close_rollback_key_0059'
  ) then
    raise exception 'completion failure leaked its idempotency claim';
  end if;
end;
$$;

-- Delay the remote spill so two sessions overlap. The user/key advisory lock
-- makes the second call wait and replay the first committed result.
create or replace function public.delay_concurrent_close_0059()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.open_bottle_id = '59300000-0000-4000-8000-000000000006' then
    perform pg_catalog.pg_sleep(0.5);
  end if;
  return new;
end;
$$;

create trigger delay_concurrent_close_0059
before insert on public.pour_events
for each row execute function public.delay_concurrent_close_0059();

do $$
declare
  v_remote record;
  v_local record;
  v_database text := current_database();
begin
  perform extensions.dblink_connect(
    'close_concurrent_0059',
    pg_catalog.format('dbname=%L', v_database)
  );

  perform *
  from extensions.dblink(
    'close_concurrent_0059',
    $remote$
      select set_config(
        'request.jwt.claim.sub',
        '59000000-0000-4000-8000-000000000001',
        false
      )
    $remote$
  ) as claim(setting text);
  perform extensions.dblink_exec(
    'close_concurrent_0059',
    'set role authenticated'
  );

  perform extensions.dblink_send_query(
    'close_concurrent_0059',
    $remote$
      select *
      from public.close_open_bottle_idempotent(
        '59100000-0000-4000-8000-000000000001',
        '59300000-0000-4000-8000-000000000006',
        '2026-07-24T09:00:00Z',
        'close_concurrent_key_0059',
        repeat('7', 64)
      )
    $remote$
  );

  perform pg_catalog.pg_sleep(0.1);
  perform set_config(
    'request.jwt.claim.sub',
    '59000000-0000-4000-8000-000000000001',
    false
  );

  select * into v_local
  from public.close_open_bottle_idempotent(
    '59100000-0000-4000-8000-000000000001',
    '59300000-0000-4000-8000-000000000006',
    '2026-07-24T09:00:00Z',
    'close_concurrent_key_0059',
    repeat('7', 64)
  );

  select * into v_remote
  from extensions.dblink_get_result('close_concurrent_0059') as result(
    outcome text,
    response_status integer,
    response_body jsonb,
    replayed boolean
  );
  perform extensions.dblink_disconnect('close_concurrent_0059');

  if v_remote.outcome <> 'closed'
     or v_remote.response_status <> 200
     or v_remote.replayed
     or v_local.outcome <> 'replay'
     or v_local.response_status <> 200
     or not v_local.replayed
     or v_local.response_body <> v_remote.response_body then
    raise exception
      'concurrent close did not serialize to fresh/replay: remote=%, local=%',
      row_to_json(v_remote),
      row_to_json(v_local);
  end if;
exception when others then
  begin
    perform extensions.dblink_disconnect('close_concurrent_0059');
  exception when others then
    null;
  end;
  raise;
end;
$$;

drop trigger delay_concurrent_close_0059 on public.pour_events;
drop function public.delay_concurrent_close_0059();

do $$
begin
  if (
    select count(*)
    from public.pour_events
    where open_bottle_id = '59300000-0000-4000-8000-000000000006'
      and kind = 'spill'
      and ml_delta = 500
  ) <> 1 then
    raise exception 'concurrent close recorded more than one spill';
  end if;

  if (
    select count(*)
    from public.api_idempotency
    where user_id = '59000000-0000-4000-8000-000000000001'
      and idempotency_key = 'close_concurrent_key_0059'
      and state = 'completed'
      and response_status = 200
  ) <> 1 then
    raise exception 'concurrent close did not complete exactly one claim';
  end if;
end;
$$;

select '0059 close-bottle idempotency acceptance passed' as result;
