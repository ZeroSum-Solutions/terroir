-- down for 0075_invoice_extract_jobs.sql
--
-- DOWN-PATH DATA POLICY (read before running against anything but a
-- scratch/local database): rolling back this migration necessarily
-- discards invoice_extract job history. Any row with
-- job_type = 'invoice_extract' (in ANY status: queued, processing,
-- succeeded, or dead) or status = 'dead' (which only this feature's code
-- ever sets) cannot exist under the constraints this file restores, so
-- those rows are deleted before the constraints are re-added. This is a
-- deliberate, destructive rollback choice, not an oversight — there is no
-- non-destructive way to revert a vocabulary this feature's own rows
-- already use. Non-invoice_extract rows (any other job_type, and any
-- status other than 'dead') are left untouched.
--
-- Wrapped in a single transaction: if the row deletion or the constraint
-- restoration ever fails, the DROP FUNCTION/DROP INDEX/DROP COLUMN
-- statements above it roll back too, instead of leaving background_jobs
-- with the new columns/indexes gone but no status/job_type check
-- constraint at all (a corrupted half-revert).

begin;

drop function if exists public.reclaim_stuck_invoice_extract_jobs(integer);
drop function if exists public.claim_invoice_extract_job(text);

drop index if exists public.background_jobs_claimed_idx;
drop index if exists public.background_jobs_claim_idx;
drop index if exists public.background_jobs_idempotency_key_uniq;

do $$
declare
  removed_count integer;
begin
  delete from public.background_jobs
  where job_type = 'invoice_extract' or status = 'dead';
  get diagnostics removed_count = row_count;
  raise notice
    'down 0075_invoice_extract_jobs: removed % background_jobs row(s) (job_type = invoice_extract or status = dead) that cannot exist under the pre-0075 constraints being restored',
    removed_count;
end $$;

alter table public.background_jobs
  drop column if exists claimed_by,
  drop column if exists claimed_at,
  drop column if exists idempotency_key;

alter table public.background_jobs
  drop constraint background_jobs_status_check;
alter table public.background_jobs
  add constraint background_jobs_status_check check (
    status in (
      'queued', 'processing', 'retrying', 'succeeded', 'failed', 'cancelled'
    )
  );

alter table public.background_jobs
  drop constraint background_jobs_job_type_check;
alter table public.background_jobs
  add constraint background_jobs_job_type_check check (
    job_type in (
      'invoice_ocr', 'wine_enrichment', 'wine_list_pdf', 'cellar_health',
      'pricing_recommendations'
    )
  );

commit;
