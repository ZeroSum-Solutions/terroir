-- 0074_background_job_lifecycle.sql
-- Durable, tenant-safe lifecycle primitives for the separately deployed worker.

-- Existing `processing` rows came from the pre-worker placeholder model. Return
-- them to the retry queue because no lease token exists to prove ownership.
alter table public.background_jobs
  add column idempotency_key text,
  add column claimed_by text,
  add column lease_token uuid,
  add column heartbeat_at timestamptz,
  add column lease_expires_at timestamptz,
  add column dead_lettered_at timestamptz;

alter table public.background_jobs
  drop constraint if exists background_jobs_status_check;

update public.background_jobs
set status = 'retrying',
    run_after = now(),
    started_at = null,
    finished_at = null,
    error_code = 'legacy_processing_recovered',
    error_message = 'Recovered during background-job lifecycle migration'
where status = 'processing';

update public.background_jobs
set finished_at = coalesce(finished_at, updated_at, created_at),
    dead_lettered_at = case
      when status = 'failed' then coalesce(finished_at, updated_at, created_at)
      else null
    end
where status in ('succeeded', 'failed', 'cancelled');

alter table public.background_jobs
  add constraint background_jobs_status_check check (
    status in (
      'queued',
      'running',
      'succeeded',
      'failed',
      'retrying',
      'cancelled'
    )
  ),
  add constraint background_jobs_idempotency_key_shape check (
    idempotency_key is null
    or (
      idempotency_key = btrim(idempotency_key)
      and char_length(idempotency_key) between 1 and 128
    )
  ),
  add constraint background_jobs_claimed_by_shape check (
    claimed_by is null
    or (
      claimed_by = btrim(claimed_by)
      and char_length(claimed_by) between 1 and 128
    )
  ),
  add constraint background_jobs_error_shape check (
    (error_code is null or char_length(error_code) between 1 and 128)
    and (error_message is null or char_length(error_message) <= 2000)
  ),
  add constraint background_jobs_payload_size check (
    pg_column_size(metadata) <= 1048576
    and pg_column_size(result) <= 1048576
  ),
  add constraint background_jobs_lifecycle_shape check (
    (
      status = 'running'
      and attempt_count between 1 and max_attempts
      and claimed_by is not null
      and lease_token is not null
      and started_at is not null
      and heartbeat_at is not null
      and lease_expires_at > heartbeat_at
      and finished_at is null
      and dead_lettered_at is null
    )
    or (
      status in ('queued', 'retrying')
      and claimed_by is null
      and lease_token is null
      and heartbeat_at is null
      and lease_expires_at is null
      and finished_at is null
      and dead_lettered_at is null
    )
    or (
      status = 'succeeded'
      and claimed_by is null
      and lease_token is null
      and heartbeat_at is null
      and lease_expires_at is null
      and finished_at is not null
      and dead_lettered_at is null
    )
    or (
      status = 'failed'
      and claimed_by is null
      and lease_token is null
      and heartbeat_at is null
      and lease_expires_at is null
      and finished_at is not null
      and dead_lettered_at is not null
    )
    or (
      status = 'cancelled'
      and claimed_by is null
      and lease_token is null
      and heartbeat_at is null
      and lease_expires_at is null
      and finished_at is not null
      and dead_lettered_at is null
    )
  );

create unique index background_jobs_idempotency_idx
  on public.background_jobs (restaurant_id, job_type, idempotency_key)
  where idempotency_key is not null;

create index background_jobs_claimable_idx
  on public.background_jobs (run_after, created_at)
  where status in ('queued', 'retrying');

create index background_jobs_running_lease_idx
  on public.background_jobs (lease_expires_at)
  where status = 'running';

create index background_jobs_dead_letter_idx
  on public.background_jobs (restaurant_id, dead_lettered_at desc)
  where status = 'failed';

create or replace function public.assert_background_job_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id
     or new.created_by is distinct from old.created_by
     or new.job_type is distinct from old.job_type
     or new.subject_table is distinct from old.subject_table
     or new.subject_id is distinct from old.subject_id
     or new.max_attempts is distinct from old.max_attempts
     or new.metadata is distinct from old.metadata
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception using
      errcode = '23514',
      message = 'background job identity and input fields are immutable';
  end if;

  if new.status = old.status then
    return new;
  end if;

  if not (
    (old.status in ('queued', 'retrying') and new.status in ('running', 'failed', 'cancelled'))
    or (old.status = 'running' and new.status in ('succeeded', 'failed', 'retrying', 'cancelled'))
    or (old.status = 'failed' and new.status = 'queued')
  ) then
    raise exception using
      errcode = '23514',
      message = format(
        'invalid background job transition from %s to %s',
        old.status,
        new.status
      );
  end if;

  return new;
end;
$$;

revoke all on function public.assert_background_job_transition() from public;

create trigger background_jobs_transition_guard
  before update on public.background_jobs
  for each row execute function public.assert_background_job_transition();

drop policy if exists "members can read background jobs"
  on public.background_jobs;
drop policy if exists "members can create own background jobs"
  on public.background_jobs;

create policy "job creators and managers can read background jobs"
  on public.background_jobs for select
  to authenticated
  using (
    public.is_member(restaurant_id)
    and (
      created_by = auth.uid()
      or public.is_member_with_role(restaurant_id, 'manager')
    )
  );

revoke select, insert, update, delete on public.background_jobs
  from public, anon, authenticated;
grant select on public.background_jobs to authenticated;

create or replace function public.background_job_backoff(
  p_attempt_count integer,
  p_base_seconds integer default 30
)
returns interval
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_seconds integer;
begin
  if p_attempt_count < 1 then
    raise exception using
      errcode = '22023',
      message = 'attempt count must be positive';
  end if;

  if p_base_seconds < 1 or p_base_seconds > 3600 then
    raise exception using
      errcode = '22023',
      message = 'base backoff must be between 1 and 3600 seconds';
  end if;

  v_seconds := least(
    86400,
    p_base_seconds * power(2::numeric, least(p_attempt_count - 1, 16))::integer
  );

  return make_interval(secs => v_seconds);
end;
$$;

revoke all on function public.background_job_backoff(integer, integer)
  from public, anon, authenticated;
grant execute on function public.background_job_backoff(integer, integer)
  to service_role;

create or replace function public.enqueue_background_job(
  p_restaurant_id uuid,
  p_job_type text,
  p_idempotency_key text,
  p_subject_table text default null,
  p_subject_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_max_attempts integer default 3,
  p_run_after timestamptz default now()
)
returns public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requester uuid := auth.uid();
  v_job public.background_jobs;
begin
  if v_requester is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using errcode = '42501', message = 'restaurant access denied';
  end if;

  if p_job_type is null
     or p_job_type not in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf') then
    raise exception using errcode = '22023', message = 'unsupported background job type';
  end if;

  if p_idempotency_key is null
     or p_idempotency_key <> btrim(p_idempotency_key)
     or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;

  if p_subject_table is not null
     and (
       p_subject_table <> btrim(p_subject_table)
       or char_length(p_subject_table) not between 1 and 64
     ) then
    raise exception using errcode = '22023', message = 'invalid subject table';
  end if;

  if p_metadata is null or pg_column_size(p_metadata) > 1048576 then
    raise exception using errcode = '22023', message = 'invalid background job metadata';
  end if;

  if p_max_attempts not between 1 and 10 then
    raise exception using errcode = '22023', message = 'max attempts must be between 1 and 10';
  end if;

  if p_run_after is null or p_run_after > now() + interval '30 days' then
    raise exception using errcode = '22023', message = 'invalid background job schedule';
  end if;

  insert into public.background_jobs (
    restaurant_id,
    created_by,
    job_type,
    idempotency_key,
    subject_table,
    subject_id,
    metadata,
    max_attempts,
    run_after
  ) values (
    p_restaurant_id,
    v_requester,
    p_job_type,
    p_idempotency_key,
    p_subject_table,
    p_subject_id,
    p_metadata,
    p_max_attempts,
    p_run_after
  )
  on conflict (restaurant_id, job_type, idempotency_key)
    where idempotency_key is not null
  do nothing
  returning * into v_job;

  if v_job.id is null then
    select *
    into v_job
    from public.background_jobs
    where restaurant_id = p_restaurant_id
      and job_type = p_job_type
      and idempotency_key = p_idempotency_key;

    if v_job.id is null
       or v_job.created_by is distinct from v_requester
       or v_job.subject_table is distinct from p_subject_table
       or v_job.subject_id is distinct from p_subject_id
       or v_job.metadata is distinct from p_metadata
       or v_job.max_attempts is distinct from p_max_attempts then
      raise exception using
        errcode = '22023',
        message = 'idempotency key was reused with different job input';
    end if;
  end if;

  return v_job;
end;
$$;

revoke all on function public.enqueue_background_job(
  uuid, text, text, text, uuid, jsonb, integer, timestamptz
) from public, anon;
grant execute on function public.enqueue_background_job(
  uuid, text, text, text, uuid, jsonb, integer, timestamptz
) to authenticated;

create or replace function public.claim_background_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 120,
  p_base_backoff_seconds integer default 30
)
returns setof public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null
     or p_worker_id <> btrim(p_worker_id)
     or char_length(p_worker_id) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'invalid worker id';
  end if;

  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'claim limit must be between 1 and 100';
  end if;

  if p_lease_seconds not between 15 and 3600 then
    raise exception using errcode = '22023', message = 'lease must be between 15 and 3600 seconds';
  end if;

  if p_base_backoff_seconds not between 1 and 3600 then
    raise exception using errcode = '22023', message = 'invalid base backoff';
  end if;

  update public.background_jobs
  set status = 'failed',
      finished_at = now(),
      dead_lettered_at = now(),
      error_code = coalesce(error_code, 'attempt_limit_exhausted'),
      error_message = coalesce(error_message, 'Background job exhausted its attempt limit'),
      claimed_by = null,
      lease_token = null,
      heartbeat_at = null,
      lease_expires_at = null
  where status in ('queued', 'retrying')
    and attempt_count >= max_attempts;

  update public.background_jobs
  set status = case
        when attempt_count >= max_attempts then 'failed'
        else 'retrying'
      end,
      run_after = case
        when attempt_count >= max_attempts then run_after
        else now() + public.background_job_backoff(
          attempt_count,
          p_base_backoff_seconds
        )
      end,
      finished_at = case
        when attempt_count >= max_attempts then now()
        else null
      end,
      dead_lettered_at = case
        when attempt_count >= max_attempts then now()
        else null
      end,
      error_code = 'lease_timeout',
      error_message = 'Worker heartbeat lease expired',
      claimed_by = null,
      lease_token = null,
      heartbeat_at = null,
      lease_expires_at = null
  where status = 'running'
    and lease_expires_at <= now();

  return query
  with claimable as (
    select id
    from public.background_jobs
    where status in ('queued', 'retrying')
      and run_after <= now()
      and attempt_count < max_attempts
    order by run_after, created_at, id
    for update skip locked
    limit p_limit
  )
  update public.background_jobs as jobs
  set status = 'running',
      attempt_count = jobs.attempt_count + 1,
      started_at = now(),
      finished_at = null,
      claimed_by = p_worker_id,
      lease_token = gen_random_uuid(),
      heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      dead_lettered_at = null
  from claimable
  where jobs.id = claimable.id
  returning jobs.*;
end;
$$;

revoke all on function public.claim_background_jobs(text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_background_jobs(text, integer, integer, integer)
  to service_role;

create or replace function public.heartbeat_background_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_lease_seconds integer default 120
)
returns public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
begin
  if p_lease_seconds not between 15 and 3600 then
    raise exception using errcode = '22023', message = 'lease must be between 15 and 3600 seconds';
  end if;

  update public.background_jobs
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_job_id
    and status = 'running'
    and claimed_by = p_worker_id
    and lease_token = p_lease_token
    and lease_expires_at > now()
  returning * into v_job;

  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'background job lease is not active';
  end if;

  return v_job;
end;
$$;

revoke all on function public.heartbeat_background_job(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.heartbeat_background_job(uuid, text, uuid, integer)
  to service_role;

create or replace function public.complete_background_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_result jsonb default '{}'::jsonb
)
returns public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
begin
  if p_result is null or pg_column_size(p_result) > 1048576 then
    raise exception using errcode = '22023', message = 'invalid background job result';
  end if;

  update public.background_jobs
  set status = 'succeeded',
      result = p_result,
      finished_at = now(),
      error_code = null,
      error_message = null,
      claimed_by = null,
      lease_token = null,
      heartbeat_at = null,
      lease_expires_at = null,
      dead_lettered_at = null
  where id = p_job_id
    and status = 'running'
    and claimed_by = p_worker_id
    and lease_token = p_lease_token
    and lease_expires_at > now()
  returning * into v_job;

  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'background job lease is not active';
  end if;

  return v_job;
end;
$$;

revoke all on function public.complete_background_job(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_background_job(uuid, text, uuid, jsonb)
  to service_role;

create or replace function public.fail_background_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean default true,
  p_base_backoff_seconds integer default 30
)
returns public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
begin
  if p_error_code is null
     or p_error_code <> btrim(p_error_code)
     or char_length(p_error_code) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'invalid background job error code';
  end if;

  if p_error_message is null or char_length(p_error_message) > 2000 then
    raise exception using errcode = '22023', message = 'invalid background job error message';
  end if;

  if p_base_backoff_seconds not between 1 and 3600 then
    raise exception using errcode = '22023', message = 'invalid base backoff';
  end if;

  update public.background_jobs
  set status = case
        when p_retryable and attempt_count < max_attempts then 'retrying'
        else 'failed'
      end,
      run_after = case
        when p_retryable and attempt_count < max_attempts
          then now() + public.background_job_backoff(
            attempt_count,
            p_base_backoff_seconds
          )
        else run_after
      end,
      finished_at = case
        when p_retryable and attempt_count < max_attempts then null
        else now()
      end,
      error_code = p_error_code,
      error_message = p_error_message,
      claimed_by = null,
      lease_token = null,
      heartbeat_at = null,
      lease_expires_at = null,
      dead_lettered_at = case
        when p_retryable and attempt_count < max_attempts then null
        else now()
      end
  where id = p_job_id
    and status = 'running'
    and claimed_by = p_worker_id
    and lease_token = p_lease_token
    and lease_expires_at > now()
  returning * into v_job;

  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'background job lease is not active';
  end if;

  return v_job;
end;
$$;

revoke all on function public.fail_background_job(
  uuid, text, uuid, text, text, boolean, integer
) from public, anon, authenticated;
grant execute on function public.fail_background_job(
  uuid, text, uuid, text, text, boolean, integer
) to service_role;

create or replace function public.cancel_background_job(
  p_restaurant_id uuid,
  p_job_id uuid
)
returns public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requester uuid := auth.uid();
  v_job public.background_jobs;
begin
  if v_requester is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  select *
  into v_job
  from public.background_jobs
  where id = p_job_id
    and restaurant_id = p_restaurant_id
  for update;

  if v_job.id is null
     or not public.is_member(p_restaurant_id)
     or not (
       v_job.created_by = v_requester
       or public.is_member_with_role(p_restaurant_id, 'manager')
     ) then
    raise exception using errcode = '42501', message = 'background job access denied';
  end if;

  if v_job.status = 'cancelled' then
    return v_job;
  end if;

  if v_job.status not in ('queued', 'retrying', 'running') then
    raise exception using errcode = '55000', message = 'completed background job cannot be cancelled';
  end if;

  update public.background_jobs
  set status = 'cancelled',
      finished_at = now(),
      claimed_by = null,
      lease_token = null,
      heartbeat_at = null,
      lease_expires_at = null,
      dead_lettered_at = null
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

revoke all on function public.cancel_background_job(uuid, uuid)
  from public, anon;
grant execute on function public.cancel_background_job(uuid, uuid)
  to authenticated;

create or replace function public.requeue_background_job(
  p_restaurant_id uuid,
  p_job_id uuid,
  p_run_after timestamptz default now()
)
returns public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requester uuid := auth.uid();
  v_job public.background_jobs;
begin
  if v_requester is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using errcode = '42501', message = 'manager access required';
  end if;

  if p_run_after is null or p_run_after > now() + interval '30 days' then
    raise exception using errcode = '22023', message = 'invalid background job schedule';
  end if;

  update public.background_jobs
  set status = 'queued',
      attempt_count = 0,
      run_after = p_run_after,
      started_at = null,
      finished_at = null,
      error_code = null,
      error_message = null,
      result = '{}'::jsonb,
      claimed_by = null,
      lease_token = null,
      heartbeat_at = null,
      lease_expires_at = null,
      dead_lettered_at = null
  where id = p_job_id
    and restaurant_id = p_restaurant_id
    and status = 'failed'
  returning * into v_job;

  if v_job.id is null then
    raise exception using errcode = '55000', message = 'dead-lettered background job not found';
  end if;

  return v_job;
end;
$$;

revoke all on function public.requeue_background_job(uuid, uuid, timestamptz)
  from public, anon;
grant execute on function public.requeue_background_job(uuid, uuid, timestamptz)
  to authenticated;

comment on table public.background_jobs is
  'Durable job state. User mutations use enqueue/cancel/requeue RPCs; service-role workers use lease-token RPCs.';

comment on column public.background_jobs.idempotency_key is
  'Caller-supplied tenant-and-job-type idempotency key; null only for pre-0074 legacy rows.';

comment on column public.background_jobs.lease_token is
  'Opaque claim token required for heartbeat, completion, and failure updates.';

comment on column public.background_jobs.dead_lettered_at is
  'Timestamp when a non-retryable or attempt-exhausted job became actionable.';
