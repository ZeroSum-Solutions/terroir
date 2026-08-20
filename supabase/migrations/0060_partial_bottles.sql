-- 0060_partial_bottles.sql
-- OPP-10 (top-10 wave 2, docs/evals/top10-evals.yaml EV-10.x): partial-
-- bottle lifecycle close-out. open_bottles + pour_events already exist —
-- this adds the preservation method on the open bottle (EV-10.1) and the
-- close-out record: theoretical remaining (size − Σ pours) vs the actual
-- remaining the closer observed, variance persisted per bottle (EV-10.2),
-- grouped by preservation method for the yield report (EV-10.3). A
-- spoilage write-off REQUIRES a reason code — enforced here, not just in
-- the API (F-1, the Bevrly zero-reason-codes lesson).

alter table public.open_bottles
  add column preservation_method text not null default 'none' check (
    preservation_method in ('coravin', 'argon', 'vacuum', 'none')
  );

create table public.bottle_closeouts (
  id                        uuid        primary key default gen_random_uuid(),
  restaurant_id             uuid        not null references public.restaurants(id) on delete cascade,
  wine_id                   uuid        not null references public.wines(id) on delete cascade,
  open_bottle_id            uuid        references public.open_bottles(id) on delete set null,
  preservation_method       text        not null check (
    preservation_method in ('coravin', 'argon', 'vacuum', 'none')
  ),
  opened_at                 timestamptz,
  closed_by                 uuid        references auth.users(id) on delete set null,
  closed_at                 timestamptz not null default now(),
  -- theoretical may go negative when pours were over-recorded; that IS the
  -- variance signal, so it is not clamped.
  theoretical_remaining_ml  integer     not null,
  actual_remaining_ml       integer     not null check (actual_remaining_ml >= 0),
  variance_ml               integer     generated always as
    (actual_remaining_ml - theoretical_remaining_ml) stored,
  written_off_ml            integer     not null default 0 check (written_off_ml >= 0),
  reason_code_id            uuid        references public.reason_codes(id) on delete restrict,
  constraint bottle_closeouts_writeoff_requires_reason check (
    written_off_ml = 0 or reason_code_id is not null
  )
);

create index bottle_closeouts_restaurant_idx
  on public.bottle_closeouts (restaurant_id, closed_at desc);
create index bottle_closeouts_wine_idx
  on public.bottle_closeouts (wine_id, closed_at desc);

alter table public.bottle_closeouts enable row level security;

create policy "members can read bottle_closeouts"
  on public.bottle_closeouts for select
  using (public.is_member(restaurant_id));

create policy "members can insert bottle_closeouts"
  on public.bottle_closeouts for insert
  with check (public.is_member(restaurant_id));

-- Close-outs are immutable records: no update/delete for authenticated.
revoke update, delete on public.bottle_closeouts from authenticated;
