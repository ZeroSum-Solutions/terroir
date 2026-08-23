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
-- ON DELETE CASCADE (not the default NO ACTION): wine_variants rows are
-- otherwise permanent (no delete policy, no P2 code path removes one) —
-- the only way one disappears today is a full restaurant teardown, via
-- wine_variants' OWN restaurant_id ON DELETE CASCADE. Without an
-- explicit action here, that same restaurant deletion also cascades
-- wines.restaurant_id independently, and Postgres does not guarantee
-- which sibling cascade fires first — NO ACTION can raise a spurious FK
-- violation if the wine_variants row is removed before the wines row
-- that points at it. CASCADE converges correctly either way: the wines
-- row is being deleted by the same restaurant teardown regardless.
alter table public.wines
  add constraint wines_variant_tenant_fk
    foreign key (wine_variant_id, restaurant_id)
    references public.wine_variants(id, restaurant_id)
    on delete cascade;

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
