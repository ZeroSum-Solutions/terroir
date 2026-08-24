-- 0089_invoice_scans_updated_at.sql
--
-- C14 (db audit 2026-08-23): POST /api/scans/[id]/re-extract has zero
-- concurrency control. Its UPDATE is fenced on nothing but id +
-- restaurant_id, so two overlapping re-extract calls on the same scan
-- (two staff members, or one slow retry overlapping a fresh attempt)
-- silently clobber each other — whichever commits last wins, with no
-- error to either caller. Verified live (.../verify/V3-concurrency.md,
-- C14): a fast, high-confidence result was silently overwritten by a
-- slower, lower-confidence one seconds later, after the fast caller had
-- already received HTTP 200 with the correct result.
--
-- The auditor's literal claimed mechanism (re-extract racing a
-- background worker's first-pass persist) was REFUTED by verification —
-- the route's own ocr_text-required precondition already blocks that.
-- The underlying absence of any concurrency control on re-extract itself
-- was CONFIRMED and is what this migration fixes.
--
-- invoice_scans.status can't serve as the fence value here: the race
-- reproduces between two re-extracts that both start AND end on the same
-- status ('complete' -> 'complete'), so a fence on an unchanged value
-- would let the second write through too. This adds `updated_at` +
-- the existing `set_updated_at()` trigger (already used on 11 other
-- tables, see e.g. 0057_bins.sql) so every UPDATE bumps a value the
-- application can fence on: read updated_at at fetch time, fence the
-- write on that exact value, and treat a 0-row result as "someone else
-- updated this scan first" (409), not "silently proceed."
--
-- invoice_scans is a per-restaurant, per-scan row table (not the
-- multi-thousand-row import path) — this ALTER TABLE is expected to be
-- fast even under the volatile `now()` default, which forces a full
-- rewrite rather than the metadata-only fast path Postgres uses for a
-- constant default. No CONCURRENTLY-anything needed.

alter table public.invoice_scans
  add column updated_at timestamptz not null default now();

create trigger invoice_scans_set_updated_at
  before update on public.invoice_scans
  for each row execute function public.set_updated_at();
