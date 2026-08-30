-- 0137_backfill_blank_producers_from_lwin.sql
-- Recover the producer for wines that were imported without one.
--
-- WHAT HAPPENED
--
-- A CSV import on 2026-08-29 created 1277 wines whose `producer` is the empty
-- string, with the producer name run together with the cuvee in `name`:
--
--   producer = ''      name = 'Benjamin Leroux Vosne-Romanée'
--   producer = ''      name = 'Bruno Giacosa Barolo Falletto'
--
-- The source rows are still in import_batch_rows.raw and they carry
-- `"producer": ""` — the column was genuinely empty in the file, so there is
-- nothing to recover from the import itself. The producer only exists inside
-- `name`, with no delimiter separating it from the cuvee.
--
-- WHY IT MATTERS
--
-- Identity resolution is producer-first. resolve_wine_variants_bulk (0099)
-- cannot normalize an empty producer, and match_lwin (0105) weights producer
-- similarity at 0.6 against a `%` operator that an empty string never
-- satisfies. So these wines could not resolve to the canonical spine and could
-- not match LWIN — 108 of 1385 wines resolved before this migration. The spine
-- was installed and inert.
--
-- HOW THE PRODUCER IS RECOVERED
--
-- lwin_catalog holds 211,498 reference wines with a `producer` column, which is
-- authoritative. Because the shape is consistently `<producer> <cuvee>`, the
-- reliable operation is a LONGEST-WORD-PREFIX match of the wine's name against
-- the set of known producers — not a trigram match on the whole string.
--
-- Trigram was tried first and rejected on evidence: matching name-to-
-- display_name scored 'Agrapart Experience' against 'ABK6, L`Experience,
-- Cognac' at 0.364 and would have written ABK6 as the producer. Prefix matching
-- returns Agrapart. Precision matters more than coverage here, because a wrong
-- producer is worse than a missing one: it is silently believable.
--
-- THE GENERIC-WORD TRAP
--
-- lwin_catalog contains producers literally named 'Chateau', 'Maison', 'Clos'
-- and 'Tenuta'. Without a stoplist, 'Château Sainte Anne Bandol Rouge' matches
-- the one-word producer 'Chateau' — 24 wines took that path. The real producer,
-- 'Château Sainte Anne', is not in the catalog at all, so the correct outcome
-- for those rows is NO match: they keep their empty producer, are not written
-- to, and do not appear in the audit table. Unrepaired is the right answer when
-- the only available answer would be wrong.
--
-- COVERAGE, MEASURED AGAINST PRODUCTION BEFORE WRITING THIS
--
--   956 of 1277 blank producers recovered (74.9%)
--   956 wines gained identity resolution
--   total resolved: 108 / 1385  ->  1064 / 1385
--
-- The remaining 321 keep an empty producer. That is the designed outcome, not a
-- failure: they are wines whose producer is not in LWIN, or is spelled
-- differently from it ('Bérêche & Fils' vs the catalog's 'Bereche et Fils').
--
-- REVERSIBILITY
--
-- Every write is recorded in public.producer_backfill_audit with the prior
-- value, so the down migration restores exactly the rows this touched and
-- nothing else. This is data repair on user-visible records; it does not get to
-- be one-way.

-------------------------------------------------------------------------------
-- 1. The audit trail, written before the repair depends on it
-------------------------------------------------------------------------------

create table if not exists public.producer_backfill_audit (
  id             uuid primary key default gen_random_uuid(),
  wine_id        uuid not null references public.wines(id) on delete cascade,
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  old_producer   text not null,
  new_producer   text not null,
  matched_words  int  not null,
  migration      text not null default '0137',
  created_at     timestamptz not null default now()
);

create index if not exists producer_backfill_audit_wine_id_idx
  on public.producer_backfill_audit (wine_id);

-- Operator-facing only. RLS on with no policy means `authenticated` reaches
-- nothing; service_role bypasses RLS and is how the down migration reads it.
alter table public.producer_backfill_audit enable row level security;

comment on table public.producer_backfill_audit is
  'Prior producer values overwritten by 0137''s LWIN prefix backfill. Exists so '
  'the repair is reversible: 0137''s down restores from these rows. Not '
  'reachable by authenticated — RLS is on with no policy, deliberately.';

-------------------------------------------------------------------------------
-- 2. The repair
-------------------------------------------------------------------------------

do $$
declare
  v_repaired int;
  v_resolved int;
begin
  -- Known producers, minus the generic single words that are also catalog
  -- entries. `length > 2` drops noise like 'Ch' that would prefix-match far too
  -- much.
  create temp table _p0137_prods on commit drop as
    select lower(unaccent(producer)) as pnorm, min(producer) as producer
    from public.lwin_catalog
    where producer is not null
      and length(producer) > 2
      and lower(unaccent(producer)) not in (
        'chateau','domaine','weingut','tenuta','castello','bodegas','cantina',
        'maison','clos','quinta','azienda','agricola','vigneti','cave','caves',
        'les','the'
      )
    group by 1;
  create index on _p0137_prods (pnorm);
  analyze _p0137_prods;

  create temp table _p0137_blank on commit drop as
    select id, restaurant_id, producer, lower(unaccent(name)) as nnorm
    from public.wines
    where btrim(coalesce(producer, '')) = '';

  -- Candidate prefixes: the first k words of the name, k = 1..6. Producers
  -- longer than six words do not occur in lwin_catalog.
  create temp table _p0137_cand on commit drop as
    select b.id, k, array_to_string((string_to_array(b.nnorm, ' '))[1:k], ' ') as prefix
    from _p0137_blank b, generate_series(1, 6) k;
  create index on _p0137_cand (prefix);
  analyze _p0137_cand;

  -- Longest prefix wins: 'Benjamin Leroux' beats 'Benjamin'.
  create temp table _p0137_fix on commit drop as
    select b.id, b.restaurant_id, b.producer as old_producer,
           m.producer as new_producer, m.k as matched_words
    from _p0137_blank b
    join lateral (
      select p.producer, c.k
      from _p0137_cand c
      join _p0137_prods p on p.pnorm = c.prefix
      where c.id = b.id
      order by c.k desc
      limit 1
    ) m on true;

  insert into public.producer_backfill_audit
    (wine_id, restaurant_id, old_producer, new_producer, matched_words)
  select id, restaurant_id, old_producer, new_producer, matched_words
  from _p0137_fix;

  update public.wines w
     set producer = f.new_producer
    from _p0137_fix f
   where w.id = f.id;

  get diagnostics v_repaired = row_count;

  -- Now that the producers exist, the spine can resolve them. This is the
  -- repair function 0135 introduced; it is idempotent by design.
  select public.backfill_wine_identity() into v_resolved;

  raise notice '0137: repaired % producer(s), resolved identity for % wine(s)',
    v_repaired, v_resolved;
end;
$$;
