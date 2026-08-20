-- 0055_lineage_verify_fixes.down.sql
-- Restores the 0054 definitions of derive_wine_lineage and merge_wines and
-- re-grants execute on seed_reason_codes. Down migrations restore prior
-- DEFINITIONS; re-run 0054's function bodies for the exact prior state.

grant execute on function public.seed_reason_codes(uuid) to authenticated;
-- The 0054 versions of derive_wine_lineage / merge_wines are restored by
-- re-applying the function definitions from 0054_wine_lineages.sql (they are
-- create-or-replace and idempotent).
