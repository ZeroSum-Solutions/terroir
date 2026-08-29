-- Reverses 0133. match_xwines returns the same rows without this index; it
-- simply falls back to the seq scan 0133 removed.
drop index if exists public.xwines_catalog_winery_lower_trgm_idx;
