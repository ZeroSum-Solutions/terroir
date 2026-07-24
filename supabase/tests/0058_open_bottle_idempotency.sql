-- Focused acceptance test for 0058_open_bottle_idempotency.sql.
-- Run only against an isolated database with migrations through 0058 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0058_open_bottle_idempotency.sql

begin;

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
    '58000000-0000-4000-8000-000000000001',
    'staff-0058@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '58000000-0000-4000-8000-000000000002',
    'outsider-0058@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '58100000-0000-4000-8000-000000000001',
    'Atomic Open Idempotency Restaurant'
  ),
  (
    '58100000-0000-4000-8000-000000000002',
    'Atomic Open Idempotency Restaurant B'
  );

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '58000000-0000-4000-8000-000000000001',
    '58100000-0000-4000-8000-000000000001',
    'staff'
  ),
  (
    '58000000-0000-4000-8000-000000000001',
    '58100000-0000-4000-8000-000000000002',
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
    '58200000-0000-4000-8000-000000000001',
    '58100000-0000-4000-8000-000000000001',
    'Replay Open',
    '0058 Producer',
    750
  ),
  (
    '58200000-0000-4000-8000-000000000002',
    '58100000-0000-4000-8000-000000000001',
    'Completion Rollback Open',
    '0058 Producer',
    375
  ),
  (
    '58200000-0000-4000-8000-000000000003',
    '58100000-0000-4000-8000-000000000001',
    'No Stock Open',
    '0058 Producer',
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
    '58300000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000001',
    '58100000-0000-4000-8000-000000000001',
    2,
    20,
    now() - interval '2 days'
  ),
  (
    '58300000-0000-4000-8000-000000000002',
    '58200000-0000-4000-8000-000000000002',
    '58100000-0000-4000-8000-000000000001',
    2,
    21,
    now() - interval '1 day'
  ),
  (
    '58300000-0000-4000-8000-000000000003',
    '58200000-0000-4000-8000-000000000003',
    '58100000-0000-4000-8000-000000000001',
    0,
    22,
    now()
  );

-- The boundary is authenticated-only, caller-bound, and hardened.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.open_bottle_from_inventory_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains open-bottle idempotency execution';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.open_bottle_from_inventory_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks open-bottle idempotency execution';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid = to_regprocedure(
      'public.open_bottle_from_inventory_idempotent(uuid,uuid,text,text)'
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
      'open-bottle idempotency lacks SECURITY DEFINER empty search_path';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.open_bottle_from_inventory_idempotent(
      '58100000-0000-4000-8000-000000000001',
      '58200000-0000-4000-8000-000000000001',
      'unauth_key_0058',
      repeat('0', 64)
    )
  $sql$,
  '42501'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '58000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.open_bottle_from_inventory_idempotent(
      '58100000-0000-4000-8000-000000000001',
      '58200000-0000-4000-8000-000000000001',
      'outsider_key_0058',
      repeat('1', 64)
    )
  $sql$,
  '42501'
);

reset role;

-- Missing-key compatibility still uses the same atomic business function and
-- does not create an idempotency row.
select set_config(
  'request.jwt.claim.sub',
  '58000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000003'
  );

  if v_result.outcome <> 'no_sealed_stock'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}' <> 'no_sealed_stock'
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
    where user_id = '58000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'unkeyed open created an idempotency claim';
  end if;
end;
$$;

-- A successful call stores the exact response. Replaying the same key returns
-- that response without decrementing inventory again or replacing the bottle.
select set_config(
  'request.jwt.claim.sub',
  '58000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000001',
    'open_replay_key_0058',
    repeat('a', 64)
  );

  if v_fresh.outcome <> 'opened'
     or v_fresh.response_status <> 201
     or v_fresh.response_body #>> '{open_bottle,wine_id}'
          <> '58200000-0000-4000-8000-000000000001'
     or (v_fresh.response_body #>> '{open_bottle,remaining_ml}')::integer
          <> 750
     or v_fresh.response_body #>> '{open_bottle,id}' is null
     or v_fresh.response_body #>> '{open_bottle,opened_at}' is null
     or v_fresh.replayed then
    raise exception 'fresh keyed open response is malformed: %',
      row_to_json(v_fresh);
  end if;

  select * into v_replay
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000001',
    'open_replay_key_0058',
    repeat('a', 64)
  );

  if v_replay.outcome <> 'replay'
     or v_replay.response_status <> 201
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed then
    raise exception 'open replay is not exact: fresh=%, replay=%',
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
    where id = '58300000-0000-4000-8000-000000000001'
  ) <> 1 then
    raise exception 'replay decremented sealed inventory more than once';
  end if;

  if (
    select count(*)
    from public.open_bottles
    where wine_id = '58200000-0000-4000-8000-000000000001'
  ) <> 1 then
    raise exception 'replay duplicated the open-bottle row';
  end if;

  select * into strict v_claim
  from public.api_idempotency
  where user_id = '58000000-0000-4000-8000-000000000001'
    and idempotency_key = 'open_replay_key_0058';

  if v_claim.restaurant_id
       <> '58100000-0000-4000-8000-000000000001'
     or v_claim.operation_id <> 'api:POST:/api/open-bottles'
     or v_claim.request_hash <> repeat('a', 64)
     or v_claim.state <> 'completed'
     or v_claim.response_status <> 201
     or v_claim.response_body #>> '{open_bottle,wine_id}'
          <> '58200000-0000-4000-8000-000000000001'
     or v_claim.completed_at is null then
    raise exception 'stored open claim is malformed: %', row_to_json(v_claim);
  end if;
end;
$$;

-- The same key with a different request hash is rejected before mutation.
select set_config(
  'request.jwt.claim.sub',
  '58000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000001',
    'open_replay_key_0058',
    repeat('b', 64)
  );

  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused'
     or v_result.replayed then
    raise exception 'request mismatch response is malformed: %',
      row_to_json(v_result);
  end if;

  -- Even the same operation and hash cannot reuse the caller key in a
  -- different restaurant where the caller is also a staff member.
  select * into v_result
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000002',
    '58200000-0000-4000-8000-000000000001',
    'open_replay_key_0058',
    repeat('a', 64)
  );

  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused'
     or v_result.replayed then
    raise exception 'restaurant mismatch response is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

-- An existing generic in-progress claim remains fail-closed and does not reach
-- the business mutation.
insert into public.api_idempotency (
  restaurant_id,
  user_id,
  operation_id,
  idempotency_key,
  request_hash
) values (
  '58100000-0000-4000-8000-000000000001',
  '58000000-0000-4000-8000-000000000001',
  'api:POST:/api/open-bottles',
  'open_progress_key_0058',
  repeat('c', 64)
);

select set_config(
  'request.jwt.claim.sub',
  '58000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000002',
    'open_progress_key_0058',
    repeat('c', 64)
  );

  if v_result.outcome <> 'idempotency_in_progress'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_in_progress'
     or v_result.replayed then
    raise exception 'in-progress response is malformed: %',
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
    where id = '58300000-0000-4000-8000-000000000002'
  ) <> 2 or exists (
    select 1
    from public.open_bottles
    where wine_id = '58200000-0000-4000-8000-000000000002'
  ) then
    raise exception 'in-progress classification mutated bottle state';
  end if;
end;
$$;

-- Expired and explicitly unknown claims stay non-mutating and preserve their
-- distinct retry classifications.
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
    '58100000-0000-4000-8000-000000000001',
    '58000000-0000-4000-8000-000000000001',
    'api:POST:/api/open-bottles',
    'open_expired_key_0058',
    repeat('e', 64),
    'in_progress',
    clock_timestamp() - interval '25 hours',
    clock_timestamp() - interval '25 hours'
  ),
  (
    '58100000-0000-4000-8000-000000000001',
    '58000000-0000-4000-8000-000000000001',
    'api:POST:/api/open-bottles',
    'open_unknown_key_0058',
    repeat('f', 64),
    'failed_unknown',
    clock_timestamp(),
    clock_timestamp()
  );

select set_config(
  'request.jwt.claim.sub',
  '58000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000002',
    'open_expired_key_0058',
    repeat('e', 64)
  );

  if v_result.outcome <> 'idempotency_key_expired'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_expired'
     or v_result.replayed then
    raise exception 'expired response is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000002',
    'open_unknown_key_0058',
    repeat('f', 64)
  );

  if v_result.outcome <> 'idempotency_outcome_unknown'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_outcome_unknown'
     or v_result.replayed then
    raise exception 'unknown-outcome response is malformed: %',
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
    where id = '58300000-0000-4000-8000-000000000002'
  ) <> 2 or exists (
    select 1
    from public.open_bottles
    where wine_id = '58200000-0000-4000-8000-000000000002'
  ) then
    raise exception 'expired or unknown classification mutated bottle state';
  end if;
end;
$$;

-- Induce failure on the final idempotency update. The inventory decrement,
-- open_bottles write, and newly inserted claim must all roll back.
create or replace function pg_temp.reject_open_completion_0058()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0058 idempotency completion failure';
end;
$$;

create trigger reject_open_completion_0058
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'open_rollback_key_0058')
execute function pg_temp.reject_open_completion_0058();

select set_config(
  'request.jwt.claim.sub',
  '58000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.open_bottle_from_inventory_idempotent(
      '58100000-0000-4000-8000-000000000001',
      '58200000-0000-4000-8000-000000000002',
      'open_rollback_key_0058',
      repeat('d', 64)
    )
  $sql$,
  'XX000'
);

reset role;
drop trigger reject_open_completion_0058 on public.api_idempotency;

do $$
begin
  if (
    select quantity
    from public.inventory_items
    where id = '58300000-0000-4000-8000-000000000002'
  ) <> 2 then
    raise exception 'completion failure leaked its inventory decrement';
  end if;

  if exists (
    select 1
    from public.open_bottles
    where wine_id = '58200000-0000-4000-8000-000000000002'
  ) then
    raise exception 'completion failure leaked its open-bottle write';
  end if;

  if exists (
    select 1
    from public.api_idempotency
    where user_id = '58000000-0000-4000-8000-000000000001'
      and idempotency_key = 'open_rollback_key_0058'
  ) then
    raise exception 'completion failure leaked its idempotency claim';
  end if;
end;
$$;

-- Once the induced failure is removed, the same key executes exactly once and
-- immediately becomes replayable.
select set_config(
  'request.jwt.claim.sub',
  '58000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000002',
    'open_rollback_key_0058',
    repeat('d', 64)
  );

  select * into v_replay
  from public.open_bottle_from_inventory_idempotent(
    '58100000-0000-4000-8000-000000000001',
    '58200000-0000-4000-8000-000000000002',
    'open_rollback_key_0058',
    repeat('d', 64)
  );

  if v_fresh.outcome <> 'opened'
     or v_fresh.response_status <> 201
     or v_fresh.replayed
     or v_replay.outcome <> 'replay'
     or v_replay.response_status <> 201
     or not v_replay.replayed
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'post-rollback execution/replay is malformed: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select quantity
    from public.inventory_items
    where id = '58300000-0000-4000-8000-000000000002'
  ) <> 1 then
    raise exception 'post-rollback replay decremented inventory more than once';
  end if;

  if (
    select count(*)
    from public.open_bottles
    where wine_id = '58200000-0000-4000-8000-000000000002'
  ) <> 1 then
    raise exception 'post-rollback replay duplicated the open-bottle row';
  end if;

  if not exists (
    select 1
    from public.api_idempotency
    where user_id = '58000000-0000-4000-8000-000000000001'
      and idempotency_key = 'open_rollback_key_0058'
      and operation_id = 'api:POST:/api/open-bottles'
      and request_hash = repeat('d', 64)
      and state = 'completed'
      and response_status = 201
  ) then
    raise exception 'post-rollback execution did not complete its claim';
  end if;
end;
$$;

select '0058 open-bottle idempotency acceptance passed' as result;

rollback;
