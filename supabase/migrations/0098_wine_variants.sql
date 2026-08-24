-- 0098_wine_variants.sql
-- P2 — wine identity spine, part 2: the tenant-scoped identity table, plus
-- the wines/wine_lineages hooks that let existing per-tenant rows point at
-- it.
--
-- wine_variants is one restaurant's claim on one (canonical_wine, vintage,
-- size) tuple. It is restaurant-scoped (unlike canonical_wines) because
-- Terroir's inventory model is restaurant-scoped SaaS — a global vintage+
-- format catalog shared across tenants would recreate exactly the cross-
-- tenant-write risk C01/C05/C06 already demonstrate elsewhere in this
-- schema. vintage and size_ml are the identity keys here, and per
-- docs/plans/2026-08-23-p2-identity-spine.md §6 they are NEVER fuzzy-
-- matched — only producer/cuvée text (canonical_wines) ever passes through
-- trigram similarity, and only to suggest.
--
-- wines is extended, not replaced: it keeps being the authoritative
-- per-tenant operational row (inventory, pours, pricing, everything
-- accumulated across 96 migrations). wine_variant_id is deliberately NOT
-- unique on wines — two wines rows resolving to the same variant because
-- of spelling drift is the exact "possible duplicate" signal a review
-- surface wants, cheaper to detect (GROUP BY HAVING count(*) > 1) than to
-- prevent by force.

create table public.wine_variants (
  id                uuid        primary key default gen_random_uuid(),
  restaurant_id     uuid        not null references public.restaurants(id) on delete cascade,
  canonical_wine_id uuid        not null references public.canonical_wines(id) on delete restrict,
  vintage           int         check (vintage is null or vintage between 1900 and extract(year from now())::int + 1),
  size_ml           int         not null default 750 check (size_ml > 0),
  lwin11            text        check (lwin11 ~ '^[0-9]{11}$'),
  lwin16            text        check (lwin16 ~ '^[0-9]{16}$'),
  gtin              text        check (gtin ~ '^[0-9]{8,14}$'),
  display_name      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.wine_variants is
  'One restaurant''s claim on one (canonical_wine_id, vintage, size_ml) '
  'identity tuple. vintage=null means NV, matching the wines.vintage '
  'convention. size_ml — never the free-text wines/inventory_items '
  '"format" column — is the sole identity key for bottle format '
  '(docs/plans/2026-08-23-p2-identity-spine.md §5): "Magnum" vs "1.5L '
  'Magnum" vs "1500ml" all describe size_ml=1500 and must never fork the '
  'identity.';

-- Composite-FK target for wines.wine_variant_id below.
create unique index wine_variants_id_restaurant_idx
  on public.wine_variants (id, restaurant_id);

-- The exact-match identity key. coalesce(vintage,0) matches the existing
-- wines_dedup_idx (0002) convention exactly, so NV variants collide on 0
-- the same way wines.vintage always has.
create unique index wine_variants_identity_idx
  on public.wine_variants (restaurant_id, canonical_wine_id, coalesce(vintage, 0), size_ml);

create unique index wine_variants_gtin_idx
  on public.wine_variants (restaurant_id, gtin)
  where gtin is not null;

create index wine_variants_restaurant_id_idx on public.wine_variants (restaurant_id);
create index wine_variants_canonical_wine_id_idx on public.wine_variants (canonical_wine_id);

create trigger wine_variants_set_updated_at
  before update on public.wine_variants
  for each row execute function public.set_updated_at();

alter table public.wine_variants enable row level security;

create policy "members can read wine_variants"
  on public.wine_variants for select to authenticated
  using (public.is_member(restaurant_id));

create policy "members can insert wine_variants"
  on public.wine_variants for insert to authenticated
  with check (public.is_member(restaurant_id));

create policy "members can update wine_variants"
  on public.wine_variants for update to authenticated
  using (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

-- No delete policy: identity records are permanent audit trail, same
-- posture as import_batches/stock_adjustments.

grant select, insert, update on table public.wine_variants to authenticated;

-------------------------------------------------------------------------------
-- wines hooks
-------------------------------------------------------------------------------

alter table public.wines
  add column wine_variant_id   uuid,
  add column canonical_wine_id uuid references public.canonical_wines(id) on delete set null;

-- C17's own fix sketch (composite FK), applied preventively on a brand-new
-- column: a wines row pointing at another tenant's wine_variant becomes a
-- constraint violation, not a latent cross-tenant bug.
--
-- P2 ROUND-3 FIX (D1-residual — scratchpad db-audit/verify/P2-critic-r2.md):
-- round 1 shipped ON DELETE CASCADE, which let a single wine_variants
-- delete silently destroy the wines row pointing at it plus every one of
-- its own CASCADE-tied audit children — CRITICAL, fixed in round 2 by
-- switching to ON DELETE SET NULL (wine_variant_id), a Postgres 15+
-- column-scoped composite-FK action. Round 2's own comment then rejected
-- plain RESTRICT (round 1's original recommendation, and the posture of
-- the sibling wine_variants_canonical_wine_id_fkey below) on the theory
-- that a restaurant teardown fires wine_variants.restaurant_id's CASCADE
-- and wines.restaurant_id's CASCADE in an unguaranteed order, and RESTRICT
-- would raise a spurious violation if the wine_variants side won that
-- race.
--
-- The round-2 critic tested that specific claim directly rather than
-- reasoning about it: dropped and recreated wines_restaurant_id_fkey to
-- give it deliberately LATER trigger OIDs than
-- wine_variants_restaurant_id_fkey's, added AFTER DELETE diagnostic
-- triggers logging clock_timestamp() to PROVE the reversed order rather
-- than infer it, and reran restaurant teardown under plain RESTRICT.
-- It never fired — 8/8 in natural order, then again under the
-- diagnostically-proven-reversed order. Independently reproduced here
-- (same technique — forced trigger-OID reversal, real NOTICE timestamps
-- confirming wine_variants deleted before wines, plain RESTRICT on the
-- fixture): teardown still succeeded with zero errors. This is consistent
-- with how Postgres actually implements NOT DEFERRABLE FK RESTRICT/
-- NO ACTION checks — as a true end-of-statement check, not a check at the
-- moment the referenced row disappears — so by the time it runs, every
-- cascade delete across the whole affected object graph (both siblings,
-- regardless of which fired first) has already completed, and there is
-- never a live wines row left pointing at an already-deleted
-- wine_variants row for the check to trip on.
--
-- So the justification for SET NULL was wrong, and SET NULL itself
-- reopened a milder version of the SAME failure class round 1 was
-- CRITICAL over: a variant delete that silently severs a wine's resolved
-- identity (wine_variant_id AND canonical_wine_id, both nulled by
-- wines_derive_canonical_wine_id below) with no error, no
-- identity_merge_log entry, and no code path that ever re-heals it.
-- Quieter than destroying the wine, but still an unguarded, unlogged
-- mutation of identity state — exactly what identity_merge_log and the
-- merge-completeness testing apparatus exist to prevent everywhere else.
--
-- Fixed to plain RESTRICT, now that it is proven safe under both natural
-- and forced-reversed cascade ordering. This matches the sibling
-- wine_variants_canonical_wine_id_fkey's posture and the design's own
-- stated philosophy: force an explicit, guarded, logged path (a real
-- merge/detach operation, not a bare DELETE) for any identity-table
-- mutation. Since no current code path deletes a wine_variants row at all
-- (confirmed in round 1), RESTRICT costs nothing today and simply ensures
-- that whenever such a delete IS attempted in the future, it fails loudly
-- instead of silently detaching — forcing whoever writes that future code
-- to go through (or add) a guarded, logged path instead.
-- Regression test (live, real service-role client, full 10-child-table
-- fixture, plus a forced-reversal reproduction): the two "D1 fix" tests
-- at the end of src/domains/identity/merge.test.ts.
alter table public.wines
  add constraint wines_variant_tenant_fk
    foreign key (wine_variant_id, restaurant_id)
    references public.wine_variants(id, restaurant_id)
    on delete restrict;

create index wines_wine_variant_id_idx on public.wines (wine_variant_id);
create index wines_canonical_wine_id_idx on public.wines (canonical_wine_id);

comment on column public.wines.wine_variant_id is
  'Not unique by design — two wines rows sharing a wine_variant_id because '
  'of pre-normalization spelling drift is the possible-duplicate signal, '
  'not an error. See merge_wines (0100) for the sanctioned collapse path.';

comment on column public.wines.canonical_wine_id is
  'Denormalized convenience (avoids a join through wine_variants for '
  'every list/search view). Kept in sync by '
  'wines_derive_canonical_wine_id below, not by convention — a '
  'convention-only invariant here would reproduce the drift C17 '
  'demonstrated for import_batch_rows'' two independently-writable FKs.';

create or replace function public.wines_derive_canonical_wine_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.wine_variant_id is null then
    new.canonical_wine_id := null;
  else
    select canonical_wine_id into new.canonical_wine_id
    from public.wine_variants
    where id = new.wine_variant_id;
  end if;
  return new;
end;
$$;

create trigger wines_derive_canonical_wine_id
  before insert or update of wine_variant_id
  on public.wines
  for each row execute function public.wines_derive_canonical_wine_id();

-------------------------------------------------------------------------------
-- wine_lineages hook — inert light-touch link. No trigger, no backfill,
-- no consumer in P2; exists so a future piece can join tenant lineages to
-- global identity without a schema change.
-------------------------------------------------------------------------------

alter table public.wine_lineages
  add column canonical_wine_id uuid references public.canonical_wines(id) on delete set null;

create index wine_lineages_canonical_wine_id_idx on public.wine_lineages (canonical_wine_id);
