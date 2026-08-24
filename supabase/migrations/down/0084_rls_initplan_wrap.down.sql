-- down for 0084_rls_initplan_wrap.sql
--
-- Re-runs the same ALTER POLICY statements with the raw
-- is_member/is_member_with_role expressions, and drops the two new
-- helper functions. Restores the pre-fix per-row-call query-plan shape
-- exactly (semantics unchanged either way — this only reverts a query
-- restructuring). Re-introduces C28's ~25x per-row overhead — only for a
-- rollback of this specific fix, never as a normal operation.

begin;

alter policy "users can read memberships in their restaurants"
  on public.memberships
  using (user_id = auth.uid() or public.is_member(restaurant_id));

alter policy "owners can manage memberships in their restaurant"
  on public.memberships
  using      (public.is_member_with_role(restaurant_id, 'owner'))
  with check (public.is_member_with_role(restaurant_id, 'owner'));

alter policy "members can read their wines"
  on public.wines
  using (public.is_member(restaurant_id));

alter policy "members can insert wines"
  on public.wines
  with check (public.is_member(restaurant_id));

alter policy "members can update their wines"
  on public.wines
  using      (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

alter policy "members can delete their wines"
  on public.wines
  using (public.is_member(restaurant_id));

alter policy "members can read their scans"
  on public.invoice_scans
  using (public.is_member(restaurant_id));

alter policy "members can insert scans"
  on public.invoice_scans
  with check (public.is_member(restaurant_id));

alter policy "members can read their inventory"
  on public.inventory_items
  using (public.is_member(restaurant_id));

alter policy "members can insert inventory"
  on public.inventory_items
  with check (public.is_member(restaurant_id));

alter policy "members can update their inventory"
  on public.inventory_items
  using      (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

alter policy "members can delete their inventory"
  on public.inventory_items
  using (public.is_member(restaurant_id));

alter policy "members can read their wine lists"
  on public.wine_lists
  using (public.is_member(restaurant_id));

alter policy "members can insert wine lists"
  on public.wine_lists
  with check (public.is_member(restaurant_id));

alter policy "members can update their wine lists"
  on public.wine_lists
  using      (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

alter policy "members can delete their wine lists"
  on public.wine_lists
  using (public.is_member(restaurant_id));

alter policy "owners can manage invitations"
  on public.invitations
  using      (public.is_member_with_role(restaurant_id, 'owner'))
  with check (public.is_member_with_role(restaurant_id, 'owner'));

alter policy "managers can read invitations"
  on public.invitations
  using (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "members can read cellar config"
  on public.cellar_config
  using (public.is_member(restaurant_id));

alter policy "managers can manage cellar config"
  on public.cellar_config
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "members manage own idempotency keys"
  on public.scan_idempotency
  using      (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

alter policy "members can read availability events"
  on public.availability_events
  using (public.is_member(restaurant_id));

alter policy "members can read open_bottles"
  on public.open_bottles
  using (public.is_member(restaurant_id));

alter policy "members can read pour_events"
  on public.pour_events
  using (public.is_member(restaurant_id));

alter policy "members can read background jobs"
  on public.background_jobs
  using (public.is_member(restaurant_id));

alter policy "members can read reason_codes"
  on public.reason_codes
  using (public.is_member(restaurant_id));

alter policy "managers can insert reason_codes"
  on public.reason_codes
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "managers can update reason_codes"
  on public.reason_codes
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "members can read wine_lineages"
  on public.wine_lineages
  using (public.is_member(restaurant_id));

alter policy "members can read bins"
  on public.bins
  using (public.is_member(restaurant_id));

alter policy "managers can insert bins"
  on public.bins
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "managers can update bins"
  on public.bins
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "members can read cellar_health"
  on public.cellar_health
  using (public.is_member(restaurant_id));

alter policy "members can read reconcile_batches"
  on public.reconcile_batches
  using (public.is_member(restaurant_id));

alter policy "members can read reconcile_actions"
  on public.reconcile_actions
  using (public.is_member(restaurant_id));

alter policy "managers can insert reconcile_batches"
  on public.reconcile_batches
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "managers can update reconcile_batches"
  on public.reconcile_batches
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "managers can insert reconcile_actions"
  on public.reconcile_actions
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "members can read bottle_closeouts"
  on public.bottle_closeouts
  using (public.is_member(restaurant_id));

alter policy "members can insert bottle_closeouts"
  on public.bottle_closeouts
  with check (public.is_member(restaurant_id));

alter policy "members can read stock_adjustments"
  on public.stock_adjustments
  using (public.is_member(restaurant_id));

alter policy "members insert own stock_adjustments"
  on public.stock_adjustments
  with check (
    public.is_member(restaurant_id)
    and acting_user_id = auth.uid()
  );

alter policy "members can read brand_kits"
  on public.brand_kits
  using (public.is_member(restaurant_id));

alter policy "managers can insert brand_kits"
  on public.brand_kits
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "managers can update brand_kits"
  on public.brand_kits
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter policy "members can read pricing_recommendations"
  on public.pricing_recommendations
  using (public.is_member(restaurant_id));

alter policy "members can update their scans"
  on public.invoice_scans
  using      (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

alter policy "members can read import batches"
  on public.import_batches
  using (public.is_member(restaurant_id));

alter policy "members can create own import batches"
  on public.import_batches
  with check (
    public.is_member_with_role(restaurant_id, 'staff')
    and created_by = auth.uid()
  );

alter policy "members can update own import batches"
  on public.import_batches
  using      (public.is_member_with_role(restaurant_id, 'staff'))
  with check (public.is_member_with_role(restaurant_id, 'staff'));

alter policy "members can read import batch rows"
  on public.import_batch_rows
  using (public.is_member(restaurant_id));

alter policy "members can create import batch rows"
  on public.import_batch_rows
  with check (public.is_member_with_role(restaurant_id, 'staff'));

alter policy "members can update import batch rows"
  on public.import_batch_rows
  using      (public.is_member_with_role(restaurant_id, 'staff'))
  with check (public.is_member_with_role(restaurant_id, 'staff'));

revoke all on function public.member_restaurant_ids_with_role(public.membership_role) from public;
drop function if exists public.member_restaurant_ids_with_role(public.membership_role);

revoke all on function public.member_restaurant_ids() from public;
drop function if exists public.member_restaurant_ids();

commit;
