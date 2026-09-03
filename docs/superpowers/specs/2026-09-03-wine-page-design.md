# Wine page — design

**Date:** 2026-09-03 · **Status:** approved, pending implementation plan
**Origin:** move 5 of `docs/plans/2026-09-02-competitor-audit-adoption-plan.md` §3, with move 3
folded in as a block on the page.

## 0. Goal

Rebuild `/cellar/[wineId]` so a single wine *reads* the way the reference product's wine page
reads — a taste block with real mention counts, a house score beside a reference score, a
drinking window rendered against the cellar, operational badges, and a vintage rail — and reuse
the same blocks in condensed form on the bottle-scan result card.

The quality bar is Vivino's wine page, captured in `docs/plans/competitor-audit-2026-09-02/vivino.md`
§14–15 and the app screenshots in that directory's `assets/`. The difference in kind: Vivino's
taste block is mined from millions of strangers; Terroir's is mined from one house's notes, where
a mention count is an operational fact about this restaurant rather than a popularity signal.

**Non-goals.** Search-result density (search takes badges and score only). The wine-list scan
overlay. Multi-venue rollups. Anything in the audit's "do not copy" lists.

## 1. What exists today (verified 2026-09-03, not assumed)

- `wine-detail-view.tsx` is 16.5 KB and already renders taste axes, food pairing, facts, a
  tasting note, compare-vintages and in-your-cellar. `page.tsx` runs one narrow server query
  with an explicit column list, deliberately, to avoid the `/cellar` fan-out.
- **No tasting-notes table exists anywhere in the schema.** House note text today is one column,
  `wines.tasting_notes`, plus free-text `pour_events.note`.
- `wines.review_excerpt`, `rating`, `drink_window_start` and `drink_window_end` are produced by
  the Claude enrichment prompt in `src/lib/wine-intelligence/enrich-claude.ts` — verbatim,
  *"≤200 char tasting-note style sentence describing the wine's expected character at peak"* —
  and stored with `rating_source = 'claude_inference'`. No URL, no citation. They render on the
  page today looking like sourced fact.
- `wines.manual_overrides text[]` exists (migration 0048) with `drink_window` a documented
  category; `enrich_wines_batch` skips any field listed there. **The house-override mechanism
  this design needs already exists.**
- `DrinkWindowTimeline` exists and renders on `/cellar` and `/insights`. The detail page queries
  `drink_window_start/end` and then never renders them.
- `cellar_config` carries per-tenant `health_dead_stock_days`, `low_stock_threshold`,
  `health_cash_trap_floor`, `health_appreciation_threshold`.
- Identity spine: `canonical_wines` is **global** (`created_by_restaurant_id` records who created
  it, not who owns it); `wine_variants` carries `restaurant_id` and holds `vintage`.
- `xwines_catalog` and `lwin_catalog` carry **zero** `restaurant_id` — the settled precedent for
  global reference data in this repo.
- `inventory_items`: `wine_id`, `quantity`, `unit_cost`, `bin_id`, `bin_location`, `section`.
  `wine_list_items`: `wine_id`, `bottle_price`, `glass_price`, `hidden`, `is_available`.
- The bottle-scan match endpoint is `POST /api/scan-bottle`; `matched-view.tsx` is a client
  component rendering a facts card plus Correct/Confirm.
- **29 non-test files read the drink-window columns**, including `cellar-health/classify.ts`,
  `cellar-health/recompute.ts`, `drink-window/alerts.ts`, `drink-window/status.ts`,
  `cellar-facets/query-filter.ts` and `cellar-facets/sort.ts`. All handle null cleanly —
  `getDrinkWindowStatus` returns `"unknown"` and `classify` treats a null window as no
  window-risk — so removing values degrades those features rather than breaking them.

## 2. Decisions, with their reasons

| # | Decision | Reason |
|---|---|---|
| D1 | The house tasting-note store is in scope, not deferred | The taste block's whole point is aggregation over house notes. There is nothing to aggregate without it, and a mention count over an empty corpus is not a smaller version of the feature — it is a different, dishonest one. |
| D2 | A note is a standalone object on a wine, not an extension of `pour_events` | A somm tasting at a supplier lunch writes a note with no bottle open. `pour_events` is high-volume telemetry and should not carry prose. |
| D3 | Chips are the stored, counted truth; a model pre-selects them from prose; the author confirms | Exact counts and exact drill-through, without making the writer do the tagging twice. Matches the audit's "confirm inferences instead of begging" doctrine. |
| D4 | Reference notes come from producer/importer tech sheets, retailer listings (score + attribution + link only), and the existing X-Wines corpus | These are publishable or already licensed. Vinous is contract-gated and Vivino/Delectable are ToS-restricted for bulk ingestion; the schema is built so licensed data drops in later. |
| D5 | The house score is the mean of per-note scores, always rendered with its `n` | It has to be on a comparable scale for a side-by-side to mean anything. Operational signals stay out of the number — that is what the badges are for. |
| D6 | The drinking window is sourced where a source states one, with a house override that wins | This is the "whose drinking window" contract from move 4, and `manual_overrides` already implements the override half. |
| D7 | The `claude_inference` values are deleted, not relabelled | A page whose selling point is trustworthiness cannot carry fabricated numbers, and a label does not fix that. The `drink_window_basis` column in §4.7 is transitional infrastructure that makes the deletion safe and reversible — it is not the label this decision rejects. See §4.7 for the measured blast radius. |
| D8 | Three composable resolvers, never a projected dossier | One resolver becomes a 700-line god function against a 400-line ratchet, and the obvious patch — a projection option for the scan card — makes fields sometimes-absent and destroys the guarantee the design exists for. |
| D9 | Two phases, one spec | Notes store and ingestion land first and accumulate real data; the page is rebuilt on data that already works. |
| D11 | Only `confirmed` descriptors are counted; `inferred` never leaves the composer | An untouched model inference is a vote, not a mention. Counting it reintroduces the fabricated signal D7 exists to remove, and a two-tier count is a number nobody can read. |
| D12 | `wine_reference_notes` is keyed on vintage, and vintage is not nullable | A vintage-less row attaches a 2015 retailer score to a 2019 bottle, globally, with a URL beside it — worse than an unsourced guess, because the UI claims a source. |
| D13 | Retirement is a flagged worker job, not a migration; and the enrichment writer is stopped first | `batch.ts:234` selects on `drink_window_start is null`, so nulling without stopping the writer re-queues every retired wine for re-invention. |
| D14 | Mis-binned is dropped | Its two clauses were different things OR'd together: a wine in more than one bin is normal, and `bin_location` drifting from `bins.code` is a data-quality matter, not a wine-page warning. |
| D15 | The house side carries **no** structural axes. Body and acidity come from the corpus; tannin and sweetness are not shown at all | Amended 2026-09-03, after Task 11 found this spec contradicting itself: §4.2 promised "the four structural axes" from a `wine_notes` schema §3.2 defines with no structural columns and a vocabulary that is aroma-and-flavour only. Nobody was ever asked for structure, so there is nothing to aggregate and nothing to backfill. Adding four optional 1–5 fields to the composer was considered and rejected: against a floor of n ≥ 3, optional inputs on a capture path with zero organic notes and 41 structureless legacy rows aggregate to n = 0 on every axis, so it ships the same empty block while adding a rating surface purely to make a type non-empty — D7's manufactured signal wearing a schema. X-Wines already supplies body and acidity with a real basis; tannin and sweetness exist in neither source and are therefore not promised. |
| D10 | No per-aroma-family colour. The claret-derived rating ramp only | See §5.6 — the family palette is the exact zone `check-design-palette.mjs` bans, and DESIGN.md forbids a fifth hue. This is a documented departure from the adoption plan's §2.1 item 4. |

## 3. Phase 1 — a working tasting log

Phase 1 has to be a product on its own, not a waiting room for phase 2. A restaurant with no
shared tasting record gets one: attributed, scored, searchable, visible on the page the day it
ships. The aggregate block is what phase 2 adds on top.

Migration **0148**, additive only.

### 3.1 Split the detail view first

`wine-detail-view.tsx` is 16.5 KB. Bolting a composer, a chip picker and a note list onto it trips
the 400-line file-size ratchet *before* phase 2's split, so the split is the first slice of phase
1, not the first slice of phase 2. `pnpm check:file-size:update` after.

### 3.2 `wine_notes` — the house corpus

`id`, `restaurant_id`, `wine_id → wines(id) on delete cascade`, `author_user_id`, `body text`,
`score smallint null` (100-point), `tasted_on date null`, `created_at`, `updated_at`.

RLS follows the **0136 pattern, not membership alone**: every policy requires the row's `wine_id`
to belong to the row's own `restaurant_id`. `wine_id` cascades, and a membership-only policy is
precisely the gap 0136 had to close. DELETE is restricted to the note's author or an owner.

**One capture path.** `wines.tasting_notes` is migrated into `wine_notes` as an authored-unknown
seed row and the field is retired from the composer, so the house does not end up with two places
to write a note. `pour_events.note` stays where it is — it is service telemetry, not a tasting
note, and D2 is the reason.

### 3.3 `descriptors` and `wine_note_descriptors`

`descriptors` is a global controlled vocabulary: `slug` pk, `label`, `family`, `sort`, seeded by
migration following the `reason_codes` / `seed_reason_codes` precedent. `family` groups chips in
the UI and carries no colour (D10).

`wine_note_descriptors`: `(note_id, descriptor_slug)` pk — the unique constraint matters, because
promotion is an `UPDATE` of `origin` and an insert-based promotion would double-count — plus
`origin` in `('confirmed','inferred')`.

**Only `confirmed` descriptors are ever counted.** The model's extraction lands as `inferred` and
lives *only* as a pre-selection in the composer; the author's tap promotes it. An untouched
inference is a model's vote, not a mention, and putting it in the tally would reintroduce exactly
the fabricated-signal problem D7 exists to remove. A count is therefore one honest number —
*"12 notes mention oak"* — not a two-tier slogan a reader has to parse.

### 3.4 `wine_reference_notes`

Global — **no `restaurant_id`, no tenant INSERT policy.** Service-role written, member-read-only,
matching `lwin_catalog` and `xwines_catalog`.

`canonical_wine_id → canonical_wines`, `vintage int not null`, `source_kind` in
`('producer','importer','retailer')`, `source_name`, `source_url`, `fetched_at`, `body text null`,
`score numeric null`, `score_scale`, `drink_window_start/end int null`.

**`vintage` is not nullable, and it is part of the natural key.** Producer sheets, importer books
and retailer scores are all vintage-specific; a vintage-less row would attach a 2015 retailer
score to a 2019 bottle, globally, for every tenant — with a URL next to it. That is worse than an
unsourced guess, because the UI would be claiming a source for it. Vintage is resolved from
`wine_variants` at enqueue time.

`corpus` is **not** a `source_kind`. X-Wines is already in the database; reading it is a resolver,
not a fetch job.

### 3.5 Ingestion — not in phase 1

The scrape does not run in phase 1. An idle table filled by O(10³)×3 headless fetches on the
single shared worker, before any resolver can display a row of it, is unattended risk with no
product value. It is a phase 2 slice, and when it runs:

- `idempotency_key = canonical_wine_id + vintage + source_kind`.
- A rate-limited queue separate from interactive jobs, so `background_jobs` consumers are not
  starved behind a crawl.
- crawl4ai first per the operator's local-first rule; its wrapper already detects bot-challenge
  and interstitial pages and fails loudly, which is what keeps a Cloudflare challenge page from
  being persisted as a producer's tasting note.
- Retailer listings contribute score, attribution and link only — never reproduced critic prose.
- Identity gates the fetch: a wine whose producer is empty (321 of them survive migration 0137)
  is skipped rather than matched to the wrong producer's tech sheet.

### 3.6 What phase 1 ships to the page

The composer (prose, chips grouped by family, optional score, tasted-on), the note list with
author and date, and each note's own confirmed chips and score rendered against it. No aggregate,
no axes, no dual score — those need a corpus that does not exist yet, which is the entire point of
shipping this first.

### 3.7 Stop writing the invented values

In the same phase, the Claude tier stops emitting `review_excerpt`, `rating` and `drink_window_*`.
This is a precondition for §4.7 and not an afterthought: `src/lib/wine-intelligence/batch.ts:234`
selects wines with

```
.or("drink_window_start.is.null,serving_temp_min.is.null")
```

so nulling those columns would make every retired wine the *primary target* of the next enrichment
run and regenerate precisely what was deleted. Retirement without this change is not merely a
no-op — it re-queues 1,277 wines for re-invention. The selection predicate moves to
`drink_window_basis is null` (§4.7) so a deliberately retired wine is not mistaken for an
un-enriched one.

## 4. Phase 2 — resolvers, blocks, surfaces

### 4.1 Provenance as a type

There is deliberately **no `estimate` basis**: values without a source are removed rather than
labelled (D7).

```ts
type Basis =
  | { kind: "house";    notes: number }                                  // confirmed only
  | { kind: "sourced";  name: string; url: string; asOf: string }
  | { kind: "corpus";   name: string }                                   // X-Wines
  | { kind: "override"; by: string; at: string }
  | { kind: "measured"; asOf: string };                                  // the house's own records

type Sourced<T> = { value: T; basis: Basis };
type Score      = { n: number; scale: 100 | 5 };
```

Every display component accepts `Sourced<T>` and renders its honesty label from the field's own
basis. `Score` carries its scale because X-Wines is a 1–5 average and critics are on 100; a dual
score that silently compares 4.2 with 92 is worse than no dual score.

`{ kind: "override" }` needs an author and a timestamp, and `wines.manual_overrides text[]` cannot
supply either. Migration 0148 adds `drink_window_set_by uuid null` and `drink_window_set_at
timestamptz null` alongside it. Without them the one window worth trusting most — the house's own
— would be the only one that could not say whose it is.

### 4.2 Three composable resolvers

Each returns a **complete** object. No projections, no optional-field variants: the unit of
composition is a whole resolver, never a subset of one.

| Resolver | Returns |
|---|---|
| `resolveHouseProfile(restaurantId, wineId)` | confirmed descriptor counts, house score with its n, the notes themselves (see D15 — the house side carries no structural axes) |
| `resolveReferenceProfile(canonicalWineId, vintage)` | reference notes, reference score, **the resolved drink window and its basis**, corpus structure from X-Wines |
| `resolveCellarContext(restaurantId, wineId)` | inventory, lots, bins, list membership, movement |

**The drink window lives in `resolveReferenceProfile`, not in cellar context**, because its value
and its basis both come from the sourced/override side. Anything that needs Drink-now — including
the scan card — awaits that resolver. A cellar resolver that quietly reached for reference data to
compute a badge would make the composable split a fiction.

### 4.3 Blocks

Each is its own component file.

| Block | Consumes |
|---|---|
| `TasteBlock` | `Sourced<HouseTaste>`, `Sourced<CorpusStructure>` |
| `ScorePair` | two `Sourced<Score>` |
| `DrinkWindowBlock` | `Sourced<DrinkWindow>` — wraps the existing `DrinkWindowTimeline` |
| `OperationalBadges` | `Sourced<Badge[]>` |
| `VintageRail` | `Sourced<VintageRow[]>` |

**One floor, n ≥ 3, for the house aggregate.** Below it the block renders per-note chips
attributed to their notes, which is honest, and the aggregate appears only when there is an
aggregate.

**Structure is corpus-sourced, never house-aggregated (D15).** The block's two halves have two
different origins and say so: confirmed descriptors and the house score come from `HouseTaste`,
while body and acidity come from `CorpusStructure` with the corpus's own wording. Nothing is drawn
faintly — a faint axis reads as data rather than absence.

### 4.4 The badges — five, not six

| Badge | Rule |
|---|---|
| Drink now | `getDrinkWindowStatus(start, end) === "drink_now"` — the existing helper in `src/lib/drink-window/status.ts`, which already means *within two years of the window closing*, not merely inside it. Fires only when the window's basis is `sourced` or `override`. Computed from `resolveReferenceProfile`. |
| Last bottle | one sellable unit left: lots of the selling format only, open-bottle remainder excluded, zero-quantity lots ignored |
| Slow mover | no depletion since receipt — `pour_events` of a depleting `kind` only (waste, tasting and adjustments do not clear it), measured from the wine's last put-away rather than a sliding window, against `cellar_config.health_dead_stock_days` |
| Below cost | the **published** `bottle_price` (hidden, unavailable and glass-only rows excluded; null or zero price skipped) against a named cost basis — weighted average `unit_cost` across non-zero lots, stated in the badge's rule text |
| Off-list | has sellable inventory and appears on no list row that is visible and available |
| ~~Mis-binned~~ | **dropped.** Its two clauses were different things OR'd together: a wine in more than one bin is normal (well plus reserve), and `bin_location` disagreeing with `bins.code` is denormalised-field drift, not misplacement. Split storage is informational, not a warning, and the drift check belongs in a data-quality sweep, not on a wine page. |

Five badges, each with a rule a buyer can predict. Reusing `getDrinkWindowStatus` also keeps the
badge, the cellar chip and the insights alert from drifting apart — the helper's own docstring
says that is why it exists.

### 4.5 Surfaces

- **Detail page** — all blocks, three resolvers in parallel.
- **Scan result card** (`matched-view.tsx`) — badges, score pair, top confirmed chips, drink-now
  state. It awaits house + reference + cellar; the condensed result rides in the existing
  `POST /api/scan-bottle` response, resolved server-side in the same request that identifies the
  wine, so the latency-critical path gains **no extra round trip**.
- **Search results** — badges and score only.

### 4.6 Design tokens

One new ramp: **rating → warmth**, derived from the house claret `#96122A`, added to `DESIGN.md`
and gated by `pnpm check:design`.

**No per-aroma-family colour** (D10). `scripts/check-design-palette.mjs` reads every colour literal
in `src/` and judges them in HSL, banning any warm hue (15–60°) at `L < 0.72` as brown and at
`L ≥ 0.80` as cream — which is exactly where oak, spice, earth and honey live. DESIGN.md separately
states there is no fifth hue beyond the four wine states and *"there must not be one."* Eight or
nine family hues is a new palette, not a re-derivation. Chips take the achromatic "at peak"
treatment and family is carried by grouping and label. Recorded as a deliberate departure from the
adoption plan's §2.1 item 4.

### 4.7 Retiring the invented values

**Not a migration.** A migration that nulls columns the running product reads is the wrong
instrument here, for two reasons: production migrations are applied by hand, out of step with the
deploy, and a rollback after application would leave old code reading nulls it never expected.

Instead: migration 0148 adds `drink_window_basis text null` — `'sourced' | 'override' | 'inferred'`
— and backfills it to `'inferred'` wherever `rating_source = 'claude_inference'`, and to
`'override'` wherever `manual_overrides` contains `drink_window`. Purely additive, safe against old
code, and it is what lets the enrichment selector in §3.7 tell a retired wine from an un-enriched
one.

The retirement itself is a **worker job behind a flag**, run only after every reader is deployed,
writing every prior value to `wine_inference_retirement_audit` — the reversible shape
`producer_backfill_audit` established.

**Two independent predicates, not one.** The draft nulled rating, excerpt and window together
under a single window-override condition, which would have preserved a fabricated rating on any
wine whose window a human had set, and would equally have risked smashing a human window to remove
a fabricated rating. They retire separately:

- `review_excerpt`, `rating`, `rating_source` retire wherever `rating_source = 'claude_inference'`.
- `drink_window_start/end` retire wherever `drink_window_basis = 'inferred'`, never where it is
  `'override'` or `'sourced'`.

**The blast radius reaches four surfaces beyond this page, and is measured before it is applied.**
29 non-test files read these columns. None break — `getDrinkWindowStatus` returns `"unknown"` and
`classify` treats a null window as no window-risk — but several go quiet:

| Surface | Effect |
|---|---|
| `cellar-health/classify.ts`, `recompute.ts` | wines lose `window_risk` and fall to other rules |
| `drink-window/alerts.ts`, `/insights` briefing | alerts stop firing for affected wines |
| `cellar-facets/query-filter.ts`, `sort.ts` | the drink-window filter returns fewer wines; sort order shifts |
| gallery card, row chips, list editor | window chips disappear |

That is the correct outcome — the product currently tells staff to drink bottles on the strength of
a number nobody sourced, and a false alert is worse than a quiet one. But it is a visible change to
four surfaces, so the retirement slice **reports a before/after count** of wines changing health
class and alerts going silent, run against a local restore, before the flag is turned on in
production.

## 5. Testing

TDD throughout, per the repo's standing rule.

- **Provenance.** Each display component gets a test asserting the honesty label renders for every
  `Basis` kind it can receive. The type stops a bare number reaching a component; these tests stop
  a component receiving `Sourced<T>` and rendering only `.value`.
- **Badges.** One test per badge per boundary condition named in §4.4 — newly received stock does
  not read as a slow mover, an unpriced list row does not read as below cost, a hidden list row
  does not decide either badge, a wine in two bins raises nothing.
- **RLS.** A live-DB containment suite for `wine_notes` following
  `src/domains/cellar/wine-ownership-write-policies.test.ts`. Live-DB only, because the boundary
  being tested is RLS itself.
- **Counting.** `inferred` descriptors never appear in a count, under any path, including after a
  promotion and a demotion.
- **Retirement.** The before/after report is itself a test fixture: run against a restore, assert
  the counts, assert every audit row round-trips.

## 6. Migration and deploy ordering

`AGENTS.md` §7: merging deploys, migrations are applied by hand afterwards, and every migration
must be safe against a database the old code is still talking to.

1. **0148 — additive only.** Tables, `drink_window_basis`, `drink_window_set_by/at`. Safe under old
   code, which ignores all of it.
2. **Phase 1 code.** File split, composer, note list, `tasting_notes` seed migration, Claude tier
   stops writing the three fields, enrichment selector moves to `drink_window_basis is null`.
3. **Phase 1 runs.** Notes accumulate. Nothing is deleted, nothing is displayed that was not there.
4. **Phase 2 code.** Resolvers, blocks, both surfaces, DESIGN.md ramp. Every block already tolerates
   an absent value, because that is the state most wines are in.
5. **Reference ingestion** enabled, rate-limited, off the interactive queue.
6. **Retirement flag** turned on last, after the before/after report, with the audit table written.

The ordering error to avoid is running step 6 before step 2: nulling the columns while the
enrichment selector still keys on `drink_window_start is null` re-queues every retired wine for
re-invention.

## 7. Adversarial audit record

Reviewed twice by Grok via OpenRouter, cast as an adversarial principal engineer and told
explicitly it was not there to validate the design. **The reviewer is an evidence input, not an
authority** — every finding was adjudicated against the Terroir source, and the ones contradicted
by it are recorded as rejected.

- **Round 1** (`x-ai/grok-4.20`, 2026-09-03): REJECT. Upheld — the single resolver becomes a god
  function against the 400-line ratchet; the scan card pays for data it does not render, and a
  projection option would destroy the guarantee; the combined scope is a big-bang. Rejected with
  evidence — "tenant-scope the reference notes", contradicted by `lwin_catalog`, `xwines_catalog`
  and `canonical_wines` all carrying no tenancy column; "provenance is solvable with code review
  plus a wrapper", which is the approach that already put an unlabelled `claude_inference` sentence
  on the page.
- **Round 2** (`x-ai/grok-4.6`, 2026-09-03): REJECT. Upheld and folded in above — the enrichment
  selector would refill every retired value (verified at `batch.ts:234`); retirement-as-migration
  is the wrong instrument; the single retirement predicate would preserve fabricated ratings on
  human-overridden wines; `manual_overrides` cannot populate an `override` basis; all six badge
  rules were underspecified or wrong, and Mis-binned was two defects OR'd together; inferred
  descriptors must never enter a tally; the ingestion key must carry vintage; phase 1 tripped the
  ratchet and had no product value on its own. Rejected — its claim that retirement-as-migration is
  *illegal* under the repo's rules overstates it, since merging deploys before the migration is
  applied by hand, so old code is not normally live against the changed data; the instrument still
  changed, for the rollback and hand-application reasons in §4.7.

## 8. Open items for the owner

- The descriptor vocabulary itself — which descriptors, in which families — is a content decision,
  not an engineering one. The seed list needs a pass before 0148 lands.
- Whether `wines.tasting_notes` seed rows should carry an author or stay authored-unknown.
- The before/after retirement report needs a production restore to run against.
