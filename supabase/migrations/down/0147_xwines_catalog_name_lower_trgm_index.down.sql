-- Reverses 0147. xwines_search returns the same rows without this index; the
-- lower(name) predicate simply falls back to the seq scan 0147 removed.
drop index if exists public.xwines_catalog_name_lower_trgm_idx;
