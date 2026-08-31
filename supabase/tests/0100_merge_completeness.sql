-- P2 wine identity spine — standing merge-completeness contract test.
--
-- This is C23's fix sketch generalized into a permanent guard, per
-- docs/plans/2026-08-23-p2-identity-spine.md §11: introspect pg_constraint
-- for every FK targeting wines/canonical_wines/wine_variants and assert
-- every referencing table's name appears in merge_wines's or
-- merge_canonical_wines's source text. It fails the build the day a
-- future migration adds a referencing table to any of these three
-- identity/inventory tables without teaching one of the merge functions
-- about it — closing C23's hole permanently rather than once.
--
-- Known limitation (see the P2 builder report): this is a table-name
-- substring match, not column-level verification. wine_aliases has TWO
-- FKs relevant here (canonical_wine_id -> canonical_wines, repointed by
-- merge_canonical_wines; wine_variant_id -> wine_variants, NOT repointed
-- by anything in P2 because nothing in P2 populates that column). Because
-- "wine_aliases" already appears in merge_canonical_wines' source for the
-- canonical_wine_id repoint, this test cannot distinguish "the whole
-- table is handled" from "one of its two relevant columns is handled" —
-- it is deliberately the same coarse-grained test the plan itself
-- specifies, not a stronger one.
begin;

select plan(1);

with fk_targets as (
  select
    c.conrelid::regclass::text as child_table,
    c.confrelid::regclass::text as parent_table,
    c.conname
  from pg_constraint c
  where c.contype = 'f'
    and c.confrelid in (
      'public.wines'::regclass,
      'public.canonical_wines'::regclass,
      'public.wine_variants'::regclass
    )
),
merge_source as (
  select string_agg(prosrc, E'\n') as src
  from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname in ('merge_wines', 'merge_canonical_wines')
),
-- Legitimately-excluded constraints go here, one row per (child_table,
-- conname), with a comment explaining why the substring heuristic below
-- would be wrong to require for that specific constraint.
--
-- producer_backfill_audit.wine_id (0137): repointing it at the surviving
-- wine would be a BUG, not the fix this test normally asks for. The row
-- records the producer value that wine X carried before 0137's LWIN
-- backfill overwrote it, and exists so 0137's down can put it back.
-- merge_wines hard-deletes the losing wine (`delete from public.wines
-- where id = p_source_wine_id`), and the FK is ON DELETE CASCADE, so the
-- loser's audit rows go with it — correct, because a pre-backfill
-- producer for a wine that no longer exists is not restorable to
-- anything. Carrying it over to the survivor would make 0137's down
-- write the LOSER's old producer onto a DIFFERENT wine, silently
-- corrupting the survivor's identity. Cascade is the intended behaviour
-- here, so there is nothing for merge_wines to learn.
allowlist (child_table, conname) as (
  values ('producer_backfill_audit'::text, 'producer_backfill_audit_wine_id_fkey'::text)
),
uncovered as (
  select f.child_table, f.parent_table, f.conname
  from fk_targets f, merge_source m
  where not exists (
          select 1 from allowlist a
          where a.child_table = f.child_table and a.conname = f.conname
        )
    and m.src not ilike '%' || regexp_replace(f.child_table, '^public\.', '') || '%'
)
select is(
  (select count(*)::int from uncovered),
  0,
  'every FK-referencing table to wines/canonical_wines/wine_variants is named in merge_wines or merge_canonical_wines source (uncovered: ' ||
    coalesce((select string_agg(child_table || '.' || conname || ' -> ' || parent_table, ', ') from uncovered), 'none') || ')'
);

select * from finish();

rollback;
