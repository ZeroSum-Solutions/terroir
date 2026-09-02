# Running the investor demo

Written 2026-08-30 on branch `feat/xwines-corpus-and-labels`; revised 2026-09-01 for the unified search box and the two-surface demo.

## Start it

```bash
npx supabase start            # if the stack is not already up
scripts/local/dev-local.sh    # NOT `pnpm dev`
```

Bottle-label scan needs `OPENROUTER_API_KEY` in the shell: since 2026-09-01 every
model call goes through OpenRouter (the direct Anthropic key is no longer read), and
`dev-local.sh` pins the local Supabase stack but does not carry a provider key. On
this machine the shell sources the key from the vault automatically; the script warns
on start if it is missing, and `.env.local` is the fallback place to put it. Without
it `POST /api/scan-bottle` answers a redacted 500 — the dev server logs the real error
to the terminal outside production, so keep the terminal off the big screen while
scanning.

**Do not re-seed before the demo.** The seeded database on this machine was audited
and corrected on 2026-09-01 (cellar sections, scan statuses, guest-menu names). The
re-seed chain at the bottom of this file takes hours and is for a fresh machine.

Then open http://localhost:3000 and hit **`/api/dev-login`** once — it signs in as
`DEV_BYPASS_EMAIL` and drops you in *LOCAL SEED - Osteria Scala*, the venue that
holds the data.

### Two surfaces, one script

The in-depth walk runs **here, on the local stack** — it is the only environment with
the seeded cellar, its 250 label photographs and its corpus links. The deployed app
(`https://terroir-web-production.up.railway.app`) is shown for what it is: the same
code, live, on real data. On production open **DEMO — Osteria Dimostrativa** (42
wines, every one spine-linked, no blank producers), not *My Restaurant*: that tenant
is a real CSV import with 321 blank producers and one photograph, and it is not the
cellar you want on a screen.

The production demo tenant was polished on 2026-09-02 (`scripts/polish-demo-tenant-hosted.ts`,
every write only-where-empty): all 42 wines now carry a colour, every bottle is filed
in a cellar section (Reds – Old World / New World, Whites, Sparkling, Rosé, Dessert &
Fortified), 40 wines have a tasting excerpt, and 22 are linked to the corpus and so
show a picture on their detail page. **Those 22 pictures are `producer` or
`representative` kind, not this wine's own label** — production's corpus holds only
514 label-kind images — and the UI captions them as such. The other 20 wines (Ridge
Monte Bello, Louis Michel Montmains, Montevertine, J.J. Prüm…) have no corpus row for
their cuvée and stay picture-less rather than wear a wrong one. The invoice scan that
had sat in "processing" since May is now a failed row with a stated reason.

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

## The one search box

Every authenticated page has one box, top of the screen: **Search cellar and
catalogue…** (`/` focuses it on pages that have no search of their own). It reads
the cellar first and the two reference catalogues behind it — LWIN (211,498) and
X-Wines (100,646) — and it *parses* what you type rather than pattern-matching it:

| Type | What happens |
|---|---|
| `esporao` | Cellar rows first (with photograph, bottles, bin), then catalogue rows |
| `a crisp white from Portugal` | Country and colour become filters; "crisp" ranks by body; 20 Portuguese whites, all with pictures |
| `2016 douro` | The year is a vintage filter, not four characters of noise |
| `something under $40 for fish` | Price and food are not search dimensions, so the box says so and offers **Ask the companion** above the rows — one tap hands the question across, already asked |
| `hello how are you` | Nothing matched anywhere; the companion is offered |

Scope tabs (**My cellar** / **Cellar + catalogue**) narrow it. A catalogue row opens a
catalogue page (`/catalogue/lwin/…`, `/catalogue/xwines/…`) that says plainly what is
known and what is *unknown, not blank*, with **Add to cellar** where the identity is
trustworthy. This box replaced three separate search surfaces on 2026-08-31 and
2026-09-01 (program plan P1); nothing older is left to demonstrate.

## The wine assistant

The **?** button in the header, on every authenticated page. Type a question:

> a bold red that pairs with beef

It answers from the cellar — 74 matches, best first, each with grape, region,
body, community rating **with its sample size**, price and bottles on hand.
Clicking a result opens that wine.

**The point to make, if anyone asks whether it is an LLM: it is not.** There is
no model in the path. The question is parsed into a whitelisted struct against
closed vocabularies — the corpus's own type/body/pairing/blend values, and the
cellar's own countries, regions and grapes — and every line rendered is a
column read from a row. That is a deliberate reading of decision **D-006b**,
which defers open-ended chat from v1 and forbids ungrounded prose.

Worth demonstrating on purpose, because it is the differentiator:

| Ask | What happens |
|---|---|
| `a malbec from Argentina, $200-400, for meats` | Parses completely and returns Tussock Jumper Malbec 2021, $209.56, 2 on hand |
| `a blend from Argentina, $200-400, for meats` | The PRD's own phrasing. The cellar's one Argentine wine is a 100% varietal, so it answers honestly: nothing in the cellar fits, and five corpus blends are offered **not in your cellar** |
| `an italian red under $60 for lamb` | Red, under $60, lamb — and a banner that it did not understand *italian*. The cellar holds no Italian wine, so the word cannot become a filter; it is the same honesty as Narnia, on a real word |
| `a red that isn't cabernet` | Reds, with the negation reported as not understood rather than silently dropped. Excluding on it is a follow-up; asserting the opposite was the bug (fixed 2026-09-01) |
| `a red from Narnia` | Reds, with a banner: *"I did not understand narnia, so that was left out of this search."* It cannot invent a country |
| `hello how are you` | No results and no list. A query that understood nothing matches nothing |

Dimensions understood: style, body, blend vs single varietal, grape, region,
country, food pairing, price (`under $40`, `$200-400`, `over $100`). When the
cellar holds nothing that fits, it offers corpus wines clearly labelled **not in
your cellar**.

It is not on the print views or the public guest menu — those are not staff
surfaces.

## Scanning

**Show the bottle-label scan** (`/scan` → *Bottle*): it photographs a label, sends it
through OpenRouter to **Gemini 3.7 Flash** (re-pinned 2026-09-02 on a measured eval,
`docs/plans/2026-09-02-bottle-scan-model-eval.md`), and comes back in four to seven
seconds with producer, wine, vintage and a confidence. An unidentifiable photo (0%
confidence, every field flagged, or producer and wine name both flagged) disables
one-tap **Confirm & save** and routes through **Correct details** — worth showing on
purpose with a non-wine photo; verified through the real route on 2026-09-02. Use a
clearly non-wine photo for that beat, not a blurry real label: a mediocre label at
moderate confidence still confirms in one tap, by design. Gemini reads labels well but
says 0.95 even when it is wrong, so do not lean on the percentage as a hedge.

**Invoice scanning works again, everywhere, without Azure** (PR #196, 2026-09-02).
Azure Document Intelligence is still gone (issue #116; the endpoint no longer
resolves), and the pipeline now hands the photo straight to the vision model when
OCR is unavailable — the row records `source: "vision"` and has no raw OCR text. Expect
**5 to 30 seconds** per invoice (the model reads the whole page), and choose the
document before the room:

- `test-invoices/OIP-1998228646.jpg` — an Astor Wines & Spirits till receipt, ten
  lines of Riesling: extracts 9 wines, arithmetic reconciles, lands as *complete*
  (about 19 s locally, 39 s under production's environment).
- `test-invoices/OIP-2427424005.jpg` — a Robert Mondavi wine-club sheet with
  handwritten notes: 9 wines, reconciles, *complete* (about 15 s).
- `test-invoices/OIP-863239403.jpg` — 3 wines, arithmetic does **not** reconcile, so it
  lands in *review* with the reason stated: the honest beat, if you want one.
- The other four fixtures are not wine invoices (a lorem-ipsum receipt, a beer
  receipt) and correctly answer "No wines could be extracted" in three to twelve
  seconds — the model does not invent lines.

A scan that never finishes (a killed request, a deploy mid-scan) no longer spins
forever: the scans page settles any row older than fifteen minutes as *failed —
stalled* (#197). The scan **history** (`/scans`) is safe to show locally:
60 seeded scans plus today's fixture runs, each with a stated reason.

The **reconciliation queue** (`/reconcile-queue`) is real work, not a bug: 318 items
sit unplaced or mismatched, $107k at risk, because the seed leaves stock to place.

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
scripts/local/fix-demo-cellar-sections.mjs   # cellar sections by colour, not round-robin
scripts/local/fix-demo-scan-statuses.mjs    # complete/review, the app's own words
scripts/seed-local-operational.ts --place-inventory
scripts/local/enable-demo-login.mjs     # confirm the user, join the venue
```
