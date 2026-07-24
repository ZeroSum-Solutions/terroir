-- Focused acceptance test for 0056_api_idempotency.sql.
-- Run against an isolated, migrated Supabase database:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0056_api_idempotency.sql

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
    raise exception using
      errcode = 'XX000',
      message = 'expected statement to fail: ' || p_sql;
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> p_sqlstate then
      raise exception
        'unexpected failure for "%": expected %, received %',
        p_sql,
        p_sqlstate,
        v_sqlstate;
    end if;
  end;
end;
$$;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '12000000-0000-4000-8000-000000000001',
  'idempotency-a@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
), (
  '12000000-0000-4000-8000-000000000002',
  'idempotency-b@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
), (
  '12000000-0000-4000-8000-000000000003',
  'idempotency-nonmember@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.restaurants (id, name) values (
  '22000000-0000-4000-8000-000000000001',
  'Idempotency Restaurant A'
), (
  '22000000-0000-4000-8000-000000000002',
  'Idempotency Restaurant B'
);

insert into public.memberships (
  user_id,
  restaurant_id,
  role
) values (
  '12000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001',
  'owner'
), (
  '12000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000002',
  'owner'
), (
  '12000000-0000-4000-8000-000000000002',
  '22000000-0000-4000-8000-000000000001',
  'staff'
);

-- The table is not a client API.
set local role authenticated;
select pg_temp.expect_failure(
  $sql$select * from public.api_idempotency$sql$,
  '42501'
);
reset role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.claim_api_idempotency(uuid,text,text,text)',
    'public.complete_api_idempotency(uuid,text,text,text,integer,jsonb,jsonb)',
    'public.fail_api_idempotency(uuid,text,text,text)',
    'public.release_api_idempotency(uuid,text,text,text)'
  ]
  loop
    if has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception 'anon retains execute on %', v_signature;
    end if;
    if not has_function_privilege(
      'authenticated',
      v_signature,
      'EXECUTE'
    ) then
      raise exception 'authenticated lacks execute on %', v_signature;
    end if;
  end loop;

  if has_function_privilege(
    'authenticated',
    'public.cleanup_api_idempotency()',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.cleanup_api_idempotency()',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.cleanup_api_idempotency()',
    'EXECUTE'
  ) then
    raise exception 'cleanup function privileges are incorrect';
  end if;

  if has_table_privilege(
    'authenticated',
    'public.api_idempotency',
    'SELECT'
  ) or has_table_privilege(
    'authenticated',
    'public.api_idempotency',
    'INSERT'
  ) or has_table_privilege(
    'authenticated',
    'public.api_idempotency',
    'UPDATE'
  ) or has_table_privilege(
    'authenticated',
    'public.api_idempotency',
    'DELETE'
  ) then
    raise exception 'authenticated retains direct idempotency table access';
  end if;

  if not (
    select relrowsecurity
    from pg_class
    where oid = 'public.api_idempotency'::regclass
  ) then
    raise exception 'api_idempotency does not have RLS enabled';
  end if;

  if not exists (
    select 1
    from cron.job
    where jobname = 'cleanup_api_idempotency_hourly'
      and schedule = '25 * * * *'
      and command = 'select public.cleanup_api_idempotency();'
  ) then
    raise exception 'hourly idempotency cleanup cron is missing or malformed';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid in (
      to_regprocedure(
        'public.claim_api_idempotency(uuid,text,text,text)'
      ),
      to_regprocedure(
        'public.complete_api_idempotency(uuid,text,text,text,integer,jsonb,jsonb)'
      ),
      to_regprocedure(
        'public.fail_api_idempotency(uuid,text,text,text)'
      ),
      to_regprocedure(
        'public.release_api_idempotency(uuid,text,text,text)'
      ),
      to_regprocedure('public.cleanup_api_idempotency()')
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'idempotency function lacks SECURITY DEFINER empty search_path';
  end if;
end;
$$;

-- User A claims a primary key in restaurant A.
select set_config(
  'request.jwt.claim.sub',
  '12000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
  v_completed boolean;
  v_released boolean;
begin
  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('a', 64)
  );
  if v_result.outcome <> 'claimed'
     or v_result.response_status is not null
     or v_result.response_headers is not null
     or v_result.response_body is not null then
    raise exception 'first claim was not claimed: %', row_to_json(v_result);
  end if;

  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('a', 64)
  );
  if v_result.outcome <> 'in_progress'
     or v_result.response_status is not null
     or v_result.response_headers is not null
     or v_result.response_body is not null then
    raise exception 'duplicate claim was not in-progress: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('b', 64)
  );
  if v_result.outcome <> 'mismatch' then
    raise exception 'request-hash reuse was not rejected: %',
      row_to_json(v_result);
  end if;

  -- One user's key is globally bound across operations and tenants.
  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/reconcile',
    'primary_key_0001',
    repeat('a', 64)
  );
  if v_result.outcome <> 'mismatch' then
    raise exception 'cross-operation key reuse was not rejected: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000002',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('a', 64)
  );
  if v_result.outcome <> 'mismatch' then
    raise exception 'cross-tenant key reuse was not rejected: %',
      row_to_json(v_result);
  end if;

  if public.complete_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('b', 64),
    201,
    '{"content-type":"application/json"}'::jsonb,
    '{"open_bottle":{"id":"bottle-a"}}'::jsonb
  ) then
    raise exception 'wrong request hash completed a claim';
  end if;

  v_completed := public.complete_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('a', 64),
    201,
    '{"content-type":"application/json","x-idempotency":"stored"}'::jsonb,
    '{"open_bottle":{"id":"bottle-a"}}'::jsonb
  );
  if not v_completed then
    raise exception 'matching claim did not complete';
  end if;

  if public.complete_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('a', 64),
    201,
    '{"content-type":"application/json","x-idempotency":"stored"}'::jsonb,
    '{"open_bottle":{"id":"bottle-a"}}'::jsonb
  ) then
    raise exception 'completed claim transitioned twice';
  end if;

  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('a', 64)
  );
  if v_result.outcome <> 'replay'
     or v_result.response_status <> 201
     or v_result.response_headers
          <> '{"content-type":"application/json","x-idempotency":"stored"}'::jsonb
     or v_result.response_body
          <> '{"open_bottle":{"id":"bottle-a"}}'::jsonb then
    raise exception 'completed response did not replay: %',
      row_to_json(v_result);
  end if;

  if public.release_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('a', 64)
  ) then
    raise exception 'release removed a completed claim';
  end if;

  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'release_key_0001',
    repeat('c', 64)
  );
  if v_result.outcome <> 'claimed' then
    raise exception 'release fixture was not claimed';
  end if;

  v_released := public.release_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'release_key_0001',
    repeat('d', 64)
  );
  if v_released then
    raise exception 'wrong request hash released a claim';
  end if;

  v_released := public.release_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'release_key_0001',
    repeat('c', 64)
  );
  if not v_released then
    raise exception 'matching in-progress claim was not released';
  end if;

  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'release_key_0001',
    repeat('c', 64)
  );
  if v_result.outcome <> 'claimed' then
    raise exception 'released claim could not be reclaimed';
  end if;

  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'unknown_key_0001',
    repeat('d', 64)
  );
  if v_result.outcome <> 'claimed' then
    raise exception 'unknown-outcome fixture was not claimed';
  end if;

  if public.fail_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'unknown_key_0001',
    repeat('e', 64)
  ) then
    raise exception 'wrong request hash marked an ambiguous failure';
  end if;

  if not public.fail_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'unknown_key_0001',
    repeat('d', 64)
  ) then
    raise exception 'matching ambiguous failure did not transition';
  end if;

  if public.fail_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'unknown_key_0001',
    repeat('d', 64)
  ) then
    raise exception 'ambiguous failure transitioned twice';
  end if;

  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'unknown_key_0001',
    repeat('d', 64)
  );
  if v_result.outcome <> 'outcome_unknown'
     or v_result.response_status is not null
     or v_result.response_headers is not null
     or v_result.response_body is not null then
    raise exception 'ambiguous outcome was not retained: %',
      row_to_json(v_result);
  end if;

  if public.release_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'unknown_key_0001',
    repeat('d', 64)
  ) then
    raise exception 'release removed an ambiguous-outcome claim';
  end if;

  if public.complete_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'unknown_key_0001',
    repeat('d', 64),
    500,
    '{"content-type":"application/json"}'::jsonb,
    '{"error":"unknown"}'::jsonb
  ) then
    raise exception 'completion overwrote an ambiguous-outcome claim';
  end if;
end;
$$;

select pg_temp.expect_failure(
  $sql$
    select public.complete_api_idempotency(
      '22000000-0000-4000-8000-000000000001',
      'api:POST:/api/pour',
      'primary_key_0001',
      repeat('a', 64),
      99,
      '{}'::jsonb,
      '{}'::jsonb
    )
  $sql$,
  '22023'
);

select pg_temp.expect_failure(
  $sql$
    select public.complete_api_idempotency(
      '22000000-0000-4000-8000-000000000001',
      'api:POST:/api/pour',
      'primary_key_0001',
      repeat('a', 64),
      200,
      '["not-an-object"]'::jsonb,
      '{}'::jsonb
    )
  $sql$,
  '22023'
);

select pg_temp.expect_failure(
  $sql$
    select * from public.claim_api_idempotency(
      '22000000-0000-4000-8000-000000000001',
      'api:POST:/api/pour',
      'short',
      repeat('a', 64)
    )
  $sql$,
  '22023'
);

select pg_temp.expect_failure(
  $sql$
    select * from public.claim_api_idempotency(
      '22000000-0000-4000-8000-000000000001',
      'api:POST:/api/pour',
      'valid_key_0001',
      repeat('A', 64)
    )
  $sql$,
  '22023'
);

reset role;

-- User B can independently claim the same tenant/operation/key.
select set_config(
  'request.jwt.claim.sub',
  '12000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'primary_key_0001',
    repeat('a', 64)
  );
  if v_result.outcome <> 'claimed' then
    raise exception 'user-scoped claim collided: %', row_to_json(v_result);
  end if;
end;
$$;

reset role;

-- A non-member cannot create a claim for a restaurant.
select set_config(
  'request.jwt.claim.sub',
  '12000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.claim_api_idempotency(
      '22000000-0000-4000-8000-000000000001',
      'api:POST:/api/pour',
      'forbidden_key_01',
      repeat('e', 64)
    )
  $sql$,
  '42501'
);

reset role;

-- Claims report expiry after 24 hours but remain observable until the
-- conservative 25-hour cleanup sweep.
insert into public.api_idempotency (
  restaurant_id,
  user_id,
  operation_id,
  idempotency_key,
  request_hash,
  created_at,
  updated_at
) values (
  '22000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001',
  'api:POST:/api/pour',
  'observable_expired_01',
  repeat('f', 64),
  now() - interval '24 hours 30 minutes',
  now() - interval '24 hours 30 minutes'
), (
  '22000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001',
  'api:POST:/api/pour',
  'sweep_expired_key_01',
  repeat('e', 64),
  now() - interval '25 hours 1 minute',
  now() - interval '25 hours 1 minute'
);

select set_config(
  'request.jwt.claim.sub',
  '12000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.claim_api_idempotency(
    '22000000-0000-4000-8000-000000000001',
    'api:POST:/api/pour',
    'observable_expired_01',
    repeat('f', 64)
  );
  if v_result.outcome <> 'expired'
     or v_result.response_status is not null
     or v_result.response_headers is not null
     or v_result.response_body is not null then
    raise exception 'retained stale claim did not report expired: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

do $$
declare
  v_deleted bigint;
begin
  v_deleted := public.cleanup_api_idempotency();
  if v_deleted <> 1 then
    raise exception 'cleanup deleted %, expected 1', v_deleted;
  end if;

  if exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'sweep_expired_key_01'
  ) then
    raise exception 'cleanup retained a row older than 25 hours';
  end if;

  if not exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'observable_expired_01'
  ) then
    raise exception 'cleanup removed a row before the 25-hour sweep window';
  end if;
end;
$$;

rollback;

select '0056 API idempotency acceptance passed' as result;
