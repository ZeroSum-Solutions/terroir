#!/usr/bin/env bash
# scripts/local/seed-lwin-catalog.sh
#
# Load the full Liv-ex LWIN reference catalog into lwin_catalog (0003).
#
# lwin_catalog shipped with its schema (0003), its matcher (0007, tuned by
# 0078/0127), and every caller that depends on it (match_lwin_bulk for CSV
# import preview, match_lwin_batch for scan/invoice enrichment, the 0137
# producer-backfill migration's own comment naming "211,498 reference
# wines") — but the table itself was never seeded past one manually-inserted
# test row. Every one of those callers has been running against 211,497
# fewer rows than it was designed for.
#
# Why psql \copy + a staging table instead of PostgREST (the .mjs pattern
# used elsewhere in this dir): 211,498 rows / 20MB through supabase-js is
# ~thousands of round trips even batched; \copy is one streaming read plus
# one set-based upsert, in a single transaction.
#
# The source CSV (lwin_id,display_name,producer,region,country,colour,type)
# has no varietal column — lwin_catalog.varietal is left untouched by this
# script, same as the app already treats it (match_lwin's own hasMetadata
# check in enrich/route.ts ORs across region/country/varietal/colour, so a
# null varietal on every row does not break the Tier-3 fallback).
#
# Usage:
#   scripts/local/seed-lwin-catalog.sh <lwin_catalog.csv>
#   scripts/local/seed-lwin-catalog.sh <csv> --confirm   # actually write
#
set -euo pipefail

cd "$(dirname "$0")/../.."

CSV="${1:-}"
CONFIRM=""
for a in "$@"; do [ "$a" = "--confirm" ] && CONFIRM=1; done

if [ -z "$CSV" ] || [ ! -f "$CSV" ]; then
  echo "usage: seed-lwin-catalog.sh <lwin_catalog.csv> [--confirm]" >&2
  exit 1
fi

# Same gate every local-only mutating script runs first: this must be THIS
# repo's loopback stack, never a hosted project and never a neighbour's.
source scripts/local/assert-local-db.sh

DB_URL="${LOCAL_SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:57322/postgres}"

echo "source: $CSV ($(wc -l < "$CSV") lines incl. header)"
echo "target: $DB_URL"
if [ -z "$CONFIRM" ]; then
  echo
  echo "DRY RUN — pass --confirm to write."
  exit 0
fi

# ------------------------------------------------------------------- load
# The staging table is temp and dropped on commit: it exists only to turn
# the CSV into one COPY plus one set-based upsert, inside a transaction that
# either lands the whole catalog or none of it.
#
# Blank strings are normalized to NULL on the way in (nullif(trim(x), '')):
# match_lwin's producer leg is a `%` trigram operator against
# lower(lc.producer), and an empty string there is a false match candidate,
# not a "no producer" signal — NULL is the correct way to say "no producer".
psql "$DB_URL" -v ON_ERROR_STOP=1 <<SQL
begin;

create temp table _lwin_staging (
  lwin_id      text,
  display_name text,
  producer     text,
  region       text,
  country      text,
  colour       text,
  type         text
) on commit drop;

\\copy _lwin_staging from '$CSV' with (format csv, header true)

insert into public.lwin_catalog (lwin_id, display_name, producer, region, country, colour, type)
select
  lwin_id,
  display_name,
  nullif(trim(producer), ''),
  nullif(trim(region), ''),
  nullif(trim(country), ''),
  nullif(trim(colour), ''),
  nullif(trim(type), '')
from _lwin_staging
where nullif(trim(lwin_id), '') is not null
  and nullif(trim(display_name), '') is not null
on conflict (lwin_id) do update
  set display_name = excluded.display_name,
      producer     = excluded.producer,
      region       = excluded.region,
      country      = excluded.country,
      colour       = excluded.colour,
      type         = excluded.type;

\\echo '--- staging vs. landed ---'
select count(*) as staged_rows from _lwin_staging;
select
  count(*) filter (where nullif(trim(lwin_id), '') is null
                     or nullif(trim(display_name), '') is null) as skipped_no_key
from _lwin_staging;

\\echo '--- lwin_catalog after load ---'
select count(*) as total_rows from public.lwin_catalog;
select
  count(producer) as with_producer,
  count(region)   as with_region,
  count(country)  as with_country,
  count(colour)   as with_colour,
  count(type)     as with_type,
  count(varietal) as with_varietal
from public.lwin_catalog;

\\echo '--- sample rows ---'
select lwin_id, display_name, producer, region, country, colour, type
from public.lwin_catalog
order by lwin_id
limit 5;

commit;
SQL
