-- 0064_brand_kits.sql
-- OPP-8 (top-10 wave 3, docs/evals/top10-evals.yaml EV-8.x): brand kit +
-- stored list themes. The Bevrly contrast: logo upload plus six raw colour
-- inputs, no palette extraction, no template, no AI (doc 17 §1.11).
-- brand_kits holds the extracted palette; the applied theme lives on the
-- wine list so /list/[slug] and /api/pdf render from ONE source (8-FR4).
-- Theme JSON is validated (zod + WCAG AA contrast) server-side before save
-- (8-FR5) — the schema stores, the API guards.

create table public.brand_kits (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  logo_url       text,
  palette        jsonb       not null default '{}'::jsonb,
  proposals      jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id)
);

create trigger brand_kits_set_updated_at
  before update on public.brand_kits
  for each row execute function public.set_updated_at();

alter table public.brand_kits enable row level security;

create policy "members can read brand_kits"
  on public.brand_kits for select
  using (public.is_member(restaurant_id));

create policy "managers can insert brand_kits"
  on public.brand_kits for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can update brand_kits"
  on public.brand_kits for update
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter table public.wine_lists
  add column theme jsonb;
