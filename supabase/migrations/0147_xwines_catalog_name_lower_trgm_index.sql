-- 0147_xwines_catalog_name_lower_trgm_index.sql
-- P1 slice 1 follow-up: the index 0146's header assumed already existed.
--
-- xwines_search (0146) predicates and scores on BOTH lower(winery_name) and
-- lower(name), and its header says it runs "on the 0133 lower-expression
-- indexes". 0133 built exactly one — winery — so the name half of every
-- palette search seq-scans all 100,646 rows. Measured 2026-09-01 on
-- xwines_search('esporao reserva', 20): 1,459 ms on production, 681 ms on
-- the local stack; with this index, 245 ms locally (94 ms for 'pol roger').
--
-- Index-only migration, the mirror of 0133: no function body, no grant, no
-- matching semantics. xwines_search returns exactly the rows it returned
-- before, faster. The raw-column xwines_catalog_name_trgm_idx (0131) stays:
-- match_xwines still reads it, and dropping it is a separate decision.
--
-- DOWN: drops the index. See down/0147_xwines_catalog_name_lower_trgm_index.down.sql.

create index if not exists xwines_catalog_name_lower_trgm_idx
  on public.xwines_catalog using gin (lower(name) gin_trgm_ops);
