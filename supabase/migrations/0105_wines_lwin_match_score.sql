-- 0105_wines_lwin_match_score.sql
--
-- P3 §5 (C24) — apply_import_batch_chunk's wines upsert coalesced lwin_id
-- as `coalesce(wines.lwin_id, excluded.lwin_id)`: whichever match landed
-- FIRST won, permanently, even when a much higher-confidence match for the
-- same wine identity arrived later in the same import (V2-import.md's
-- proven repro: a 0.31-score wrong match locked in ahead of a 0.95-score
-- correct one, purely by insertion order). Fixing the coalesce (0108)
-- requires comparing scores, which requires storing one — wines.lwin_id
-- alone carries no confidence information today.
--
-- Nullable: existing wines rows (and any lwin_id set by a path other than
-- apply_import_batch_chunk_v2, e.g. match_lwin_batch, 0007) simply have
-- lwin_match_score = null, which apply_import_batch_chunk_v2's coalesce
-- treats as "never overwrite" (same as before this migration) rather than
-- back-filling a synthetic score for data this migration has no way to
-- verify.
--
-- DOWN: drops the column. Any wines row with a real lwin_id keeps it —
-- this column carries no information the rest of the schema depends on.

alter table public.wines
  add column lwin_match_score real;

comment on column public.wines.lwin_match_score is
  'C24 (db audit 2026-08-23): the match_lwin score (0-1) behind '
  'wines.lwin_id, when it was set by apply_import_batch_chunk_v2 (0108). '
  'Lets a later, higher-confidence match overwrite an earlier lower-'
  'confidence one regardless of insertion order — null means "no scored '
  'match on record," which the upsert''s CASE always treats as '
  '"never overwrite," identical to the pre-C24 coalesce''s behavior for '
  'that case.';
