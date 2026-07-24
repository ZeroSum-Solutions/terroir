-- TER-020D01 — distributed authenticated API rate limiting.
--
-- Every authenticated API operation consumes two fixed-window buckets in the
-- same database transaction:
--   1. a global per-user bucket; and
--   2. a per-user bucket for the operation's server-assigned risk class.
--
-- The function derives the user from auth.uid(). Callers cannot choose a
-- subject or a numerical limit. The backing table has no client-facing grants
-- or RLS policies; authenticated callers can interact only through the
-- SECURITY DEFINER function.

create table public.api_rate_limit_buckets (
  user_id         uuid        not null references auth.users(id) on delete cascade,
  bucket_key      text        not null check (
    bucket_key in (
      'global',
      'class:standard',
      'class:mutation',
      'class:expensive',
      'class:sensitive'
    )
  ),
  window_start    timestamptz not null,
  window_seconds  integer     not null check (window_seconds in (60, 3600)),
  request_count   bigint      not null check (request_count > 0),
  reset_at        timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, bucket_key, window_start),
  constraint api_rate_limit_bucket_window
    check (
      reset_at
      = window_start + make_interval(secs => window_seconds)
    )
);

create index api_rate_limit_buckets_reset_at_idx
  on public.api_rate_limit_buckets (reset_at);

alter table public.api_rate_limit_buckets enable row level security;

revoke all on table public.api_rate_limit_buckets from public;
revoke all on table public.api_rate_limit_buckets from anon;
revoke all on table public.api_rate_limit_buckets from authenticated;

create or replace function public.consume_api_rate_limit(
  p_risk_class text
) returns table (
  allowed boolean,
  limit_count integer,
  remaining integer,
  retry_after_seconds integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_global_limit constant integer := 600;
  v_global_window_seconds constant integer := 60;
  v_class_limit integer;
  v_class_window_seconds integer;
  v_global_window_start timestamptz;
  v_class_window_start timestamptz;
  v_global_reset_at timestamptz;
  v_class_reset_at timestamptz;
  v_global_count bigint;
  v_class_count bigint;
  v_allowed boolean;
  v_effective_limit integer;
  v_effective_count bigint;
  v_effective_reset_at timestamptz;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  case p_risk_class
    when 'standard' then
      v_class_limit := 120;
      v_class_window_seconds := 60;
    when 'mutation' then
      v_class_limit := 60;
      v_class_window_seconds := 60;
    when 'expensive' then
      v_class_limit := 10;
      v_class_window_seconds := 60;
    when 'sensitive' then
      v_class_limit := 10;
      v_class_window_seconds := 3600;
    else
      raise exception using
        errcode = '22023',
        message = 'invalid API risk class';
  end case;

  v_global_window_start := to_timestamp(
    floor(
      extract(epoch from v_now) / v_global_window_seconds
    ) * v_global_window_seconds
  );
  v_class_window_start := to_timestamp(
    floor(
      extract(epoch from v_now) / v_class_window_seconds
    ) * v_class_window_seconds
  );
  v_global_reset_at :=
    v_global_window_start
    + make_interval(secs => v_global_window_seconds);
  v_class_reset_at :=
    v_class_window_start
    + make_interval(secs => v_class_window_seconds);

  -- All calls take the shared global bucket before their class bucket. This
  -- consistent lock order prevents cross-class deadlocks for one user.
  insert into public.api_rate_limit_buckets as bucket (
    user_id,
    bucket_key,
    window_start,
    window_seconds,
    request_count,
    reset_at
  ) values (
    v_user_id,
    'global',
    v_global_window_start,
    v_global_window_seconds,
    1,
    v_global_reset_at
  )
  on conflict (user_id, bucket_key, window_start)
  do update
  set request_count = bucket.request_count + 1,
      window_seconds = excluded.window_seconds,
      reset_at = excluded.reset_at,
      updated_at = v_now
  returning request_count into v_global_count;

  insert into public.api_rate_limit_buckets as bucket (
    user_id,
    bucket_key,
    window_start,
    window_seconds,
    request_count,
    reset_at
  ) values (
    v_user_id,
    'class:' || p_risk_class,
    v_class_window_start,
    v_class_window_seconds,
    1,
    v_class_reset_at
  )
  on conflict (user_id, bucket_key, window_start)
  do update
  set request_count = bucket.request_count + 1,
      window_seconds = excluded.window_seconds,
      reset_at = excluded.reset_at,
      updated_at = v_now
  returning request_count into v_class_count;

  v_allowed :=
    v_global_count <= v_global_limit
    and v_class_count <= v_class_limit;

  -- Successful requests report the risk-class bucket because it is the
  -- tighter normal limit. A rejected request reports the bucket whose reset
  -- must be awaited; if both reject, the later reset controls Retry-After.
  if v_global_count > v_global_limit
     and (
       v_class_count <= v_class_limit
       or v_global_reset_at > v_class_reset_at
     ) then
    v_effective_limit := v_global_limit;
    v_effective_count := v_global_count;
    v_effective_reset_at := v_global_reset_at;
  else
    v_effective_limit := v_class_limit;
    v_effective_count := v_class_count;
    v_effective_reset_at := v_class_reset_at;
  end if;

  return query
  select
    v_allowed,
    v_effective_limit,
    greatest(
      0,
      v_effective_limit - least(v_effective_count, 2147483647)::integer
    ),
    case
      when v_allowed then 0
      else greatest(
        1,
        ceil(
          extract(epoch from (v_effective_reset_at - v_now))
        )::integer
      )
    end,
    v_effective_reset_at;
end;
$$;

revoke all on function public.consume_api_rate_limit(text) from public;
revoke all on function public.consume_api_rate_limit(text) from anon;
grant execute on function public.consume_api_rate_limit(text) to authenticated;

create or replace function public.cleanup_api_rate_limit_buckets()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  delete from public.api_rate_limit_buckets
  where reset_at < clock_timestamp() - interval '1 hour';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_api_rate_limit_buckets() from public;
revoke all on function public.cleanup_api_rate_limit_buckets() from anon;
revoke all on function public.cleanup_api_rate_limit_buckets()
  from authenticated;
grant execute on function public.cleanup_api_rate_limit_buckets()
  to service_role;

select cron.schedule(
  'cleanup_api_rate_limit_buckets_hourly',
  '15 * * * *',
  $$select public.cleanup_api_rate_limit_buckets();$$
);

comment on table public.api_rate_limit_buckets is
  'Distributed fixed-window counters for authenticated per-user API limits.';

comment on function public.consume_api_rate_limit(text) is
  'Atomically consumes per-user global and risk-class API buckets using hardcoded server-side limits.';

comment on function public.cleanup_api_rate_limit_buckets() is
  'Deletes API rate-limit buckets more than one hour past their reset time.';
