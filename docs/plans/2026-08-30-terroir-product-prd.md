# Terroir — Product PRD (from the 2026-08-29 field walk)

**Status:** DECIDED — the six gated items in §6 were answered by delegation on 2026-08-30.
The decisions are recorded in `docs/plans/2026-08-30-field-walk-decisions.md` (D1–D6); §6
below is retained as the statement of each question, annotated with its answer.
**Date:** 2026-08-30
**Source:** `docs/plans/2026-08-29-terroir-refactor-field-notes.md` (field walk, 2026-08-29)
**Baseline commit:** `39afe36` at authoring time. Superseded since: `3b02f3b` (#162, the Tier-1
work §8 describes) and `0bc4c72` (#163) have both landed on `main`.
**Author:** Claude (autonomous overnight run, 2026-08-29 → 08-30)

---

## 0. Read this first

This document converts the 2026-08-29 field-walk notes into specced, sized, sequenced
requirements. It was written to be actioned without further clarification **except** for the
six items in §6, which were genuinely blocked on a product decision only Devin could make.
Devin then delegated those six rather than answer them; they are decided as D1–D6 in
`docs/plans/2026-08-30-field-walk-decisions.md`, and each `### 6.N` below carries a pointer to
its decision.

**What changed while this was being written.** A concurrent session landed six PRs
(#154, #155, #156, #157, #160, #161) between 19:30 and 21:13 on 2026-08-29, including the
Phase 2 monolith decomposition (145 files) and a root-cause fix for one of the logged bugs.
Every "current state" claim below was re-verified against `39afe36`, not against the notes.

**Terminology.** Requirement IDs carry over from the field notes unchanged (`SCAN-06`,
`CELLAR-02`, …) so the two documents stay cross-referenceable. New IDs introduced here are
marked `[new]`.

---

## 1. Product thesis

Terroir is a wine **management, collection, and purchasing** platform for two customers who
share one data model:

- the **individual collector**, who wants to know what they own, what it's worth, and when to
  drink it;
- the **restaurant**, which additionally needs pricing, menus, staff wayfinding, and POS-adjacent
  inventory truth.

The bar Devin set is explicit and is the acceptance standard for every item below:

> "If we were to be the top-of-the-line, the best wine application in the world for management,
> collection, and purchasing, then this type of stuff can't happen."

Three capabilities differentiate Terroir from Vivino (consumer scanning), CellarTracker
(enthusiast ledger), Invintory (concierge 3D), and Binwise/BevSpot (restaurant back-office):

1. **Self-serve photoreal 3D cellar mapping** — no dispatched employee, no abstract mock-up.
2. **One system for both collection and service** — the same bottle record drives the drink
   window, the bin location, the menu price, and the pour.
3. **Conversational access over the whole corpus** — natural language and voice, not filters.

---

## 2. Global rules

These are cross-cutting constraints. They bind every screen and are acceptance criteria for
every UI item in this document.

### GLOBAL-01 — One row of controls, maximum

**Rule.** All tabs, filters, toggles, and actions on a page must fit on **one horizontal row**
within one frame at the target breakpoint. If they do not fit, the answer is fewer controls —
never a second row.

**Rationale (Devin, verbatim):** *"If you cannot fit all the buttons horizontally in one frame,
then there are too many buttons."*

**Current violation of record.** The Cellar page renders four stacked control rows
(`terroir-cellar-list-view.png`). See CELLAR-01.

**Make it mechanical `[new]`.** This repo already enforces design rules in CI with four
scripts (`check-design-palette`, `-contrast`, `-token-sync`, `-typography`) plus a fingerprinted
file-size ratchet that can only shrink. GLOBAL-01 should join them rather than live in a doc
that decays:

- Add `scripts/check-control-rows.mjs` with a per-route baseline of control-row counts.
- Baseline today's counts; the ratchet permits decrease only.
- Wire into `pnpm check:design` and the existing CI gate.

**Acceptance:** the script fails CI when a route's control-row count increases; the Cellar
route's baseline entry reaches `1`.

**Size:** S (script) + per-page work carried by each page's own item.

### GLOBAL-02 — The search bar is exempt, and it is everywhere

- Search is **excluded** from GLOBAL-01 and lives as its own element.
- It sits at the **top** of the page.
- It is present on **every** page.

**Acceptance:** every route under `src/app/(app)/` renders a search input above its control row;
a route-inventory test asserts presence. Search is one of the product's most important surfaces
and is never collapsed into an overflow menu.

**Size:** M

### GLOBAL-03 — Real imagery, not text-only heroes

Text headline + button wall is not an acceptable page head. Hero imagery is what ties a page
together.

**Constraint that outranks this item.** Per the house rule on client-owned identity, visual
direction is not to be invented freehand. Terroir has a committed design contract at
`DESIGN.md` (Nocturne, 60 colours / 16 type scales, CI-enforced). Hero art direction must be
derived from that contract, and any new imagery is an art-direction task with Devin in the
loop — **not** something to generate autonomously.

**Acceptance:** deferred to a design pass. Not implemented autonomously. See §6.5.

**Size:** M–L, design-gated.

### GLOBAL-04 — Wine imagery wherever a wine is named `[new, promoted from notes]`

Any surface naming a wine must be able to show the bottle: cellar rows, bin cards, detail
drawers, list builder, search results.

**Driving scenario (Devin):** an employee is told "this wine is in Bin A5," finds ten different
bottles there, and has no idea which one. *"She's gonna waste time. I should know what it looks
like."*

**Current state — better than the notes assumed.** `wines.hero_image_url` exists in the schema
and PR #150 ("give every wine a picture") landed. This is therefore largely a **display** gap,
not a data gap. Each surface below must actually render it.

**Acceptance:** bin cards, the wine detail drawer, and list rows all render `hero_image_url`
with a typed fallback when null.

**Size:** S per surface.

---

## 3. Already landed — reconciled against `39afe36`

Do not re-implement these.

### BUG-02 — Leading comma / empty producer → **FIXED, and it was far worse than logged**

Logged as a cosmetic *", Benjamin Leroux Vosne-Romanée"*. Root cause, found by the concurrent
session and fixed in migration `0137` (#161): a 2026-08-29 CSV import created **1,277 wines with
`producer = ''`**, with the producer run together with the cuvée in `name`.

The consequence was not cosmetic. Identity resolution is producer-first:
`resolve_wine_variants_bulk` cannot normalise an empty producer, and `match_lwin` weights
producer at 0.6 against a `%` operator an empty string never satisfies. **Production had
resolved 108 of 1,385 wines. The identity spine was installed and inert.**

**Lesson worth keeping:** a rendering artefact in the Lists UI was the visible tip of a
data-integrity failure that had silently disabled the wine identity system. Cosmetic bug reports
from the field walk deserve a root-cause pass, not a CSS fix.

### Phase 2 decomposition — landed (#156)

145 files changed. The files this PRD touches were all decomposed, which makes the work below
*easier*, not harder:

- `wine-detail-drawer.tsx` → plus `wine-detail-drawer-state.ts`, `pricing-section.tsx`,
  `serving-temp-section.tsx`, `decant-time-section.tsx`, `enrich-control.tsx`, …
- `cellar-list.tsx` → `cellar-shell.tsx`, `cellar-row.tsx`, `cellar-grid.tsx`,
  `draggable-wine-row.tsx`, `bin-data.ts`, `taxonomy-group.tsx`
- `wine-list-editor.tsx` → `components/{add-wine-modal,wine-row,template-picker,sortable-section-button}.tsx`

### Other Phase 0 blockers — landed

- `0136` — cross-tenant wine ownership `WITH CHECK` (#154), closing the cascade-delete gap.
- Adapter contract tests (#155), closing the zero-coverage adapter layer.

---

## 4. Tier 1 — Ship now (no decision required)

Small, self-contained, testable, no design approval needed. **These are the items implemented
in tonight's run; see §8 for what actually shipped.**

### LIST-02 — Auto-select the wine's style when adding to a list

**Current behaviour (verified, `add-wine-modal.tsx:60`):** the modal pre-checks
`activeSectionId` — *the section the user was already viewing*, regardless of the wine.

This is precisely how a red Burgundy ended up filed under **Sparkling** in
`terroir-lists-builder-brandkit.png`: Devin was viewing the Sparkling section when he added
*Benjamin Leroux Vosne-Romanée 2019*. The modal did exactly what it was coded to do, and it was
the wrong thing.

**Required behaviour.** Pre-select the section matching the wine's own style, falling back to
`activeSectionId` only when no section matches.

**The data already exists.** `wines.colour` carries the vocabulary
`red | white | sparkling | rose | dessert | fortified`
(`src/lib/cellar-facets/index.ts:23-35`), which maps 1:1 onto the six sections in the modal
(Sparkling / White / Rosé / Red / Dessert / Fortified). No new column, no inference, no LLM.

**Acceptance:**
- Adding a wine with `colour = 'red'` pre-checks a section named "Red" (case/diacritic
  insensitive; "Rosé" matches `rose`).
- No matching section → falls back to `activeSectionId`, preserving today's behaviour.
- `colour` null → falls back to `activeSectionId`.
- The user can still change the selection; this only changes the *default*.
- Unit test covers all six colours, the null case, and the no-matching-section case.

**Size:** S · **Risk:** low · **Files:** `add-wine-modal.tsx`

### BUG-03 — Section names truncated to uselessness

**Current (verified, `sortable-section-button.tsx:137`):** `<span className="truncate ...">`
inside a fixed-width sidebar renders `Sp… 1`, `W… 1`, `De… 0`. A sidebar whose only job is to
name sections fails to name them.

**Acceptance:** full section names are readable at the default width, or the name is available
without hover (title attribute is a floor, not the fix). No horizontal overflow.

**Size:** S · **Risk:** low

### CELLAR-07 — Detail drawer opens pinned to top instead of at the selection

**Required:** the drawer aligns to the selected row rather than the viewport top, so selecting a
wine 300 rows down does not throw the reader to the top of the panel.

**Acceptance:** opening the drawer from a scrolled position keeps the selected wine's identity
block in view without further scrolling.

**Size:** S–M · **Risk:** low

### CELLAR-08 — Bin cards are dead ends

**Current (verified, `terroir-cellar-bin-view.png`):** selecting bin A5 opens a panel reading
`Bin A5 / 10 bottles` and one unclickable text box.

Devin: *"a little stupid box with a box of text inside of it that gives me no information except
for the name of the wine, which I think is ridiculous."*

**Required:**
1. The bin card is clickable and opens the wine's full detail (the same drawer as list view).
2. The card renders the bottle image (GLOBAL-04) — this is the staff-wayfinding scenario.

**Acceptance:** clicking a bin card opens the detail drawer for that wine; the card shows
`hero_image_url` with a typed fallback.

**Size:** M · **Risk:** low · **Files:** `cellar-grid.tsx`, `bin-data.ts`

### SCAN-04 — Invoices are permanent in the ledger, with an explicit delete

**Required:**
- An invoice that scans incorrectly, returns **zero** items, or is unwanted **stays in the
  ledger and remains viewable**. Entries never silently vanish — that confuses and annoys users.
- An explicit **Delete** action exists on any invoice, chosen by the user.

**Acceptance:** a zero-result scan produces a visible ledger row with a zero-item state and a
reason; deletion is explicit, confirmed, and audited.

**Verified state (2026-08-30):** there is **no delete endpoint for scans or invoices** —
nothing under `src/app/api/scan*` handles `DELETE`, and no client calls one.

**Why this was not implemented autonomously.** The button is the easy half. The real question
is what deletion means for an invoice whose line items were **already applied to inventory**:

- refuse to delete an applied invoice, or
- delete it and revert the stock it added, or
- soft-delete — hide it from the ledger, keep the rows.

The third contradicts Devin's own requirement that entries stay viewable. The second needs to
reuse the import domain's existing revert path (`batch-revert`, per the Phase 3 plan), not
invent a second one. The first is the cheapest and may well be right.

Deleting an invoice that has already moved stock, chosen wrong and unattended, silently
corrupts inventory — the one class of bug this product cannot afford. **Needs Devin's call;
promoted from Tier 1 to a decision gate.**

**Size:** M once decided · **Risk:** medium — inventory correctness.

---

## 5. Tier 2 — Ship next (bounded, needs a design pass)

### CELLAR-01 — Dismantle the Cellar control stack

**Current (verified):** four stacked rows —

1. `ALL 15,004` · `OPEN 10` · `DRINK NOW 19`
2. `Open bottles 10` · search · `Name A–Z` · list/grid toggle · filter icon · `Reconcile 9 open bottles`
3. `Producer` · `Region` · `Filters`
4. `Select wines`

Plus: the control labelled **Filter** actually opens **Cellar Settings** and navigates somewhere
else entirely — mislabelled *and* a context switch.

**Required:** one control row (GLOBAL-01), search lifted out and above (GLOBAL-02), the
mislabelled Filter/Settings control corrected, and real hero treatment (GLOBAL-03).

**Recommended consolidation** (for review, not yet approved): scope pills
(All / Open / Drink now) stay as the primary segment; view toggle stays; Producer, Region, and
the other facets collapse into a **single** filter surface; `Select wines` becomes a mode
entered from that surface; `Reconcile` is a contextual action that appears only when open
bottles exist.

**Size:** L · **Gated on:** design review (§6.5)

### CELLAR-05 / CELLAR-06 — Rebuild the detail drawer's information hierarchy

**Current:** name, vintage, `FULL DETAIL` link, Open/Sealed/Status counts, then a large
**RECORD COMP OR ADJUSTMENT** form dominating the panel, then Preservation method, then stacked
buttons (`86 this wine`, `Re-enrich`, `Edit metadata`, `Open bottle`).

Devin: *"Do we think that the record comp or adjustment is the most important thing to fill up
the largest part of this sidebar? I don't think so."*

**Required:** the wine occupies the primary real estate — **bottle image**, identity, and the
enriched attributes of SCAN-08 (producer, grape, ratings, pairings, acidity, market price).
Comp/adjustment demotes to a secondary action. Buttons obey GLOBAL-01.

**Reference for the target shape** (`vincent-onboard-02-know-every-bottle.png`): cutout bottle ·
blend badge · vintage + name · producer · region · country · **est. value** · **drink window** ·
**avg critic score** · review count · AI summary with audio.

**Size:** L · **Gated on:** design review + SCAN-08 data availability

### LIST-03 / LIST-04 — Pricing suggestions and settings-driven markup

**Current:** GLASS and BOTTLE columns render `—`. No suggestion, no value.

**Required:**
- Pricing data is **always** available on a wine.
- The app **suggests** a glass price and a bottle price as the starting point.
- Adjustment via a **minus / price / plus** stepper, a dollar at a time.
- A markup rule in settings (e.g. *always 6% above purchase*) is **already applied** to the
  suggestion before the user sees it.

**Note:** `wines` already carries `retail_min/median/max`, `retail_retailer_count`,
`pricing_target_markup_ratio`, and `pricing_target_pour_cost_pct`, and a `pricing` domain
exists. This is closer to wiring than to greenfield.

**Size:** M–L

### LIST-05 — Brand kit from a URL

**Current:** `Upload logo` button, swatch strip, `Generate themes`. No URL field, no drop target.
Devin: *"Right now it's not working. That bothers me."*

**Required:** accept a **business URL**, a **logo**, or a **brand kit**, via **drag-and-drop** or
**paste**; generate the kit; the kit drives menu design.

**Note:** the URL path is a scraping task; the house rule is crawl4ai first, Firecrawl only on
bot-wall/paywall, WebFetch terminal. The `branding` format is Firecrawl-only, which is one of
the documented exceptions where Firecrawl is the correct first call.

**Two defects hide here:** the missing URL input, and *"it's not working"* — which may be the
existing logo path failing. Needs a repro pass before it is one ticket or two.

**Size:** M

### SCAN-09 — Search on the Scan page

**Current (verified):** `src/app/(app)/scan/` has no search surface.

Devin: *"That simple search feature is nowhere on this page, which I think is a very large miss."*

**Required:** type any wine → search → get its information → **add to inventory** or **buy**.

**Reference** (`vivino-search-empty-state.png`): ALL WINES / MY WINES scope tabs, recent
searches, and a populated empty state of popular categories (offers, style, country, grape,
region, **food**).

**Size:** M — and it partly falls out of GLOBAL-02.

---

## 6. Decision gates — DECIDED (see `docs/plans/2026-08-30-field-walk-decisions.md`)

I could not responsibly guess these, and each one changes the work materially. Answering the
**six** of them (§6.1–§6.6) unblocked roughly two-thirds of the remaining roadmap.

**They are answered.** Devin delegated all six on 2026-08-30 rather than answer them himself;
the calls, their reasoning, and their reversal cost are recorded as **D1–D6** in
`docs/plans/2026-08-30-field-walk-decisions.md`. That record, not this section, is the decision
authority. Each question below is kept as written and annotated with its **Decided:** pointer.

### 6.1 SCAN-03 — Which migration sources, and what is "Beverly"?

**Decided: D1** — `docs/plans/2026-08-30-field-walk-decisions.md`.

Named in the walk: **Binwise** (usually paired with **Toast**) and something heard as
**"Beverly"**.

> **CORRECTION.** This section originally guessed **BevSpot** (possibly Beverage Analytics).
> That guess was wrong. "Beverly" is **Bevrly** — *Bevrly Inventory Scanner*, a restaurant
> beverage-inventory app built around barcode scanning that "centralizes inventory and
> locations" (<https://apps.apple.com/ca/app/bevrly-inventory-scanner/id6740220524>). The
> evidence was already in this repository: `docs/evals/README.md:3` describes this codebase as
> the **"Bevrly-response build"**. D1 names the preset `bevrly` and keeps a `bevspot` preset
> alongside it, since BevSpot is also a real product in this space.

**Needed:** the confirmed source list, and whether v1 is credentialed API pulls (the Invintory
model — `invintory-cellartracker-import-options.png` shows username/password with per-bucket
checkboxes for Collection / Pending delivery / Wishlist / Reviews / History) or export-file
ingestion.

**Why it blocks:** POS integrations need partner credentials and, in Toast's case, a developer
account. That is a procurement task, not a coding task.

### 6.2 SCAN-07 — How literally do we take Vivino's architecture?

**Decided: D2** — `docs/plans/2026-08-30-field-walk-decisions.md`.

Devin: *"I would like to do maybe a one-to-one comparison with the Vivino app and I would like
for us to probably take that architecture since it does work so well. We can have a fallback of
a language model if needed."*

Two readings, materially different builds:

- **(a) Literal** — visual-match-first: label embeddings against a pre-built corpus, ANN
  retrieval, ~2s p50, LLM only on miss. Fast and cheap per scan; requires a corpus and an
  embedding pipeline.
- **(b) Outcome** — match Vivino's *speed and completeness* by whatever path, LLM-primary with
  aggressive caching.

**Recommendation: (a).** It is what the quoted latency demands, and (b) cannot hit ~2s p50
reliably on a cold LLM call. But this is an architecture commitment and should be Devin's.

### 6.3 SCAN-06 — Corpus coverage is the real recognition gap

**Decided: D3** — `docs/plans/2026-08-30-field-walk-decisions.md`.

The reproducible miss is **Champagne Frédéric Savart "Haute Couture", Le Mesnil/Oger Grand Cru,
2017, Extra-Brut** — a grower champagne whose own label reads **`2030 Bouteilles`** (a
~2,030-bottle cuvée). Scanned twice, not found.

This is very likely **not** a model-quality problem. It is a **corpus** problem: a 2,000-bottle
grower cuvée is absent from most commercial wine databases. Vivino finds the *producer*
(`vivino-wine-detail-savart.png` — a different Savart cuvée, 83 ratings) because Vivino's corpus
is user-generated at consumer scale.

**Two separable gaps, and they need separate decisions:**
1. **Coverage** — which corpus/corpora do we license or build? Grower champagne, small-domaine
   Burgundy, and natural wine are exactly where a collector-grade product cannot afford misses,
   and exactly where commercial catalogues are thinnest.
2. **Fuzzy text matching** — Vivino returns correct results for the *misspelled* query "Fredric
   savart" (`vivino-search-results-fuzzy.png`). Our matching should be typo-tolerant
   independently of image recognition. This half is buildable now.

**Regression fixture:** keep this bottle permanently.
`docs/screenshots/2026-08-29-field-notes/ref-savart-haute-couture-2017-bottle.HEIC`

### 6.4 CELLAR-02 — 3D cellar: what is v1?

**Decided: D4** — `docs/plans/2026-08-30-field-walk-decisions.md`.

The differentiator. User scans their space (camera and/or **LiDAR**), gets a 3D map of cellar /
fridge / bin / racks, and assigns wines to positions.

Competitive read — **Invintory**: dispatches a human to scan, turnaround is slow, and the result
is *"ugly"* — an abstract mock-up that replicates your organisational pattern but does not look
like your space. `vincent-onboard-04-3d-cellar-map.png` shows the genre's current visual
language (stylised dark rack elevation, "Left wall", one bottle highlighted).

Terroir's angle is **self-serve, instant, photoreal**.

**Needed:** is v1 (a) phone LiDAR + photogrammetry producing a true captured mesh, (b) a
guided-capture flow that fits a *parametric* rack model to photos, or (c) a 2D-photo-backed bin
grid — real imagery, no mesh? These differ by roughly an order of magnitude in effort.

**Recommendation: (c) → (b) → (a).** (c) delivers the actual user value Devin described — *know
what the bottle and the space look like* — in weeks rather than quarters, and each step is a
superset of the last. Photorealism is the north star, not necessarily v1.

### 6.5 Design authority for the visual rework

**Decided: D5** — `docs/plans/2026-08-30-field-walk-decisions.md`.

GLOBAL-03, CELLAR-01, and CELLAR-05/06 are visual-design changes to Devin's own product.
`DESIGN.md` (Nocturne) is a committed, CI-enforced contract. Redesigning the Cellar page
autonomously would mean inventing art direction with no brief and no approval, against a house
rule that visual identity is owned, not assumed.

**Needed:** either a brief/reference set, or approval to propose options for review.
**Not done autonomously**, deliberately.

### 6.6 SCAN-04 — what does deleting an applied invoice do?

**Decided: D6** — `docs/plans/2026-08-30-field-walk-decisions.md`.

Promoted here from Tier 1 once the code was actually checked. See §4's SCAN-04 entry: no
delete endpoint exists, and the decision that matters is what happens to inventory an
invoice already added. Refuse / revert / soft-delete — pick one.

---

## 7. Tier 3 — Epics needing their own specs

Each is multi-week and deserves a document of its own. Listed for sequencing, not specced here.

| ID | Epic | Depends on | Rough size |
|---|---|---|---|
| SCAN-05 | Camera-first capture (full-screen camera + draggable bottom sheet, per `vivino-capture-sheet.png`) | design | 2–3 wk |
| SCAN-06/08 | Corpus coverage + deep attributes (producer, grape, ratings, pairings, acidity, market price) | §6.3 | 4–8 wk |
| SCAN-07 | Recognition pipeline re-architecture | §6.2 | 4–6 wk |
| SCAN-10 | NL chatbot over the corpus — *"a good blend from Argentina, $200–400, pairs with meats"* | corpus | 3–4 wk |
| SCAN-11 | Voice agent (tap and talk) | SCAN-10 | 2 wk |
| CELLAR-02 | 3D cellar mapping | §6.4 | 6 wk – 2 qtr |
| LIST-01 | AI list curation ("all wines in perfect drinking window", user then thumbs through candidates) | — | 2 wk |
| SCAN-03 | Migration/transfer flows | §6.1 | 3–5 wk |

**Note on SCAN-10/11 scope.** The reference (`vincent-onboard-03-ai-sommelier.png`) answers from
*the user's own collection* — "what wine **from my collection** should I pair with sushi" — citing
acidity, ABV, and critic score from inventory. Devin's own example is catalogue-shaped (find me a
$200–400 Argentine blend). **Both** are required, and they are different retrieval problems:
one queries inventory, the other queries the world. Worth splitting into two tickets.

---

## 8. What shipped in tonight's autonomous run

**This has since landed.** The branch was squash-merged to `main` as `3b02f3b` (#162) on
2026-08-30; it is no longer awaiting review. The description below is kept as the record of
what that PR contained.

Branch `feat/field-notes-tier-1`, three commits. Every gate green at each commit:
`tsc --noEmit`, `pnpm lint` (0 errors), `pnpm test` (3,032 passing), `check:design`,
`check:file-size`, `verify:feature-ledger`, `verify:api-contract`,
`verify:product-conformance`.

| ID | What changed | Verified by |
|---|---|---|
| LIST-02 | Adding a wine pre-selects the section matching the wine's own `colour` instead of whichever section was open | 23 unit tests, fixture built from `DEFAULT_SECTIONS` |
| CELLAR-08 | Bin cards became buttons onto the detail drawer and now render the bottle image | tsc across the three-file payload boundary; full suite |
| BUG-03 | Section names no longer truncate to `Sp…` / `De…` | reasoning + `title` fallback; **not** visually confirmed |
| CELLAR-07 | Detail drawer anchors to the viewport instead of the document top | reasoning; **not** visually confirmed |

**Net −44 lines** against the file-size baseline: the bin-grid payload type had been
declared three times (page / shell / grid) and the add-wine modal's three wire types
were inline. Both were extracted, which is what made room for the changes above under
a ratchet that only permits shrinkage.

### 8.1 The audit caught three real defects

A GPT-5.6 adversarial review of the first commit found three problems, all confirmed
against the tree before fixing. Recorded because two of them are instructive:

1. **LIST-02 was wrong in a way the field notes were also wrong about.** The notes
   list six sections (Sparkling / White / Rosé / Red / Dessert / Fortified); the code's
   `DEFAULT_SECTIONS` ships **five**, folding two colours into `"Dessert & Fortified"`.
   Exact name matching therefore failed for `dessert` and `fortified` — two of six
   colours, on the default template — and silently fell back to the active section,
   which is the exact bug being fixed. Section names are now read as alternatives split
   on real separators. Substring matching is still refused: `"Red Burgundy"` must not
   swallow every red.
   *This is worth noticing: Devin's screenshot sidebar shows five rows, not six. The
   notes recorded the intent; the code records the truth.*

   Measured against the seeded local database, the stored `colour` values are exactly
   the six expected, lowercase and unaccented, with **no nulls**:
   `red` 126 · `white` 70 · `fortified` 14 · `sparkling` 14 · `dessert` 13 · `rose` 13.
   So the first version would have silently misfiled **27 of 250 wines — 11% of the
   corpus** — while appearing to work for everything else. That is the shape of bug an
   adversarial pass is worth running for.

2. **The BUG-03 fix had a touch regression.** Hiding the row's rename/delete behind
   `opacity-0` and overlaying them reclaims width — but an `opacity-0` button still
   takes taps, and an iPad meets the `md` breakpoint with no hover. Tapping the right
   of a row would have hit an invisible Delete. The actions stay in flow; the width
   comes from the sidebar going 220px → 248px instead.

3. **`src/app/api/cellar/grid/route.ts` is dead code — and broken.** It has no callers
   anywhere in `src` or `e2e`, and it builds the bin payload **unpaginated** while
   `page.tsx` pages it 1,000 rows at a time. Wired up as-is it would silently truncate
   any cellar over 1,000 placed bottles. Left in place and flagged rather than deleted,
   per the standing rule on unrelated dead code. **Someone should decide its fate.**

### 8.2 Not visually confirmed

BUG-03 and CELLAR-07 are CSS-layout changes. Their reasoning is documented and each
mirrors a pattern already correct elsewhere in the same component, but no screen was
available on this run and neither was seen rendered. A local Supabase stack was up but
belonged to the concurrent session's work, and disturbing it unattended was not worth
the risk. **Open a wine after scrolling, and open a list sidebar, before trusting
these two.**

---

## 9. Scope statement — what this run did not do, and why

Devin's instruction was "take care of all the items we logged," running unattended with no
ability to ask questions or get approval. That is not fully achievable, and the honest
accounting matters more than a green checkmark:

1. **The headline items are decision-gated, not effort-gated.** SCAN-03, SCAN-07, CELLAR-02,
   and the design authority question (§6) were flagged as open questions in the field notes
   *the same evening they were written*. Guessing them autonomously would produce work built on
   an invented premise — the most expensive kind to unwind.

2. **Several items are multi-week epics** (§7). No overnight run delivers 3D LiDAR cellar
   mapping or a re-architected recognition pipeline.

3. **A concurrent session was actively merging into this repo** — six PRs between 19:30 and
   21:13, including a 145-file decomposition. Running a second merge train against the same
   files overnight risks exactly the collisions the refactor plan's own §7.4 warns about.
   Tonight's code changes were therefore kept small, isolated from the refactor's contended
   files, and left on a branch for review rather than auto-landed. **That branch has since
   been reviewed and landed on `main` as `3b02f3b` (#162).**

4. **GLM 5.3 was not available and was not used.** There is no Z.AI/GLM credential on this
   machine, and `~/.claude/CLAUDE.md` records GLM/Z.AI as dropped from the stack on 2026-06-02.
   The adversarial audit was run with **Codex GPT-5.6**, which is subscription-billed, logged
   in, and the approved verification lane. Substituting silently would have been worse than
   saying so.

**The highest-value thing available tonight was this document** — it turns thirty-odd scattered
observations into specced work with acceptance criteria, and isolates the six decisions that
unblock the rest. `/goal` requires an approved spec with measurable success criteria; the field
notes explicitly were not one. Now there is a candidate.

---

## 10. Recommended sequence

1. ~~**Devin answers §6**~~ — **done**, by delegation on 2026-08-30. See
   `docs/plans/2026-08-30-field-walk-decisions.md` (D1–D6). The sequence now starts at step 2.
2. **Tier 1 lands** (§4) — small, already partly done tonight.
3. **GLOBAL-01 gate script + GLOBAL-02 search** — cheap, and they constrain everything after.
4. **Tier 2 design pass** (§5) — CELLAR-01, CELLAR-05/06, LIST-03/04 together, once §6.5 is
   answered.
5. **Corpus decision drives everything on the Scan side** (§6.3). Until it is made, SCAN-06,
   -07, -08, and -10 are all speculative. The fuzzy-text-matching half can proceed regardless.
6. **3D cellar starts as (c)** — real photographic bin imagery — and earns its way to (a).
