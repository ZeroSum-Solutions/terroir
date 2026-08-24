-- 0081_anon_column_scoping.sql
--
-- C06 (db audit 2026-08-23) — 0074_public_api_grants.sql gave `anon` full
-- table-level SELECT (all columns, no column-level grant) on restaurants
-- and wines. RLS is row-level only, so a `select=*` request against the
-- raw Data API (not the SSR page's own curated column list) returns every
-- column for any row the row policy allows — including internal
-- pricing-strategy and ops-tuning columns no anon consumer needs.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C06): anon
-- `select=*` on a published wine returned pricing_target_pour_cost_pct,
-- pricing_target_markup_ratio, pricing_dismissed_until, retail_min/max/
-- median/retailer_count/refreshed_at, manual_overrides, and overpaid_flag;
-- on the restaurant row it returned auto_eightysix_from_inventory,
-- eightysix_ml_threshold, default_target_pour_cost_pct, and
-- default_target_markup_ratio. Separately, a wine_list_items row with
-- hidden = true remained anon-readable with full price fields, because
-- the "published list items are public" policy never checked `hidden`.
--
-- Correction the verifier made to the original claim: actual cost basis
-- (inventory_items.unit_cost) is NOT anon-exposed — inventory_items has no
-- anon grant at all (0074 only lists restaurants/wine_lists/
-- wine_list_sections/wine_list_items/wines). What leaks is pricing
-- *strategy* metadata and hidden items, not raw COGS. This migration does
-- not touch inventory_items.
--
-- Anon read-path audit (required before narrowing anon access — see the
-- fix-lane brief): grepped the whole app for every anon/public Supabase
-- client construction (`createAnonClient` / `getSupabasePublicConfig`,
-- excluding proxy.ts which only refreshes sessions, never queries data).
-- Exactly two consumers of wines/restaurants columns exist:
--   - src/app/list/[slug]/page.tsx        (public menu + its metadata)
--   - src/app/list/[slug]/print/page.tsx  (print view + its metadata)
-- Both select the *same* wines columns (id, name, producer, vintage,
-- varietal, region, serving_temp_min, serving_temp_max,
-- serving_temp_label, is_eightysixed) and the same restaurants columns
-- (name, eightysix_strategy, logo_url) — no other anon path touches these
-- tables. list/[slug]/page.tsx's own bin-code lookup uses the SERVICE ROLE
-- client already (fetchPublicBinCodes), not anon — untouched here.
--
-- eightysix_strategy is deliberately KEPT anon-readable even though the
-- original audit grouped it with "internal ops intelligence": the public
-- page reads it directly to decide whether to hide or mark 86'd items
-- (`eightysixStrategy = restaurant?.eightysix_strategy === "mark" ? ... `)
-- — removing it would break the public menu's own rendering. Only the
-- genuinely internal, anon-unused sibling knobs (eightysix_ml_threshold,
-- auto_eightysix_from_inventory, default_target_pour_cost_pct,
-- default_target_markup_ratio) are excluded.
--
-- Fix: revoke anon's table-level SELECT on wines and restaurants, replace
-- with column-level SELECT grants covering exactly the columns above (plus
-- each table's `id`, required for PostgREST's FK-embed join condition —
-- Postgres column privileges cover columns used in a join's ON/WHERE
-- condition, not only the output list). This is transparent to PostgREST's
-- embedding (same FK graph, same table names — no application code
-- change) and to every existing anon query, which already only names
-- these columns; it only blocks `select=*` / explicit-other-column
-- requests against the raw Data API. wine_lists and wine_list_sections
-- keep their existing full table-level anon grant unchanged — neither has
-- any pricing/ops column, only display config (name, template, slug,
-- is_published, position, etc.).
--
-- wine_list_items keeps its table-level anon grant too (no sensitive
-- columns there — glass_price/bottle_price ARE the customer-facing menu
-- prices) but gets its SELECT policy's predicate fixed to also require
-- hidden = false, closing the second, independent leak. The app's SSR
-- page already filters `!item.hidden` client-side after fetching; this
-- makes that filtering also true at the RLS level, closing the raw-API
-- bypass without changing what the rendered page shows.
--
-- DOWN: restores the original blanket anon table-level SELECT on wines
-- and restaurants, and the pre-fix wine_list_items anon policy (no hidden
-- check). See down/0081_anon_column_scoping.down.sql.

revoke select on table public.wines, public.restaurants from anon;

grant select (
  id, name, producer, vintage, varietal, region,
  serving_temp_min, serving_temp_max, serving_temp_label, is_eightysixed
) on public.wines to anon;

grant select (
  id, name, eightysix_strategy, logo_url
) on public.restaurants to anon;

drop policy "published list items are public" on public.wine_list_items;
create policy "published list items are public"
  on public.wine_list_items for select to anon
  using (
    hidden = false
    and exists (
      select 1 from public.wine_list_sections s
      join public.wine_lists wl on wl.id = s.wine_list_id
      where s.id = section_id and wl.is_published = true
    )
  );
