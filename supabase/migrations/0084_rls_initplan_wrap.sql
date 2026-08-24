-- 0084_rls_initplan_wrap.sql
--
-- C28 (db audit 2026-08-23) — RLS policies calling non-inlineable
-- SECURITY DEFINER membership helpers (`is_member`, `is_member_with_role`,
-- 0001_auth_boundary.sql) do it once PER ROW a scan examines, even when
-- every row shares the same restaurant_id the index condition already
-- matched on. SECURITY DEFINER functions are never planner-inlined
-- (inlining would silently drop the privilege-elevation semantics), so
-- there is no way around the per-call cost except changing how often the
-- planner calls it.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C28), hard
-- numbers: at 22,216 rows, a tenant-scoped `count(*)` on wines made
-- 22,217 is_member() calls (pg_stat_user_functions delta) and ran 122ms
-- with 44,485 buffer hits, versus 4.8ms / 53 buffer hits with RLS
-- bypassed — ~25x slower, ~840x the buffer hits, purely from the per-row
-- function-call overhead. Confirmed systemic by grep: 19 migration files
-- use the raw `is_member(restaurant_id)` / `is_member_with_role(
-- restaurant_id, ...)` pattern directly inside a USING/WITH CHECK clause,
-- and zero instances anywhere use the standard mitigation.
--
-- *** This fix lane's own fix sketch got the mitigation wrong; corrected
-- here. *** The sketch's first suggestion — wrap the call as
-- `(select public.is_member(restaurant_id))` — was tried first in this
-- migration's development and MEASURED TO NOT WORK: `restaurant_id` is a
-- column of the row being filtered, so `(select is_member(restaurant_id))`
-- is a CORRELATED subquery (its argument varies per row), which Postgres
-- cannot hoist into a once-per-statement InitPlan — it stays a SubPlan
-- re-executed once per row, identical in cost to the unwrapped call, and
-- measured slightly WORSE here (733ms / 40,435 buffers vs. the unfixed
-- baseline's 122ms / 44,485 buffers) from the added subquery overhead.
-- `(select auth.uid())`-style wraps work in Supabase's own performance
-- guidance because `auth.uid()` takes no row-dependent argument at all —
-- that shape does not generalize to a function whose argument is a
-- column of the row it's filtering.
--
-- The fix that actually works — and the one the fix sketch also named as
-- the "better" alternative — restructures the predicate so the ONLY
-- membership lookup has NO row-dependent input: two new helper functions,
-- `member_restaurant_ids()` and `member_restaurant_ids_with_role(role)`,
-- return the CALLER's own set of qualifying restaurant ids (keyed only on
-- auth.uid() and, for the role variant, a literal role argument — neither
-- varies per row). Policies then read `restaurant_id in (select
-- public.member_restaurant_ids())` — an UNCORRELATED subquery the planner
-- hashes/materializes ONCE per statement, then probes per row via a plain
-- hash lookup instead of a function call. Measured after rewriting wines'
-- four policies to this shape (identical 22-ish-thousand-row scale as
-- above): 1 call to member_restaurant_ids() total (not 20,004+), 3.5-4ms
-- execution time, ~185 buffer hits — matching the RLS-bypassed baseline,
-- not merely improving on the broken-RLS baseline.
--
-- member_restaurant_ids()/_with_role() are SECURITY DEFINER (same
-- recursion-avoidance rationale as is_member/is_member_with_role — a
-- policy on `memberships` itself calling a function that reads
-- `memberships` would recurse under RLS if the function weren't DEFINER)
-- and STABLE. is_member/is_member_with_role themselves are UNCHANGED —
-- still used verbatim inside plpgsql function bodies elsewhere in this
-- schema (find_or_create_wine, set_wine_availability, record_pour, etc.),
-- where the once-per-invocation cost was never the problem C28 measured.
--
-- Semantic equivalence, not just speed, verified for every predicate
-- shape used below: for any given user and restaurant, "restaurant_id IN
-- (select member_restaurant_ids())" is true iff "is_member(restaurant_id)"
-- is true (both reduce to "a memberships row exists for this user and
-- this restaurant_id") — verified directly in this fix lane, side by
-- side under a real authenticated session, for is_member and all three
-- is_member_with_role role arguments ('staff'/'manager'/'owner'), for
-- both an owner (qualifies for all three) and a staff-only member
-- (qualifies for 'staff' only) — all six checks matched old vs. new
-- exactly. RLS baseline (tenant B still sees only its own rows) was
-- re-confirmed after applying this migration.
--
-- Done via `ALTER POLICY ... USING (...) WITH CHECK (...)`, not DROP +
-- CREATE: it changes only the qual/check expression of an existing
-- policy in place, so a policy's name, command, and role list all stay
-- exactly as they were in whichever migration originally created it.
-- Omitting USING or WITH CHECK from a given ALTER POLICY statement below
-- leaves that clause untouched (Postgres semantics) — every statement
-- here supplies exactly the clause(s) the source policy actually has.
--
-- Deliberately NOT touched: the EXISTS-subquery policies that call
-- is_member() on a JOINED table's aliased column (e.g. wine_list_sections
-- / wine_list_items' `public.is_member(wl.restaurant_id)`, C05's own new
-- policies) — those weren't part of the specific 19-file/22,217-call
-- pattern the verifier measured (a correlated per-row argument coming
-- from a join, not the same value repeated across every row of an
-- index-matched scan on the policy's own table), so rewriting them is a
-- separate, unverified change out of this cluster's scope. Also not
-- touched: the `restaurants` table's own two policies (`is_member(id)` /
-- `is_member_with_role(id, 'manager')`) — those key off the table's own
-- primary key column, not `restaurant_id`, and were likewise not part of
-- the measured 19-file pattern.
--
-- DOWN: re-runs the same ALTER POLICY statements with the raw (unwrapped)
-- is_member/is_member_with_role expressions, and drops the two new helper
-- functions. Restores the pre-fix per-row-call plan shape exactly. See
-- down/0084_rls_initplan_wrap.down.sql.

-- ── Helper functions: the caller's own qualifying restaurant id sets ───
create or replace function public.member_restaurant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select restaurant_id from public.memberships where user_id = auth.uid();
$$;

comment on function public.member_restaurant_ids() is
  'C28 (db audit 2026-08-23): returns every restaurant_id the calling '
  'user is a member of. Takes no row-dependent argument (unlike '
  'is_member(restaurant_id)), so a policy written as '
  '`restaurant_id in (select public.member_restaurant_ids())` lets the '
  'planner evaluate this ONCE per statement (an uncorrelated subquery) '
  'instead of once per row. SECURITY DEFINER for the same reason as '
  'is_member: avoids RLS recursion when used in a policy on memberships '
  'itself.';

create or replace function public.member_restaurant_ids_with_role(required public.membership_role)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select restaurant_id from public.memberships
  where user_id = auth.uid()
    and (
      role = required
      or (required = 'manager' and role = 'owner')
      or (required = 'staff' and role in ('owner', 'manager'))
    );
$$;

comment on function public.member_restaurant_ids_with_role(public.membership_role) is
  'C28 (db audit 2026-08-23): role-hierarchy counterpart to '
  'member_restaurant_ids() — returns every restaurant_id where the '
  'calling user has AT LEAST the given role (same hierarchy as '
  'is_member_with_role: owner satisfies manager and staff, manager '
  'satisfies staff). `required` is a literal per call site, not a row '
  'value, so this is equally safe to use as an uncorrelated `restaurant_id '
  'in (select ...)` subquery.';

revoke all on function public.member_restaurant_ids() from public;
grant execute on function public.member_restaurant_ids() to authenticated;
revoke all on function public.member_restaurant_ids_with_role(public.membership_role) from public;
grant execute on function public.member_restaurant_ids_with_role(public.membership_role) to authenticated;

-- ── 0001_auth_boundary.sql: memberships ─────────────────────────────────
alter policy "users can read memberships in their restaurants"
  on public.memberships
  using (user_id = auth.uid() or restaurant_id in (select public.member_restaurant_ids()));

alter policy "owners can manage memberships in their restaurant"
  on public.memberships
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('owner')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('owner')));

-- ── 0002_phase2_schema.sql: wines ────────────────────────────────────────
alter policy "members can read their wines"
  on public.wines
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert wines"
  on public.wines
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can update their wines"
  on public.wines
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can delete their wines"
  on public.wines
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0002_phase2_schema.sql: invoice_scans ────────────────────────────────
alter policy "members can read their scans"
  on public.invoice_scans
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert scans"
  on public.invoice_scans
  with check (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0002_phase2_schema.sql: inventory_items ──────────────────────────────
alter policy "members can read their inventory"
  on public.inventory_items
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert inventory"
  on public.inventory_items
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can update their inventory"
  on public.inventory_items
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can delete their inventory"
  on public.inventory_items
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0002_phase2_schema.sql: wine_lists ────────────────────────────────────
alter policy "members can read their wine lists"
  on public.wine_lists
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert wine lists"
  on public.wine_lists
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can update their wine lists"
  on public.wine_lists
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can delete their wine lists"
  on public.wine_lists
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0004_team_invitations.sql: invitations ──────────────────────────────
alter policy "owners can manage invitations"
  on public.invitations
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('owner')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('owner')));

alter policy "managers can read invitations"
  on public.invitations
  using (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0005_cellar_config.sql: cellar_config ───────────────────────────────
alter policy "members can read cellar config"
  on public.cellar_config
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can manage cellar config"
  on public.cellar_config
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0011_scan_idempotency.sql: scan_idempotency ─────────────────────────
alter policy "members manage own idempotency keys"
  on public.scan_idempotency
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0015_wine_availability.sql: availability_events ─────────────────────
alter policy "members can read availability events"
  on public.availability_events
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0016_pour_tracking.sql: open_bottles, pour_events ───────────────────
alter policy "members can read open_bottles"
  on public.open_bottles
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can read pour_events"
  on public.pour_events
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0052_background_jobs.sql: background_jobs ───────────────────────────
-- (the pre-fix INSERT policy this table also had was dropped by C20's
-- own fix, 0083 — nothing left to wrap there.)
alter policy "members can read background jobs"
  on public.background_jobs
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0053_reason_codes.sql: reason_codes ─────────────────────────────────
alter policy "members can read reason_codes"
  on public.reason_codes
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can insert reason_codes"
  on public.reason_codes
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can update reason_codes"
  on public.reason_codes
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0054_wine_lineages.sql: wine_lineages ────────────────────────────────
alter policy "members can read wine_lineages"
  on public.wine_lineages
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0057_bins.sql: bins ──────────────────────────────────────────────────
alter policy "members can read bins"
  on public.bins
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can insert bins"
  on public.bins
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can update bins"
  on public.bins
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0058_cellar_health.sql: cellar_health ────────────────────────────────
alter policy "members can read cellar_health"
  on public.cellar_health
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0059_reconcile_queue.sql: reconcile_batches, reconcile_actions ──────
alter policy "members can read reconcile_batches"
  on public.reconcile_batches
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can read reconcile_actions"
  on public.reconcile_actions
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can insert reconcile_batches"
  on public.reconcile_batches
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can update reconcile_batches"
  on public.reconcile_batches
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can insert reconcile_actions"
  on public.reconcile_actions
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0060_partial_bottles.sql: bottle_closeouts ──────────────────────────
alter policy "members can read bottle_closeouts"
  on public.bottle_closeouts
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert bottle_closeouts"
  on public.bottle_closeouts
  with check (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0063_stock_adjustments.sql: stock_adjustments ───────────────────────
alter policy "members can read stock_adjustments"
  on public.stock_adjustments
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members insert own stock_adjustments"
  on public.stock_adjustments
  with check (
    restaurant_id in (select public.member_restaurant_ids())
    and acting_user_id = auth.uid()
  );

-- ── 0064_brand_kits.sql: brand_kits ──────────────────────────────────────
alter policy "members can read brand_kits"
  on public.brand_kits
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can insert brand_kits"
  on public.brand_kits
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can update brand_kits"
  on public.brand_kits
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0065_pricing_recommendations.sql: pricing_recommendations ──────────
alter policy "members can read pricing_recommendations"
  on public.pricing_recommendations
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0066_invoice_scans_update_policy.sql: invoice_scans ─────────────────
alter policy "members can update their scans"
  on public.invoice_scans
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0076_csv_import_batches.sql: import_batches, import_batch_rows ─────
alter policy "members can read import batches"
  on public.import_batches
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can create own import batches"
  on public.import_batches
  with check (
    restaurant_id in (select public.member_restaurant_ids_with_role('staff'))
    and created_by = auth.uid()
  );

alter policy "members can update own import batches"
  on public.import_batches
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('staff')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('staff')));

alter policy "members can read import batch rows"
  on public.import_batch_rows
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can create import batch rows"
  on public.import_batch_rows
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('staff')));

alter policy "members can update import batch rows"
  on public.import_batch_rows
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('staff')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('staff')));
