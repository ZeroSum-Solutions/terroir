#!/usr/bin/env bash
# scripts/local/seed-xwines-ratings.sh
#
# Fill the two rating aggregates that 0131 created and nothing ever wrote.
#
# 0131 shipped `xwines_catalog.rating_avg` / `.rating_count` and the
# `xwines_vintage_ratings` table, and its own comment names the numbers they
# are meant to hold: aggregates over the distribution's 21,013,536 individual
# ratings, at one row per (wine, vintage). The raw ratings are deliberately NOT
# imported — 21M rows would dwarf every other table in the schema and nothing
# in the product reads one stranger's score. Only the aggregates land.
#
# Until they do, the wine detail page renders nothing where it means to show a
# community rating (wine-detail-view.tsx:145) and drops the compare-vintages
# table entirely (:254, gated on `vintageRatings.length > 1`).
#
# Why this is a shell script when its sibling seeder is an .mjs: the vintage
# grain is ~1M rows. Through supabase-js that is ~2,000 PostgREST round trips;
# through COPY it is one. The aggregation itself is a single streaming awk pass
# over 1.07 GB, which never holds more than the group table in memory.
#
# Usage:
#   scripts/local/seed-xwines-ratings.sh <XWines_Full_21M_ratings.csv>
#   scripts/local/seed-xwines-ratings.sh <csv> --confirm   # actually write
#
set -euo pipefail

cd "$(dirname "$0")/../.."

CSV="${1:-}"
CONFIRM=""
for a in "$@"; do [ "$a" = "--confirm" ] && CONFIRM=1; done

if [ -z "$CSV" ] || [ ! -f "$CSV" ]; then
  echo "usage: seed-xwines-ratings.sh <XWines_Full_21M_ratings.csv> [--confirm]" >&2
  exit 1
fi

# Same gate every local-only mutating script runs first: this must be THIS
# repo's loopback stack, never a hosted project and never a neighbour's.
source scripts/local/assert-local-db.sh

DB_URL="${LOCAL_SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:57322/postgres}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
AGG="$WORK/vintage-aggregates.tsv"
WINE_AGG="$WORK/wine-aggregates.tsv"

# ---------------------------------------------------------------- aggregate
# RatingID,UserID,WineID,Vintage,Rating,Date — no quoted fields in this
# distribution (verified: zero double-quotes in 21M rows), so a plain comma
# split is safe and an RFC-4180 reader would only cost time.
#
# TWO grains, and they do not cover the same rows.
#
# `xwines_vintage_ratings.vintage` is a NOT NULL integer, so the 442,391
# ratings filed under "N.V." cannot be represented there — and should not be:
# a house's non-vintage cuvée is a different bottling from its 2015, not a row
# to fold into one. Dropping them leaves 1,006,211 groups, which with the 2,382
# N.V. groups is exactly the 1,008,593 that 0131's comment names.
#
# `xwines_catalog.rating_avg` has NO vintage grain — it answers "what do people
# think of this wine". For a Champagne or a cava the N.V. bottling IS the wine,
# so excluding those ratings there would leave the category's most-rated wines
# showing nothing. The wine-level average is therefore taken over EVERY rating,
# N.V. included, rather than rolled up from the vintage table.
echo "aggregating $(basename "$CSV") ..."
awk -F, -v OFS='\t' -v vout="$AGG" -v wout="$WINE_AGG" '
  NR == 1 { next }
  $5 !~ /^[0-9.]+$/ { malformed++; next }
  {
    wn[$3]++; ws[$3] += $5            # every rating, N.V. included
    if ($4 ~ /^[0-9]{4}$/) {
      k = $3 OFS $4
      n[k]++; s[k] += $5
    } else nv++
  }
  END {
    for (k in n) print k, n[k], s[k] / n[k] > vout
    for (w in wn) print w, wn[w], ws[w] / wn[w] > wout
    printf("ratings read:            %d\n", NR - 1 - malformed) > "/dev/stderr"
    printf("  of which non-vintage:  %d (wine-level only)\n", nv) > "/dev/stderr"
    printf("malformed ratings:       %d\n", malformed) > "/dev/stderr"
    printf("(wine,vintage) groups:   %d\n", length(n)) > "/dev/stderr"
    printf("wines rated:             %d\n", length(wn)) > "/dev/stderr"
  }
' "$CSV"

echo "target: $DB_URL"
if [ -z "$CONFIRM" ]; then
  echo
  echo "DRY RUN — pass --confirm to write."
  exit 0
fi

# ------------------------------------------------------------------- load
# The two staging tables are temp and dropped on commit: they exist only to
# turn each aggregate into one COPY plus one set-based write, inside a single
# transaction that either lands both grains or neither.
psql "$DB_URL" -v ON_ERROR_STOP=1 <<SQL
begin;

create temp table _xw_vintage_agg (
  wine_id      integer not null,
  vintage      integer not null,
  rating_count integer not null,
  rating_avg   numeric not null
) on commit drop;

create temp table _xw_wine_agg (
  wine_id      integer not null,
  rating_count integer not null,
  rating_avg   numeric not null
) on commit drop;

\\copy _xw_vintage_agg from '$AGG' with (format text)
\\copy _xw_wine_agg from '$WINE_AGG' with (format text)

-- Both joins against xwines_catalog are load-bearing, not defensive:
-- xwines_vintage_ratings has an FK to it, and the ratings file covers wines
-- the 100K wine CSV does not.
insert into public.xwines_vintage_ratings (wine_id, vintage, rating_avg, rating_count)
select a.wine_id, a.vintage, round(a.rating_avg, 3), a.rating_count
from _xw_vintage_agg a
join public.xwines_catalog c on c.wine_id = a.wine_id
where a.rating_count > 0
  and a.rating_avg between 1 and 5
on conflict (wine_id, vintage) do update
  set rating_avg = excluded.rating_avg,
      rating_count = excluded.rating_count;

update public.xwines_catalog c
set rating_avg = round(a.rating_avg, 3),
    rating_count = a.rating_count
from _xw_wine_agg a
where a.wine_id = c.wine_id
  and a.rating_count > 0
  and a.rating_avg between 1 and 5;

commit;

\\echo '--- result ---'
select count(*) as vintage_rows from public.xwines_vintage_ratings;
select count(*) as catalog_rows, count(rating_avg) as with_rating from public.xwines_catalog;
select round(avg(rating_avg), 3) as mean_rating, max(rating_count) as most_rated
from public.xwines_catalog where rating_avg is not null;
SQL
