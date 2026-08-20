-- 0053_reason_codes.sql
-- F-1 (top-10 wave 0, docs/evals/top10-evals.yaml EV-F1.1): structured reason
-- codes for comps, spills, spoilage, and manual adjustments. Pre-seeded per
-- restaurant so downstream accountability analytics (OPP-7) and spoilage
-- write-offs (OPP-10) never start from an empty table — the Bevrly lesson
-- (audit doc 17 §1.13: zero codes configured at a live customer, so nothing
-- downstream could ever carry a structured cause).

create table public.reason_codes (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  code           text        not null,
  label          text        not null,
  category       text        not null check (
    category in ('comp', 'spill', 'training', 'spoilage', 'adjustment', 'other')
  ),
  active         boolean     not null default true,
  created_at     timestamptz not null default now()
);

create unique index reason_codes_restaurant_code_idx
  on public.reason_codes (restaurant_id, code);

create index reason_codes_restaurant_id_idx
  on public.reason_codes (restaurant_id);

alter table public.reason_codes enable row level security;

create policy "members can read reason_codes"
  on public.reason_codes for select
  using (public.is_member(restaurant_id));

create policy "managers can insert reason_codes"
  on public.reason_codes for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can update reason_codes"
  on public.reason_codes for update
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

-- No delete policy: codes are deactivated (active = false), never deleted,
-- so historical events always keep their referent.

create or replace function public.seed_reason_codes(p_restaurant_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.reason_codes (restaurant_id, code, label, category)
  values
    (p_restaurant_id, 'comp_guest',    'Comped — guest recovery',      'comp'),
    (p_restaurant_id, 'comp_industry', 'Comped — industry / VIP',      'comp'),
    (p_restaurant_id, 'spill',         'Spilled / broken',             'spill'),
    (p_restaurant_id, 'training',      'Staff training / tasting',     'training'),
    (p_restaurant_id, 'spoilage',      'Corked / oxidised / spoiled',  'spoilage'),
    (p_restaurant_id, 'count_adjust',  'Count correction',             'adjustment'),
    (p_restaurant_id, 'other',         'Other',                        'other')
  on conflict (restaurant_id, code) do nothing;
$$;

-- Signup trigger now also seeds reason codes. Body otherwise identical to
-- 0001_auth_boundary.sql's definition.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_restaurant_id uuid;
  restaurant_name   text;
begin
  restaurant_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'restaurant_name'), ''),
    'My Restaurant'
  );

  insert into public.restaurants (name)
  values (restaurant_name)
  returning id into new_restaurant_id;

  insert into public.memberships (user_id, restaurant_id, role)
  values (new.id, new_restaurant_id, 'owner');

  perform public.seed_reason_codes(new_restaurant_id);

  return new;
end;
$$;

-- Backfill: seed reason codes for existing restaurants
select public.seed_reason_codes(r.id) from public.restaurants r;
