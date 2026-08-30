-- 0136_wine_ownership_on_write_policies.sql
--
-- Closes the [HIGH] cross-tenant cascade-delete hole documented in
-- docs/plans/2026-08-29-modular-architecture-refactor.md §3.1 and named
-- as an unfixed real remedy in docs/runbooks/csv-import.md.
--
-- THE DEFECT
-- ----------
-- The INSERT policies on stock_adjustments and bottle_closeouts gate on
-- membership of the row's OWN restaurant_id, and on nothing else:
--
--   bottle_closeouts   with check (restaurant_id in (select member_restaurant_ids()))
--   stock_adjustments  with check (restaurant_id in (select member_restaurant_ids())
--                                  and acting_user_id = auth.uid())
--
-- Neither verifies that the row's wine_id belongs to that same tenant. Both
-- tables declare `wine_id ... references public.wines(id) on delete cascade`,
-- and Postgres FK cascades run as the table owner and BYPASS RLS entirely.
--
-- So: a member of tenant B inserts a perfectly policy-compliant row —
-- restaurant_id = B, acting_user_id = themselves — naming tenant A's wine_id.
-- Nothing rejects it. Later, tenant A deletes that wine for their own
-- reasons, and the cascade silently deletes tenant B's immutable financial
-- record. Tenant A cannot see what they destroyed; tenant B is never told.
-- Both tables `revoke update, delete ... from authenticated` precisely
-- because these rows are meant to be immutable, which is what makes a
-- silent cascade delete of them worse than an ordinary bug.
--
-- The existing mitigation is an app-layer service-role reference sweep
-- before every wine delete (src/domains/import/batch-service.ts), which the
-- csv-import runbook itself documents as leaving a narrowed-but-open TOCTOU
-- race: the sweep and the delete are two statements, and a concurrent insert
-- between them is unprotected. This migration takes the first of the two
-- fixes that runbook names — an ownership WITH CHECK — so the guarantee
-- stops depending on the order of two application statements.
--
-- WHY `exists` AND NOT A DEFINER HELPER
-- ------------------------------------
-- The subquery reads public.wines under the CALLER's rights, so it is itself
-- RLS-filtered by "members can read their wines" (is_member(restaurant_id)).
-- That is deliberate and gives the check two independent reasons to reject a
-- foreign wine_id: the explicit restaurant_id equality below, and the fact
-- that the caller cannot see the row at all. A SECURITY DEFINER helper would
-- have made the check authoritative but would have added a new RLS-bypassing
-- surface to close a hole caused by an RLS bypass. Invoker rights are the
-- point, not an oversight.
--
-- MEASURED BEFORE APPLYING: 0 existing rows in either table reference a wine
-- belonging to another tenant, so there is nothing to remediate and this is
-- purely forward-looking. Policies govern new writes only; if a future
-- environment does hold such rows they survive untouched and must be swept
-- separately.
--
-- SCOPE NOTE: bottle_closeouts.open_bottle_id has the same unchecked
-- cross-tenant reference, but is `on delete set null` rather than cascade,
-- so it cannot destroy a row. It is constrained here anyway — the check is
-- one clause, the class of defect is identical, and leaving a known
-- cross-tenant reference unguarded next to its fixed sibling invites someone
-- to later "follow the existing pattern" into the wrong one.

-- Both policies are amended with `alter policy`, not dropped and recreated,
-- following 0084's precedent for this exact pair. `alter policy ... with
-- check` leaves the policy's role list untouched — these are roles={public},
-- and a drop/create would have to restate that or silently narrow them.

-- === stock_adjustments ===

alter policy "members insert own stock_adjustments"
  on public.stock_adjustments
  with check (
    restaurant_id in (select public.member_restaurant_ids())
    and acting_user_id = auth.uid()
    and exists (
      select 1
      from public.wines w
      where w.id = stock_adjustments.wine_id
        and w.restaurant_id = stock_adjustments.restaurant_id
    )
  );

comment on table public.stock_adjustments is
  'Immutable stock adjustment events. INSERT requires membership of the row''s restaurant, self-attribution, AND that wine_id belongs to that same restaurant (0136) — wine_id cascades on delete and cascades bypass RLS.';

-- === bottle_closeouts ===

alter policy "members can insert bottle_closeouts"
  on public.bottle_closeouts
  with check (
    restaurant_id in (select public.member_restaurant_ids())
    and exists (
      select 1
      from public.wines w
      where w.id = bottle_closeouts.wine_id
        and w.restaurant_id = bottle_closeouts.restaurant_id
    )
    and (
      open_bottle_id is null
      or exists (
        select 1
        from public.open_bottles ob
        where ob.id = bottle_closeouts.open_bottle_id
          and ob.restaurant_id = bottle_closeouts.restaurant_id
      )
    )
  );

comment on table public.bottle_closeouts is
  'Immutable bottle close-out records. INSERT requires membership of the row''s restaurant AND that wine_id (and open_bottle_id, when present) belong to that same restaurant (0136).';
