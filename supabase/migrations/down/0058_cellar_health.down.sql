-- down for 0058_cellar_health.sql
alter table public.background_jobs
  drop constraint background_jobs_job_type_check;
alter table public.background_jobs
  add constraint background_jobs_job_type_check check (
    job_type in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf')
  );
drop table if exists public.cellar_health;
alter table public.cellar_config
  drop column if exists health_dead_stock_days,
  drop column if exists health_cash_trap_floor,
  drop column if exists health_appreciation_threshold;
