-- 0083_background_jobs_enqueue_rpc.sql
--
-- C20 (db audit 2026-08-23) — background_jobs' INSERT policy
-- (`is_member_with_role(restaurant_id, 'staff') and created_by = auth.uid()`)
-- applies zero guardrails on anything else in the row: idempotency_key,
-- max_attempts, run_after, and status are all caller-controlled.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C20), mechanism
-- corrected from the original claim: the DB layer applies zero guardrails
-- (ownership, scheduling, retry caps, idempotency-key integrity) on a
-- direct insert; the worker's own tenant-fetch check in
-- invoice-extract-handler.ts (not RLS, not the DB) is what limits blast
-- radius for a *forged* subject_id, and it does nothing for a *real* one.
-- A freshly created, lowest-privilege `staff` member (the floor of
-- is_member_with_role, not a distinct restriction) inserted a live
-- invoice_extract job with a forged idempotency_key (defeating the
-- database's only double-bill guard, background_jobs_idempotency_key_uniq),
-- max_attempts = 1000 against an app default of 5, and run_after in 1970
-- (immediately runnable) — 201 Created, and claim_invoice_extract_job
-- (simulated as service_role, exactly as the real worker would) picked it
-- up immediately. The reachable exploit is not "forge someone else's
-- data" (invoice-extract-handler.ts's tenant-fetch check does stop that);
-- it's a low-privilege staff member enqueueing their OWN tenant's real,
-- RLS-visible invoice_scans rows directly, bypassing the app's sanctioned
-- enqueue path (src/lib/jobs/enqueue.ts) entirely — multiplying real paid
-- Anthropic/OCR calls per scan past the idempotency guarantee, inflating
-- retries 200x past the designed cap, and (via claim's global,
-- non-tenant-scoped FIFO) monopolizing the shared queue.
--
-- Context: a separate verification lane established this whole subsystem
-- has ZERO live callers in src/app today (enqueueInvoiceExtractJob is
-- called from nowhere yet) — this is real, imminent infrastructure, not
-- yet wired to a route. Fixed properly below; deliberately NOT gold-plated
-- (see the migration's tail comment for what is left for whoever wires it
-- up next).
--
-- Fix, per the fix sketch:
--   1. Deny `authenticated` INSERT/UPDATE/DELETE on background_jobs
--      entirely — drop the old permissive INSERT policy and revoke the
--      table-level grants (0074 gave insert/update/delete blanket to
--      authenticated on all tables; there was never an UPDATE or DELETE
--      policy for this table, so this mainly formalizes what RLS already
--      denied for those two, and closes the one real gap: INSERT).
--   2. Route all enqueueing through `enqueue_invoice_extract_job`, a new
--      SECURITY DEFINER RPC that: verifies the caller is a staff-or-above
--      member of p_restaurant_id; verifies p_scan_id is a real
--      invoice_scans row that actually belongs to p_restaurant_id (subject
--      ownership, same tenant-fetch shape invoice-extract-handler.ts
--      already uses); pins idempotency_key = p_scan_id and created_by =
--      auth.uid() (both now ignore any caller-supplied value — there is no
--      such parameter); forces max_attempts to the constant default
--      (5 — must track DEFAULT_MAX_ATTEMPTS in
--      src/lib/jobs/constants.ts if that ever changes); and ignores
--      caller-supplied run_after/status entirely (always 'queued', always
--      run_after = now()). Preserves the existing revive-a-dead-job
--      behavior enqueue.ts implemented client-side, now atomic and
--      server-side.
--   3. Give claim_invoice_extract_job a per-tenant fairness bound: no more
--      than 3 invoice_extract jobs from the same restaurant may be
--      'processing' at once — a tenant with many queued jobs can no
--      longer occupy every worker slot simultaneously and starve every
--      other tenant's queue. Kept as an in-body constant, not a new
--      parameter: adding a parameter would change the function's
--      signature and `create or replace function` cannot alter an
--      existing function's parameter list in place (it would silently
--      create a SECOND overload alongside the original text-only one,
--      leaving the old, fairness-free version still callable under the
--      same name) — same signature avoids that hazard and needs no
--      change to claim.ts.
--
-- src/lib/jobs/enqueue.ts and its test are updated in this same fix
-- commit to call the new RPC instead of inserting/updating background_jobs
-- directly (that file's raw table access would otherwise silently break
-- the instant this migration's REVOKE lands, for whichever future caller
-- wires it up with a normal per-request authenticated client). Every OTHER
-- consumer of background_jobs is untouched and unaffected by the REVOKE:
--   - pricing_recommendations/cellar_health recompute
--     (src/lib/pricing-recommendations/recompute.ts,
--     src/lib/cellar-health/recompute.ts) already insert/update
--     background_jobs exclusively through a SERVICE-ROLE admin client
--     (src/app/api/pricing-recommendations/recompute/route.ts,
--     src/app/api/cellar-health/recompute/route.ts) — service_role
--     bypasses RLS and table grants entirely, so it is untouched by this
--     REVOKE regardless of job_type.
--   - claim_invoice_extract_job / reclaim_stuck_invoice_extract_jobs are
--     already granted to service_role ONLY (0075) — an authenticated-role
--     client gets permission-denied calling either, so the worker's own
--     claim -> complete/heartbeat chain (src/lib/jobs/claim.ts,
--     complete.ts, heartbeat.ts, reclaim.ts, run-once.ts) can only ever
--     run with a service-role client structurally, before and after this
--     migration — their raw background_jobs UPDATE calls are therefore
--     also unaffected.
--
-- Deliberately left for whoever wires this feature up (not gold-plated
-- here): reclaim_stuck_invoice_extract_jobs' own requeue does not re-apply
-- the fairness cap (a reclaimed job just goes back to 'queued' and
-- competes normally on the next claim); the fairness constant (3) is a
-- starting point, not a tuned value — there is no production traffic yet
-- to tune it against; and no route/UI exists yet to call
-- enqueue_invoice_extract_job at all.
--
-- DOWN: restores the pre-fix INSERT policy and table grants, drops
-- enqueue_invoice_extract_job, and restores claim_invoice_extract_job's
-- pre-fix (no fairness cap) body. See
-- down/0083_background_jobs_enqueue_rpc.down.sql.

-- ── 1. Deny authenticated direct writes on background_jobs ─────────────
drop policy "members can create own background jobs" on public.background_jobs;

revoke insert, update, delete on public.background_jobs from authenticated;

-- ── 2. Sanctioned enqueue path ───────────────────────────────────────────
create or replace function public.enqueue_invoice_extract_job(
  p_restaurant_id uuid,
  p_scan_id       uuid
)
returns table (job_id uuid, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_job_id  uuid;
  v_status  text;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Subject ownership: p_scan_id must be a real invoice_scans row that
  -- actually belongs to p_restaurant_id — the same tenant-fetch shape
  -- invoice-extract-handler.ts already applies before any provider call.
  if not exists (
    select 1 from public.invoice_scans
    where id = p_scan_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'invoice scan % not found for restaurant %', p_scan_id, p_restaurant_id
      using errcode = 'P0002';
  end if;

  begin
    insert into public.background_jobs (
      restaurant_id, created_by, job_type, status,
      subject_table, subject_id, idempotency_key, max_attempts, run_after
    ) values (
      p_restaurant_id, v_user_id, 'invoice_extract', 'queued',
      'invoice_scans', p_scan_id, p_scan_id::text,
      5, -- DEFAULT_MAX_ATTEMPTS in src/lib/jobs/constants.ts — keep in sync
      now()
    )
    returning id into v_job_id;

    job_id := v_job_id;
    created := true;
    return next;
    return;
  exception when unique_violation then
    -- Idempotent conflict on (job_type, idempotency_key): fetch the
    -- existing job and, if it's dead (exhausted retries), revive it —
    -- same semantics enqueue.ts previously implemented client-side across
    -- three separate round trips; now one atomic server-side path.
    select bj.id, bj.status into v_job_id, v_status
    from public.background_jobs bj
    where bj.job_type = 'invoice_extract' and bj.idempotency_key = p_scan_id::text;

    if v_job_id is null then
      raise exception 'idempotent enqueue conflict but no existing job found for scan %', p_scan_id;
    end if;

    if v_status = 'dead' then
      update public.background_jobs
      set status = 'queued', attempt_count = 0, error_code = null,
          error_message = null, claimed_by = null, claimed_at = null,
          run_after = now()
      where id = v_job_id and status = 'dead';
    end if;

    job_id := v_job_id;
    created := false;
    return next;
    return;
  end;
end;
$$;

comment on function public.enqueue_invoice_extract_job(uuid, uuid) is
  'C20 (db audit 2026-08-23): the only sanctioned way for an authenticated '
  'session to create/revive an invoice_extract background_jobs row. '
  'SECURITY DEFINER because authenticated has no table-level INSERT/UPDATE '
  'on background_jobs at all — verifies staff-or-above membership on '
  'p_restaurant_id and that p_scan_id actually belongs to it, then pins '
  'idempotency_key = p_scan_id, created_by = auth.uid(), status = '
  '''queued'', run_after = now(), and max_attempts to the constant default '
  '— none of those are caller-controlled inputs.';

revoke all on function public.enqueue_invoice_extract_job(uuid, uuid) from public;
grant execute on function public.enqueue_invoice_extract_job(uuid, uuid) to authenticated;

-- ── 3. Per-tenant fairness on the claim function ────────────────────────
create or replace function public.claim_invoice_extract_job(p_worker_id text)
returns setof public.background_jobs
language sql
as $$
  with in_flight as (
    select restaurant_id, count(*) as n
    from public.background_jobs
    where job_type = 'invoice_extract' and status = 'processing'
    group by restaurant_id
  ),
  claimable as (
    select b.id
    from public.background_jobs b
    left join in_flight f on f.restaurant_id = b.restaurant_id
    where b.job_type = 'invoice_extract'
      and b.status = 'queued'
      and b.run_after <= now()
      -- C20 fairness cap: no more than 3 invoice_extract jobs from the
      -- same restaurant may be 'processing' at once, so one tenant's
      -- staff member cannot push enough queued jobs to occupy every
      -- worker slot and starve every other tenant's queue. A starting
      -- value, not a tuned one — there is no production traffic yet.
      and coalesce(f.n, 0) < 3
    order by b.run_after
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
  'FOR UPDATE SKIP LOCKED, excluding any restaurant that already has 3 '
  'jobs in ''processing'' (C20 db audit 2026-08-23 per-tenant fairness '
  'cap). Concurrent worker instances never claim the same row. Returns '
  'zero or one row.';

revoke all on function public.claim_invoice_extract_job(text) from public;
grant execute on function public.claim_invoice_extract_job(text) to service_role;
