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

-- P2 ROUND-5 FIX (D9-residual — scratchpad db-audit/verify/P2-critic-r4.md):
-- shared, deterministic text-normalization helper. Round 4's LWIN
-- corroboration gate used pg_trgm similarity() with match_lwin's ranking
-- thresholds (0.3/0.21) — a threshold tuned to be TOLERANT of false
-- positives because a human reviews match_lwin's suggestions. That is the
-- wrong tool for a permanent, cross-tenant, unrepairable security
-- decision: similarity('Chateau Pichon Longueville Baron', 'Chateau
-- Pichon Longueville Comtesse de Lalande') = 0.55, comfortably above 0.3,
-- for two REAL, DISTINCT Bordeaux estates that share a long common
-- prefix — live-verified against this exact pair before writing this
-- comment. A fuzzy threshold cannot separate them; no threshold reliably
-- can, because their similarity is a property of shared vocabulary, not
-- of being the same wine.
--
-- identity_normalize_text() replaces the threshold with a DETERMINISTIC
-- equality check: the same normalize-and-token-sort technique
-- 0101_wine_identity_backfill.sql already uses for its own best-effort
-- SQL-side approximation of src/domains/identity/normalize.ts (unaccent
-- + lowercase + collapse non-alnum + token-sort) — extracted here into
-- one shared function so there is exactly one implementation instead of
-- duplicated inline copies, and reused by 0101 below for both its
-- existing wines-normalization pass AND the new corroboration check.
-- Baron and Lalande normalize to different token sets ("baron chateau
-- longueville pichon" vs "chateau comtesse de lalande longueville
-- pichon") and can never satisfy an equality check regardless of shared
-- vocabulary, while a genuine data-entry-error — accents, case, spacing,
-- punctuation — still normalizes identically on both sides, preserving
-- the legitimate "LWIN wins over textual FORMATTING differences"
-- behavior resolve_wine_variants_bulk depends on. This is the same
-- SQL-vs-TS-normalization approximation risk 0101 already discloses and
-- accepts (Postgres unaccent()'s dictionary vs JS NFKD-plus-manual-œ/æ-
-- folding will not agree on every input) — the risk direction stays
-- "creates one extra row a later match could have reused," never
-- "verifies the wrong wine," because a normalization MISMATCH here can
-- only cause a false NEGATIVE (reject/downgrade a legitimate match), not
-- a false positive.
create extension if not exists unaccent;

create or replace function public.identity_normalize_text(raw text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    (select string_agg(t, ' ' order by t)
     from unnest(string_to_array(
       trim(regexp_replace(lower(unaccent(raw)), '[^a-z0-9]+', ' ', 'g')),
       ' '
     )) as t
     where t <> ''),
    ''
  );
$$;

comment on function public.identity_normalize_text(text) is
  'Deterministic SQL-side approximation of '
  'src/domains/identity/normalize.ts''s normalizeProducerOrCuvee (unaccent '
  'instead of NFKD+manual folding — a known, accepted divergence risk, '
  'see 0101''s header). Used ONLY for deterministic comparisons — exact '
  'equality (producer) or token-array subset (cuvee vs display_name, '
  'since display_name commonly combines producer + wine name) — never '
  'as a fuzzy/threshold input. '
  'Round-5 fix for D9-residual: replaces the round-4 pg_trgm similarity() '
  'threshold, which could not distinguish real, differently-named wines '
  'that share vocabulary (Chateau Pichon Longueville Baron vs ...Comtesse '
  'de Lalande, similarity 0.55).';

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
-- that DETERMINISTICALLY corroborates against the real catalog (see
-- below). 'operator_confirmed' is intentionally NEVER reachable through
-- this policy — nothing in P2 sets it; it exists in the CHECK constraint
-- for a future manager-gated promotion RPC, out of scope here
-- (docs/plans/2026-08-23-p2-identity-spine.md §12).
--
-- P2 ROUND-4/5 HISTORY (D9, then D9-residual — scratchpad
-- db-audit/verify/P2-critic-r3.md and -r4.md): round 1 only checked
-- lwin7's FORMAT. Round 4 added a corroboration check using pg_trgm
-- similarity() at match_lwin's own ranking thresholds (0.3/0.21) — WRONG:
-- that threshold is tuned to be tolerant of false positives because a
-- human reviews match_lwin's suggestions; this policy makes a permanent,
-- cross-tenant, unrepairable decision. The round-5 critic proved live
-- that similarity('Chateau Pichon Longueville Baron', 'Chateau Pichon
-- Longueville Comtesse de Lalande') = 0.55 — two REAL, DISTINCT estates,
-- both comfortably above 0.3 — then reproduced the full cross-tenant
-- hijack through all three enforcement copies using nothing but the
-- system's OWN real data (no attacker needed): tenant A submits
-- Lalande's own correct text with Baron's real lwin7; the (then-fuzzy)
-- gate accepted it as lwin_verified; tenant B later submits Baron's own
-- correct text with the same lwin7, and because LWIN-exact wins by
-- design, tenant B bound to tenant A's Lalande-labelled row.
--
-- The round-5 critic ALSO found a second, more severe hole: the
-- 'unverified' branch below placed NO constraint on lwin7 at all, so a
-- row could squat a real lwin7 as 'unverified' garbage — the
-- corroboration check never even ran — and 0099's phase-1 lwin_exact
-- match had no identity_status filter, so EVERY later import carrying
-- that lwin7, including a fully legitimate one, matched the squatter.
-- That path needed no fuzzy match, no attacker cleverness, and did not
-- go through this policy's 'lwin_verified' branch at all.
--
-- Round 5 fixes BOTH, structurally rather than by tuning a constant:
--
-- 1. NEW CHECK CONSTRAINT canonical_wines_lwin7_requires_verified below:
--    lwin7 may be non-null ONLY when identity_status = 'lwin_verified'.
--    This is a table-level CHECK, not an RLS policy clause, so it is
--    enforced for EVERY insert path universally — the authenticated RLS
--    policy here, resolve_wine_variants_bulk (SECURITY INVOKER, so RLS
--    already applied, but defense-in-depth matters), AND 0101's backfill
--    (which runs as the table owner and bypasses RLS entirely — this
--    CHECK constraint is the only thing that reaches it). Closes the
--    unverified-squat path outright: there is no longer any insert shape
--    that lets lwin7 through without the corroboration check below also
--    having to pass.
-- 2. The corroboration check itself is now DETERMINISTIC, not fuzzy:
--    identity_normalize_text() (defined above) applied to both sides.
--    PRODUCER is compared for EXACT equality — this is what actually
--    separates Baron from Lalande (their normalized forms differ), while
--    still tolerating genuine data-entry-error formatting differences
--    (accents/case/spacing/punctuation collapse identically on both
--    sides). CUVEE is compared by TOKEN SUBSET, not exact equality:
--    lwin_catalog.display_name commonly combines producer + wine name
--    (verified against this table's own seed data), so an exact-string
--    check against cuvee alone would reject every legitimate match. A
--    submitted cuvee whose normalized tokens are ALL present in
--    display_name's normalized tokens is accepted; a wrong cuvee (e.g.
--    the real producer's LWIN attached to a fabricated bottling name)
--    is not. Both comparisons are still deterministic set/string
--    operations, never a score — which is what makes resolve_wine_
--    variants_bulk's "LWIN wins over textual FORMATTING differences"
--    feature still work
--    for its intended case).
--
-- This RLS policy protects DIRECT inserts. It does NOT, by itself,
-- protect resolve_wine_variants_bulk's own batched insert from aborting
-- the ENTIRE batch the moment one row's lwin7 fails this check (a WITH
-- CHECK violation on any one row of a multi-row INSERT fails the whole
-- statement) — that RPC (0099) carries its own pre-insert corroboration
-- gate (now also deterministic) for exactly that reason, so a bad LWIN
-- downgrades just that one row to unverified instead of aborting a
-- 5,000-row import chunk. 0101's backfill carries its own copy of the
-- corroboration logic too (reusing identity_normalize_text() directly,
-- not duplicating the expression) — the CHECK CONSTRAINT is what makes
-- the OUTCOME safe there even if that logic ever drifted; the RLS
-- policy and the RPC gate exist to make the CREATE decision correct in
-- the first place, not merely safe-by-constraint.
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
          -- `canonical_wines.producer`/`.cuvee` MUST be table-qualified
          -- here, not bare — lwin_catalog also has its own `producer`
          -- column, and an unqualified reference inside this subquery
          -- resolves to lc.producer (the subquery's own scope), not the
          -- row being inserted, silently turning this into `x = x`
          -- (always true). Caught live during round-5 verification: the
          -- unqualified form let Pichon Lalande's own text pass
          -- corroboration against Pichon Baron's catalog row, because
          -- the check was accidentally comparing Baron's catalog
          -- producer to itself. `lwin_catalog` has no `cuvee` or
          -- `identity_status` column, so those bare references above are
          -- not at risk — only the two names it happens to share with
          -- canonical_wines.
          and public.identity_normalize_text(canonical_wines.producer) = public.identity_normalize_text(lc.producer)
          and string_to_array(public.identity_normalize_text(canonical_wines.cuvee), ' ') <@ string_to_array(public.identity_normalize_text(lc.display_name), ' ')
      )
    )
  );

-- P2 ROUND-5 FIX (D9-residual): closes the unverified-squat path at the
-- schema level, universally, regardless of insert path or role. See the
-- policy comment above for the full history.
alter table public.canonical_wines
  add constraint canonical_wines_lwin7_requires_verified
  check (lwin7 is null or identity_status = 'lwin_verified');

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
