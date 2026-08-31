#!/usr/bin/env bash
# scripts/local/relink-demo-identities.sh
#
# Finish what seed-xwines-labels.mjs started: move the IDENTITY layer onto the
# real wines, not just the cellar rows.
#
# That seeder re-pointed all 250 local demo wines at real X-Wines bottlings and
# gave each one a real label photograph. It updated `wines` — and `wines` alone.
# Two triggers decided what followed, and they disagreed:
#
#   wines_derive_lineage           BEFORE INSERT OR UPDATE OF (lwin_id,
#                                  producer, name, lineage_id)  -> DID fire.
#   wines_derive_canonical_wine_id BEFORE INSERT OR UPDATE OF (wine_variant_id)
#                                  -> did NOT fire; the seeder never wrote that
#                                  column.
#
# So lineages were re-derived correctly (which is why there are 500 of them:
# 250 live ones on the real names, plus 250 now-orphaned rows still carrying
# "aster house / burgundy pinot noir lot 001"), while `canonical_wines` kept
# the invented seed identities wholesale.
#
# The visible cost is on the wine detail page. resolveXWinesProfile()
# (src/lib/wine-intelligence/xwines-profile.ts:299) prefers a trusted
# `canonical_wines.xwines_wine_id` link and falls back to a live trigram match
# only when there is none. Every one of the 250 was on the fallback path,
# re-deriving by fuzzy match a fact we already knew exactly — and presenting it
# as provenance "matched" with a similarity score rather than "linked".
#
# We do not have to re-match anything to fix it. The seeder recorded which
# X-Wines wine each cellar wine became, in the image path it wrote:
# `.../wine-images/xwines/<wine_id>.jpeg`. All 250 recover from that, all 250
# are distinct, all 250 exist in xwines_catalog, and all 250 already agree with
# their catalog row on both winery and wine name — so this is a lookup, not a
# match, and it cannot silently attach the wrong bottle.
#
# identity_status is deliberately NOT promoted. Its check constraint offers
# lwin_verified (requires an lwin7, which we are not setting) and
# operator_confirmed (means a human confirmed this, and a seed script is not a
# human). The X-Wines link is its own column and says its own thing.
#
# Usage:
#   scripts/local/relink-demo-identities.sh
#   scripts/local/relink-demo-identities.sh --confirm
#
set -euo pipefail
cd "$(dirname "$0")/../.."

CONFIRM=""
for a in "$@"; do [ "$a" = "--confirm" ] && CONFIRM=1; done

source scripts/local/assert-local-db.sh
DB_URL="${LOCAL_SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:57322/postgres}"

# X-Wines' six types are exactly Terroir's six colours (same map as the
# labels seeder — kept in sync by hand because SQL and JS cannot share it).
read -r -d '' RESOLVED <<'SQL' || true
with resolved as (
  select w.id            as wine_id,
         w.wine_variant_id,
         v.canonical_wine_id,
         c.wine_id        as xw_id,
         c.winery_name,
         c.name           as cuvee,
         c.region_name,
         c.country,
         case c.type
           when 'Red'          then 'red'
           when 'White'        then 'white'
           when 'Sparkling'    then 'sparkling'
           when 'Rosé'         then 'rose'
           when 'Dessert'      then 'dessert'
           when 'Dessert/Port' then 'fortified'
         end              as colour,
         w.vintage
  from public.wines w
  join public.wine_variants v on v.id = w.wine_variant_id
  join public.xwines_catalog c
    on c.wine_id = (regexp_match(w.hero_image_url, 'xwines/(\d+)\.jpeg$'))[1]::int
)
SQL

if [ -z "$CONFIRM" ]; then
  psql "$DB_URL" -v ON_ERROR_STOP=1 <<SQL
\pset pager off
$RESOLVED
select count(*) as resolvable,
       count(*) filter (where cw.xwines_wine_id is not null)     as already_linked,
       count(*) filter (where cw.producer is distinct from r.winery_name
                           or cw.cuvee    is distinct from r.cuvee)  as identity_stale
from resolved r join public.canonical_wines cw on cw.id = r.canonical_wine_id;

select (select count(*) from public.wine_lineages l
        where not exists (select 1 from public.wines w where w.lineage_id = l.id))
       as orphaned_lineages;
SQL
  echo
  echo "DRY RUN — pass --confirm to write."
  exit 0
fi

psql "$DB_URL" -v ON_ERROR_STOP=1 <<SQL
\pset pager off
begin;

$RESOLVED
, updated as (
  update public.canonical_wines cw
  set producer       = r.winery_name,
      cuvee          = r.cuvee,
      colour         = coalesce(r.colour, cw.colour),
      region         = r.region_name,
      country        = r.country,
      xwines_wine_id = r.xw_id,
      updated_at     = now()
  from resolved r
  where cw.id = r.canonical_wine_id
  returning cw.id
)
select count(*) as canonical_rows_relinked from updated;

-- An alias is "the raw string an import used for this wine". Every alias here
-- still spells the invented name, which now exists nowhere else in the
-- database — so an operator searching the cellar by an alias would get a hit
-- on a wine whose every other field disagrees with it.
$RESOLVED
update public.wine_aliases a
set raw_producer = r.winery_name,
    raw_cuvee    = r.cuvee
from resolved r
where a.canonical_wine_id = r.canonical_wine_id;

-- wine_variants carries the vintage, and the seeder moved each wine onto a
-- vintage the real bottling actually had. The variant kept the old one.
$RESOLVED
update public.wine_variants v
set vintage    = r.vintage,
    updated_at = now()
from resolved r
where v.id = r.wine_variant_id
  and v.vintage is distinct from r.vintage;

-- The 250 lineages stranded when wines_derive_lineage re-derived on the new
-- names. Nothing references them (wines.lineage_id is ON DELETE SET NULL and
-- none of these are pointed at); left alone they are 250 rows of invented
-- producers sitting in a table the cellar searches.
delete from public.wine_lineages l
where not exists (select 1 from public.wines w where w.lineage_id = l.id);

commit;

\echo '--- result ---'
select count(*) as wines,
       count(cw.xwines_wine_id) as linked_to_corpus,
       count(*) filter (where cw.producer = w.producer and cw.cuvee = w.name) as identity_agrees
from public.wines w
join public.wine_variants v  on v.id = w.wine_variant_id
join public.canonical_wines cw on cw.id = v.canonical_wine_id;

select count(*) as lineages_remaining from public.wine_lineages;
SQL
