-- 0111_inventory_items_bounds_and_currency_checks.sql
--
-- P3 §5 (C18) — vintage and size_ml already have working range guards in
-- row-validator.ts (MIN_VINTAGE..CURRENT_YEAR+1; size_ml > 0), so this
-- migration deliberately does NOT touch either. What's actually unbounded
-- is quantity and unit_cost (no upper bound at either layer — the app
-- validator only checked non-negativity, and inventory_items' own CHECKs,
-- 0002, only ever asserted `>= 0`), and currency (free text, no allowlist
-- anywhere). This migration is the DB-layer half of C18's fix; the
-- app-layer half (literal-vs-coerced string validation catching
-- '2015abc' -> 2015, '750ml' -> 750, '12.5.7' -> 12.50, plus the matching
-- MAX_QUANTITY/MAX_UNIT_COST/currency-allowlist checks) is entirely
-- TypeScript (row-validator.ts, constants.ts) — no migration needed for
-- that half, per the design doc's own §4 note.
--
-- Bounds chosen to match src/domains/import/constants.ts exactly
-- (MAX_QUANTITY = 100,000; MAX_UNIT_COST = 1,000,000) so the two layers
-- can never disagree about what's in-bounds, the same "TS and DB compute
-- the same key" discipline as wines_dedup_idx / dedup-key.ts.
--
-- Currency allowlist is a small closed set (ISO-4217 codes actually
-- relevant to a wine cellar) — not a full ISO-4217 library (YAGNI, per
-- the design doc explicitly). `currency is null` stays valid: a CSV row
-- with no currency column value is still a legitimate import (defaults
-- flow through unchanged elsewhere in this domain).
--
-- These CHECKs apply to EVERY insert/update on inventory_items, not just
-- ones from apply_import_batch_chunk — the manual add-inventory UI path
-- gets the same bound/allowlist protection for free, which is correct:
-- C18's actual defect (silent coercion, no upper bound, free-text
-- currency) was never specific to the CSV importer, the importer was just
-- the reproduction vector the audit used.
--
-- DOWN: drops all three CHECK constraints. No data to reconcile — these
-- are pure guards on future writes, dropping them doesn't touch any
-- existing row.

alter table public.inventory_items
  add constraint inventory_items_quantity_upper_bound
    check (quantity <= 100000),
  add constraint inventory_items_unit_cost_upper_bound
    check (unit_cost <= 1000000),
  add constraint inventory_items_currency_allowlist
    check (currency is null or currency in ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY'));

comment on constraint inventory_items_quantity_upper_bound on public.inventory_items is
  'C18 (db audit 2026-08-23): matches MAX_QUANTITY in '
  'src/domains/import/constants.ts exactly — the two layers can never '
  'disagree about what quantity is in-bounds.';

comment on constraint inventory_items_unit_cost_upper_bound on public.inventory_items is
  'C18: matches MAX_UNIT_COST in src/domains/import/constants.ts exactly.';

comment on constraint inventory_items_currency_allowlist on public.inventory_items is
  'C18: a small closed set of ISO-4217 codes actually relevant to a wine '
  'cellar, matching the app-side allowlist in '
  'src/domains/import/constants.ts exactly — not a full ISO-4217 library '
  '(YAGNI).';
