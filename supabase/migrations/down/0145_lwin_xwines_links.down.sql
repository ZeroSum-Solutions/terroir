-- Down for 0145_lwin_xwines_links.sql: drop the WS-IDENT linkage storage.
--
-- Order is FK-driven: links reference runs, so links drop first. Tombstones
-- reference only the two catalog tables and can go in any position. Nothing
-- else references these tables — canonical_wines.xwines_wine_id (0132) is
-- populated FROM accepted links by the batch script but carries no FK to
-- them, so already-propagated values survive this down exactly as §5 intends
-- provenance to outlive a storage rollback: the committed coverage reports
-- under docs/plans/ws-ident-runs/ remain the record of where they came from.

drop table if exists public.lwin_xwines_link_tombstones;
drop table if exists public.lwin_xwines_links;
drop table if exists public.xwines_link_runs;

-- Restores 0134's exact privilege set: authenticated only.
revoke execute on function public.match_xwines(text, text, float, integer) from service_role;
