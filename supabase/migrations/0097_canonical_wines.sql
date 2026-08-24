-- 0097_canonical_wines.sql
-- P2 — wine identity spine, part 1: the global identity table.
--
-- canonical_wines is the internal, immutable identity a real-world wine
-- (producer + cuvée, no vintage/size) gets exactly once, ever, regardless of
-- how many tenants carry it or how many times its name is misspelled on a
-- CSV. It is deliberately NOT restaurant-scoped: two restaurants' imports of
-- "Domaine Jean Grivot, Vosne-Romanée" must resolve to the same row so a
-- later image/enrichment pass (P4) can serve one cached asset to both,
-- without either tenant's inventory ever becoming visible to the other
-- (that boundary lives entirely in wine_variants/wines, not here).
--
-- LWIN (lwin7) participates as an alias/anchor, never as the primary key —
-- see docs/plans/2026-08-23-p2-identity-spine.md §1 for why: a bad fuzzy
-- LWIN match must never be able to retroactively invalidate this row's
-- identity (the C24 failure mode). vintage and bottle size are NEVER part
-- of this table — they are wine_variants' job (0098) and are always exact
-- keys, never fuzzy-matched (see resolve_wine_variants_bulk, 0099).

create table public.canonical_wines (
  id                     uuid        primary key default gen_random_uuid(),
  producer               text        not null,
  cuvee                  text        not null,
  producer_norm          text        not null,
  cuvee_norm             text        not null,
  colour                 text,
  region                 text,
  country                text,
  lwin7                  text        check (lwin7 ~ '^[0-9]{7}$'),
  identity_status        text        not null default 'unverified' check (
    identity_status in ('lwin_verified', 'operator_confirmed', 'unverified')
  ),
  created_by_restaurant_id uuid      references public.restaurants(id) on delete set null,
  created_by_user_id     uuid        references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.canonical_wines is
  'Global (not restaurant-scoped) real-world wine identity: producer + '
  'cuvée, no vintage/size. created_by_* is audit metadata only, never a '
  'tenancy boundary — every authenticated tenant can read and (shape-'
  'restricted) insert into this table by design, since it is a shared '
  'catalog every import contributes to. See the migration header and '
  'docs/plans/2026-08-23-p2-identity-spine.md §8 for the anti-pollution '
  'reasoning: access control cannot lock this table down without also '
  'blocking legitimate long-tail wine creation, so correctness is '
  'enforced on WHAT a row may assert (identity_status/lwin7 shape), not '
  'WHO may write it.';

create unique index canonical_wines_identity_idx
  on public.canonical_wines (producer_norm, cuvee_norm);

create unique index canonical_wines_lwin7_idx
  on public.canonical_wines (lwin7)
  where lwin7 is not null;

create index canonical_wines_producer_trgm_idx
  on public.canonical_wines using gin (producer_norm gin_trgm_ops);

create index canonical_wines_cuvee_trgm_idx
  on public.canonical_wines using gin (cuvee_norm gin_trgm_ops);

create trigger canonical_wines_set_updated_at
  before update on public.canonical_wines
  for each row execute function public.set_updated_at();

alter table public.canonical_wines enable row level security;

create policy "anyone authenticated can read canonical_wines"
  on public.canonical_wines for select to authenticated
  using (true);

-- Shape-restricted insert, not ownership-restricted (there is no owner to
-- check on a global table): a raw client/RPC insert may only claim
-- 'unverified' outright, or 'lwin_verified' when it also supplies a lwin7
-- that CORROBORATES against the real catalog (see below — round 1 only
-- checked lwin7's format, not that it named a real, matching wine).
-- 'operator_confirmed' is intentionally NEVER reachable through this
-- policy — nothing in P2 sets it; it exists in the CHECK constraint for a
-- future manager-gated promotion RPC, which is explicitly out of scope
-- here (docs/plans/2026-08-23-p2-identity-spine.md §12).
--
-- P2 ROUND-4 FIX (D9 — scratchpad db-audit/verify/P2-critic-r3.md): the
-- round-1 policy only checked lwin7's FORMAT (7 digits), never that it
-- named a real wine, let alone the wine actually being submitted. lwin7
-- is otherwise attacker-controlled input: any authenticated tenant could
-- claim identity_status='lwin_verified' with an arbitrary 7-digit string,
-- and canonical_wines_lwin7_idx being UNIQUE means the first writer owns
-- that LWIN globally, forever — with no UPDATE/DELETE policy on this
-- table, the victim (any OTHER tenant who later imports the real wine
-- correctly, or the identity itself) cannot repair it; only service-role
-- merge_canonical_wines can. Composed with resolve_wine_variants_bulk's
-- "LWIN-exact deterministically wins over producer/cuvée text" behavior
-- (0099, by design, for the legitimate data-entry-error case), an
-- attacker who submits producer='Garbage', cuvee='X', lwin7=<a real
-- wine's LWIN> before anyone else creates that canonical row silently
-- hijacks every later tenant's correctly-submitted import of that same
-- real wine onto their own garbage-labeled row — cross-tenant identity
-- corruption on the table every future image/visual-search piece
-- (P4/P5/P6) will key off.
--
-- Fixed: 'lwin_verified' now additionally requires that lwin7 names a
-- real public.lwin_catalog row (that table's primary key is lwin_id —
-- there is no separate "lwin7" column there, see
-- 0003_wine_intelligence.sql) AND that the SUBMITTED producer/cuvee
-- actually resemble that catalog row's producer/display_name — closing
-- both forgery (a LWIN that doesn't exist at all) and mis-binding (a
-- REAL LWIN attached to the wrong wine, which would still squat the
-- unique index otherwise). Reuses match_lwin's own already-tuned
-- similarity thresholds (0007_lwin_matching.sql: 0.3 for producer,
-- 0.3 * 0.7 = 0.21 for name-vs-display_name) rather than inventing new
-- ones. This is a format-and-content check on the row being inserted, the
-- same kind of objectively-checkable-fact test the round-1 comment above
-- already described — it just now actually checks the fact, not merely
-- its shape.
--
-- This RLS policy protects DIRECT inserts (including a raw client
-- posting straight to this table, or any future code path). It does NOT,
-- by itself, protect resolve_wine_variants_bulk's own batched insert from
-- aborting the ENTIRE batch the moment one row's lwin7 fails this check
-- (a WITH CHECK violation on any one row of a multi-row INSERT fails the
-- whole statement) — that RPC (0099) carries its OWN, functionally
-- equivalent pre-insert corroboration gate for exactly that reason, so a
-- bad LWIN downgrades just that one row to unverified instead of
-- aborting a 5,000-row import chunk. Nor does it protect 0101's backfill,
-- which runs as the table owner and bypasses RLS entirely — that
-- migration carries its own independent copy of this same gate too. All
-- three enforcement points must be kept in agreement; see D9's write-up
-- for why a single shared implementation wasn't practical (this is SQL
-- data-manipulation-language duplicated across a policy expression, a
-- PL/pgSQL function body, and a plain migration script — three different
-- execution contexts with no shared-function seam that fires in the
-- right place for all three without adding a security-definer function
-- purely for this check, which was judged more machinery than the
-- problem warrants for now).
create policy "members can insert canonical_wines"
  on public.canonical_wines for insert to authenticated
  with check (
    identity_status = 'unverified'
    or (
      identity_status = 'lwin_verified'
      and lwin7 is not null
      and exists (
        select 1 from public.lwin_catalog lc
        where lc.lwin_id = lwin7
          and similarity(lower(producer), lower(lc.producer)) >= 0.3
          and similarity(lower(cuvee), lower(lc.display_name)) >= 0.21
      )
    )
  );

-- No update/delete policy for authenticated or anon: this table is
-- append-mostly. The only sanctioned mutation paths are
-- resolve_wine_variants_bulk (0099, insert-only) and merge_canonical_wines
-- (0100, service-role only, which both updates referrers and deletes the
-- source row under its own privileges).
--
-- P2 ROUND-2 FIX (D4 — scratchpad db-audit/verify/P2-critic-r1.md):
-- created_by_restaurant_id is audit-only per this table's own design (see
-- the table comment above), but §8 of
-- docs/plans/2026-08-23-p2-identity-spine.md only evaluated that column
-- against a WRITE-corruption threat model and never asked whether a
-- global, any-authenticated-readable table should expose it for READING.
-- The critic reproduced live that it does: any signed-in user at any
-- restaurant can read which OTHER restaurant first stocked a given wine —
-- a narrow but real competitive-intelligence leak, and — combined with
-- 0029_public_restaurant_read.sql's public restaurant-name policy — a
-- restaurant's own name is reachable from it too. Deliberate decision:
-- restrict, not merely document. No app code anywhere reads
-- created_by_restaurant_id or created_by_user_id via the authenticated
-- role (confirmed by grep across src/**), so there is no functional loss,
-- and RETURNING clauses on this table (resolve_wine_variants_bulk, 0099)
-- never reference either column, so this cannot break the one write path
-- that populates them. Column-level GRANT (not a second RLS policy —
-- Postgres RLS is row-level only) is the standard mechanism for
-- restricting a subset of columns on an otherwise-readable table; per
-- has_table_privilege's own semantics (true if the role holds privilege
-- on ANY column), the existing "authenticated can select ...
-- canonical_wines" pgTAP assertion in
-- supabase/tests/0097_identity_spine_grants.sql is unaffected. Both
-- created_by_* columns get the same treatment since they share the exact
-- same audit-only justification and the same platform-wide-read shape —
-- leaving one restricted and its sibling open would be an inconsistency,
-- not a decision.
grant select (
  id, producer, cuvee, producer_norm, cuvee_norm, colour, region, country,
  lwin7, identity_status, created_at, updated_at
) on table public.canonical_wines to authenticated;
grant insert on table public.canonical_wines to authenticated;
