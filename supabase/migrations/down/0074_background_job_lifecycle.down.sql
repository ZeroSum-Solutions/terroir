-- 0074_background_job_lifecycle.down.sql
-- Remove worker lifecycle primitives and restore the pre-0074 queue model.

drop policy if exists "job creators and managers can read background jobs"
  on public.background_jobs;

drop function if exists public.requeue_background_job(uuid, uuid, timestamptz);
drop function if exists public.cancel_background_job(uuid, uuid);
drop function if exists public.fail_background_job(
  uuid, text, uuid, text, text, boolean, integer
);
drop function if exists public.complete_background_job(uuid, text, uuid, jsonb);
drop function if exists public.heartbeat_background_job(uuid, text, uuid, integer);
drop function if exists public.claim_background_jobs(text, integer, integer, integer);
drop function if exists public.enqueue_background_job(
  uuid, text, text, text, uuid, jsonb, integer, timestamptz
);
drop function if exists public.background_job_backoff(integer, integer);

drop trigger if exists background_jobs_transition_guard
  on public.background_jobs;
drop function if exists public.assert_background_job_transition();

drop index if exists public.background_jobs_dead_letter_idx;
drop index if exists public.background_jobs_running_lease_idx;
drop index if exists public.background_jobs_claimable_idx;
drop index if exists public.background_jobs_idempotency_idx;

alter table public.background_jobs
  drop constraint if exists background_jobs_lifecycle_shape,
  drop constraint if exists background_jobs_payload_size,
  drop constraint if exists background_jobs_error_shape,
  drop constraint if exists background_jobs_claimed_by_shape,
  drop constraint if exists background_jobs_idempotency_key_shape,
  drop constraint if exists background_jobs_status_check;

update public.background_jobs
set status = 'processing'
where status = 'running';

alter table public.background_jobs
  add constraint background_jobs_status_check check (
    status in (
      'queued',
      'processing',
      'retrying',
      'succeeded',
      'failed',
      'cancelled'
    )
  ),
  drop column if exists dead_lettered_at,
  drop column if exists lease_expires_at,
  drop column if exists heartbeat_at,
  drop column if exists lease_token,
  drop column if exists claimed_by,
  drop column if exists idempotency_key;

create policy "members can read background jobs"
  on public.background_jobs for select
  to authenticated
  using (public.is_member(restaurant_id));

create policy "members can create own background jobs"
  on public.background_jobs for insert
  to authenticated
  with check (
    public.is_member_with_role(restaurant_id, 'staff')
    and created_by = auth.uid()
  );

grant select, insert, update, delete on public.background_jobs
  to authenticated;

comment on table public.background_jobs is
  'Durable retryable job state for long-running OCR, enrichment, and PDF work.';
