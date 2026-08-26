# Spike 4 — Corpus join rates (X-Wines, WineSensed)

Date: 2026-08-25 · Status: **RUN, verdict below** · Feeds SPEC-04 / SPEC-16, and forces one
correction to synthesis D2.4 + Gate-0 eval design (VWP-FR-016 / SPEC-06).

**Question:** can X-Wines (community ratings) and WineSensed (phone photos) attach to
Terroir's identity spine? The spine's name key today is the LWIN catalog
(211,498 rows, production, read-only export).

**Method:** normalized both sides (NFKD accent-strip, lowercase, punctuation→space,
stop-token removal for `domaine/chateau/winery/...`), then measured three tiers: full-name
exact, producer reachability, and cuvée token-overlap (Jaccard ≥ 0.6) within a matched
producer. Script: `~/projects/terroir-data/join_analysis.py`. These are **conservative
floors** — production uses pg_trgm similarity, which scores higher than exact/Jaccard.

## Result 1 — X-Wines → LWIN

| Tier | Wines matched (of 100,646) | Rate |
|---|---|---|
| Full-name exact match | 6,293 | **6.3%** |
| Producer reachable in LWIN | 47,614 | **47.3%** |
| Producer + cuvée (Jaccard ≥ 0.6) | 15,912 | **15.8%** |

LWIN side: 210,133 distinct normalized names across 37,238 distinct producers.

**Reading it.** Name-based joining of X-Wines to our spine is weak. ~47% is the realistic
ceiling for producer-anchored trigram matching (you cannot match a cuvée whose producer
isn't in LWIN at all), and ~16% is the floor for automated cuvée-level attachment. The gap
between 6.3% and 15.8% is exactly the space where fuzzy matching earns its keep; the gap
between 15.8% and 47.3% is what better cuvée matching could win.

**Why the misses look the way they do.** X-Wines is consumer-review breadth (France 24.2%,
Italy 19.2%, US 13.1%, then Spain/Portugal/Germany/Australia/Chile/Argentina/South
Africa/Brazil), while LWIN is trade/investment-grade coverage. Sampled misses were
New-World and mass-market bottlings (Casa Perini, Castellamare, Monte Paschoal); sampled
hits were producers LWIN happens to carry. The two corpora are aimed at different halves
of the wine world, so a low global join rate is structural, not a bug.

**Consequence:** this measurement does NOT predict coverage on the partner cellar, and the
partner cellar is what matters. A restaurant list skews toward exactly the trade wines LWIN
covers well, so partner-side join rate is plausibly much higher than 15.8%. **The
decision-relevant rerun is partner-CSV → X-Wines, which is blocked on the partner CSV.**
Until then, no community-ratings coverage number may be promised in the demo (VWP-FR-022's
"critic score pending" honesty rule already covers the display side).

## Result 2 — WineSensed → anything: **not name-joinable at all**

`images_reviews_attributes.csv` (1,014,630 rows, 996,808 unique image refs) carries
columns `vintage_id, image, review, experiment_id, year, winery_id, wine_alcohol, country,
region, price, rating, grape` — but **no wine name and no winery name anywhere**, only
opaque numeric Vivino-internal IDs. In the image-bearing rows sampled, every metadata
column except `vintage_id` and `image` was empty.

**Join rate by name: 0%, structurally.** There is no crosswalk from `vintage_id` to LWIN,
canonical wines, or editions without an external Vivino mapping we do not have and will not
scrape.

### Plan correction (D2.4 / VWP-FR-016 / SPEC-06)

Synthesis D2.4 scopes WineSensed as "**evaluation benchmark** + hard negatives ONLY." The
"evaluation benchmark" half is **not achievable as written**: a labeled top-1/top-3
accuracy benchmark requires knowing which edition each photo depicts, and these photos
cannot be mapped to our editions. WineSensed can therefore serve only as:

- **out-of-corpus / hard-negative material** — unlabeled photos that must produce ABSTAIN.
  This is genuinely valuable: VWP-FR-016 requires separating in-corpus from out-of-corpus
  false-accepts, and this is a large, realistic, phone-photo source of out-of-corpus queries.
- **domain-gap reference** for spike 7 (phone-photo vs. packshot appearance).

It cannot supply the labeled accuracy denominator. **That denominator must come from our
own partner-cellar photo set** (photograph the room's bottles, label them by the editions we
resolved) — which is what Gate 0's frozen benchmark already specifies. Net effect: no new
work, but the eval doc must stop calling WineSensed a benchmark and call it what it is.

## Result 3 — X-Wines label images (manifest question, closed)

X-Wines Full publishes **no label images**: the wines CSV has no image column and no Full
image archive exists; the author's hashing file states "Labels on demand." Only the Slim
tier ships images (1,007). Bulk X-Wines imagery requires contacting the author. Irrelevant
to the frozen demo index; a real limit on the post-demo breadth layer.

## Verdict

- **X-Wines: KEEP as a post-demo breadth/community layer, coverage unproven for our use.**
  Global name-join to LWIN is 6.3%/15.8%/47.3% by tier. Do not quote community-ratings
  coverage until the partner-CSV rerun.
- **WineSensed: KEEP, but re-scoped** to hard negatives / out-of-corpus abstention material
  and domain-gap reference. Remove "benchmark" framing from the eval spec.
- **Neither dataset changes the frozen demo index** (synthesis D2.3 stands).

## Reproduce

```
cd ~/projects/terroir-data && python3 join_analysis.py
```
Inputs: `lwin_catalog.csv` (211,498 rows, read-only export from production),
`xwines/XWines_Full_100K_wines.csv` (MD5-verified), `winesensed/images_reviews_attributes.csv`.
