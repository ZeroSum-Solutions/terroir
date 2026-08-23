-- down for 0100_wine_identity_merge.sql
-- Down migrations restore prior DEFINITIONS (same convention as
-- down/0055_lineage_verify_fixes.down.sql): merge_wines' pre-P2 body is
-- 0055's — re-apply 0055_lineage_verify_fixes.sql's merge_wines
-- create-or-replace to restore it (it is idempotent). This down only
-- removes what 0100 added outright.
begin;

revoke execute on function public.merge_canonical_wines(uuid, uuid) from service_role;
drop function if exists public.merge_canonical_wines(uuid, uuid);

drop policy if exists "members can read their restaurant's merge log" on public.identity_merge_log;
drop table if exists public.identity_merge_log;

commit;
