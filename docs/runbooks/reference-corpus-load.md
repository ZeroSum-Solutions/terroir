# Loading the reference corpus into a hosted environment

`xwines_catalog`, `xwines_vintage_ratings` and the imagery on those rows are
**data loads, not migrations**. Nothing in CI, and nothing in a merge, puts them
there. Migrations 0131-0141 build the table, indexes, matcher and grants; they
create an empty table and stop.

This runbook exists because that distinction cost a lot. Production ran for
months with `lwin_catalog` at 211,498 rows and `xwines_catalog` at **0** — so
every wine page fell through the corpus read and rendered a grey placeholder,
and no test could see it, because the local stack has all 100,646 rows. The
question "why are there no wine images in production?" was asked nine times
before anyone checked the row count on the hosted database.

**If wine images or taste facts are missing in a hosted environment, count the
rows before reading any code:**

```sh
# READ-ONLY. Answers the question in one call.
node -e 'import("@supabase/supabase-js").then(async ({createClient})=>{
  const {config}=await import("dotenv"); config({path:".env.local"});
  const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  for (const t of ["xwines_catalog","xwines_vintage_ratings","lwin_catalog"]) {
    const {count}=await db.from(t).select("*",{count:"exact",head:true});
    console.log(t, count);
  }})'
```

## 1. The catalogue and ratings (CC0-1.0)

Source files are the X-Wines Full distribution, unmodified. They are not in the
repo — 34MB and 1.07GB. On this machine they live in
`~/projects/terroir-data/xwines/`.

```sh
# Dry run first. Parses, aggregates 21M ratings, prints a preview, writes nothing.
npx tsx scripts/seed-xwines.ts \
  ~/projects/terroir-data/xwines/XWines_Full_100K_wines.csv \
  ~/projects/terroir-data/xwines/XWines_Full_21M_ratings.csv

# Then, deliberately:
ALLOW_PROD_SEED=yes npx tsx scripts/seed-xwines.ts <wines.csv> <ratings.csv> --confirm
```

Expect `100,646` catalog rows and `1,006,211` (wine, vintage) rating rows. The
ratings pass streams 21,013,536 source rows and takes several minutes.

## 2. The photography

```sh
# Harvest to .wine-imagery/ (network only, no DB). Re-reads its cache if present.
node scripts/local/harvest-wine-imagery.mjs

node scripts/seed-catalog-imagery-hosted.mjs                     # dry run
ALLOW_PROD_SEED=yes node scripts/seed-catalog-imagery-hosted.mjs --confirm
```

Writes `image_url`/`image_kind`/`image_source`/`image_credit` per 0138. Rows are
updated, never upserted — a PostgREST upsert builds a full INSERT tuple before
`ON CONFLICT` fires and dies on every NOT NULL column the row already has. Ids
are chunked at 100 because `.in()` travels in the URL.

Only `label` and `producer` kinds are written. `representative` — a real bottle
of the same type and country from an unrelated producer — is deliberately NOT
written by this script; see the decision note below.

## What this actually buys, measured on production 2026-08-31

1,385 wines, before any of the above: **1** had a photograph, **0** had a taste
fact.

| | after |
|---|---|
| shows real facts (grapes, body, acidity, pairings, rating) | 455 (32.9%) |
| shows a photograph | 82 (5.9%) |

The gap between those two numbers is **image supply, not matching**. Open Food
Facts holds 14,045 photographed wines, overwhelmingly European supermarket
bottles; only 3,751 of its brands reach a corpus winery at the producer floor.
There is no open, commercially-licensed corpus of wine label photography — the
one large Vivino-derived set (WineSensed, 897K images) is CC BY-NC-ND 4.0, and
both the NC and the ND clause forbid this use.

Three levers remain, and all three are product decisions rather than bugs:

1. **Write `representative` images too.** Takes photographs from 82 to ~455 —
   every wine that resolves to the corpus. Each is a real bottle, captioned by
   `CORPUS_IMAGE_NOTE` as "Representative bottle — not this wine's label". It is
   honest and it is not the reader's wine.
2. **`cipher982/wine-images-126k`** — 107,821 retailer bottle photos, CC-BY-4.0
   self-declared, but the uploader states they do not hold rights to the
   underlying photography. A chain-of-title question, not a technical one.
3. **Photograph bottles in the app.** Already works, 100% correct, manual.

## Related: LWIN can fill metadata the corpus cannot

1,032 of the 1,385 wines carry an `lwin_id`, and `lwin_catalog` holds producer,
region, country and varietal. Measured on the same run, LWIN could fill
**region and country for 985 wines (71.1%)** and producer for 149 (10.8%) — well
above the corpus's 32.9%, and by identity rather than by fuzzy match. Nothing
reads it for that purpose today.
