-- 0148_wine_notes.sql
--
-- The house tasting-note corpus, its controlled descriptor vocabulary, the
-- global sourced-reference table, and the drink-window provenance columns.
--
-- Implements phase 1 of docs/superpowers/specs/2026-09-03-wine-page-design.md.
-- Additive only: it creates four tables and three columns, and the single
-- UPDATE it runs writes one NEW column on existing rows. Nothing existing is
-- rewritten, so this is safe against a database the OLD code is still talking
-- to — the window it lands in, per AGENTS.md non-negotiable #7.
--
-- WHY THE RLS IS NOT MEMBERSHIP-ONLY
-- ---------------------------------
-- wine_notes.wine_id is `references public.wines(id) on delete cascade`, and
-- Postgres FK cascades run as the table owner and BYPASS RLS entirely. A
-- membership-only WITH CHECK is exactly the hole 0136 had to close on
-- stock_adjustments and bottle_closeouts: a member of tenant B inserts a
-- perfectly policy-compliant row — restaurant_id = B, author = themselves —
-- naming tenant A's wine_id, and when tenant A later deletes that wine for
-- their own reasons the cascade silently destroys tenant B's note. Tenant A
-- cannot see what they destroyed; tenant B is never told.
--
-- The `exists` subquery below reads public.wines under the CALLER's rights, so
-- it is itself RLS-filtered by "members can read their wines". That is
-- deliberate, and it gives the check two independent reasons to reject a
-- foreign wine_id: the explicit restaurant_id equality, and the fact that the
-- caller cannot see the row at all. A SECURITY DEFINER helper would have made
-- the check authoritative but would have added a new RLS-bypassing surface to
-- close a hole caused by an RLS bypass. Invoker rights are the point.
--
-- WHY wine_reference_notes HAS NO restaurant_id
-- ---------------------------------------------
-- It is published reference data — producer and importer tech sheets, retailer
-- scores — ingested by a service-role job, not authored by tenants.
-- lwin_catalog and xwines_catalog carry no tenancy column either, and
-- canonical_wines is global (created_by_restaurant_id records who created a
-- row, not who owns it). One fetch therefore serves every restaurant holding
-- that wine. There is deliberately NO INSERT, UPDATE or DELETE policy: an
-- authenticated user must never be able to author a row that every other
-- tenant will read as sourced fact.
--
-- WHY vintage IS NOT NULL ON wine_reference_notes
-- -----------------------------------------------
-- Producer sheets, importer books and retailer scores are all vintage-specific.
-- A vintage-less row would attach a 2015 retailer score to a 2019 bottle,
-- globally, for every tenant, with a source URL beside it — worse than an
-- unsourced guess, because the interface would be claiming provenance for it.
--
-- WHY drink_window_basis EXISTS
-- -----------------------------
-- Two reasons. It is what lets a rendered window say WHOSE it is, which
-- `manual_overrides text[]` cannot do — hence the paired set_by / set_at
-- columns, because the one window most worth trusting, the house's own, would
-- otherwise be the only one unable to name its author. And it is what lets the
-- enrichment selector in src/lib/wine-intelligence/batch.ts distinguish a
-- deliberately retired wine from an un-enriched one. That selector currently
-- reads `.or("drink_window_start.is.null,...")`, so without this column a
-- later retirement that nulled those values would make every retired wine the
-- PRIMARY TARGET of the next enrichment run and regenerate exactly what was
-- removed.

-- === the house corpus ===

create table public.wine_notes (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  wine_id        uuid not null references public.wines(id) on delete cascade,
  author_user_id uuid not null references auth.users(id),
  body           text not null check (length(btrim(body)) > 0),
  score          smallint check (score between 50 and 100),
  tasted_on      date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index wine_notes_wine_idx on public.wine_notes (wine_id, created_at desc);
create index wine_notes_restaurant_idx on public.wine_notes (restaurant_id);

alter table public.wine_notes enable row level security;

create policy "members read own wine_notes"
  on public.wine_notes for select
  using (restaurant_id in (select public.member_restaurant_ids()));

create policy "members insert own wine_notes"
  on public.wine_notes for insert
  with check (
    restaurant_id in (select public.member_restaurant_ids())
    and author_user_id = auth.uid()
    and exists (
      select 1 from public.wines w
      where w.id = wine_notes.wine_id
        and w.restaurant_id = wine_notes.restaurant_id
    )
  );

create policy "authors update own wine_notes"
  on public.wine_notes for update
  using (author_user_id = auth.uid())
  with check (
    author_user_id = auth.uid()
    and exists (
      select 1 from public.wines w
      where w.id = wine_notes.wine_id
        and w.restaurant_id = wine_notes.restaurant_id
    )
  );

create policy "authors and owners delete wine_notes"
  on public.wine_notes for delete
  using (
    author_user_id = auth.uid()
    or restaurant_id in (select public.member_restaurant_ids_with_role('owner'))
  );

comment on table public.wine_notes is
  'House tasting notes. INSERT requires membership of the row''s restaurant, self-attribution, AND that wine_id belongs to that same restaurant (0148, following 0136) — wine_id cascades on delete and cascades bypass RLS.';

-- === the controlled vocabulary ===

create table public.descriptors (
  slug   text primary key,
  label  text not null,
  family text not null,
  sort   int  not null default 0
);

alter table public.descriptors enable row level security;

create policy "authenticated read descriptors"
  on public.descriptors for select to authenticated using (true);

comment on table public.descriptors is
  'Global controlled tasting vocabulary. `family` groups chips in the UI and carries NO colour: DESIGN.md forbids a fifth hue beyond the four wine states, and bans exactly the warm mid-tones an aroma palette would need.';

create table public.wine_note_descriptors (
  note_id         uuid not null references public.wine_notes(id) on delete cascade,
  descriptor_slug text not null references public.descriptors(slug),
  origin          text not null check (origin in ('confirmed','inferred')),
  primary key (note_id, descriptor_slug)
);

-- The composite primary key is load-bearing rather than hygiene. Promotion of a
-- model suggestion from 'inferred' to 'confirmed' is an UPDATE of origin; with
-- no such key an insert-based promotion would leave both rows and double-count
-- that descriptor in every tally on the page.

alter table public.wine_note_descriptors enable row level security;

create policy "members read own note descriptors"
  on public.wine_note_descriptors for select
  using (
    exists (
      select 1 from public.wine_notes n
      where n.id = wine_note_descriptors.note_id
        and n.restaurant_id in (select public.member_restaurant_ids())
    )
  );

create policy "authors write own note descriptors"
  on public.wine_note_descriptors for all
  using (
    exists (
      select 1 from public.wine_notes n
      where n.id = wine_note_descriptors.note_id
        and n.author_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.wine_notes n
      where n.id = wine_note_descriptors.note_id
        and n.author_user_id = auth.uid()
    )
  );

comment on table public.wine_note_descriptors is
  'Descriptors on a note. Only ''confirmed'' rows are ever counted on the page — an untouched model inference is a vote, not a mention.';

-- === global sourced reference notes ===

create table public.wine_reference_notes (
  id                 uuid primary key default gen_random_uuid(),
  canonical_wine_id  uuid not null references public.canonical_wines(id) on delete cascade,
  vintage            int  not null,
  source_kind        text not null check (source_kind in ('producer','importer','retailer')),
  source_name        text not null,
  source_url         text not null,
  fetched_at         timestamptz not null,
  body               text,
  score              numeric,
  score_scale        smallint check (score_scale in (5, 100)),
  drink_window_start int,
  drink_window_end   int,
  constraint wine_reference_notes_score_needs_scale
    check ((score is null) = (score_scale is null)),
  unique (canonical_wine_id, vintage, source_kind, source_name)
);

create index wine_reference_notes_lookup_idx
  on public.wine_reference_notes (canonical_wine_id, vintage);

alter table public.wine_reference_notes enable row level security;

create policy "authenticated read reference notes"
  on public.wine_reference_notes for select to authenticated using (true);

comment on table public.wine_reference_notes is
  'Published reference notes, global like lwin_catalog and xwines_catalog. Service-role written by the reference_note_fetch job; deliberately NO tenant INSERT policy. vintage is not nullable because a vintage-less row would attach one vintage''s score to another with a URL beside it.';

-- === drink-window provenance ===

alter table public.wines
  add column drink_window_basis  text
    check (drink_window_basis in ('sourced','override','inferred')),
  add column drink_window_set_by uuid references auth.users(id),
  add column drink_window_set_at timestamptz;

comment on column public.wines.drink_window_basis is
  '0148 — where this window came from. The enrichment selector keys on this being null so a deliberately retired wine is not mistaken for an un-enriched one.';

comment on column public.wines.drink_window_set_by is
  '0148 — who set the window by hand. manual_overrides is a text[] and cannot carry an author, so without this the house''s own window would be the only one unable to say whose it is.';

-- An override is a stronger statement than an inference, so it is written
-- first and the inference backfill skips any row already claimed.

update public.wines
   set drink_window_basis = 'override'
 where 'drink_window' = any(manual_overrides);

update public.wines
   set drink_window_basis = 'inferred'
 where drink_window_basis is null
   and rating_source = 'claude_inference'
   and drink_window_start is not null;
