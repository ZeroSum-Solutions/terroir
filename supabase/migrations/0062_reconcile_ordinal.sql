-- 0062_reconcile_ordinal.sql
-- OPP-5 verify finding V6: undo must restore actions in exact reverse
-- application order, and created_at is not a total order (equal
-- timestamps permit arbitrary sequencing). Each action now records its
-- 0-based position within its batch; undo orders by ordinal desc.

alter table public.reconcile_actions
  add column ordinal integer not null default 0 check (ordinal >= 0);

create unique index reconcile_actions_batch_ordinal_idx
  on public.reconcile_actions (batch_id, ordinal);
