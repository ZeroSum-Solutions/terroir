-- Acceptance coverage for 0074_background_job_lifecycle.sql.
-- Run against an isolated database migrated through 0074:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0074_background_job_lifecycle.sql

begin;

create or replace function pg_temp.expect_failure(
  p_sql text,
  p_sqlstate text,
  p_message text default null
) returns void
language plpgsql
as $$
declare
  v_sqlstate text;
  v_message text;
begin
  begin
    execute p_sql;
    raise exception using
      errcode = 'XX000',
      message = 'expected statement to fail: ' || p_sql;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_message = message_text;

    if v_sqlstate <> p_sqlstate
       or (p_message is not null and v_message is distinct from p_message) then
      raise exception 'unexpected failure: state=%, message=%',
        v_sqlstate,
        v_message;
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
) values
  (
    '74000000-0000-4000-8000-000000000001',
    'jobs-owner-a@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '74000000-0000-4000-8000-000000000002',
    'jobs-staff-a@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '74000000-0000-4000-8000-000000000003',
    'jobs-owner-b@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '74000000-0000-4000-8000-000000000004',
    'jobs-outsider@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '74000000-0000-4000-8000-000000000005',
    'jobs-former-member@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  ('74100000-0000-4000-8000-000000000001', 'Jobs Restaurant A'),
  ('74100000-0000-4000-8000-000000000002', 'Jobs Restaurant B');

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '74000000-0000-4000-8000-000000000001',
    '74100000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '74000000-0000-4000-8000-000000000002',
    '74100000-0000-4000-8000-000000000001',
    'staff'
  ),
  (
    '74000000-0000-4000-8000-000000000003',
    '74100000-0000-4000-8000-000000000002',
    'owner'
  ),
  (
    '74000000-0000-4000-8000-000000000005',
    '74100000-0000-4000-8000-000000000001',
    'staff'
  );

-- The table is read-only to authenticated callers and entirely hidden from
-- anonymous callers. Mutations cross explicit RPC boundaries.
do $$
declare
  v_signature text;
begin
  if has_table_privilege('authenticated', 'public.background_jobs', 'INSERT')
     or has_table_privilege('authenticated', 'public.background_jobs', 'UPDATE')
     or has_table_privilege('authenticated', 'public.background_jobs', 'DELETE') then
    raise exception 'authenticated retains direct background job mutation';
  end if;

  if not has_table_privilege('authenticated', 'public.background_jobs', 'SELECT') then
    raise exception 'authenticated lacks background job read access';
  end if;

  if has_table_privilege('anon', 'public.background_jobs', 'SELECT') then
    raise exception 'anonymous callers can read background jobs';
  end if;

  foreach v_signature in array array[
    'public.enqueue_background_job(uuid,text,text,text,uuid,jsonb,integer,timestamptz)',
    'public.cancel_background_job(uuid,uuid)',
    'public.requeue_background_job(uuid,uuid,timestamptz)'
  ] loop
    if not has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception 'authenticated lacks execute on %', v_signature;
    end if;
    if has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception 'anonymous caller retains execute on %', v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.claim_background_jobs(text,integer,integer,integer)',
    'public.heartbeat_background_job(uuid,text,uuid,integer)',
    'public.complete_background_job(uuid,text,uuid,jsonb)',
    'public.fail_background_job(uuid,text,uuid,text,text,boolean,integer)'
  ] loop
    if has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception 'untrusted role retains worker execute on %', v_signature;
    end if;
    if not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'service role lacks worker execute on %', v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc
    where oid in (
      to_regprocedure('public.enqueue_background_job(uuid,text,text,text,uuid,jsonb,integer,timestamptz)'),
      to_regprocedure('public.claim_background_jobs(text,integer,integer,integer)'),
      to_regprocedure('public.heartbeat_background_job(uuid,text,uuid,integer)'),
      to_regprocedure('public.complete_background_job(uuid,text,uuid,jsonb)'),
      to_regprocedure('public.fail_background_job(uuid,text,uuid,text,text,boolean,integer)'),
      to_regprocedure('public.cancel_background_job(uuid,uuid)'),
      to_regprocedure('public.requeue_background_job(uuid,uuid,timestamptz)')
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'background job RPC lacks hardened definer configuration';
  end if;
end;
$$;

-- No JWT identity and a non-member both fail closed.
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$
    select public.enqueue_background_job(
      '74100000-0000-4000-8000-000000000001',
      'invoice_ocr',
      'no-identity'
    )
  $sql$,
  '42501',
  'authentication required'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000004',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$
    select public.enqueue_background_job(
      '74100000-0000-4000-8000-000000000001',
      'invoice_ocr',
      'cross-tenant'
    )
  $sql$,
  '42501',
  'restaurant access denied'
);
reset role;

-- Staff can enqueue idempotently. Reusing a key with different input fails.
select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
do $$
declare
  v_first public.background_jobs;
  v_replay public.background_jobs;
begin
  v_first := public.enqueue_background_job(
    '74100000-0000-4000-8000-000000000001',
    'invoice_ocr',
    'staff-enqueue',
    'invoice_scans',
    '74200000-0000-4000-8000-000000000001',
    '{"source":"fixture"}'::jsonb,
    3
  );

  v_replay := public.enqueue_background_job(
    '74100000-0000-4000-8000-000000000001',
    'invoice_ocr',
    'staff-enqueue',
    'invoice_scans',
    '74200000-0000-4000-8000-000000000001',
    '{"source":"fixture"}'::jsonb,
    3
  );

  if v_first.id is distinct from v_replay.id
     or v_first.created_by is distinct from
       '74000000-0000-4000-8000-000000000002'::uuid then
    raise exception 'idempotent enqueue did not return the caller-owned job';
  end if;

  if (
    select count(*)
    from public.background_jobs
    where restaurant_id = '74100000-0000-4000-8000-000000000001'
      and job_type = 'invoice_ocr'
      and idempotency_key = 'staff-enqueue'
  ) <> 1 then
    raise exception 'idempotent enqueue created duplicate jobs';
  end if;
end;
$$;

select pg_temp.expect_failure(
  $sql$
    select public.enqueue_background_job(
      '74100000-0000-4000-8000-000000000001',
      'invoice_ocr',
      'staff-enqueue',
      'invoice_scans',
      '74200000-0000-4000-8000-000000000001',
      '{"source":"different"}'::jsonb,
      3
    )
  $sql$,
  '22023',
  'idempotency key was reused with different job input'
);

select pg_temp.expect_failure(
  $sql$delete from public.background_jobs$sql$,
  '42501'
);
reset role;

-- Create manager, cross-tenant, and former-member rows through the same public
-- boundary before evaluating row-level visibility.
select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select public.enqueue_background_job(
  '74100000-0000-4000-8000-000000000001',
  'wine_enrichment',
  'owner-a-enqueue'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;
select public.enqueue_background_job(
  '74100000-0000-4000-8000-000000000002',
  'wine_list_pdf',
  'owner-b-enqueue'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000005',
  true
);
set local role authenticated;
select public.enqueue_background_job(
  '74100000-0000-4000-8000-000000000001',
  'wine_list_pdf',
  'former-member-enqueue'
);
reset role;

delete from public.memberships
where user_id = '74000000-0000-4000-8000-000000000005';

-- Staff only sees its own row. Tenant managers see every tenant row. A user in
-- another tenant and a former member cannot retain visibility.
select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.background_jobs;
  if v_count <> 1 then
    raise exception 'staff visibility is broader than its own current-member job: %', v_count;
  end if;
end;
$$;
reset role;

select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.background_jobs
  where restaurant_id = '74100000-0000-4000-8000-000000000001';
  if v_count <> 3 then
    raise exception 'tenant owner cannot see every tenant job: %', v_count;
  end if;

  select count(*) into v_count
  from public.background_jobs
  where restaurant_id = '74100000-0000-4000-8000-000000000002';
  if v_count <> 0 then
    raise exception 'tenant owner can see cross-tenant jobs';
  end if;
end;
$$;
reset role;

select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000005',
  true
);
set local role authenticated;
do $$
begin
  if (select count(*) from public.background_jobs) <> 0 then
    raise exception 'former member retained job visibility';
  end if;
end;
$$;
reset role;

-- State-machine tests use a clean queue.
truncate public.background_jobs;

select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select public.enqueue_background_job(
  '74100000-0000-4000-8000-000000000001',
  'invoice_ocr',
  'complete-job'
);
reset role;

-- Claims increment attempts atomically. Only the active lease may heartbeat or
-- complete, and a completed token cannot deliver output twice.
set local role service_role;
do $$
declare
  v_claim public.background_jobs;
  v_heartbeat public.background_jobs;
  v_complete public.background_jobs;
  v_previous_expiry timestamptz;
begin
  select * into v_claim
  from public.claim_background_jobs('worker-a', 1, 120, 30);

  if v_claim.status <> 'running'
     or v_claim.attempt_count <> 1
     or v_claim.lease_token is null then
    raise exception 'unexpected claim result: %', row_to_json(v_claim);
  end if;

  perform pg_temp.expect_failure(
    format(
      'select public.heartbeat_background_job(%L, %L, %L, 120)',
      v_claim.id,
      'wrong-worker',
      v_claim.lease_token
    ),
    'P0001',
    'background job lease is not active'
  );

  v_previous_expiry := v_claim.lease_expires_at;
  v_heartbeat := public.heartbeat_background_job(
    v_claim.id,
    'worker-a',
    v_claim.lease_token,
    180
  );
  if v_heartbeat.lease_expires_at <= v_previous_expiry then
    raise exception 'heartbeat did not extend the lease';
  end if;

  v_complete := public.complete_background_job(
    v_claim.id,
    'worker-a',
    v_claim.lease_token,
    '{"artifact":"fixture.pdf"}'::jsonb
  );
  if v_complete.status <> 'succeeded'
     or v_complete.finished_at is null
     or v_complete.result <> '{"artifact":"fixture.pdf"}'::jsonb
     or v_complete.lease_token is not null then
    raise exception 'completion did not seal the job';
  end if;

  perform pg_temp.expect_failure(
    format(
      'select public.complete_background_job(%L, %L, %L, %L::jsonb)',
      v_claim.id,
      'worker-a',
      v_claim.lease_token,
      '{"artifact":"duplicate.pdf"}'
    ),
    'P0001',
    'background job lease is not active'
  );
end;
$$;
reset role;

-- Retryable failures use 10s, 20s, ... exponential delays and become a dead
-- letter at the attempt limit.
truncate public.background_jobs;
select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select public.enqueue_background_job(
  '74100000-0000-4000-8000-000000000001',
  'wine_enrichment',
  'retry-job',
  null,
  null,
  '{}'::jsonb,
  3
);
reset role;

do $$
declare
  v_claim public.background_jobs;
  v_failed public.background_jobs;
  v_attempt integer;
begin
  for v_attempt in 1..3 loop
    select * into v_claim
    from public.claim_background_jobs('worker-retry', 1, 120, 10);

    if v_claim.attempt_count <> v_attempt then
      raise exception 'claim attempt mismatch: expected %, got %',
        v_attempt,
        v_claim.attempt_count;
    end if;

    v_failed := public.fail_background_job(
      v_claim.id,
      'worker-retry',
      v_claim.lease_token,
      'provider_unavailable',
      'Fixture provider failure',
      true,
      10
    );

    if v_attempt < 3 then
      if v_failed.status <> 'retrying'
         or v_failed.run_after < now() + make_interval(secs => 10 * (2 ^ (v_attempt - 1)))
         or v_failed.dead_lettered_at is not null then
        raise exception 'retry backoff mismatch at attempt %: %',
          v_attempt,
          row_to_json(v_failed);
      end if;

      update public.background_jobs
      set run_after = now() - interval '1 second'
      where id = v_claim.id;
    else
      if v_failed.status <> 'failed'
         or v_failed.finished_at is null
         or v_failed.dead_lettered_at is null then
        raise exception 'attempt-exhausted job did not dead-letter';
      end if;
    end if;
  end loop;
end;
$$;

-- Staff cannot replay dead letters; tenant managers can, and replay resets all
-- attempt/lease/error state without changing the idempotent job identity.
select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  format(
    'select public.requeue_background_job(%L, %L)',
    '74100000-0000-4000-8000-000000000001',
    (
      select id
      from public.background_jobs
      where idempotency_key = 'retry-job'
    )
  ),
  '42501',
  'manager access required'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
do $$
declare
  v_job public.background_jobs;
begin
  v_job := public.requeue_background_job(
    '74100000-0000-4000-8000-000000000001',
    (
      select id
      from public.background_jobs
      where idempotency_key = 'retry-job'
    )
  );

  if v_job.status <> 'queued'
     or v_job.attempt_count <> 0
     or v_job.error_code is not null
     or v_job.dead_lettered_at is not null then
    raise exception 'manager replay did not reset dead letter';
  end if;
end;
$$;
reset role;

-- A lost worker is recovered into retrying; expiration on the last attempt is
-- terminal. Recovery and the next claim occur in one claim transaction.
truncate public.background_jobs;
select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select public.enqueue_background_job(
  '74100000-0000-4000-8000-000000000001',
  'invoice_ocr',
  'timeout-job',
  null,
  null,
  '{}'::jsonb,
  2
);
reset role;

do $$
declare
  v_claim public.background_jobs;
begin
  select * into v_claim
  from public.claim_background_jobs('worker-timeout', 1, 15, 1);

  update public.background_jobs
  set heartbeat_at = now() - interval '2 minutes',
      lease_expires_at = now() - interval '1 minute'
  where id = v_claim.id;

  if exists (
    select 1 from public.claim_background_jobs('worker-recovery', 1, 15, 1)
  ) then
    raise exception 'timed-out job ignored retry backoff';
  end if;

  select * into v_claim
  from public.background_jobs
  where id = v_claim.id;

  if v_claim.status <> 'retrying'
     or v_claim.error_code <> 'lease_timeout'
     or v_claim.lease_token is not null then
    raise exception 'timed-out job was not recovered safely';
  end if;

  update public.background_jobs
  set run_after = now() - interval '1 second'
  where id = v_claim.id;

  select * into v_claim
  from public.claim_background_jobs('worker-recovery', 1, 15, 1);

  if v_claim.attempt_count <> 2 then
    raise exception 'recovered job did not advance to its second attempt';
  end if;

  update public.background_jobs
  set heartbeat_at = now() - interval '2 minutes',
      lease_expires_at = now() - interval '1 minute'
  where id = v_claim.id;

  perform public.claim_background_jobs('worker-recovery', 1, 15, 1);

  select * into v_claim
  from public.background_jobs
  where id = v_claim.id;

  if v_claim.status <> 'failed'
     or v_claim.error_code <> 'lease_timeout'
     or v_claim.dead_lettered_at is null then
    raise exception 'last-attempt timeout did not dead-letter';
  end if;
end;
$$;

-- Cancellation is caller-bound, can revoke an active lease, and makes a late
-- worker completion fail. Cancellation itself is idempotent.
truncate public.background_jobs;
select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select public.enqueue_background_job(
  '74100000-0000-4000-8000-000000000001',
  'wine_list_pdf',
  'cancel-job'
);
reset role;

set local role service_role;
create temporary table job_claim_fixture on commit drop as
select * from public.claim_background_jobs('worker-cancel', 1, 120, 30);
reset role;
grant select on job_claim_fixture to authenticated, service_role;

select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000004',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  format(
    'select public.cancel_background_job(%L, %L)',
    '74100000-0000-4000-8000-000000000001',
    (select id from job_claim_fixture)
  ),
  '42501',
  'background job access denied'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '74000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
do $$
declare
  v_cancelled public.background_jobs;
begin
  v_cancelled := public.cancel_background_job(
    '74100000-0000-4000-8000-000000000001',
    (select id from job_claim_fixture)
  );

  if v_cancelled.status <> 'cancelled'
     or v_cancelled.finished_at is null
     or v_cancelled.lease_token is not null then
    raise exception 'cancellation did not revoke the active lease';
  end if;

  if (public.cancel_background_job(
    '74100000-0000-4000-8000-000000000001',
    v_cancelled.id
  )).status <> 'cancelled' then
    raise exception 'cancellation replay was not idempotent';
  end if;
end;
$$;
reset role;

set local role service_role;
select pg_temp.expect_failure(
  format(
    'select public.complete_background_job(%L, %L, %L, %L::jsonb)',
    (select id from job_claim_fixture),
    'worker-cancel',
    (select lease_token from job_claim_fixture),
    '{}'
  ),
  'P0001',
  'background job lease is not active'
);
reset role;

-- The transition guard rejects a terminal-state resurrection outside the
-- manager-only dead-letter replay function.
select pg_temp.expect_failure(
  format(
    'update public.background_jobs set status = %L where id = %L',
    'queued',
    (select id from job_claim_fixture)
  ),
  '23514',
  'invalid background job transition from cancelled to queued'
);

rollback;
