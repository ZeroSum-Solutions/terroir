-- Down for 0136 — restores the membership-only WITH CHECK clauses exactly as
-- 0084_rls_initplan_wrap.sql left them, and drops the table comments 0136 added
-- (both tables had none before).
--
-- Reverting REOPENS the cross-tenant cascade-delete hole described in 0136's
-- header. The only remaining guard then is the app-layer reference sweep in
-- src/domains/import/batch-service.ts, whose TOCTOU race docs/runbooks/csv-import.md
-- documents. Do not run this down without knowing that.
--
-- Rows written while 0136 was in force are left alone: the policy constrains
-- new writes and never rewrote existing data, so there is nothing to undo.

alter policy "members insert own stock_adjustments"
  on public.stock_adjustments
  with check (
    restaurant_id in (select public.member_restaurant_ids())
    and acting_user_id = auth.uid()
  );

alter policy "members can insert bottle_closeouts"
  on public.bottle_closeouts
  with check (restaurant_id in (select public.member_restaurant_ids()));

comment on table public.stock_adjustments is null;
comment on table public.bottle_closeouts is null;
