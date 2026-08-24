-- 0090_invoice_scans_committed_at.sql
--
-- C15 (db audit 2026-08-23): POST /api/scans/[id]/commit has no idempotency
-- guard at all — no idempotency key, no committed flag on invoice_scans, no
-- unique constraint on inventory_items. Verified live
-- (.../verify/V3-concurrency.md, C15) as the real tenant owner via genuine
-- PostgREST requests: committing the same scan twice inserted the full set
-- of inventory_items TWICE (wines correctly deduped via
-- find_or_create_wines_batch's own ON CONFLICT, but inventory quantities
-- doubled) on a plain sequential retry — no timing/race technique needed,
-- just a client reload, timeout-and-retry, or double-click. Re-graded
-- CRITICAL: silently doubling real dollar-valued inventory ahead of a
-- 20,000-row bulk import into this same code-path family.
--
-- `committed_at` is claimed atomically (`UPDATE ... WHERE committed_at IS
-- NULL RETURNING id`) BEFORE the wine/inventory work runs, in the same
-- style already established by invoice_scans' other fenced writes
-- (invoice-scan-service.ts, re-extract/route.ts). A second commit attempt
-- sees 0 rows claimed and returns 409 instead of re-inserting. On any
-- failure after the claim, the route releases it (sets committed_at back
-- to null) so a genuinely failed attempt (network blip, transient RPC
-- error) can still be retried — only a call that actually reached
-- "inventory rows exist" is permanently fenced.

alter table public.invoice_scans
  add column committed_at timestamptz;
