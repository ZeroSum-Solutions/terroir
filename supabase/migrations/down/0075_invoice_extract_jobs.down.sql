-- down for 0075_invoice_extract_jobs.sql

drop function if exists public.reclaim_stuck_invoice_extract_jobs(integer);
drop function if exists public.claim_invoice_extract_job(text);

drop index if exists public.background_jobs_claimed_idx;
drop index if exists public.background_jobs_claim_idx;
drop index if exists public.background_jobs_idempotency_key_uniq;

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
