-- 0063_stock_adjustments.sql
-- OPP-7 (top-10 wave 3, docs/evals/top10-evals.yaml EV-7.x): comp and
-- adjustment events, member-attributed. The Bevrly contrast: comps exist
-- only as a value-tracker movement class with zero reason codes configured
-- (doc 17 §1.9, §1.13). Every event requires a reason code (F-1) and the
-- acting member is the AUTHENTICATED user — enforced by the insert policy,
-- not just the API — so client-supplied member ids can never be persisted
-- (EV-7.1, EV-7.2).

create table public.stock_adjustments (
  id              uuid        primary key default gen_random_uuid(),
  restaurant_id   uuid        not null references public.restaurants(id) on delete cascade,
  wine_id         uuid        not null references public.wines(id) on delete cascade,
  kind            text        not null check (kind in ('comp', 'adjustment')),
  bottles         integer     not null default 0,
  ml              integer     not null default 0,
  constraint stock_adjustments_nonzero check (bottles <> 0 or ml <> 0),
  reason_code_id  uuid        not null references public.reason_codes(id) on delete restrict,
  acting_user_id  uuid        not null references auth.users(id),
  note            text,
  created_at      timestamptz not null default now()
);

create index stock_adjustments_restaurant_idx
  on public.stock_adjustments (restaurant_id, created_at desc);
create index stock_adjustments_member_idx
  on public.stock_adjustments (restaurant_id, acting_user_id, created_at desc);

alter table public.stock_adjustments enable row level security;

create policy "members can read stock_adjustments"
  on public.stock_adjustments for select
  using (public.is_member(restaurant_id));

-- acting_user_id must be the session user: the database, not the API,
-- guarantees events cannot be attributed to someone else.
create policy "members insert own stock_adjustments"
  on public.stock_adjustments for insert
  with check (
    public.is_member(restaurant_id)
    and acting_user_id = auth.uid()
  );

-- Events are immutable.
revoke update, delete on public.stock_adjustments from authenticated;
