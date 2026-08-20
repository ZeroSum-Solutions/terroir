-- 0059_reconcile_queue.sql
-- OPP-5 (top-10 wave 2, docs/evals/top10-evals.yaml EV-5.x): wine-aware
-- reconciliation queue substrate. The queue rows themselves are DERIVED
-- (unplaced stock, unmatched scan lines, duplicate suspects, ambiguous
-- lineages) — what the schema owns is the accept/undo ledger: bulk-accept
-- groups actions into a batch, every action snapshots the full prior and
-- new state of its subject row, and undo restores prior_state byte-equal
-- within the undo window (EV-5.4). Ranked by capital at risk, not recency
-- (EV-5.2) — that is query-side.

create table public.reconcile_batches (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  created_by     uuid        references auth.users(id) on delete set null,
  action_count   integer     not null default 0 check (action_count >= 0),
  created_at     timestamptz not null default now(),
  undone_at      timestamptz,
  undone_by      uuid        references auth.users(id) on delete set null
);

create index reconcile_batches_restaurant_idx
  on public.reconcile_batches (restaurant_id, created_at desc);

create table public.reconcile_actions (
  id             uuid        primary key default gen_random_uuid(),
  batch_id       uuid        not null references public.reconcile_batches(id) on delete cascade,
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  action_type    text        not null check (
    action_type in ('place_bin', 'match_scan', 'link_lineage', 'dismiss')
  ),
  subject_table  text        not null,
  subject_id     uuid        not null,
  prior_state    jsonb       not null,
  new_state      jsonb       not null,
  created_at     timestamptz not null default now()
);

create index reconcile_actions_batch_idx
  on public.reconcile_actions (batch_id);
create index reconcile_actions_restaurant_idx
  on public.reconcile_actions (restaurant_id, created_at desc);

alter table public.reconcile_batches enable row level security;
alter table public.reconcile_actions enable row level security;

create policy "members can read reconcile_batches"
  on public.reconcile_batches for select
  using (public.is_member(restaurant_id));

create policy "members can read reconcile_actions"
  on public.reconcile_actions for select
  using (public.is_member(restaurant_id));

create policy "managers can insert reconcile_batches"
  on public.reconcile_batches for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can update reconcile_batches"
  on public.reconcile_batches for update
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can insert reconcile_actions"
  on public.reconcile_actions for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

-- Actions are immutable once written (the audit trail undo relies on);
-- batches close via undone_at, never by rewriting actions.
revoke update, delete on public.reconcile_actions from authenticated;
revoke delete on public.reconcile_batches from authenticated;
