-- 0065_pricing_recommendations.sql
-- OPP-9 (top-10 wave 3, docs/evals/top10-evals.yaml EV-9.x): materialized
-- pricing recommendations. The Bevrly contrast: -15% on allocated Burgundy
-- from velocity alone, 18s page load (doc 17 §1.10). Recommendations are
-- job-computed (same service-role pattern as cellar_health) so the view
-- reads a table, not an 18-second pipeline (EV-9.4). Every row carries
-- class + rationale + evidence (EV-9.1); the Meursault rule (EV-9.2) is
-- recommender logic, pinned by eval fixture.

create table public.pricing_recommendations (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  wine_id        uuid        not null references public.wines(id) on delete cascade,
  class          text        not null check (
    class in ('discount_to_move', 'raise_appreciating', 'feature_btg', 'hold')
  ),
  rationale      text        not null,
  evidence       jsonb       not null default '{}'::jsonb,
  timing         text,
  computed_at    timestamptz not null default now(),
  unique (restaurant_id, wine_id)
);

create index pricing_recommendations_restaurant_class_idx
  on public.pricing_recommendations (restaurant_id, class);

alter table public.pricing_recommendations enable row level security;

create policy "members can read pricing_recommendations"
  on public.pricing_recommendations for select
  using (public.is_member(restaurant_id));

-- Job-computed state: only the service role writes.
revoke insert, update, delete on public.pricing_recommendations from authenticated, anon;

-- The recompute job type joins the background job vocabulary.
alter table public.background_jobs
  drop constraint background_jobs_job_type_check;
alter table public.background_jobs
  add constraint background_jobs_job_type_check check (
    job_type in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf', 'cellar_health', 'pricing_recommendations')
  );
