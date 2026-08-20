-- down for 0062_reconcile_ordinal.sql
drop index if exists public.reconcile_actions_batch_ordinal_idx;
alter table public.reconcile_actions drop column if exists ordinal;
