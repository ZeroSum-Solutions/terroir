# Terroir — Refactor Field Notes (running capture → PRD)

**Started:** 2026-08-29
**Status:** OPEN / actively being appended to
**Owner:** Devin
**Purpose:** Raw capture of everything observed while walking the running app page by page,
organized as it comes in. This document is the input to a PRD — it is **not** the PRD yet.

## How this doc works

- Notes arrive **out of order** and get filed under the page/system they belong to.
- Every item gets a stable ID (`SCAN-01`, `CELLAR-04`, …) so later notes, screenshots, and PRD
  sections can reference it without renumbering.
- `[obs]` = observed fact/complaint · `[want]` = desired behavior · `[bug]` = looks like a defect ·
  `[rule]` = a hard convention that binds all pages · `[ref]` = inspiration from another app
- **Claude's inference** is labeled inline as `> Inference:` so it can be confirmed or struck.
  Nothing inferred is treated as a requirement until Devin confirms it.
- Screenshots live in `docs/screenshots/2026-08-29-field-notes/` (renamed from the unlabeled
  originals; see the index at the bottom). Screenshots are **unlabeled and unordered by design** —
  some are Terroir, some are competitor apps used as inspiration.

---

## 0. Global rules and conventions

These bind every page, not just the one they were noticed on.

### GLOBAL-01 `[rule]` One row of buttons, maximum

> "I need a hard rule that there should not be any more buttons than a single line across the
> page, whatever page we're on. If you cannot fit all the buttons horizontally in one frame, then
> there are too many buttons."

- All tabs / filters / toggles / actions on a page must fit on **one horizontal row** in one frame.
- If they don't fit, the answer is **fewer buttons**, not a second row.
- Overflow goes into a single consolidated control (one menu / one filter surface), not a new row.
- Violation of record: Cellar page currently has **four** stacked rows of controls (CELLAR-01).

### GLOBAL-02 `[rule]` The search bar is exempt — and it is everywhere

- The search input is **excluded** from the one-row rule and lives as its own element.
- It sits **at the top** of the page.
- It is present on **every page**. It is one of the most important features in the product.

### GLOBAL-03 `[want]` Every page needs real imagery / a real hero

- Text-only heroes with a wall of buttons under them are unacceptable.
- Hero imagery is what ties a page together visually. Applies to Cellar first (worst offender),
  but is a general standard.

### GLOBAL-04 `[rule]` Quality bar

> "If we were to be the top-of-the-line, the best wine application in the world for management,
> collection, and purchasing, then this type of stuff can't happen."

The bar is best-in-world for **management + collection + purchasing**. Unformatted button soup,
missing imagery, and dead-end panels fail that bar on sight.

### GLOBAL-05 `[want]` Wine imagery is table stakes, everywhere a wine appears

Any surface that names a wine should be able to show what the bottle looks like — cellar rows, bin
cards, detail panels, list builder, search results. Driving case is staff wayfinding (see
CELLAR-08), but it applies globally.

---

## 1. Scan / Invoice page

The Scan page's job: get a collection of wines into a personal or restaurant inventory, from any
starting point.

### 1.1 Ingestion & migration

#### SCAN-01 `[obs]` Supported inputs today (as understood)

CSV, XLS/XLSX (Excel), JPEG, PNG, PDF → wines into a personal or restaurant collection.
Images cover both **invoices** and **bottles**.

#### SCAN-02 `[want]` Every avenue of ingestion must be easy

"All avenues of this" should be easily done — no single blessed path that works while the others
are second-class.

#### SCAN-03 `[want]` First-class migration / transfer flow from incumbent systems

Restaurants already hold their collection somewhere. Named explicitly:

- **Binwise** ("Benwise") — typically paired with a POS, most likely **Toast**
- **Beverage/"Beverly"** — an app in this space
  > Inference: likely **BevSpot** or **Beverage Analytics**; needs confirmation of the exact product.

Requirement: any individual **or** restaurant can migrate everything over **seamlessly**, and it
routes correctly into the right places on arrival. The flow must be **extremely easy, intuitive,
and fast**.

> Inference (from `invintory-get-started-imports.png`): the competitor pattern is a short, named
> list of source-specific importers on the empty state — "Import from CellarTracker", "Import from
> Vivino", "Upload a spreadsheet" — rather than one generic uploader. Invintory does a credentialed
> API pull (`invintory-cellartracker-import-options.png`: username + password, explicitly not
> stored, with per-bucket checkboxes for *My Collection / Pending delivery / Wishlist / Community
> reviews / History*). That per-bucket selection is the "routed correctly" idea made concrete.
> Candidate source list to confirm: Binwise, Toast, BevSpot/"Beverly", CellarTracker, Vivino,
> plain spreadsheet.

#### SCAN-04 `[want]` Invoice ledger entries are permanent, with an explicit delete

- If an invoice scans incorrectly, comes back with **zero** items, or is simply unwanted, it must
  **stay in the ledger** and remain viewable. Silently disappearing entries confuse and annoy users.
- There must be an explicit **Delete** option on any invoice, chosen by the user.

### 1.2 Capture UX

#### SCAN-05 `[want]` Camera-first capture screen, modeled on Vivino

Current capture UI "is not up to standard."

Target pattern (`vivino-capture-sheet.png`, `vivino-capture-sheet-expanded.png`):

- The **whole screen is the camera**.
- A **sliding bottom sheet / card** overlays it, draggable up and down, carrying secondary content
  (Vivino puts "Recent scans" and an upsell there).
- Minimal chrome on the camera itself: close, auto/mode, flash. Corner framing guides.
- Recent-scan rows are rich: thumbnail, producer, wine + vintage, country flag + style + region,
  rating pill, price pill, overflow menu.

Devin: "I love the style so we should incorporate that."

> Inference (`vincent-onboard-01-catalog-any-wine.png`): a second reference app puts a
> **Label / Wine List** segmented toggle inside the camera and prompts "Scan front or back of
> label", with the identified wine surfacing as a card pinned over the viewfinder. Worth
> considering alongside the Vivino sheet.

### 1.3 Recognition engine

#### SCAN-06 `[bug]` Bottles fail to be recognized

Reproducible miss: **Champagne Frédéric Savart "Haute Couture", Le Mesnil / Oger, Grand Cru, 2017,
Extra-Brut** (label reads `2030 Bouteilles` — a ~2,030-bottle grower cuvée).
Scanned **twice**, not found either time.

- Bottle photo: `ref-savart-haute-couture-2017-bottle.HEIC`
- Vivino finds the producer without trouble: `vivino-wine-detail-savart.png` shows
  *Fréderic Savart x Caviste Blanc de Noirs Champagne Premier Cru*, 4.3 / 83 ratings.
- Vivino also handles a **misspelled** text query — `vivino-search-results-fuzzy.png`, typed
  "Fredric savart", returns two correct Savart cuvées.

> Inference: two distinct gaps here — (a) label/image recognition coverage on low-production grower
> producers, and (b) fuzzy/typo-tolerant text matching. Treat as separate work items.
> Use this exact bottle as a permanent regression fixture.

#### SCAN-07 `[want]` Re-architect image → wine processing for Vivino-class speed

- Vivino: take a photo → **~2 seconds** → result, with the wine's full information already there.
- Terroir "doesn't have any of that."
- Devin wants a **one-to-one comparison with the Vivino app** and is inclined to **adopt that
  architecture**, since it demonstrably works.
- A **language model is the fallback**, not the primary path.

> Inference: implies a fast deterministic first stage (label embedding / visual match against a
> pre-built corpus) with an LLM only for the misses. This is an architectural decision to confirm
> before it becomes a PRD line.

#### SCAN-08 `[obs/want]` Deep wine attributes are missing on scan results

A scan must return, fast:

- Producer
- Grape variety
- Rating systems (plural — critic scores as well as community)
- Food pairings
- Acidity
- **Market price**
- "and stuff like that" — see the reference detail sheet below for the fuller shape

> Reference for what a complete detail view looks like (`vincent-onboard-02-know-every-bottle.png`):
> cutout bottle image · "Blend (3)" badge · vintage + wine name · producer · region · country ·
> **Est. value ($158)** · **drink window ("Ready 2022–2043")** · **avg critic score (97)** ·
> review count with "View all" · an AI-generated **Summary** with an audio play button.

### 1.4 Search & AI on the Scan page

#### SCAN-09 `[want]` A search bar on this page — currently absent, and a large miss

Type any wine → search → get its information → **add it to inventory** or **buy it**.
Devin: "That simple search feature is nowhere on this page, which I think is a very large miss."

> Inference (`vivino-search-empty-state.png`, `vivino-search-categories-scroll.png`): Vivino's
> search scopes results with an **ALL WINES / MY WINES** tab pair, keeps **Recent searches**, and
> fills the empty state with **Popular categories** — offers, style (Red/White/Sparkling), country,
> grape, region, and even **food** (Beef, Shellfish). A useful model for our empty state.

#### SCAN-10 `[want]` Natural-language chatbot over the wine corpus

Beyond name/region lookup. Example query Devin gave verbatim:

> "Hey, I'm looking for a good blend from Argentina and something between the $200 and $400 range
> that might pair nicely with meats."

Must handle constraints across style/blend, country/region, **price range**, and **pairing**.
Should be genuinely in-depth, not a keyword box with a chat skin.

#### SCAN-11 `[want]` Voice agent

Tap a button and talk to it. Applies to the chatbot/search experience. "A huge plus."

> Reference (`vincent-onboard-03-ai-sommelier.png`): a named AI sommelier persona ("Vincent") that
> answers *"What wine from my collection should I pair with sushi tonight?"* by reasoning over
> **the user's own collection** — citing acidity, ABV, and critic score from the inventory. Note
> the scope: recommendations **from your collection**, not just from a catalog.

---

## 2. Cellar page

> "One of the most ugly things I've ever seen."
> Screenshots: `terroir-cellar-list-view.png`, `terroir-cellar-bin-view.png`,
> `terroir-cellar-wine-side-panel.png`

This page needs extensive work; it is also where the biggest differentiator lives (CELLAR-02).

### 2.1 Layout & information architecture

#### CELLAR-01 `[bug/obs]` Button soup — four stacked rows of unformatted controls

Current state, top to bottom (`terroir-cellar-list-view.png`):

1. Hero: eyebrow "MY RESTAURANT · CELLAR" + headline "A cellar beyond the *ordinary*" — **text only,
   no imagery**
2. Row 1 — count pills: `ALL 15,004` · `OPEN 10` · `DRINK NOW 19`
3. Row 2 — `Open bottles 10` · search input · `Name A–Z` · list/grid toggle · filter icon ·
   `Reconcile 9 open bottles`
4. Row 3 — `Producer` · `Region` · `Filters`
5. Row 4 — `Select wines`

Problems as stated:

- Tabs directly under the hero text, then **more** tabs under that.
- No formatting or placement discipline — items have no visual grouping or hierarchy.
- The "Filter" control is actually **Cellar Settings** and navigates somewhere completely
  different — mislabeled, and a jarring context switch.
- Result is confusing to use.

Required fix: condense to the genuinely important controls on **one row** (GLOBAL-01), pull the
search out as its own top-of-page input (GLOBAL-02), and design a real layout around it — plus
hero imagery (GLOBAL-03).

#### CELLAR-02 `[want]` 3D cellar mapping — the headline differentiator

The concept:

- User scans their space with a phone — camera and/or **LiDAR**.
- The app builds a **3D map** of their cellar, fridge, bin, storage facility, racks, etc.
- The user then **assigns which wines go where** inside that map.

Acknowledged as a lot of work; explicitly accepted as the cost of a **major differentiator**.

Competitive read — **Invintory**:

- They do 3D imaging/scans, but **a human employee is dispatched** to perform the scan.
- Turnaround is slow — it takes a while before the scan is uploaded to your account.
- The resulting bins / 3D representations are, in Devin's words, **ugly**: a mock-up that doesn't
  resemble your actual space, only replicating its organizational pattern.
- `vincent-onboard-04-3d-cellar-map.png` shows the genre's current visual language — a stylized
  dark rack elevation labeled "Left wall" with one bottle highlighted and a "1 selected" tray.

Terroir's angle: **self-serve, instant, and photoreal** — capture real images of the actual storage
apparatus and render a 3D representation of the **real thing**, not an abstract mock-up.

#### CELLAR-03 `[obs]` Location grouping works and is worth keeping

Scrolling shows wines grouped by location — `CELLAR B`, `BAR FRIDGE`, `UNCATEGORIZED (97)`.
"I can see where everything is, which is cool." The grouping concept is good; its **positioning /
placement on the page** needs rework.

#### CELLAR-04 `[bug]` Drag and drop between locations does not work

Rows show a drag handle (⣿) and can be picked up and dragged, but **they don't stick** — the move
never commits. Moving a wine from one location/bin to another by dragging is expected behavior.

### 2.2 Wine detail panel

Screenshot: `terroir-cellar-wine-side-panel.png`

#### CELLAR-05 `[bug/obs]` The panel contains almost no wine information

Current contents: wine name, vintage, a `FULL DETAIL` link, then Open / Sealed / Status counts and
bin path, then a large **RECORD COMP OR ADJUSTMENT** form (Kind, Unit, Quantity, Reason, Note,
Record event), then Preservation method, then stacked buttons: `86 this wine`, `Re-enrich`,
`Edit metadata`, `Open bottle`.

What's wrong:

- **No information about the wine itself.**
- **No hero image of the bottle** — which would be very helpful for someone trying to find that
  specific wine.
- The buttons are stacked at the bottom with no considered arrangement (GLOBAL-01).

#### CELLAR-06 `[want]` Re-prioritize the panel — "Record comp or adjustment" is not the headline

> "Do we think that the record comp or adjustment is the most important thing to fill up the
> largest part of this sidebar? I don't think so."

The largest real estate should go to the wine: image, identity, and the enriched attributes from
SCAN-08. Comp/adjustment is a secondary action.

#### CELLAR-07 `[bug]` Panel opens pinned to the top instead of centered on the selection

The side panel should open **centered on whatever wine was selected**, not anchored to the top of
the viewport — otherwise it's disorienting after scrolling down a long list.

### 2.3 Bin view

Screenshot: `terroir-cellar-bin-view.png`

#### CELLAR-08 `[bug/want]` Bin cards are dead ends with no information

Toggling List → Bin shows a lettered/numbered grid (A1–F8) with per-cell counts and an
In stock / Low / Empty legend. Selecting a cell opens a side panel: `Bin A5`, `10 bottles`, and a
single plain box containing *"Puy Florent, Puy Florent, Merlot, Pays d'Oc — 2020 · Qty 10"*.

Problems:

- The card is **not clickable** — it's a dead end.
- "A little stupid box with a box of text inside of it that gives me no information except for the
  name of the wine, which I think is ridiculous."

Required:

- Clicking a bin card must open the wine's full detail.
- The card must show **what the bottle looks like** — the driving scenario is an employee told
  "this wine is in Bin A5" who then has to identify it among ten bottles. Without an image they
  waste time.

---

## 3. Lists page (wine lists / menus)

Screenshot: `terroir-lists-builder-brandkit.png` — list "spring of forever", DRAFT, 2 wines.
Example used: name *"Spring of Forever"*, description *"All Perfect Drinking Window"*.

### LIST-01 `[want]` AI-assisted list curation

When creating a wine list, the user should be able to state an intent — e.g. *"I want all the wines
I have that are in the perfect drinking window on this list"* — and the AI selects the candidates.
The user then **picks with thumb or cursor** which of those candidates actually make the list.

The drinking-window example is illustrative, not the only case. The principle: **people shouldn't
have to curate a list entirely by hand.**

### LIST-02 `[want]` Auto-select the wine's style when adding to a selection

The "Add to selection" modal shows the wine name + vintage and requires manually choosing a section
from: Sparkling · White · Rosé · Red · Dessert · Fortified.

The app already knows (or can infer) the style — it should **pre-select the correct one**.

> **Correction (2026-08-30, from the code):** these notes list six sections. The
> product ships **five** — `DEFAULT_SECTIONS` in `src/lib/wine-list/types.ts` is
> Sparkling / White / Rosé / Red / **Dessert & Fortified**, the last folding two
> colours into one. The screenshot's sidebar shows five rows, not six. This mattered:
> the first implementation matched section names exactly and so missed dessert and
> fortified entirely. See PRD §8.1.

> Corroborating evidence in `terroir-lists-builder-brandkit.png`: *Benjamin Leroux Vosne-Romanée
> 2019* — a red Burgundy — is currently filed under the **Sparkling** section. Exactly the failure
> this requirement prevents.

### LIST-03 `[want]` Pricing must always be present, with suggested glass and bottle prices

- Pricing data should **always** be available on a wine.
- The app should **suggest a glass price and a bottle price** as the starting point.
- The user adjusts from there — proposed control: a **minus / suggested price / plus** stepper
  (a dollar at a time).

Current state: the GLASS and BOTTLE columns show `—` for the wine on the list. No suggestion, no
value.

### LIST-04 `[want]` Settings-driven markup flows into the suggestion automatically

If the user sets a rule in settings — e.g. *always price 6% above purchase price* — that markup is
already **calculated into the suggested price** before they ever see it. Then they hit "Add to list".

### LIST-05 `[bug]` Brand kit doesn't work

Expected: input a **business URL**, or a **logo**, or a **brand kit** — by **drag-and-drop** or
**copy/paste** (URL) — and have the brand kit generated for them, which then **populates the design
of their menus**.

Current UI offers only an `Upload logo` button plus a swatch strip and a `Generate themes` button
("Upload a logo, extract its palette, then generate accessible menu themes"). There is **no URL
input** and no drop target. "Right now it's not working. That bothers me."

### LIST-06 `[bug]` Wines added to a wine list don't register

Adding a wine to the wine list "won't come up. It doesn't actually register."

> Note: the captured screenshot shows the list at "2 wines" with one visible under Sparkling, so
> the failure may be partial (specific path, specific section, or a stale view). Needs a precise
> repro before it becomes a ticket.

---

## 4. Cross-cutting bugs & data-quality issues

Spotted in the screenshots; not yet called out verbally. Flagged for confirmation.

### BUG-01 `[bug]` Producer name duplicated in wine titles

- Side panel: **"Benoit Ente Benoit Ente, Puligny-Montrachet"**
- Bin panel: **"Puy Florent, Puy Florent, Merlot, Pays d'Oc"**

Producer appears to be concatenated twice into the display name.

### BUG-02 `[bug]` Leading comma / empty producer field in list builder

List row renders as **", Benjamin Leroux Vosne-Romanée"** — a leading comma from an empty producer
segment.

### BUG-03 `[bug]` Section names truncated to uselessness in the Lists sidebar

Sections render as `Sp… 1`, `W… 1`, `Rosé 0`, `Red 0`, `De… 0` — the sidebar column is too narrow
to show the section names it exists to display.

---

## 5. Open questions / to confirm with Devin

1. **"Beverly"** — is this **BevSpot**, **Beverage Analytics**, or another product? (SCAN-03)
2. Confirm the full source list for the migration flow: Binwise, Toast, BevSpot?, CellarTracker,
   Vivino, spreadsheet — any others?
3. **SCAN-07** — is "take Vivino's architecture" a directive to build a visual-match-first pipeline
   with an LLM fallback, or a looser "match their speed and completeness"?
4. **CELLAR-02** — is the 3D capture target phone-only (LiDAR + photogrammetry), and is
   photorealism a v1 requirement or a north star?
5. **LIST-06** — exact repro path for the "added wine doesn't register" bug.
6. Which app is the black-and-gold reference (screenshots `vincent-onboard-*`) — appears to be
   **Vincent**? Confirm so it can be cited properly as an inspiration source.
7. Its onboarding asks persona ("just getting into wine" / "building a collection" / "run a
   restaurant or hotel"), goals, and collection size before anything else — is a comparable
   onboarding in scope for Terroir?

---

## Screenshot index

`docs/screenshots/2026-08-29-field-notes/` — originals were unlabeled; names below are Claude's
reading of each. Correct any that are mis-assigned.

### Terroir (our app)

| File | What it shows | Notes |
|---|---|---|
| `terroir-cellar-list-view.png` | Cellar page, list view | CELLAR-01, CELLAR-03, GLOBAL-01/02/03 |
| `terroir-cellar-bin-view.png` | Cellar page, bin grid + Bin A5 panel | CELLAR-08, BUG-01 |
| `terroir-cellar-wine-side-panel.png` | Wine detail side panel | CELLAR-05/06/07, BUG-01 |
| `terroir-lists-builder-brandkit.png` | Lists builder + brand kit | LIST-02/03/05, BUG-02, BUG-03 |

### Vivino (capture + search + detail reference)

| File | What it shows | Notes |
|---|---|---|
| `vivino-capture-sheet.png` | Full-screen camera + bottom sheet, collapsed | SCAN-05 — the style to adopt |
| `vivino-capture-sheet-expanded.png` | Same sheet dragged up | SCAN-05 |
| `vivino-wine-detail-savart.png` | Savart × Caviste Blanc de Noirs detail | SCAN-06 — Vivino finds the producer |
| `vivino-search-results-fuzzy.png` | Query "Fredric savart" → correct results | SCAN-06 — typo tolerance |
| `vivino-search-empty-state.png` | Search empty state, recent + categories | SCAN-09 |
| `vivino-search-categories-scroll.png` | Categories incl. grape, region, food | SCAN-09 |

### Vincent (?) — black/gold onboarding reference

| File | What it shows | Notes |
|---|---|---|
| `vincent-onboard-01-catalog-any-wine.png` | Camera with Label/Wine List toggle | SCAN-05 |
| `vincent-onboard-02-know-every-bottle.png` | Full wine detail: est. value, drink window, critic score, AI summary | SCAN-08 — the target detail shape |
| `vincent-onboard-03-ai-sommelier.png` | AI sommelier answering from *your collection* | SCAN-10, SCAN-11 |
| `vincent-onboard-04-3d-cellar-map.png` | 3D rack elevation, "Left wall", 1 selected | CELLAR-02 |
| `vincent-onboard-05-persona-question.png` | Onboarding: persona | Open question 7 |
| `vincent-onboard-06-goals-question.png` | Onboarding: goals | Open question 7 |
| `vincent-onboard-07-collection-size.png` | Onboarding: collection size | Open question 7 |
| `vincent-onboard-08-collection-size-selected.png` | Same, selected state | Open question 7 |

### Invintory — migration reference

| File | What it shows | Notes |
|---|---|---|
| `invintory-get-started-imports.png` | Empty state: Add bottles / CellarTracker / Vivino / spreadsheet | SCAN-03 |
| `invintory-cellartracker-import-options.png` | Credentialed import with per-bucket checkboxes | SCAN-03 |

### Source material

| File | What it shows | Notes |
|---|---|---|
| `ref-savart-haute-couture-2017-bottle.HEIC` | The bottle that failed to scan, twice | SCAN-06 regression fixture |
