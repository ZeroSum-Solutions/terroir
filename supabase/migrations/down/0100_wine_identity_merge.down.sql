-- down for 0100_wine_identity_merge.sql
-- Down migrations restore prior DEFINITIONS (same convention as
-- down/0055_lineage_verify_fixes.down.sql): merge_wines' pre-P2 body is
-- 0055's.
--
-- P2 ROUND-2 FIX (D2 — scratchpad db-audit/verify/P2-critic-r1.md): the
-- round-1 version of this file made that same claim in a comment but
-- never actually inlined 0055's create-or-replace statement, so a full
-- rollback left merge_wines permanently broken (every call raised
-- `record "v_source" has no field "wine_variant_id"`, since the row type
-- still had 0100's extended PL/pgSQL body but the run order means
-- 0098's wine_variant_id/canonical_wine_id columns on `wines` are NOT YET
-- dropped at this point in a reverse rollback — 0101, THEN 0100, THEN
-- 0099, THEN 0098, THEN 0097 — so simply leaving 0100's body in place
-- would not even error until much later, and dropping it outright with
-- no replacement would break every caller immediately). This is the
-- `down/0048`/`down/0014` known-broken-down pattern, reproduced fresh.
--
-- The fix: actually inline 0055_lineage_verify_fixes.sql's merge_wines
-- body below, verbatim (copied byte-for-byte from that migration file,
-- not retyped from memory), so a full rollback genuinely restores the
-- exact pre-P2 function rather than merely claiming to.
begin;

revoke execute on function public.merge_canonical_wines(uuid, uuid) from service_role;
drop function if exists public.merge_canonical_wines(uuid, uuid);

drop policy if exists "members can read their restaurant's merge log" on public.identity_merge_log;
drop table if exists public.identity_merge_log;

-- Verbatim restoration of 0055_lineage_verify_fixes.sql's merge_wines
-- (its "V2 — replace merge_wines with section-level list dedupe" block).
-- create or replace is idempotent — safe even though 0100's extended
-- version is still installed under the same name at this point.
create or replace function public.merge_wines(
  p_source_wine_id uuid,
  p_target_wine_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source            public.wines%rowtype;
  v_target            public.wines%rowtype;
  v_restaurant_id     uuid;
  v_moved_inventory   int;
  v_moved_pours       int;
  v_moved_bottles     int;
  v_moved_list_items  int;
  v_deduped_list_items int;
  v_moved_avail       int;
begin
  if p_source_wine_id = p_target_wine_id then
    raise exception 'identical_merge: source and target are the same wine';
  end if;

  perform 1 from public.wines
    where id in (p_source_wine_id, p_target_wine_id)
    order by id
    for update;

  select * into v_source from public.wines where id = p_source_wine_id;
  select * into v_target from public.wines where id = p_target_wine_id;

  if v_source.id is null or v_target.id is null
     or v_source.restaurant_id <> v_target.restaurant_id then
    raise exception 'wine_not_found: both wines must exist in the same restaurant';
  end if;

  v_restaurant_id := v_source.restaurant_id;
  if not public.is_member_with_role(v_restaurant_id, 'manager') then
    raise exception 'forbidden: manager role required to merge wines';
  end if;

  if v_source.lineage_id is null or v_target.lineage_id is null
     or v_source.lineage_id <> v_target.lineage_id then
    raise exception 'lineage_mismatch_merge: wines are not the same producer-cuvée — merging is only for true duplicates';
  end if;

  if coalesce(v_source.vintage, 0) <> coalesce(v_target.vintage, 0) then
    raise exception 'cross_vintage_merge: % and % are distinct vintages — they are already linked as vintage siblings, not duplicates',
      coalesce(v_source.vintage::text, 'NV'), coalesce(v_target.vintage::text, 'NV');
  end if;

  if v_source.size_ml <> v_target.size_ml then
    raise exception 'format_mismatch_merge: % ml and % ml are distinct formats',
      v_source.size_ml, v_target.size_ml;
  end if;

  update public.inventory_items set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_inventory = row_count;

  update public.pour_events set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_pours = row_count;

  update public.open_bottles set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_bottles = row_count;

  -- A section listing BOTH wines would show the target twice after a blind
  -- repoint (no uniqueness on (section_id, wine_id)). Drop the source's row
  -- wherever the target is already listed, then repoint the rest.
  delete from public.wine_list_items s
   where s.wine_id = p_source_wine_id
     and exists (
           select 1 from public.wine_list_items t
            where t.section_id = s.section_id
              and t.wine_id = p_target_wine_id
         );
  get diagnostics v_deduped_list_items = row_count;

  update public.wine_list_items set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_list_items = row_count;

  update public.availability_events set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_avail = row_count;

  delete from public.wines where id = p_source_wine_id;

  return jsonb_build_object(
    'target_id',                 p_target_wine_id,
    'moved_inventory_items',     v_moved_inventory,
    'moved_pour_events',         v_moved_pours,
    'moved_open_bottles',        v_moved_bottles,
    'moved_wine_list_items',     v_moved_list_items,
    'deduped_wine_list_items',   v_deduped_list_items,
    'moved_availability_events', v_moved_avail
  );
end;
$$;

commit;
