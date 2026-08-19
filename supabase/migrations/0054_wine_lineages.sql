-- 0054_wine_lineages.sql
-- F-2 + OPP-1 (top-10 wave 0, docs/evals/top10-evals.yaml EV-F2.1, EV-1.1–1.4):
-- vintage as first-class identity. A lineage is one producer-cuvée; vintages
-- are distinct child wines carrying their own cost basis. Identity comes from
-- LWIN7 (wines.lwin_id prefix — lwin_catalog is wine-level, no vintage) with a
-- normalised producer+name fallback; wines whose name-group matches more than
-- one LWIN identity stay unlinked (ambiguous) for review.
--
-- Derivation is a BEFORE trigger so every creation path — cellar add, scan
-- commit, create-from-lwin — gets a lineage with no app-side coordination.
-- Cross-vintage merging is rejected here in merge_wines, not just hidden in
-- the UI: for wine, vintage is identity, not duplication.

create table public.wine_lineages (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  lwin7          text        check (lwin7 ~ '^[0-9]{7}$'),
  producer_norm  text        not null,
  cuvee_norm     text        not null,
  created_at     timestamptz not null default now()
);

create unique index wine_lineages_lwin7_idx
  on public.wine_lineages (restaurant_id, lwin7)
  where lwin7 is not null;

create unique index wine_lineages_name_idx
  on public.wine_lineages (restaurant_id, producer_norm, cuvee_norm)
  where lwin7 is null;

create index wine_lineages_norms_idx
  on public.wine_lineages (restaurant_id, producer_norm, cuvee_norm);

alter table public.wine_lineages enable row level security;

create policy "members can read wine_lineages"
  on public.wine_lineages for select
  using (public.is_member(restaurant_id));

-- No client write policies: lineages are created/assigned only by the
-- security-definer derivation trigger below.

alter table public.wines
  add column lineage_id uuid references public.wine_lineages(id) on delete set null;

create index wines_lineage_id_idx on public.wines (lineage_id);

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
    -- LWIN identity wins.
    insert into public.wine_lineages (restaurant_id, lwin7, producer_norm, cuvee_norm)
    values (new.restaurant_id, v_lwin7, v_producer_norm, v_cuvee_norm)
    on conflict (restaurant_id, lwin7) where lwin7 is not null do nothing
    returning id into v_lineage_id;
    if v_lineage_id is null then
      select id into v_lineage_id
        from public.wine_lineages
       where restaurant_id = new.restaurant_id and lwin7 = v_lwin7;
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
      -- Ambiguous identity: leave unlinked for review (EV-F2.1).
      v_lineage_id := null;
    elsif v_match_count = 0 then
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

  new.lineage_id := v_lineage_id;
  return new;
end;
$$;

create trigger wines_derive_lineage
  before insert or update of lwin_id, producer, name
  on public.wines
  for each row execute function public.derive_wine_lineage();

-------------------------------------------------------------------------------
-- Backfill existing wines. Pass A: LWIN-identified wines. Pass B: name-keyed
-- wines, adopting a unique LWIN lineage where one exists, staying null where
-- the name-group is ambiguous (matches 2+ LWIN identities).
-- Updates below only touch lineage_id, so the derivation trigger (scoped to
-- lwin_id/producer/name) does not fire.
-------------------------------------------------------------------------------

insert into public.wine_lineages (restaurant_id, lwin7, producer_norm, cuvee_norm)
select distinct on (w.restaurant_id, substr(w.lwin_id, 1, 7))
       w.restaurant_id,
       substr(w.lwin_id, 1, 7),
       lower(btrim(w.producer)),
       lower(btrim(w.name))
  from public.wines w
 where w.lwin_id ~ '^[0-9]{7}'
 order by w.restaurant_id, substr(w.lwin_id, 1, 7), w.created_at
on conflict (restaurant_id, lwin7) where lwin7 is not null do nothing;

update public.wines w
   set lineage_id = l.id
  from public.wine_lineages l
 where w.lwin_id ~ '^[0-9]{7}'
   and l.restaurant_id = w.restaurant_id
   and l.lwin7 = substr(w.lwin_id, 1, 7);

update public.wines w
   set lineage_id = m.lineage_id
  from (
        select l.restaurant_id, l.producer_norm, l.cuvee_norm,
               min(l.id::text)::uuid as lineage_id
          from public.wine_lineages l
         where l.lwin7 is not null
         group by 1, 2, 3
        having count(*) = 1
       ) m
 where w.lineage_id is null
   and (w.lwin_id is null or w.lwin_id !~ '^[0-9]{7}')
   and w.restaurant_id = m.restaurant_id
   and lower(btrim(w.producer)) = m.producer_norm
   and lower(btrim(w.name)) = m.cuvee_norm;

insert into public.wine_lineages (restaurant_id, producer_norm, cuvee_norm)
select distinct w.restaurant_id, lower(btrim(w.producer)), lower(btrim(w.name))
  from public.wines w
 where w.lineage_id is null
   and (w.lwin_id is null or w.lwin_id !~ '^[0-9]{7}')
   and not exists (
         select 1
           from public.wine_lineages l
          where l.restaurant_id = w.restaurant_id
            and l.lwin7 is not null
            and l.producer_norm = lower(btrim(w.producer))
            and l.cuvee_norm = lower(btrim(w.name))
       )
on conflict (restaurant_id, producer_norm, cuvee_norm) where lwin7 is null do nothing;

update public.wines w
   set lineage_id = l.id
  from public.wine_lineages l
 where w.lineage_id is null
   and (w.lwin_id is null or w.lwin_id !~ '^[0-9]{7}')
   and l.restaurant_id = w.restaurant_id
   and l.lwin7 is null
   and l.producer_norm = lower(btrim(w.producer))
   and l.cuvee_norm = lower(btrim(w.name));

-------------------------------------------------------------------------------
-- merge_wines — the only sanctioned duplicate-collapse path (EV-1.2, EV-1.3).
-- Role-checked security-definer RPC, same pattern as record_pour /
-- reconcile_open_bottles_batch. Guards are enforced HERE: same lineage, same
-- vintage, same format. Repoints every wines referrer, then deletes source.
-------------------------------------------------------------------------------

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
  v_moved_avail       int;
begin
  if p_source_wine_id = p_target_wine_id then
    raise exception 'identical_merge: source and target are the same wine';
  end if;

  -- Deterministic lock order to avoid deadlocks between concurrent merges.
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

  -- Repoint every referrer; history rows keep their own timestamps, actors,
  -- and costs — the audit trail survives the merge (EV-1.2).
  update public.inventory_items set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_inventory = row_count;

  update public.pour_events set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_pours = row_count;

  update public.open_bottles set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_bottles = row_count;

  update public.wine_list_items set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_list_items = row_count;

  update public.availability_events set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_avail = row_count;

  delete from public.wines where id = p_source_wine_id;

  return jsonb_build_object(
    'target_id',                p_target_wine_id,
    'moved_inventory_items',    v_moved_inventory,
    'moved_pour_events',        v_moved_pours,
    'moved_open_bottles',       v_moved_bottles,
    'moved_wine_list_items',    v_moved_list_items,
    'moved_availability_events', v_moved_avail
  );
end;
$$;
