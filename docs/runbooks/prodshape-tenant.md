# The production-shaped local tenant

`LOCAL PRODSHAPE - Trattoria Bianca` is a second local tenant that holds
**production's ratios** instead of the demo tenant's. Use it whenever a QA pass,
a screenshot, or a "does this work" claim is about how the app behaves on real
data rather than on a fixture built to look good.

## Why it exists

`scripts/seed-local-supabase.mjs` builds `LOCAL SEED - Osteria Scala`. That
tenant is the best case for producer completeness and identity links, but the
reproducible seed does not include direct wine photos or the optional X-Wines
corpus load. A QA session that only drives the demo tenant is still blind to the
defects that appear at production's missing-data ratios.

| axis | `LOCAL SEED - Osteria Scala` | production (2026-08-30) | `LOCAL PRODSHAPE - Trattoria Bianca` |
|---|---|---|---|
| wines | 250 | 1,385 | 400 |
| with `hero_image_url` | 0 (0%) | 1 (0.07%) | 1 (0.25%) |
| blank `producer` | 0 (0%) | 321 (23.2%) | 93 (23.2%) |
| spine-linked (`wine_variant_id`) | 250 (100%) | 1,064 (76.8%) | 307 (76.8%) |
| corpus images reachable on a fresh reproducible stack | 0 | 0 | 0 |

The counts are deliberately not production's; the **ratios** are. 400 wines is
enough to page, sort, filter and scroll through by hand.

Blank-producer rows carry production's exact damage shape: `producer = ''` with
the producer run into the front of `name` and no delimiter — `Juniper Vale Rioja
Gran Reserva` — which is why they resolve to no spine link (identity resolution
is producer-first). See AGENTS.md § "two identity systems".

## Ids

| | |
|---|---|
| restaurant | `de200000-0000-4000-8000-000000000001` |
| name | `LOCAL PRODSHAPE - Trattoria Bianca` |
| wines | `de200001-0000-4000-8000-0000000000NN`, NN = 1..400 |
| the one wine with a photograph | `de200001-0000-4000-8000-000000000137` |
| members | the base seeder's `owner+local@`, `manager+local@`, `staff+local@terroir.test` |

Every id is stable, so cleanup is exact and re-running never duplicates a row.

## Create, refresh, delete

`scripts/local/prodshape.sh` pins the LOCAL stack from `supabase status` — it
never reads `.env.local`, which holds production credentials (AGENTS.md
non-negotiable #1) — and refuses a non-loopback target.

```bash
scripts/local/prodshape.sh                       # dry run, prints the plan
scripts/local/prodshape.sh --confirm             # create or refresh (idempotent)
scripts/local/prodshape.sh --check               # re-run the corpus-miss gate only
scripts/local/prodshape.sh --teardown --confirm  # remove it completely
```

**Run `pnpm supabase:seed:local:apply` first on a fresh stack.** The fixture
attaches to the base seeder's three users rather than creating its own, because
`handle_new_user()` auto-provisions a restaurant for every new auth user and that
stray tenant is precisely what makes "most recent membership" lookups
non-deterministic.

Teardown removes the restaurant (everything tenant-scoped cascades), both storage
prefixes, and the identity-spine rows the fixture created — but only the
`canonical_wines` rows nothing else still points at, because that table is shared
across tenants by design. Verified: after `--teardown --confirm` the database
returns to exactly its pre-fixture counts.

## Switching a session into it, and back

The app already owns both halves of this. `PUT /api/restaurant/{id}` checks
membership and then writes the signed, HttpOnly `active_restaurant_id` cookie
itself (`src/lib/api/active-restaurant.ts`), and
`src/lib/api/resolve-active-membership.ts` reads that cookie ahead of its
most-recent-membership fallback. **Do not hand-forge the cookie** — a second copy
of the HMAC is a fixture that keeps working after the app's own signing changes,
which is a fixture that has stopped testing the app.

**In a Playwright spec** — `e2e/prodshape.ts`. `page.request` shares the browser
context's cookie jar, so the cookie the route sets is the cookie the next
`page.goto` sends.

```ts
import { enterProdShape, leaveProdShape } from "./prodshape";

await page.request.get("/api/dev-login");
await enterProdShape(page);   // now in LOCAL PRODSHAPE - Trattoria Bianca
await page.goto("/cellar");
await leaveProdShape(page);   // back in LOCAL SEED - Osteria Scala
```

**In a browser you are already signed into**, from the devtools console:

```js
await fetch("/api/restaurant/de200000-0000-4000-8000-000000000001", { method: "PUT" });
location.reload();
// back:
await fetch("/api/restaurant/de100000-0000-4000-8000-000000000001", { method: "PUT" });
```

**From a shell**, with a cookie jar:

```bash
mkdir -p .tmp
curl -s -c jar -b jar -L -o .tmp/prodshape-login.html http://127.0.0.1:3000/api/dev-login
curl -s -X PUT -b jar -c jar http://127.0.0.1:3000/api/restaurant/de200000-0000-4000-8000-000000000001
curl -s -b jar http://127.0.0.1:3000/cellar | grep -o "LOCAL PRODSHAPE - Trattoria Bianca" | head -1
```

## The default membership does not move

`resolveActiveMembership` falls back to the **most recently created** membership,
and a dozen e2e specs re-implement that same `created_at DESC limit 1` lookup for
themselves. A new membership that became the newest would therefore break the
whole suite silently.

The fixture's memberships are written with a fixed, deliberately old `created_at`
of **2026-01-05**, older than anything the base seeder writes (it takes the
`now()` default). Three things hold that in place:

- the seeder refuses to report success unless the owner's newest membership is
  still the demo tenant's (`assertDemoTenantStillDefault`);
- `e2e/prodshape-tenant.test.ts` asserts a cookie-less session still lands in the
  demo tenant, and that the switch enters the fixture and leaves it again;
- a session that never calls the switch route is unaffected either way.

## What this cannot reproduce, and why

**Production's `xwines_catalog` is empty (0 rows). This checkout's holds
100,646, and the table has no tenant column** — one table, one state. The local
corpus must not be deleted; other suites read it.

So the fixture reproduces the *rendered outcome* of an empty corpus instead:
every producer and cuvée in it is invented and **verified** to reach nothing in
the catalogue, so every corpus lookup made *for one of these wines* takes the miss
path — byte-for-byte what an empty catalogue returns. That check is
`scripts/local/prodshape-corpus-miss-check.mjs`, and the seeder runs it as a gate
before it writes anything:

- no leading-word prefix of any blank-producer name is exactly an X-Wines winery
  (the `recoverProducerFromName` query — this is what would otherwise hand these
  wines a picture);
- no producer clears `XWINES_PRODUCER_FLOOR` (0.80) against the corpus.

Both floors are checked at every prefix length, including the one-word prefixes
the app's own `IMAGE_ACCEPT` two-word floor would reject anyway: a fixture that
stays a miss only because a downstream floor caught it is one floor change away
from silently growing pictures production cannot have. Six candidate producers
were rejected by this gate and replaced — see `prodshape-identities.mjs`.

**What that leaves genuinely unreproduced:**

1. **Corpus reads that are not scoped to a tenant wine.** `/api/assistant`'s
   corpus lane (`src/app/api/assistant/route.ts`) queries `xwines_catalog`
   directly with no tenant filter when the cellar has no match. In production
   that lane returns nothing; here it returns real wines. The assistant's
   empty-corpus behaviour is therefore **not** covered by this fixture and needs a
   different technique (a transaction-scoped truncate, or a stub) if it matters.
2. **Production's scale.** 400 wines, not 1,385; 520 inventory rows. Pagination,
   query cost and scroll behaviour at production volume are not exercised.
3. **Real-world producer spellings.** Production's blank-producer rows are real
   houses — `Bérêche & Fils`, `Benjamin Leroux`. Using real names here would have
   matched the local corpus and destroyed the empty-corpus property, so the
   fixture uses invented ones. Accents and an apostrophe are carried in the
   *cuvée* instead, so normalization, sorting and truncation still see non-ASCII
   text; but a bug that only fires on a specific real producer string will not
   show up here.
4. **`producer_backfill_audit` history.** Migration `0137`'s repair rows exist in
   production and not here (this checkout: 0 rows). The fixture models `0137`'s
   *outcome* — 23% of wines left with an empty producer — not its audit trail.
5. **`lwin_catalog`.** Locally seeded with 211,517 rows. Not manipulated by this
   fixture.

## What a photograph-less wine actually renders

Measured at 390px, 2026-08-30, on `de200001-…-000000000010` (`Kingfisher Estate
/ Ribera del Duero Classico`, no `hero_image_url`, spine-linked, no corpus
entry):

- **No `<img>` element is emitted at all.** The hero slot renders a bottle-shaped
  card holding a circular monogram of the producer's initials ("KE") in the
  wine's own colour. No broken image, no empty box, no layout shift; document
  overflow at 390px is 0.
- Below it: producer eyebrow, name, vintage, `Spain · Castilla y León ·
  Tempranillo`, on-hand count.
- A grey notice: *"No reference entry matched Kingfisher Estate closely enough to
  trust, so taste structure, grapes and pairings aren't shown for this bottle."*
- "Facts about the wine" holds producer / grapes / region / bottle only. No
  tasting note, no drink window, no rating — all of which the demo tenant has for
  every wine.

On a **blank-producer** wine (`…-000000000009`, `Juniper Vale Rioja Gran
Reserva`) the same page degrades further: the monogram falls back to the first
letters of `name` and renders grey (no `colour`), there is no producer eyebrow,
and "Facts about the wine" contains a single row — `Bottle 750 ml`.

**Defect found while building this:** that notice interpolates the producer
unguarded — `wine-detail-view.tsx:456`, `No reference entry matched {`${producer}
`}closely enough…`. With `producer = ''` it renders *"No reference entry matched
closely enough to trust"*, a broken sentence, on **every one of production's 321
blank-producer wines**.
