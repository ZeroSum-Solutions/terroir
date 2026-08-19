-- 0055_lineage_verify_fixes.sql
-- Wave-0 adversarial-review fixes (Grok 4.6 verify pass, findings V1/V2/V6 —
-- see Terroir Planning/evidence/model-audits/wave0-verify-grok.json):
--
--  V1 (high)  derive_wine_lineage forked vintage siblings when a wine on a
--             name-keyed lineage later gained an lwin_id: the LWIN branch
--             always created a NEW lineage and moved only that wine. Fix:
--             upgrade a matching name-keyed lineage in place (set lwin7) so
--             every sibling keeps the same lineage_id.
--  V2 (med)   merge_wines could leave the target listed twice in one wine
--             list section (no uniqueness on (section_id, wine_id)). Fix:
--             drop source list rows whose section already lists the target,
--             then repoint the rest; report the dedupe count.
--  V6 (low)   seed_reason_codes was executable by any authenticated session
--             against any restaurant id (security definer, no authz). Fix:
--             revoke direct execute; the signup trigger and migrations run
--             as owner and are unaffected.

-- V6 — seed_reason_codes is infrastructure, not an API.
revoke execute on function public.seed_reason_codes(uuid)
  from public, anon, authenticated;

-- V1 — replace the derivation trigger function.
create or replace function public.derive_wine_lineage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lwin7         text;
  v_producer_norm text;
  v_cuvee_norm    text;
  v_lineage_id    uuid;
  v_match_count   int;
begin
  v_producer_norm := lower(btrim(new.producer));
  v_cuvee_norm    := lower(btrim(new.name));
  v_lwin7 := case
    when new.lwin_id is not null and new.lwin_id ~ '^[0-9]{7}'
      then substr(new.lwin_id, 1, 7)
    else null
  end;

  if v_lwin7 is not null then
    -- LWIN identity wins. Adoption order:
    --   1. an existing LWIN lineage for this code;
    --   2. upgrade a matching name-keyed lineage in place (sets lwin7), so
    --      vintage siblings that predate LWIN enrichment keep their lineage;
    --   3. create a fresh LWIN lineage.
    select id into v_lineage_id
      from public.wine_lineages
     where restaurant_id = new.restaurant_id and lwin7 = v_lwin7;

    if v_lineage_id is null then
      begin
        update public.wine_lineages
           set lwin7 = v_lwin7
         where restaurant_id = new.restaurant_id
           and lwin7 is null
           and producer_norm = v_producer_norm
           and cuvee_norm = v_cuvee_norm
        returning id into v_lineage_id;
      exception when unique_violation then
        -- Concurrent transaction created this LWIN lineage; adopt it below.
        v_lineage_id := null;
      end;
    end if;

    if v_lineage_id is null then
      insert into public.wine_lineages (restaurant_id, lwin7, producer_norm, cuvee_norm)
      values (new.restaurant_id, v_lwin7, v_producer_norm, v_cuvee_norm)
      on conflict (restaurant_id, lwin7) where lwin7 is not null do nothing
      returning id into v_lineage_id;
      if v_lineage_id is null then
        select id into v_lineage_id
          from public.wine_lineages
         where restaurant_id = new.restaurant_id and lwin7 = v_lwin7;
      end if;
    end if;
  else
    -- Name fallback: adopt the LWIN lineage with these norms iff exactly one.
    select count(*), min(id::text)::uuid
      into v_match_count, v_lineage_id
      from public.wine_lineages
     where restaurant_id = new.restaurant_id
       and lwin7 is not null
       and producer_norm = v_producer_norm
       and cuvee_norm = v_cuvee_norm;

    if v_match_count > 1 then
      v_lineage_id := null;
    elsif v_match_count = 0 then
      select id into v_lineage_id
        from public.wine_lineages
       where restaurant_id = new.restaurant_id
         and lwin7 is null
         and producer_norm = v_producer_norm
         and cuvee_norm = v_cuvee_norm;
      if v_lineage_id is null then
        insert into public.wine_lineages (restaurant_id, producer_norm, cuvee_norm)
        values (new.restaurant_id, v_producer_norm, v_cuvee_norm)
        on conflict (restaurant_id, producer_norm, cuvee_norm) where lwin7 is null do nothing
        returning id into v_lineage_id;
        if v_lineage_id is null then
          select id into v_lineage_id
            from public.wine_lineages
           where restaurant_id = new.restaurant_id
             and lwin7 is null
             and producer_norm = v_producer_norm
             and cuvee_norm = v_cuvee_norm;
        end if;
      end if;
    end if;
  end if;

  new.lineage_id := v_lineage_id;
  return new;
end;
$$;

-- V2 — replace merge_wines with section-level list dedupe.
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
