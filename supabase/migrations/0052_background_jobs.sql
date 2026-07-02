-- 0052_background_jobs.sql
-- Retryable job records for long-running OCR, enrichment, and PDF work.
-- This migration adds the durable state model only; worker activation and
-- moving request paths async remain operational follow-up work.

create table public.background_jobs (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  created_by     uuid references auth.users(id) on delete set null,
  job_type       text not null check (
    job_type in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf')
  ),
  status         text not null default 'queued' check (
    status in ('queued', 'processing', 'retrying', 'succeeded', 'failed', 'cancelled')
  ),
  subject_table  text,
  subject_id     uuid,
  attempt_count  integer not null default 0 check (attempt_count >= 0),
  max_attempts   integer not null default 3 check (max_attempts > 0),
  run_after      timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  error_code     text,
  error_message  text,
  result         jsonb not null default '{}'::jsonb,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint background_jobs_attempt_window
    check (attempt_count <= max_attempts)
);

create trigger background_jobs_set_updated_at
  before update on public.background_jobs
  for each row execute function public.set_updated_at();

create index background_jobs_restaurant_status_idx
  on public.background_jobs (restaurant_id, status, run_after);

create index background_jobs_subject_idx
  on public.background_jobs (job_type, subject_table, subject_id);

alter table public.background_jobs enable row level security;

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

comment on table public.background_jobs is
  'Durable retryable job state for long-running OCR, enrichment, and PDF work.';

comment on column public.background_jobs.status is
  'queued, processing, retrying, succeeded, failed, or cancelled.';

comment on column public.background_jobs.job_type is
  'invoice_ocr, wine_enrichment, or wine_list_pdf.';
