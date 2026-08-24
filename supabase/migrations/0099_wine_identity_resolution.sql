-- 0099_wine_identity_resolution.sql
-- P2 — wine identity spine, part 3: the alias ledger and the dedup
-- service's DB entrypoint.
--
-- wine_aliases is not given its own numbered migration in
-- docs/plans/2026-08-23-p2-identity-spine.md — §0 lists it as an in-scope
-- deliverable and §6-9 describe how it is written and read, but the plan's
-- own §3 migration set never gives it a CREATE TABLE. It is defined here,
-- immediately before the one function that writes it, because it is
-- specifically the dedup service's own spelling corpus (§9 step 6), and
-- because both the canonical- and variant-scoped shapes it needs
-- (§8's tenancy table has separate rows for each) only make sense once
-- both canonical_wines (0097) and wine_variants (0098) exist.
create table public.wine_aliases (
  id                uuid        primary key default gen_random_uuid(),
  canonical_wine_id uuid        references public.canonical_wines(id) on delete cascade,
  wine_variant_id   uuid        references public.wine_variants(id) on delete cascade,
  restaurant_id     uuid        references public.restaurants(id) on delete cascade,
  raw_producer      text,
  raw_cuvee         text,
  source            text        not null default 'import' check (source in ('import', 'lwin', 'manual')),
  match_method      text        not null check (
    match_method in ('exact', 'lwin_exact', 'fuzzy_suggested', 'fuzzy_confirmed')
  ),
  confidence        real,
  created_at        timestamptz not null default now(),
  -- Exactly one scope per row: canonical-scoped (global, no restaurant_id)
  -- XOR variant-scoped (tenant, restaurant_id required). Never both null,
  -- never both set — a variant-scoped alias without knowing which tenant
  -- asserted it would be an unscoped write nobody could ever read back
  -- under RLS.
  constraint wine_aliases_scope_check check (
    (canonical_wine_id is not null and wine_variant_id is null and restaurant_id is null)
    or (wine_variant_id is not null and restaurant_id is not null)
  )
);

comment on table public.wine_aliases is
  'Append-only spelling/identifier corpus. Canonical-scoped rows '
  '(canonical_wine_id set, restaurant_id null) are the ONLY shape '
  'resolve_wine_variants_bulk below writes in P2 — recording every raw '
  'producer/cuvée string a batch resolved against its canonical_wine_id, '
  'match_method=''exact''. The variant-scoped shape (wine_variant_id + '
  'restaurant_id set) is schema-ready for a future GTIN/LWIN11/LWIN16 '
  'alias writer per docs/plans/2026-08-23-p2-identity-spine.md §8, but no '
  'P2 code path populates it — see the P2 builder report for why that is '
  'flagged as this migration''s weakest point for the merge-completeness '
  'contract test (0100).';

-- Idempotency: resolve_wine_variants_bulk re-run on identical input must
-- add zero new alias rows. Partial (scoped to canonical-only rows) because
-- that is the only shape this migration's writer produces; a future
-- variant-scoped writer needs its own uniqueness rule.
create unique index wine_aliases_canonical_raw_idx
  on public.wine_aliases (canonical_wine_id, raw_producer, raw_cuvee)
  where restaurant_id is null;

create index wine_aliases_variant_idx
  on public.wine_aliases (wine_variant_id)
  where wine_variant_id is not null;

alter table public.wine_aliases enable row level security;

-- Canonical-scoped rows (restaurant_id null) are globally readable, same
-- trust tier as canonical_wines itself; variant-scoped rows are
-- tenant-gated. is_member(null) is false for every caller (no membership
-- row has a null restaurant_id), so this single USING clause correctly
-- implements both halves of docs/plans/2026-08-23-p2-identity-spine.md
-- §8's two-row tenancy table without a second policy.
create policy "read canonical-scoped or own-tenant wine_aliases"
  on public.wine_aliases for select to authenticated
  using (restaurant_id is null or public.is_member(restaurant_id));

-- Shape-restricted, not authenticity-restricted, for the same reason as
-- canonical_wines: match_method may only claim 'exact' (an objectively
-- checkable text-equality fact) or 'fuzzy_suggested' (explicitly
-- non-authoritative). 'lwin_exact'/'fuzzy_confirmed' are reserved for a
-- future privileged writer; nothing in P2 ever inserts them.
create policy "insert canonical-scoped or own-tenant wine_aliases"
  on public.wine_aliases for insert to authenticated
  with check (
    match_method in ('exact', 'fuzzy_suggested')
    and (restaurant_id is null or public.is_member(restaurant_id))
  );

-- No update/delete: append-only ledger.

grant select, insert on table public.wine_aliases to authenticated;

-------------------------------------------------------------------------------
-- resolve_wine_variants_bulk — the dedup service's DB entrypoint.
--
-- Called once per batch of UNIQUE variants (a pre-deduplicated set the
-- caller has already collapsed by (producer_norm, cuvee_norm, vintage,
-- size_ml)), never once per CSV row — the direct answer to C10 (no
-- per-row PL/pgSQL loop, no advisory lock anywhere below).
--
-- SECURITY INVOKER, not definer: this is C01's own fix sketch applied to
-- new code. RLS on wine_variants (is_member(restaurant_id)) is the ONLY
-- thing between a caller and writing another tenant's variant, and
-- invoker mode is what makes that check actually apply. There is
-- deliberately NO manual is_member() guard in this function body — a
-- caller targeting a restaurant_id it is not a member of must fail via
-- the real RLS policy on the wine_variants INSERT below, not a
-- hand-rolled check that could drift from the policy over time.
--
-- Input rows are already normalized by src/domains/identity/normalize.ts
-- — this function does no Unicode folding. lwin7 SHOULD already have
-- cleared the caller's confidence gate (P3's contract: only a
-- lwin_score >= 0.6 match_lwin_bulk result may be forwarded as lwin7;
-- anything weaker is a separate, non-identity-affecting field) — but
-- that contract is a client-side convention, not a server-side
-- guarantee, and this function must not trust it blindly (D9 — scratchpad
-- db-audit/verify/P2-critic-r3.md): a malicious or buggy caller can put
-- ANY 7-digit string in lwin7 regardless of what P3's real code does.
-- The corroboration gate at step 2.5 below is what actually enforces
-- this, by checking the claim against public.lwin_catalog before ever
-- letting it create a canonical_wines row.
create or replace function public.resolve_wine_variants_bulk(
  p_restaurant_id uuid,
  p_variants jsonb
)
returns table (
  idx                    int,
  canonical_wine_id      uuid,
  wine_variant_id        uuid,
  canonical_match_method text,
  canonical_created      boolean,
  variant_created        boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
-- The RETURNS TABLE columns above (canonical_wine_id, wine_variant_id,
-- idx) collide by name with real columns on _rwvb_input/wine_variants/
-- wine_aliases. This function never reads or writes those OUT
-- parameters as PL/pgSQL variables anywhere in its body (only via the
-- final RETURN QUERY, which is alias-qualified and unambiguous) — every
-- bare use of those names elsewhere is meant to resolve to the SQL
-- column, which is what this directive makes happen instead of an
-- "ambiguous" error at the ON CONFLICT target lists below.
begin
  -- Scratch table for this call. "if not exists" + truncate (rather than
  -- a bare CREATE) so a second call within the same transaction — the
  -- fault-injection tests deliberately do this — reuses it safely.
  -- "on commit drop" means it never outlives the calling transaction.
  create temporary table if not exists _rwvb_input (
    idx                    int primary key,
    producer_raw           text not null,
    cuvee_raw              text not null,
    producer_norm          text not null,
    cuvee_norm             text not null,
    vintage                int,
    size_ml                int not null,
    lwin7                  text,
    lwin11                 text,
    lwin16                 text,
    gtin                   text,
    canonical_wine_id      uuid,
    canonical_match_method text,
    canonical_created      boolean not null default false,
    wine_variant_id        uuid,
    variant_created        boolean not null default false
  ) on commit drop;

  truncate _rwvb_input;

  -- 1. Unnest the batch.
  insert into _rwvb_input (
    idx, producer_raw, cuvee_raw, producer_norm, cuvee_norm,
    vintage, size_ml, lwin7, lwin11, lwin16, gtin
  )
  select x.idx, x.producer_raw, x.cuvee_raw, x.producer_norm, x.cuvee_norm,
         x.vintage, x.size_ml, x.lwin7, x.lwin11, x.lwin16, x.gtin
  from jsonb_to_recordset(p_variants) as x(
    idx int, producer_raw text, cuvee_raw text, producer_norm text, cuvee_norm text,
    vintage int, size_ml int, lwin7 text, lwin11 text, lwin16 text, gtin text
  );

  -- 2. Canonical, phase 1 (exact). Two separate UPDATEs, not one OR'd
  -- join, so LWIN7 equality deterministically wins even where producer/
  -- cuvée text differs (a data-entry-error row still lands on the LWIN
  -- identity, never forks a second canonical row for it — it becomes an
  -- alias below, not a duplicate).
  update _rwvb_input i
  set canonical_wine_id = cw.id,
      canonical_match_method = 'lwin_exact'
  from public.canonical_wines cw
  where i.lwin7 is not null
    and cw.lwin7 = i.lwin7;

  update _rwvb_input i
  set canonical_wine_id = cw.id,
      canonical_match_method = 'exact'
  from public.canonical_wines cw
  where i.canonical_wine_id is null
    and cw.producer_norm = i.producer_norm
    and cw.cuvee_norm = i.cuvee_norm;

  -- 2.5. LWIN corroboration gate (D9 fix — scratchpad db-audit/verify/
  -- P2-critic-r3.md): a row that reaches here has NOT matched any
  -- existing canonical_wines row (neither by LWIN equality nor by exact
  -- text) and is about to CREATE one in phase 2 below, claiming
  -- identity_status='lwin_verified' whenever its lwin7 is set. Without
  -- this gate, this header comment's own claim that "lwin7 must already
  -- have cleared the caller's confidence gate (P3's contract)" is a
  -- client-side promise protecting a server-side invariant — i.e. not a
  -- gate at all, since the caller supplies lwin7 directly in the jsonb
  -- payload. A tenant could submit producer='Garbage', cuvee='X',
  -- lwin7=<a real wine's LWIN>; canonical_wines_lwin7_idx is UNIQUE, so
  -- that forged row would permanently own the real LWIN, and every OTHER
  -- tenant who later imports the real wine correctly would hit this same
  -- exact-match phase above and — because LWIN-exact deterministically
  -- wins over producer/cuvée text, by design, two paragraphs up — bind
  -- their inventory to the attacker-controlled row. canonical_wines has
  -- no UPDATE/DELETE policy, so the victim cannot repair this themselves.
  --
  -- The gate: lwin7 may only be trusted if it names a REAL lwin_catalog
  -- row (lwin_catalog.lwin_id is that table's primary key — the catalog
  -- has no separate "lwin7" column, see 0003_wine_intelligence.sql) whose
  -- producer/display_name actually resemble the SUBMITTED producer_raw/
  -- cuvee_raw. Reuses match_lwin's own already-tuned similarity
  -- thresholds (0007_lwin_matching.sql: 0.3 for producer, 0.3 * 0.7 =
  -- 0.21 for name-vs-display_name) rather than inventing new numbers —
  -- the same comparison this codebase already trusts elsewhere. A row
  -- whose lwin7 fails corroboration is DOWNGRADED (lwin7 stripped, so
  -- phase 2 below naturally falls to identity_status='unverified'), not
  -- rejected: a single bad LWIN in a 5,000-row import chunk must not
  -- abort the whole chunk, and this row still gets a real (unverified)
  -- canonical identity via its own text — the safe, always-available
  -- fallback. Set-based, no per-row loop, no exception raised — the
  -- direct C10-consistent answer, same discipline as every other step in
  -- this function. The exact-match phase above is unaffected and remains
  -- safe by construction: it only ever matches EXISTING canonical_wines
  -- rows, and every existing row was itself either created through this
  -- same corroboration gate or through 0101's backfill (which carries its
  -- own, independent copy of this same gate — see that migration's
  -- header — since a migration runs as the table owner and bypasses RLS
  -- entirely, so canonical_wines' own INSERT policy corroboration cannot
  -- protect it).
  update _rwvb_input i
  set lwin7 = null
  where i.canonical_wine_id is null
    and i.lwin7 is not null
    and not exists (
      select 1 from public.lwin_catalog lc
      where lc.lwin_id = i.lwin7
        and similarity(lower(i.producer_raw), lower(lc.producer)) >= 0.3
        and similarity(lower(i.cuvee_raw), lower(lc.display_name)) >= 0.21
    );

  -- 3. Canonical, phase 2 (create). DISTINCT ON collapses two rows in the
  -- SAME batch that are the same new wine to one insert attempt — the
  -- direct answer to the "same-batch duplicate" fault injection.
  -- ON CONFLICT DO NOTHING handles a genuinely concurrent OTHER call
  -- committing the same (producer_norm, cuvee_norm) between step 2 and
  -- here.
  with new_canon as (
    insert into public.canonical_wines (
      producer, cuvee, producer_norm, cuvee_norm, lwin7,
      identity_status, created_by_restaurant_id, created_by_user_id
    )
    select distinct on (i.producer_norm, i.cuvee_norm)
      i.producer_raw, i.cuvee_raw, i.producer_norm, i.cuvee_norm, i.lwin7,
      case when i.lwin7 is not null then 'lwin_verified' else 'unverified' end,
      p_restaurant_id, auth.uid()
    from _rwvb_input i
    where i.canonical_wine_id is null
    order by i.producer_norm, i.cuvee_norm, i.idx
    on conflict (producer_norm, cuvee_norm) do nothing
    returning id, producer_norm, cuvee_norm
  )
  update _rwvb_input i
  set canonical_wine_id = nc.id,
      canonical_match_method = 'created',
      canonical_created = true
  from new_canon nc
  where i.canonical_wine_id is null
    and i.producer_norm = nc.producer_norm
    and i.cuvee_norm = nc.cuvee_norm;

  -- 4. Re-join: lost-the-conflict-race read-back. Under READ COMMITTED,
  -- this SELECT gets a fresh snapshot and will see a concurrent session's
  -- now-committed insert.
  update _rwvb_input i
  set canonical_wine_id = cw.id,
      canonical_match_method = 'exact',
      canonical_created = false
  from public.canonical_wines cw
  where i.canonical_wine_id is null
    and cw.producer_norm = i.producer_norm
    and cw.cuvee_norm = i.cuvee_norm;

  -- 5. Variant resolution — identical two-phase pattern keyed on
  -- (restaurant_id, canonical_wine_id, coalesce(vintage,0), size_ml).
  -- vintage and size_ml are exact keys here, never fuzzy — see the
  -- migration header.
  update _rwvb_input i
  set wine_variant_id = wv.id
  from public.wine_variants wv
  where wv.restaurant_id = p_restaurant_id
    and wv.canonical_wine_id = i.canonical_wine_id
    and coalesce(wv.vintage, 0) = coalesce(i.vintage, 0)
    and wv.size_ml = i.size_ml;

  with new_variants as (
    insert into public.wine_variants (
      restaurant_id, canonical_wine_id, vintage, size_ml, lwin11, lwin16, gtin
    )
    select distinct on (i.canonical_wine_id, coalesce(i.vintage, 0), i.size_ml)
      p_restaurant_id, i.canonical_wine_id, i.vintage, i.size_ml, i.lwin11, i.lwin16, i.gtin
    from _rwvb_input i
    where i.wine_variant_id is null
    order by i.canonical_wine_id, coalesce(i.vintage, 0), i.size_ml, i.idx
    on conflict (restaurant_id, canonical_wine_id, coalesce(vintage, 0), size_ml) do nothing
    returning id, canonical_wine_id, vintage, size_ml
  )
  update _rwvb_input i
  set wine_variant_id = nv.id,
      variant_created = true
  from new_variants nv
  where i.wine_variant_id is null
    and i.canonical_wine_id = nv.canonical_wine_id
    and coalesce(i.vintage, 0) = coalesce(nv.vintage, 0)
    and i.size_ml = nv.size_ml;

  update _rwvb_input i
  set wine_variant_id = wv.id
  from public.wine_variants wv
  where i.wine_variant_id is null
    and wv.restaurant_id = p_restaurant_id
    and wv.canonical_wine_id = i.canonical_wine_id
    and coalesce(wv.vintage, 0) = coalesce(i.vintage, 0)
    and wv.size_ml = i.size_ml;

  -- 6. Alias write — the spelling corpus. One batched, deduped insert;
  -- ON CONFLICT DO NOTHING against wine_aliases_canonical_raw_idx is what
  -- makes a re-run of identical input add zero new rows here too.
  insert into public.wine_aliases (canonical_wine_id, raw_producer, raw_cuvee, source, match_method)
  select distinct on (i.canonical_wine_id, i.producer_raw, i.cuvee_raw)
    i.canonical_wine_id, i.producer_raw, i.cuvee_raw, 'import', 'exact'
  from _rwvb_input i
  where i.canonical_wine_id is not null
  order by i.canonical_wine_id, i.producer_raw, i.cuvee_raw, i.idx
  on conflict (canonical_wine_id, raw_producer, raw_cuvee) where restaurant_id is null do nothing;

  -- 7. Return the per-idx result set.
  return query
  select i.idx, i.canonical_wine_id, i.wine_variant_id, i.canonical_match_method,
         i.canonical_created, i.variant_created
  from _rwvb_input i
  order by i.idx;
end;
$$;

comment on function public.resolve_wine_variants_bulk(uuid, jsonb) is
  'Set-based identity resolution for a pre-deduplicated batch of unique '
  '(producer, cuvee, vintage, size_ml) variants. SECURITY INVOKER: RLS on '
  'wine_variants is the tenant boundary, not a check in this function. '
  'Every phase is a fixed number of set-based statements regardless of '
  'batch size — no per-row loop, no advisory lock.';

revoke all on function public.resolve_wine_variants_bulk(uuid, jsonb) from public;
grant execute on function public.resolve_wine_variants_bulk(uuid, jsonb) to authenticated;
