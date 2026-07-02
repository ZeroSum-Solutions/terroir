-- 0052_background_jobs.down.sql

drop policy if exists "members can create own background jobs"
  on public.background_jobs;

drop policy if exists "members can read background jobs"
  on public.background_jobs;

drop trigger if exists background_jobs_set_updated_at
  on public.background_jobs;

drop table if exists public.background_jobs;

