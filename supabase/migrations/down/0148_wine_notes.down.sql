-- Down for 0148.
--
-- READ THIS BEFORE RUNNING IT. Unlike every other down migration in this repo,
-- this one DESTROYS USER-AUTHORED CONTENT. wine_notes holds tasting notes that
-- staff typed by hand; they exist nowhere else, and dropping the table is not
-- reversible by re-running the forward migration. There is no recovery path
-- short of a database restore. If the intent is to disable the feature rather
-- than erase it, stop rendering the composer instead — the tables are inert
-- when nothing reads them.
--
-- wine_reference_notes is different in kind: it is re-fetchable, so losing it
-- costs crawl budget rather than information.
--
-- The drink_window_basis backfill is not undone because there is nothing to
-- undo — 0148 wrote a NEW column and rewrote no existing value, so dropping
-- the column restores the prior state exactly.
--
-- NOTE: dropping drink_window_basis returns the enrichment selector in
-- src/lib/wine-intelligence/batch.ts to keying on `drink_window_start is
-- null`. If any wine has already been retired by the phase-2 job, reverting
-- this makes those wines the primary targets of the next enrichment run and
-- the invented values will be regenerated.

drop table if exists public.wine_note_descriptors;
drop table if exists public.wine_reference_notes;
drop table if exists public.wine_notes;
drop table if exists public.descriptors;

alter table public.wines
  drop column if exists drink_window_basis,
  drop column if exists drink_window_set_by,
  drop column if exists drink_window_set_at;
