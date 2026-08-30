# Running the investor demo

Written 2026-08-30, on branch `feat/xwines-corpus-and-labels`.

## Start it

```bash
npx supabase start            # if the stack is not already up
scripts/local/dev-local.sh    # NOT `pnpm dev`
```

Then open http://localhost:3000 and hit **`/api/dev-login`** once — it signs in as
`DEV_BYPASS_EMAIL` and drops you in *LOCAL SEED - Osteria Scala*, the venue that
holds the data.

## Why not `pnpm dev`

Because the dotenv file this repo uses holds **production** credentials — a hosted
project URL and a production service-role key. `AGENTS.md` non-negotiable #1 says so
outright. Next resolves that file, so a plain `pnpm dev` gives you:

- a development build, with development's relaxed guards,
- holding a key that bypasses RLS on live tenant data,
- and `/api/dev-login` still enabled, because it gates on `NODE_ENV === "production"`
  and that is false here.

Nothing in the terminal distinguishes the two. Both print a localhost URL and an
"Environments" line. The only signal is the data that comes back — which is why
`/api/health` mattering is not a footnote: it used to build its probe with
`node:https` unconditionally, so a **correct local server reported unhealthy while a
production-pointed one reported fine.** That is fixed; a healthy local server now
answers `{"status":"ok","db":"connected"}`.

`scripts/local/dev-local.sh` reads the local keys from `supabase status` and runs the
same loopback guard every other local-only script here runs, before it serves.

## What is in the demo database

| | |
|---|---|
| Wines in the cellar | 250, all real bottlings, each with a distinct label photograph |
| Reference corpus | 100,646 wines, every one with a rating and a picture |
| Ratings | 1,006,211 per-(wine, vintage) rows, aggregated from 21,013,536 |
| LWIN catalog | 211,498 reference wines |
| Storage | 14,031 images in the public `wine-images` bucket |

Every one of the 250 resolves to the corpus through a trusted
`canonical_wines.xwines_wine_id` link, so the detail page shows grape, body, acidity,
food pairings, community rating and a per-vintage rating history without doing any
fuzzy matching live.

**A good page to land on:** the cellar's most-rated wine — Esporão Reserva Tinto,
4.21/5 from 9,662 ratings, Alicante Bouschet, pairs with beef.

## What the imagery actually claims

`xwines_catalog.image_kind` is a closed vocabulary, and the distinction is load-bearing
if anyone asks:

- **`label`** (1,429) — this wine's own label.
- **`producer`** (8,542) — a real bottle from this producer, a different cuvée.
- **`representative`** (90,675) — a real wine bottle of the same type and country,
  unrelated producer. Says nothing about this wine beyond "red, French", and the UI
  captions it as such.

Sources: X-Wines (CC0-1.0), Open Food Facts (contributor photos, CC-BY-SA-3.0),
Wikimedia Commons (per-file). `image_credit` records what each source **stated**. That
is provenance, **not a licence clearance** — fine for a demo, needs real diligence
before anything ships.

## Things that are deliberately not perfect

- **~22% of the cellar is past its drinking window.** About 5% is chosen, so
  `/insights` has real work to surface. The other ~17% is structural: the corpus's
  vintage lists stop around 2021, and a rosé with a three-year window whose newest
  vintage is 2020 is past in 2026 from every vintage its producer made. Forcing those
  in would mean inventing vintages.
- **Almost nothing reads as "young"** for the same reason.
- **No critic scores anywhere.** `rating_source`'s vocabulary is mostly real critics,
  and filling one in would have minted a Wine Advocate score for Château Mouton
  Rothschild that Wine Advocate never gave — on a screen an investor can check. The
  community average is shown instead, in its own units, with its sample size.
- **`wines.lwin_id` is still the synthetic `LOCAL…` value.** Only 30 of 250 match real
  LWIN above 0.9, and a wrong LWIN id on a real wine is worse than an obviously fake
  one.
- **Reverting a completed import batch really does delete its inventory items** — real
  product behaviour (0109), not a seeding artefact. Recover with
  `scripts/seed-local-supabase.mjs --confirm`.

## Re-seeding from scratch

In order; each script is dry-run by default and takes `--confirm`:

```
scripts/seed-local-supabase.mjs         # restaurant, wines, inventory, lists
scripts/local/seed-xwines-labels.mjs    # corpus + label photographs
scripts/local/seed-xwines-ratings.sh    # 21M ratings -> aggregates
scripts/local/seed-lwin-catalog.sh      # LWIN reference catalog
scripts/local/harvest-wine-imagery.mjs  # network fetch (slow, cached)
scripts/local/seed-catalog-imagery.mjs  # upload + attach, resumable
scripts/local/relink-demo-identities.sh # identity layer -> real wines
scripts/local/seed-demo-drink-windows.mjs
scripts/local/seed-demo-tasting-notes.mjs
scripts/local/fix-demo-wine-lists.mjs
scripts/seed-local-operational.ts --place-inventory
scripts/local/enable-demo-login.mjs     # confirm the user, join the venue
```
