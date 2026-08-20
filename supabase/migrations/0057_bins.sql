-- 0057_bins.sql
-- OPP-6 (top-10 wave 1, docs/evals/top10-evals.yaml EV-6.x): bin-first
-- location model. Bins are first-class rows — code, zone, capacity,
-- priority — replacing the free-text inventory_items.bin_location as the
-- physical key (the text column stays during migration; new writes go to
-- bin_id). "Unplaced" is a queue state, never a pseudo-bin (EV-6.4).
-- The Bevrly contrast: their /locations screen renders empty while ten
-- locations are in use, and pseudo-locations mix with physical ones
-- (audit doc 17 §1.14, §1.3).

create table public.bins (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  code           text        not null,
  zone           text,
  capacity       int         check (capacity > 0),
  priority       int         not null default 0,
  sort_order     int         not null default 0,
  retired_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One code namespace per restaurant, case-insensitive ("r4-s3" is "R4-S3").
create unique index bins_restaurant_code_idx
  on public.bins (restaurant_id, lower(code));

create index bins_restaurant_id_idx on public.bins (restaurant_id);

create trigger bins_set_updated_at
  before update on public.bins
  for each row execute function public.set_updated_at();

alter table public.bins enable row level security;

create policy "members can read bins"
  on public.bins for select
  using (public.is_member(restaurant_id));

create policy "managers can insert bins"
  on public.bins for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can update bins"
  on public.bins for update
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

-- No delete policy: bins are retired (retired_at), never deleted, so stock
-- history keeps its referent.

alter table public.inventory_items
  add column bin_id uuid references public.bins(id) on delete set null;

create index inventory_items_bin_id_idx on public.inventory_items (bin_id);

-- EV-6.5 surface: bin codes may flow onto the public list, per list.
alter table public.wine_lists
  add column show_bin_codes boolean not null default false;

-- Backfill: promote every distinct legacy free-text bin_location to a real
-- bin and point the stock at it.
insert into public.bins (restaurant_id, code)
select distinct i.restaurant_id, upper(btrim(i.bin_location))
  from public.inventory_items i
 where i.bin_location is not null
   and btrim(i.bin_location) <> ''
on conflict do nothing;

update public.inventory_items i
   set bin_id = b.id
  from public.bins b
 where i.bin_location is not null
   and btrim(i.bin_location) <> ''
   and b.restaurant_id = i.restaurant_id
   and lower(b.code) = lower(btrim(i.bin_location));
