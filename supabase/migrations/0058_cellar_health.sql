-- 0058_cellar_health.sql
-- OPP-2 (top-10 wave 2, docs/evals/top10-evals.yaml EV-2.x): wine-aware
-- cellar health. Replaces the single "sleepy inventory" bucket (the Bevrly
-- failure: 96% of cellar value flagged, doc 17 §1.2) with a partition —
-- every stocked wine lands in exactly one of window_risk | hold |
-- dead_stock | cash_trap | healthy, each row carrying the human-readable
-- reason for the rule that fired (EV-2.1, EV-2.3). Segments are written by
-- the nightly cellar_health background job; thresholds are owner-tunable
-- on cellar_config so a rerun reclassifies (EV-2.4).

-- 1. Thresholds ----------------------------------------------------------
alter table public.cellar_config
  add column health_dead_stock_days        integer not null default 120
    check (health_dead_stock_days > 0),
  add column health_cash_trap_floor        numeric not null default 500
    check (health_cash_trap_floor >= 0),
  add column health_appreciation_threshold numeric not null default 0.08
    check (health_appreciation_threshold >= 0);

-- 2. Segment storage -----------------------------------------------------
create table public.cellar_health (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  wine_id        uuid        not null references public.wines(id) on delete cascade,
  segment        text        not null check (
    segment in ('window_risk', 'hold', 'dead_stock', 'cash_trap', 'healthy')
  ),
  reason         text        not null,
  computed_at    timestamptz not null default now(),
  unique (restaurant_id, wine_id)
);

create index cellar_health_restaurant_segment_idx
  on public.cellar_health (restaurant_id, segment);

alter table public.cellar_health enable row level security;

create policy "members can read cellar_health"
  on public.cellar_health for select
  using (public.is_member(restaurant_id));

-- Segments are job-computed state: only the service role writes them.
revoke insert, update, delete on public.cellar_health from authenticated, anon;

-- 3. Nightly job type ----------------------------------------------------
alter table public.background_jobs
  drop constraint background_jobs_job_type_check;
alter table public.background_jobs
  add constraint background_jobs_job_type_check check (
    job_type in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf', 'cellar_health')
  );
