-- 0080_wine_list_items_tenant_fk.sql
--
-- C05 (db audit 2026-08-23) — the wine_list_items INSERT/UPDATE policies
-- validate only the SECTION's tenant (via section_id -> wine_list_sections
-- -> wine_lists.restaurant_id), never the WINE's. wine_id and section_id
-- are two independent foreign keys with no relationship enforced between
-- their tenants.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C05): cross-
-- tenant insert succeeded in BOTH directions (201 Created, no FK/RLS
-- rejection), and linking tenant A's private (never-published) wine into
-- tenant B's published list made it anonymously readable — proven with a
-- real anon GET before (empty) and after (A's wine, full price fields)
-- publishing B's list. No compromise of A's account required, only
-- knowledge of A's wine UUID — and C01's now-fixed open catalog-write RPCs
-- previously meant an attacker didn't even need a leaked id.
--
-- Fix, two independent layers matching the fix sketch:
--
--  1. Denormalize restaurant_id onto wine_list_items, matching
--     wines.restaurant_id, enforced by a COMPOSITE FK to a new
--     wines(id, restaurant_id) unique constraint. This makes "this item's
--     restaurant_id equals its wine's real restaurant_id" a hard schema
--     invariant — true regardless of RLS, and even for a future
--     SECURITY DEFINER path that bypasses RLS entirely.
--
--  2. wine_list_sections has no restaurant_id column of its own (it is one
--     join further from restaurants than wine_list_items), so "this item's
--     restaurant_id equals its SECTION's real restaurant_id" cannot be
--     expressed as a second composite FK — a composite FK can only pin a
--     column to a value that literally exists in another table's unique
--     key, not to a value derived via a join. That side is enforced by a
--     BEFORE INSERT/UPDATE trigger that resolves the section's restaurant
--     via wine_list_sections -> wine_lists and rejects any mismatch. Same
--     "pure data-integrity check, not a permission gate" shape as
--     derive_wine_lineage (0054) — SECURITY DEFINER so it resolves the
--     section's true restaurant deterministically regardless of the
--     caller's own RLS visibility into wine_list_sections, rather than
--     the "NOT SECURITY DEFINER, needs current_user" shape of the owner-
--     only triggers (0022/0023), which are role checks, not data checks.
--
-- With both layers in place, both attack directions the verifier ran are
-- closed: attaching A's wine into B's section requires restaurant_id to
-- equal A's wine's restaurant (composite FK) AND B's section's restaurant
-- (trigger) simultaneously — impossible unless A and B are the same
-- tenant. The INSERT/UPDATE RLS policies are also updated to check the
-- new column directly (`is_member(restaurant_id)` plus a section-restaurant
-- match), so the common case still fails with a clean RLS 42501 before
-- ever reaching the trigger or the FK.
--
-- Deliberately NOT touched: the SELECT policies (including C06's anon
-- "published list items are public" hidden-column fix, and the read/delete
-- policies' existing section-join shape) — out of this cluster's scope.
-- Once this migration lands, a mismatched wine/section pairing can no
-- longer be CREATED, which is what made C06's hidden-item leak scenario
-- reachable in the first place; C06's own migration fixes the independent
-- hidden-bypass bug on its own terms.
--
-- Lock note: wines and wine_list_items are both expected to be small
-- (hundreds to low thousands of rows per tenant) at this stage — the ALTER
-- TABLE ADD CONSTRAINT / backfill UPDATE here take a plain ACCESS EXCLUSIVE
-- lock for the duration of a full-table scan, acceptable at current scale.
-- If either table is materially larger by the time this runs against a
-- real environment, backfill in batches and add the FK as NOT VALID +
-- VALIDATE CONSTRAINT (a separate, non-blocking step) instead.
--
-- DOWN: drops the trigger, the composite FK, the column, and the wines
-- uniqueness constraint, and restores the pre-fix INSERT/UPDATE policies
-- verbatim. See down/0080_wine_list_items_tenant_fk.down.sql.

-- ── 1. wines(id, restaurant_id) — composite FK target ──────────────────
-- id alone is already globally unique (primary key), so this adds no new
-- restriction on wines data; it exists purely so wine_list_items can FK
-- against the (id, restaurant_id) pair.
alter table public.wines
  add constraint wines_id_restaurant_id_key unique (id, restaurant_id);

-- ── 2. wine_list_items.restaurant_id — denormalized, backfilled, FK'd ──
alter table public.wine_list_items
  add column restaurant_id uuid references public.restaurants(id) on delete cascade;

update public.wine_list_items wli
set restaurant_id = w.restaurant_id
from public.wines w
where w.id = wli.wine_id
  and wli.restaurant_id is null;

alter table public.wine_list_items
  alter column restaurant_id set not null;

alter table public.wine_list_items
  add constraint wine_list_items_wine_restaurant_fkey
  foreign key (wine_id, restaurant_id) references public.wines (id, restaurant_id)
  on delete restrict;

comment on column public.wine_list_items.restaurant_id is
  'C05 (db audit 2026-08-23): denormalized from wines.restaurant_id, enforced '
  'by the composite FK wine_list_items_wine_restaurant_fkey — a row can never '
  'reference a wine belonging to a different restaurant. Combined with the '
  'wine_list_items_enforce_section_restaurant trigger (which checks the '
  'section side of the same invariant) and the updated insert/update RLS '
  'policies below, this closes the cross-tenant wine/section linkage bug.';

-- ── 3. Section-side invariant: restaurant_id must match the section's ──
create or replace function public.wine_list_items_enforce_section_restaurant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_section_restaurant_id uuid;
begin
  select wl.restaurant_id into v_section_restaurant_id
  from public.wine_list_sections s
  join public.wine_lists wl on wl.id = s.wine_list_id
  where s.id = new.section_id;

  if v_section_restaurant_id is null then
    raise exception 'wine_list_items.section_id % does not resolve to a restaurant', new.section_id
      using errcode = '23503';
  end if;

  if v_section_restaurant_id <> new.restaurant_id then
    raise exception
      'wine_list_items.restaurant_id (%) does not match its section''s restaurant (%)',
      new.restaurant_id, v_section_restaurant_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.wine_list_items_enforce_section_restaurant() is
  'C05 (db audit 2026-08-23): BEFORE INSERT/UPDATE guard — resolves section_id''s '
  'real restaurant via wine_list_sections -> wine_lists and rejects any row whose '
  'restaurant_id disagrees. SECURITY DEFINER so the check is deterministic '
  'regardless of the caller''s own RLS visibility into wine_list_sections '
  '(a pure data-integrity check, not a role/permission gate).';

create trigger wine_list_items_enforce_section_restaurant
  before insert or update of section_id, restaurant_id on public.wine_list_items
  for each row execute function public.wine_list_items_enforce_section_restaurant();

-- ── 4. INSERT/UPDATE RLS policies now check both sides directly ────────
drop policy "members can insert list items" on public.wine_list_items;
create policy "members can insert list items"
  on public.wine_list_items for insert to authenticated
  with check (
    public.is_member(restaurant_id)
    and exists (
      select 1 from public.wine_list_sections s
      join public.wine_lists wl on wl.id = s.wine_list_id
      where s.id = section_id and wl.restaurant_id = restaurant_id
    )
  );

drop policy "members can update their list items" on public.wine_list_items;
create policy "members can update their list items"
  on public.wine_list_items for update to authenticated
  using (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and public.is_member(wl.restaurant_id)
  ))
  with check (
    public.is_member(restaurant_id)
    and exists (
      select 1 from public.wine_list_sections s
      join public.wine_lists wl on wl.id = s.wine_list_id
      where s.id = section_id and wl.restaurant_id = restaurant_id
    )
  );
