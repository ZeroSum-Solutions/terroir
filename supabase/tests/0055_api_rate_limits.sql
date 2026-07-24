-- Focused acceptance test for 0055_api_rate_limits.sql.
-- Run against an isolated, migrated Supabase database:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0055_api_rate_limits.sql

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
  '11000000-0000-4000-8000-000000000001',
  'rate-limit-a@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
), (
  '11000000-0000-4000-8000-000000000002',
  'rate-limit-b@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

-- The table is not a client API. Authenticated users cannot inspect or forge
-- counters directly, while the SECURITY DEFINER function can update them.
set local role authenticated;
select pg_temp.expect_failure(
  $sql$select * from public.api_rate_limit_buckets$sql$,
  '42501'
);
reset role;

do $$
begin
  if has_table_privilege(
    'authenticated',
    'public.api_rate_limit_buckets',
    'SELECT'
  ) then
    raise exception 'authenticated retains direct rate-limit table access';
  end if;

  if has_table_privilege(
    'anon',
    'public.api_rate_limit_buckets',
    'SELECT'
  ) then
    raise exception 'anon retains direct rate-limit table access';
  end if;

  if has_function_privilege(
    'anon',
    'public.consume_api_rate_limit(text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains rate-limit function execute';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.consume_api_rate_limit(text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks rate-limit function execute';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid in (
      to_regprocedure('public.consume_api_rate_limit(text)'),
      to_regprocedure('public.cleanup_api_rate_limit_buckets()')
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'rate-limit function lacks SECURITY DEFINER empty search_path';
  end if;
end;
$$;

-- No authenticated subject means the function fails before creating a bucket.
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$select * from public.consume_api_rate_limit('standard')$sql$,
  '42501'
);
reset role;

-- User A consumes the standard class. Its 120/minute class bucket is the
-- effective metadata bucket; the 600/minute global bucket is also incremented.
select set_config(
  'request.jwt.claim.sub',
  '11000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
  v_index integer;
  v_reset_at timestamptz;
begin
  select * into v_result
  from public.consume_api_rate_limit('standard');

  if not v_result.allowed
     or v_result.limit_count <> 120
     or v_result.remaining <> 119
     or v_result.retry_after_seconds <> 0
     or v_result.reset_at <= clock_timestamp()
     or v_result.reset_at > clock_timestamp() + interval '60 seconds' then
    raise exception 'unexpected first standard result: %', row_to_json(v_result);
  end if;
  v_reset_at := v_result.reset_at;

  for v_index in 2..120 loop
    select * into v_result
    from public.consume_api_rate_limit('standard');
  end loop;

  if not v_result.allowed
     or v_result.limit_count <> 120
     or v_result.remaining <> 0
     or v_result.retry_after_seconds <> 0
     or v_result.reset_at <> v_reset_at then
    raise exception 'unexpected final allowed standard result: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.consume_api_rate_limit('standard');

  if v_result.allowed
     or v_result.limit_count <> 120
     or v_result.remaining <> 0
     or v_result.retry_after_seconds < 1
     or v_result.retry_after_seconds > 60
     or v_result.reset_at <> v_reset_at then
    raise exception 'unexpected rejected standard result: %',
      row_to_json(v_result);
  end if;
end;
$$;

select pg_temp.expect_failure(
  $sql$select * from public.consume_api_rate_limit('unknown')$sql$,
  '22023'
);

reset role;

do $$
declare
  v_global_count bigint;
  v_class_count bigint;
begin
  select request_count into v_global_count
  from public.api_rate_limit_buckets
  where user_id = '11000000-0000-4000-8000-000000000001'
    and bucket_key = 'global';

  select request_count into v_class_count
  from public.api_rate_limit_buckets
  where user_id = '11000000-0000-4000-8000-000000000001'
    and bucket_key = 'class:standard';

  if v_global_count <> 121 or v_class_count <> 121 then
    raise exception
      'global and class counters were not consumed together: global=%, class=%',
      v_global_count,
      v_class_count;
  end if;
end;
$$;

-- A second user receives independent global and class buckets.
select set_config(
  'request.jwt.claim.sub',
  '11000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
  v_index integer;
begin
  select * into v_result
  from public.consume_api_rate_limit('standard');
  if not v_result.allowed or v_result.remaining <> 119 then
    raise exception 'user buckets are not independent: %', row_to_json(v_result);
  end if;

  for v_index in 1..10 loop
    select * into v_result
    from public.consume_api_rate_limit('sensitive');
  end loop;
  if not v_result.allowed
     or v_result.limit_count <> 10
     or v_result.remaining <> 0 then
    raise exception 'unexpected sensitive limit result: %', row_to_json(v_result);
  end if;

  select * into v_result
  from public.consume_api_rate_limit('sensitive');
  if v_result.allowed
     or v_result.limit_count <> 10
     or v_result.remaining <> 0
     or v_result.retry_after_seconds < 1
     or v_result.retry_after_seconds > 3600 then
    raise exception 'sensitive class did not enforce 10/hour: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

-- Cleanup removes only buckets that have been expired for more than an hour.
insert into public.api_rate_limit_buckets (
  user_id,
  bucket_key,
  window_start,
  window_seconds,
  request_count,
  reset_at
) values (
  '11000000-0000-4000-8000-000000000002',
  'class:mutation',
  date_trunc('minute', now()) - interval '3 hours',
  60,
  1,
  date_trunc('minute', now()) - interval '3 hours' + interval '60 seconds'
);

do $$
declare
  v_deleted bigint;
begin
  v_deleted := public.cleanup_api_rate_limit_buckets();
  if v_deleted <> 1 then
    raise exception 'cleanup deleted %, expected 1', v_deleted;
  end if;

  if exists (
    select 1
    from public.api_rate_limit_buckets
    where user_id = '11000000-0000-4000-8000-000000000002'
      and bucket_key = 'class:mutation'
  ) then
    raise exception 'cleanup retained an expired bucket';
  end if;
end;
$$;

rollback;

select '0055 API rate limits acceptance passed' as result;
