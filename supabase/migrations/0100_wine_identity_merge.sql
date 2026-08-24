-- 0100_wine_identity_merge.sql
-- P2 — wine identity spine, part 4: merge, closing the confirmed C23 gap.
--
-- identity_merge_log is an append-only forensic record of every merge.
-- Merges are hard deletes, not self-service-reversible — this table gives
-- a human enough (a full snapshot of the deleted row, plus per-child moved
-- counts) to reconstruct one by hand if it was a mistake. There is no
-- unmerge_* RPC in P2.
create table public.identity_merge_log (
  id              uuid        primary key default gen_random_uuid(),
  merge_type      text        not null check (merge_type in ('canonical_wine', 'wine')),
  source_id       uuid        not null,
  target_id       uuid        not null,
  restaurant_id   uuid        references public.restaurants(id) on delete set null,
  source_snapshot jsonb       not null,
  moved_counts    jsonb       not null,
  merged_by       uuid        references auth.users(id) on delete set null,
  merged_at       timestamptz not null default now()
);

comment on table public.identity_merge_log is
  'Append-only. restaurant_id is populated for wine-level merges '
  '(merge_wines), null for canonical-level merges (merge_canonical_wines), '
  'since a canonical merge is inherently cross-tenant. Written only by '
  'those two functions, both SECURITY DEFINER/service-role, never by a '
  'raw client insert.';

create index identity_merge_log_restaurant_idx
  on public.identity_merge_log (restaurant_id, merged_at desc)
  where restaurant_id is not null;
create index identity_merge_log_source_idx on public.identity_merge_log (source_id);
create index identity_merge_log_target_idx on public.identity_merge_log (target_id);

alter table public.identity_merge_log enable row level security;

-- is_member(null) is false for every caller, so this single policy
-- correctly hides every canonical-level (restaurant_id null) row from
-- authenticated clients — those are readable only by service_role, which
-- bypasses RLS entirely (confirmed: service_role has BYPASSRLS locally).
create policy "members can read their restaurant's merge log"
  on public.identity_merge_log for select to authenticated
  using (public.is_member(restaurant_id));

-- No insert/update/delete policy for authenticated/anon: merge_wines is
-- SECURITY DEFINER (runs as its owner regardless of grants) and
-- merge_canonical_wines is service-role-only, so neither needs a client
-- write grant here.
grant select on table public.identity_merge_log to authenticated;

-------------------------------------------------------------------------------
-- merge_wines — replaced again (the same pattern 0055 used on 0054's
-- version). Extended per the confirmed C23 finding
-- (scratchpad db-audit/verify/V4-bottles.md): the shipped function
-- repointed only 5 of the 10 live FKs to wines(id), and 4 of the other 5
-- were CASCADE — silently destroyed, not orphaned, under a 200 OK that
-- never mentioned the loss. All 10 confirmed via a live pg_constraint
-- query against this exact schema (see the P2 builder report). Existing
-- lineage/vintage/format-equality guards and the manager-role check are
-- untouched — this is a mechanical extension, not a rewrite of its
-- guards.
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
  v_source                    public.wines%rowtype;
  v_target                    public.wines%rowtype;
  v_restaurant_id              uuid;
  v_moved_inventory            int;
  v_moved_pours                int;
  v_moved_bottles              int;
  v_moved_list_items           int;
  v_deduped_list_items         int;
  v_moved_avail                int;
  v_moved_bottle_closeouts     int;
  v_moved_stock_adjustments    int;
  v_moved_pricing_recs         int;
  v_moved_cellar_health        int;
  v_dropped_cellar_health      int;
  v_moved_import_batch_rows    int;
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

  -- P2: wine_variant_id repoint, fail loud rather than silently pick.
  -- Both set and different means normalization failed to converge two
  -- spellings onto one identity — the fix is a merge_canonical_wines call
  -- first, not this function guessing which one is right.
  if v_source.wine_variant_id is not null and v_target.wine_variant_id is not null
     and v_source.wine_variant_id <> v_target.wine_variant_id then
    raise exception 'variant_identity_conflict: source wine_variant_id % and target wine_variant_id % disagree — run merge_canonical_wines to reconcile the underlying identities first',
      v_source.wine_variant_id, v_target.wine_variant_id;
  end if;

  if v_target.wine_variant_id is null and v_source.wine_variant_id is not null then
    update public.wines set wine_variant_id = v_source.wine_variant_id
     where id = p_target_wine_id;
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

  -- P2 (C23 fix): bottle_closeouts, stock_adjustments, pricing_recommendations
  -- have no uniqueness constraint blocking a blind repoint — real write-offs,
  -- comps, and pricing history that a pre-P2 merge silently cascade-deleted.
  update public.bottle_closeouts set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_bottle_closeouts = row_count;

  update public.stock_adjustments set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_stock_adjustments = row_count;

  update public.pricing_recommendations set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_pricing_recs = row_count;

  -- cellar_health has unique(restaurant_id, wine_id); since source and
  -- target share one restaurant (enforced above), at most one row per
  -- wine can exist. If the target already has one, the source's is a
  -- redundant duplicate (recomputed nightly, per its own migration
  -- comment) — drop it rather than picking one arbitrarily. Otherwise
  -- repoint it.
  delete from public.cellar_health s
   where s.wine_id = p_source_wine_id
     and exists (
           select 1 from public.cellar_health t
            where t.wine_id = p_target_wine_id and t.restaurant_id = s.restaurant_id
         );
  get diagnostics v_dropped_cellar_health = row_count;

  update public.cellar_health set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_cellar_health = row_count;

  -- P2 (C23 fix): import_batch_rows.applied_wine_id is ON DELETE SET NULL
  -- today — the merge silently orphans "which import created this wine".
  update public.import_batch_rows set applied_wine_id = p_target_wine_id
   where applied_wine_id = p_source_wine_id;
  get diagnostics v_moved_import_batch_rows = row_count;

  insert into public.identity_merge_log (
    merge_type, source_id, target_id, restaurant_id, source_snapshot, moved_counts, merged_by
  ) values (
    'wine', p_source_wine_id, p_target_wine_id, v_restaurant_id,
    to_jsonb(v_source),
    jsonb_build_object(
      'moved_inventory_items',      v_moved_inventory,
      'moved_pour_events',          v_moved_pours,
      'moved_open_bottles',         v_moved_bottles,
      'moved_wine_list_items',      v_moved_list_items,
      'deduped_wine_list_items',    v_deduped_list_items,
      'moved_availability_events',  v_moved_avail,
      'moved_bottle_closeouts',     v_moved_bottle_closeouts,
      'moved_stock_adjustments',    v_moved_stock_adjustments,
      'moved_pricing_recommendations', v_moved_pricing_recs,
      'moved_cellar_health',        v_moved_cellar_health,
      'dropped_cellar_health',      v_dropped_cellar_health,
      'moved_import_batch_rows',    v_moved_import_batch_rows
    ),
    auth.uid()
  );

  delete from public.wines where id = p_source_wine_id;

  return jsonb_build_object(
    'target_id',                     p_target_wine_id,
    'moved_inventory_items',         v_moved_inventory,
    'moved_pour_events',             v_moved_pours,
    'moved_open_bottles',            v_moved_bottles,
    'moved_wine_list_items',         v_moved_list_items,
    'deduped_wine_list_items',       v_deduped_list_items,
    'moved_availability_events',     v_moved_avail,
    'moved_bottle_closeouts',        v_moved_bottle_closeouts,
    'moved_stock_adjustments',       v_moved_stock_adjustments,
    'moved_pricing_recommendations', v_moved_pricing_recs,
    'moved_cellar_health',           v_moved_cellar_health,
    'dropped_cellar_health',         v_dropped_cellar_health,
    'moved_import_batch_rows',       v_moved_import_batch_rows
  );
end;
$$;

comment on function public.merge_wines(uuid, uuid) is
  'P2 extension (0100) of the 0055 version: now repoints all 10 live FKs '
  'to wines(id) (previously 5), closing the confirmed C23 data-loss gap, '
  'plus the new wine_variant_id conflict guard. See '
  'supabase/tests/0100_merge_completeness.sql for the standing regression '
  'test that fails the build if a future FK to wines/canonical_wines/'
  'wine_variants is added without updating this function or '
  'merge_canonical_wines.';

-------------------------------------------------------------------------------
-- merge_canonical_wines — operator/service-role only. NOT exposed to
-- tenants: the orchestrating session narrowed this from the plan's
-- original "any manager at one stakeholder restaurant" design (the
-- plan's own §14 flagged that authorization rule as its least-settled
-- decision) rather than inventing an untested cross-tenant permissions
-- model. Tenant-level deduplication is fully served by merge_wines above;
-- this function exists so an operator can fix the shared canonical
-- catalog itself (e.g. two independently-created rows for the same
-- real-world wine because two tenants imported it before either had a
-- matching LWIN).
--
-- SECURITY INVOKER, not definer (a deliberate deviation from the plan's
-- text): the plan called for DEFINER because it originally needed to let
-- an ordinary authenticated tenant manager cross a tenancy boundary they
-- couldn't otherwise see. Now that only service_role may call this
-- function at all (see the grant below), DEFINER's privilege elevation is
-- not load-bearing — service_role already has BYPASSRLS (confirmed
-- locally: rolbypassrls=true), so INVOKER reaches every row this function
-- needs without any elevation, at strictly lower privilege. There is no
-- manager-role check in this body for the same reason: the grant IS the
-- authorization.
-------------------------------------------------------------------------------
create or replace function public.merge_canonical_wines(
  p_source_id uuid,
  p_target_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_source              public.canonical_wines%rowtype;
  v_target              public.canonical_wines%rowtype;
  v_conflict_restaurant uuid;
  v_conflict_vintage    int;
  v_conflict_size_ml    int;
  v_moved_variants      int;
  v_moved_lineages      int;
  v_moved_wines         int;
  v_moved_aliases       int;
  v_deduped_aliases     int;
begin
  if p_source_id = p_target_id then
    raise exception 'identical_merge: source and target are the same canonical wine';
  end if;

  perform 1 from public.canonical_wines
    where id in (p_source_id, p_target_id)
    order by id
    for update;

  select * into v_source from public.canonical_wines where id = p_source_id;
  select * into v_target from public.canonical_wines where id = p_target_id;

  if v_source.id is null or v_target.id is null then
    raise exception 'canonical_wine_not_found: both canonical wines must exist';
  end if;

  -- variant_conflict: a restaurant holding both source and target as the
  -- same (vintage, size_ml) is a real tenant-level duplicate this merge
  -- would otherwise create by repointing both onto one canonical id.
  -- Fail loud and name the restaurant — resolved via that tenant's own
  -- merge_wines first, deliberately not auto-resolved here.
  select a.restaurant_id, a.vintage, a.size_ml
    into v_conflict_restaurant, v_conflict_vintage, v_conflict_size_ml
  from public.wine_variants a
  where a.canonical_wine_id = p_source_id
    and exists (
      select 1 from public.wine_variants b
      where b.canonical_wine_id = p_target_id
        and b.restaurant_id = a.restaurant_id
        and coalesce(b.vintage, 0) = coalesce(a.vintage, 0)
        and b.size_ml = a.size_ml
    )
  limit 1;

  if v_conflict_restaurant is not null then
    raise exception 'variant_conflict: restaurant % already holds both canonical wines as the same vintage (%) and size_ml (%) — resolve via that restaurant''s merge_wines first',
      v_conflict_restaurant, coalesce(v_conflict_vintage::text, 'NV'), v_conflict_size_ml;
  end if;

  update public.wine_variants set canonical_wine_id = p_target_id
   where canonical_wine_id = p_source_id;
  get diagnostics v_moved_variants = row_count;

  update public.wine_lineages set canonical_wine_id = p_target_id
   where canonical_wine_id = p_source_id;
  get diagnostics v_moved_lineages = row_count;

  -- wines.canonical_wine_id is denormalized off wine_variants (see 0098's
  -- wines_derive_canonical_wine_id trigger) but that trigger only fires on
  -- wines.wine_variant_id changing — not on the wine_variants row it
  -- points at being repointed underneath it by this function. Without
  -- this line the denormalized column would silently go stale the moment
  -- this function runs, which is exactly the kind of convention-only
  -- invariant 0098's own comment says C17 already showed is unsafe.
  update public.wines set canonical_wine_id = p_target_id
   where canonical_wine_id = p_source_id;
  get diagnostics v_moved_wines = row_count;

  -- Dedup exact-duplicate aliases before repointing, mirroring 0055's
  -- wine_list_items dedupe: a raw string already recorded against the
  -- target keeps only one row.
  delete from public.wine_aliases s
   where s.canonical_wine_id = p_source_id
     and exists (
       select 1 from public.wine_aliases t
        where t.canonical_wine_id = p_target_id
          and t.raw_producer is not distinct from s.raw_producer
          and t.raw_cuvee is not distinct from s.raw_cuvee
     );
  get diagnostics v_deduped_aliases = row_count;

  update public.wine_aliases set canonical_wine_id = p_target_id
   where canonical_wine_id = p_source_id;
  get diagnostics v_moved_aliases = row_count;

  insert into public.identity_merge_log (
    merge_type, source_id, target_id, restaurant_id, source_snapshot, moved_counts, merged_by
  ) values (
    'canonical_wine', p_source_id, p_target_id, null,
    to_jsonb(v_source),
    jsonb_build_object(
      'moved_wine_variants', v_moved_variants,
      'moved_wine_lineages', v_moved_lineages,
      'moved_wines',         v_moved_wines,
      'moved_wine_aliases',  v_moved_aliases,
      'deduped_wine_aliases', v_deduped_aliases
    ),
    auth.uid()
  );

  delete from public.canonical_wines where id = p_source_id;

  return jsonb_build_object(
    'target_id',            p_target_id,
    'moved_wine_variants',  v_moved_variants,
    'moved_wine_lineages',  v_moved_lineages,
    'moved_wines',          v_moved_wines,
    'moved_wine_aliases',   v_moved_aliases,
    'deduped_wine_aliases', v_deduped_aliases
  );
end;
$$;

comment on function public.merge_canonical_wines(uuid, uuid) is
  'Operator/service-role only — see the comment above this function''s '
  'definition for why there is no authenticated grant and no in-body '
  'role check. Every future migration adding an FK to canonical_wines(id)'
  '/wine_variants(id) MUST extend this function (or merge_wines) AND '
  'supabase/tests/0100_merge_completeness.sql in the same migration.';

revoke all on function public.merge_canonical_wines(uuid, uuid) from public;
grant execute on function public.merge_canonical_wines(uuid, uuid) to service_role;
