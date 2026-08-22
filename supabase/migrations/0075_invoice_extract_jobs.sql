-- 0075_invoice_extract_jobs.sql
--
-- G1-6: background job runner, one job type (invoice_extract).
--
-- Reuses the existing public.background_jobs table (0052) instead of
-- creating a parallel jobs table. That table already had restaurant_id,
-- attempt_count/max_attempts, and run_after — this migration adds exactly
-- what invoice_extract's runner needs on top:
--
--   1. `invoice_extract` joins the job_type vocabulary (same pattern as
--      0058/0065 extending this constraint for their own job types).
--   2. `dead` joins the status vocabulary as the terminal failure state,
--      distinct from `failed` (which existing job types may still use as
--      their own terminal state — this migration does not touch their
--      semantics).
--   3. `idempotency_key` + a partial unique index: the enqueue-idempotency
--      guarantee for "cannot double-bill Anthropic on retry" lives here,
--      in the database, not in application hope. A duplicate enqueue for
--      the same (job_type, idempotency_key) is rejected at the constraint
--      level; the enqueue helper turns that into "return the existing job".
--   4. `claimed_at` / `claimed_by`: who currently owns an in-flight
--      attempt, and since when — required for stuck-job reclaim (a job
--      claimed longer than the stuck threshold gets requeued).
--   5. `claim_invoice_extract_job` / `reclaim_stuck_invoice_extract_jobs`:
--      the atomic claim (FOR UPDATE SKIP LOCKED) and stuck-reclaim sweep
--      can't be expressed through PostgREST's query builder (no SELECT
--      FOR UPDATE, no CTEs), so they're SQL functions the worker calls via
--      RPC. Both run SECURITY INVOKER (the default) — service_role already
--      has full table DML (0074) and bypasses RLS, so no elevated
--      privilege is needed, and EXECUTE is revoked from PUBLIC and granted
--      only to service_role: no other role should be claiming jobs.

-- ── 1. job_type vocabulary ─────────────────────────────────────────────
alter table public.background_jobs
  drop constraint background_jobs_job_type_check;
alter table public.background_jobs
  add constraint background_jobs_job_type_check check (
    job_type in (
      'invoice_ocr',
      'wine_enrichment',
      'wine_list_pdf',
      'cellar_health',
      'pricing_recommendations',
      'invoice_extract'
    )
  );

-- ── 2. status vocabulary ───────────────────────────────────────────────
alter table public.background_jobs
  drop constraint background_jobs_status_check;
alter table public.background_jobs
  add constraint background_jobs_status_check check (
    status in (
      'queued', 'processing', 'retrying', 'succeeded', 'failed',
      'cancelled', 'dead'
    )
  );

-- ── 3. idempotent enqueue ──────────────────────────────────────────────
alter table public.background_jobs
  add column idempotency_key text,
  add column claimed_at timestamptz,
  add column claimed_by text;

create unique index background_jobs_idempotency_key_uniq
  on public.background_jobs (job_type, idempotency_key)
  where idempotency_key is not null;

comment on column public.background_jobs.idempotency_key is
  'Caller-supplied key (e.g. the subject scan id) unique per job_type. '
  'Enforced by background_jobs_idempotency_key_uniq so a retried enqueue '
  'call cannot create a second job for the same unit of work.';

comment on column public.background_jobs.claimed_at is
  'Set by claim_invoice_extract_job when a worker takes ownership of a '
  '"processing" job. Used by the stuck-job reclaim sweep to find jobs '
  'whose worker died mid-attempt.';

comment on column public.background_jobs.claimed_by is
  'Opaque worker instance identifier (e.g. hostname:pid). Used as a '
  'fencing token: completion writes are conditioned on claimed_by still '
  'matching, so a zombie worker cannot clobber a job that has since been '
  'reclaimed by another worker.';

-- ── 4. claim + reclaim indexes ─────────────────────────────────────────
-- Atomic claim: WHERE job_type = ? AND status = 'queued' AND run_after <= now()
-- ORDER BY run_after — the existing background_jobs_restaurant_status_idx
-- is keyed by restaurant_id first, which doesn't help a claim query that
-- deliberately scans across all tenants for the oldest runnable job.
create index background_jobs_claim_idx
  on public.background_jobs (job_type, status, run_after);

-- Stuck-job reclaim: WHERE status = 'processing' AND claimed_at < cutoff.
create index background_jobs_claimed_idx
  on public.background_jobs (status, claimed_at)
  where status = 'processing';

-- ── 5. atomic claim ─────────────────────────────────────────────────────
create function public.claim_invoice_extract_job(p_worker_id text)
returns setof public.background_jobs
language sql
as $$
  with claimable as (
    select id
    from public.background_jobs
    where job_type = 'invoice_extract'
      and status = 'queued'
      and run_after <= now()
    order by run_after
    for update skip locked
    limit 1
  )
  update public.background_jobs b
  set status = 'processing',
      claimed_at = now(),
      claimed_by = p_worker_id,
      started_at = now()
  from claimable
  where b.id = claimable.id
  returning b.*;
$$;

comment on function public.claim_invoice_extract_job(text) is
  'Atomically claims the single oldest runnable invoice_extract job via '
  'FOR UPDATE SKIP LOCKED, so concurrent worker instances never claim the '
  'same row. Returns zero or one row.';

revoke all on function public.claim_invoice_extract_job(text) from public;
grant execute on function public.claim_invoice_extract_job(text) to service_role;

-- ── 6. stuck-job reclaim ────────────────────────────────────────────────
create function public.reclaim_stuck_invoice_extract_jobs(p_stuck_after_seconds integer)
returns setof public.background_jobs
language sql
as $$
  with stuck as (
    select id
    from public.background_jobs
    where job_type = 'invoice_extract'
      and status = 'processing'
      and claimed_at < now() - make_interval(secs => p_stuck_after_seconds)
    for update skip locked
  )
  update public.background_jobs b
  set status = case
        when b.attempt_count + 1 >= b.max_attempts then 'dead'
        else 'queued'
      end,
      attempt_count = b.attempt_count + 1,
      claimed_at = null,
      claimed_by = null,
      run_after = now(),
      finished_at = case
        when b.attempt_count + 1 >= b.max_attempts then now()
        else null
      end,
      error_code = 'stuck_reclaimed',
      error_message = 'Reclaimed: claimed longer than the stuck threshold '
        || 'without completing.'
  from stuck
  where b.id = stuck.id
  returning b.*;
$$;

comment on function public.reclaim_stuck_invoice_extract_jobs(integer) is
  'Sweeps every invoice_extract job claimed longer than p_stuck_after_seconds '
  'ago (worker crashed or was killed mid-attempt) and requeues it with '
  'attempt_count incremented, or marks it dead once max_attempts is '
  'exhausted. Safe to run concurrently with claims and with itself.';

revoke all on function public.reclaim_stuck_invoice_extract_jobs(integer) from public;
grant execute on function public.reclaim_stuck_invoice_extract_jobs(integer) to service_role;
