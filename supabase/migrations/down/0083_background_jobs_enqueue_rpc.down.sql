-- down for 0083_background_jobs_enqueue_rpc.sql
--
-- Restores claim_invoice_extract_job's pre-fix (no fairness cap) body,
-- drops enqueue_invoice_extract_job, restores the table-level grants, and
-- restores the pre-fix permissive INSERT policy on background_jobs.
-- Re-introduces C20's job-injection hole — only for a rollback of this
-- specific fix, never as a normal operation. Note: src/lib/jobs/enqueue.ts
-- is updated in the same fix commit to call the RPC this down migration
-- removes — rolling back this migration without also reverting that file
-- will break the (currently uncalled) enqueue helper.

begin;

create or replace function public.claim_invoice_extract_job(p_worker_id text)
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

revoke all on function public.enqueue_invoice_extract_job(uuid, uuid) from public;
drop function if exists public.enqueue_invoice_extract_job(uuid, uuid);

grant insert, update, delete on public.background_jobs to authenticated;

create policy "members can create own background jobs"
  on public.background_jobs for insert
  to authenticated
  with check (
    public.is_member_with_role(restaurant_id, 'staff')
    and created_by = auth.uid()
  );

commit;
