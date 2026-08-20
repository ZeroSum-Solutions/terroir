-- 0066_invoice_scans_update_policy.sql
--
-- invoice_scans shipped with SELECT + INSERT policies only, so every
-- user-client UPDATE (scan review edits, OPP-5 reconcile match_scan)
-- silently matched zero rows under RLS. The reconcile ledger reads that
-- zero-row result as a compare-and-swap conflict and returns 409
-- "Subject changed during reconciliation." — caught by the @opp-5 E2E.
--
-- Mirror the wines/inventory_items member-update pattern.

create policy "members can update their scans"
  on public.invoice_scans for update to authenticated
  using (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));
