# Competitor Audit and Adoption Plan — Vivino, Delectable, Vinous, InVintory, Bevly, Bevrly

**Date:** 2026-09-02 · **Status:** evidence brief + ranked backlog, awaiting Devin's picks
**Full briefs:** `docs/plans/competitor-audit-2026-09-02/<app>.md` (one per app, cited, `[PUBLISHED]`/`[ESTIMATE]` discipline)
**Earlier, shallower pass:** `2026-09-01-competitor-flow-comparison.md` (demo-day talking points)

---

## 0. Why this exists

Devin's brief (2026-09-02): the five apps below each do part of what Terroir is trying to do,
and some of it better. Audit each for functions, design, layout and architecture we can pull
in. Every claim in the per-app briefs is sourced from public pages, store listings, press and
reviews; **no app was used logged-in**, so anything only visible inside an account is marked
as a gap in each brief's "Gaps" section and is the reason the logins in §1 exist.

Two premises were tested and corrected by the evidence:

- **Delectable is not fast at identification; it is fast at *capture*.** The photo lands in
  your profile instantly and identification resolved later — historically by human
  transcription averaging about fifteen minutes. The speed Devin experiences is a non-blocking
  UI. Terroir can have both, because its identification is a parallel vision model.
- **"Beverly" was dictated, and two apps fit the sound.** Devin picked **Bevly**
  (bevlypos.com) from the options offered, but it is a liquor-store POS from a payments ISO,
  not a restaurant tool. The earlier 2026-09-01 comparison audited **Bevrly** (bevrly.com),
  restaurant wine inventory with POS depletion sync, binning and hardware count scanners,
  which fits "restaurateurs logging, auditing and tracking sales" far better. Both are
  audited below (§2.5 Bevly, §2.6 Bevrly). **Neither has won the market**: Bevly shows
  "10+" Android installs and no review-site listings; Bevrly is a two-person company with
  zero App Store ratings, a "1+" Play install bucket, no Toast partner-directory listing and
  fifteen named venues, eleven of them in New York. Bevrly's *product* is nonetheless the
  deepest restaurant workflow in the set, and its 48-page public docs plus its shipped
  JavaScript exposed the whole route map, so its brief is the most complete of the six.

---

## 1. Access — where the logins live

Credentials are in **ZS Vault**, category `Competitor Apps`, never in this repo. Read with
`zsvault get <id> --field username` / `--field url`; the password field is for the 1Password
autofill flow through the Claude in Chrome extension, which signs in without exposing the
value to the agent.

| Vault id | App | URL | Notes |
|---|---|---|---|
| `vivino_login` | Vivino | https://www.vivino.com | |
| `delectable_login` | Delectable | https://delectable.com | Owned by Vinous; iOS app last shipped 2021 |
| `vinous_login` | Vinous | https://vinous.com | Shared account from IB Hospitality (Rohan) |
| `invintory_login` | InVintory | https://invintory.com | Web app exists; 3D view is iOS-only |
| `bevly_login` | Bevly | https://bevlypos.com | See §0 — if Devin meant Bevrly (bevrly.com), this entry gets repointed |

Entries were created 2026-09-02 with URL, username where known, and a placeholder password;
Devin sets the real passwords with `zsvault edit <id>` (hidden prompt). The logged-in
walkthroughs that close each brief's "Gaps" section need the Chrome extension connected and
the same logins present in 1Password.

---

## 2. What each app is best at, and what to take

Build sizes are engineering estimates against Terroir's codebase: S under a day, M two to five
days, L a sprint or more. Every item names what to copy and what to do better; the per-app
briefs carry the evidence and a longer list.

### 2.1 Vivino — the wine page and the taste model

Vivino's wine page is the reference for how a wine should *read*. Its taste block is mined
from millions of strangers' reviews; Terroir's would be mined from one house's notes, where a
mention count is an operational fact.

| # | Adopt | Do better | Size |
|---|---|---|---|
| 1 | Aggregate-from-notes taste block: descriptor chips with mention counts, each a drill-through into the notes that contain it, plus four structural axes (light–bold, smooth–tannic, dry–sweet, soft–acidic) | Scope it to the house ("across 14 house notes"), show axes only above an n floor; extends the existing `AxisBar` | M |
| 2 | A Home surface whose job is harvesting preference signal (recent scans + thumb up/down + taste profile) | Terroir's signal is a by-product of service — poured, 86'd, returned — so confirm inferences instead of begging for ratings. No Home exists today | M |
| 3 | A closed, documented highlight-badge vocabulary | Operational badges: *Drink now, Last bottle, Slow mover, Below cost, Off-list, Mis-binned*, each stating its rule on tap | S |
| 4 | Two colour ramps: rating→warmth and a per-aroma-family constant colour | Re-derive inside Nocturne and add to `DESIGN.md` as token families; Vivino's flavour hexes are the browns Terroir bans | S |
| 5 | Rating-basis honesty labels ("4.3, based on all vintages" / "112 ratings") | Make it a component contract for every derived number: whose drinking window, which price basis, how many notes an axis stands on | S |
| 6 | Wine-list scan with results overlaid on the user's own photo | Same shape as the invoice pipeline; the twist is scoring a competitor's list against the house cellar | L |
| 7 | Compare-vintages spine under one canonical wine | `canonical_wines`/`wine_variants` is already the shape; add what the house paid, poured and sold per vintage | M |
| 8 | Published, tiered pricing page | Tier by venue or list size instead of country | S |

Do not copy: commerce above taste on the wine page, sponsored cards inside the primary object,
a bare 5-star global average (Vivino's own mean is 3.6 and 4.0 beats 85% of its database),
40px controls (below the 44px floor), gating the daily job behind the paywall, the
cellar-as-list model, the palette and type.

### 2.2 Delectable — capture first, identify later

Delectable's advantage was an asynchronous capture model: a label photo is a first-class object
in your profile before it is identified, and it resolves in place. Its identity spine
(`base_wine` → `wine_profile`) is structurally Terroir's `canonical_wines` → `wine_variants`
minus `size_ml`.

| # | Adopt | Do better | Size |
|---|---|---|---|
| 1 | Pending-capture async model: a `bottle_captures` row with status `pending / matched / needs_review / rejected`, resolved by a worker | Reuse `src/domains/scanning/` ledger + stalled-detector; make instant resolution the norm and pending the exception | M |
| 2 | Bulk photo-library import: gallery affordance beside the shutter, multi-select, no per-image confirmation | On mobile web this is `<input type="file" multiple>` opening the native picker; bounded-concurrency upload; a 40-bottle rack shoot resolves in under a minute instead of Delectable's 46. **Highest-leverage onboarding item across all five apps** | S–M |
| 3 | Three exits from a bad match (reject / search by name / escalate) | Sort the batch by confidence and bulk-confirm the high tier; extend `/reconcile-queue` and `scan-review.tsx`; log confidence in `scan-telemetry.ts` | M |
| 4 | Producer eyebrow + dual-score row on the wine card | House score vs reference score, in Terroir tokens | S |
| 5 | Photo-as-texture insight tiles (each facet tile grounded on one of the cellar's own label photos) | `/insights` already has richer facts; label imagery is already stored | S |
| 6 | Federated unified search, results grouped by entity with a per-group MORE | Group over wines, producers, bins, lists, scans, staff; feed the same payload to the AI companion | M |
| 7 | Region×grape composite category pages and chips | Generate from this cellar's composition; reuse the chips to assemble a by-the-glass list | S–M |
| 8 | Vintage rail on the wine page | Near-free on the spine; render vintage × format. Public wine page must read `canonical_wines` + aggregate, never one tenant's variants | S |

Do not copy: public-by-default personal notes (its worst documented failure), a staffed
transcription queue, selling identification accuracy as a subscription, separate scan and buy
apps, the status feed, identity-poor bulk uploads that drop bin/section, the 2026 site as a
design reference.

### 2.3 Vinous — the content model and search

Vinous's public SSR payloads expose its whole record shape: canonical wine (with LWIN7) →
vintages (with LWIN11) → per-vintage review with integer drinking window, score, note HTML,
producer commentary, author, dates and row-level provenance. That is Terroir's spine with the
interop key Terroir lacks.

| # | Adopt | Do better | Size |
|---|---|---|---|
| 1 | Two-integer drinking window plus the retained raw string | Render against the user's cellar: "in window, 4 years left" / "1 year early" / "past window", and make it a cellar filter | S |
| 2 | Year-sniffing in the search box (Terroir's `query-parse.ts` already does vintage, country, region, colour) | Add bottle formats, producer aliases and bin codes; show a removable chip per extracted facet so the user sees why results narrowed | S |
| 3 | Structural facts public, judgement gated | When no critic note exists, render the full identity card and say "no note on file"; never lorem ipsum | S |
| 4 | Bidirectional note ↔ source provenance (name, URL, date on every excerpt) | Put it on every enrichment excerpt Terroir writes; this is also what makes licensing defensible | M |
| 5 | LWIN7 on `canonical_wines`, LWIN11 on `wine_variants`, explicit match flag | Track match confidence and method; unmatched becomes a work queue | M |
| 6 | Facet set with URL-addressable filter state | Add the hierarchical region facet Vinous lacks, plus *in my cellar*, *bin*, *on this list*, *ready to drink* | M |
| 7 | Published rating-scale reference | Per-source scale normalisation; never silently average incompatible scales | S |
| 8 | Split `tasting_note` from `producer_commentary` | Add a third field Vinous cannot have: the house note | S |

**Sourcing Vinous data:** only by contract. Scraping is prohibited and technically blocked;
consumer and Pro tiers forbid commercial reuse (Pro is in-stock wines only, which excludes
the older vintages Devin values); Enterprise ($2,000/yr, 1,500 concurrent notes, Liv-ex API
needing Liv-ex Gold) is the realistic entry; Enterprise Max is "required for content
resellers" and unpriced. The clause that bites Terroir bans use "within any algorithmic
ratings system" without written permission, which the AI companion plausibly is. Safest
pattern is CellarTracker's co-subscription: the user brings their own Vinous subscription and
Terroir renders their entitled content. Recommended: build the record shape now, ship with
unlicensed sources and house notes, prototype co-subscription first, and only approach Vinous
when a paying customer asks for it by name.

Do not copy: registration wall on "free" tools, lorem-ipsum blur, copy-blocking CSS, three
conflicting archive sizes, abandoned mobile apps, the missing region facet, a capped count
reported as a total, a 1000 ms typeahead debounce.

### 2.4 InVintory — the location model, and how to beat its 3D

InVintory's moat is not rendering; it is a strict storage → section → slot model with a
human-readable coordinate (`Wall A ❯ R3, C5, D1`) that prints on a shelf label, and a Locate
affordance on every surface a wine appears. Its 3D is hand-built by the user, paywalled, one
rack at a time on any paid plan; the stitched room is an Elite deliverable modelled by staff
and then locked so the customer cannot edit or delete it. Documented gaps: imports cannot
place bottles, no custom slot labels, no free orbit, no whole-shelf view, one silent
position-clearing path, AI that cannot place a bottle.

| # | Adopt | Do better | Size |
|---|---|---|---|
| 1 | Three-level model with a readable coordinate | Extend `cellar_config`'s flat grid with section geometry (cols/rows/depth) and a per-bottle slot; keep `bins.code` as the alias; configurable axis labels | M |
| 2 | Rack / Bin / Case as honest precision levels | Add a restaurant-only Zone tier over `bins.zone`; always show the precision level | S |
| 3 | Locate on every surface | Also on AI answers, invoice-scan results and wine-list lines; first fidelity is text + 2D map, never WebGL as the only answer | M |
| 4 | Generate the layout, don't build it | Spec form (S), photo→rack over the existing vision pipeline (L), import→placement from a bin column (M) — the last is a capability InVintory says it lacks | L |
| 5 | Non-destructive reorganisation as a stated contract | Dry-run every geometry edit ("this unplaces 3 bottles"), re-home on move | S |
| 6 | Unplaced as a first-class queue | `0057_bins.sql` already declares it; finish with a persistent "N bottles need a home" card | S |
| 7 | Per-location scoping + kiosk mode | Scope membership to location → room → section on top of existing RLS; shared-iPad session mode | M |
| 8 | AI that places into slots, with preview diff | "Put the six Chablis in Wall B row 4" — InVintory's headline gap | M |

**The 3D proposal (brief §7.1):** make the cellar a declarative, versioned JSON layout
document that everything renders from — printed shelf map, 2D plan and a generated 3D room
with free orbit, instanced-mesh WebGL in the browser so it runs everywhere InVintory's
iOS-only 209 MB binary does not. Slots are derived, only occupancy is stored. Programme size
L, shippable in order: layout doc + text coordinate (M) → 2D map + Locate everywhere (M) →
import-to-placement (M) → 3D room (M–L) → photo-to-rack (L). Restaurant multi-location and a
pull-list-in-walk-order service loop are what make it a tool rather than a showpiece.

Do not copy: paywalled bottle-finding, vendor-locked cellars, refusing custom labels,
cosmetic-only settings, dated notes imported as public reviews with defaults that differ by
platform, unrevocable snapshot wine lists, Enterprise-gated selling price, dead Android
controls, phone-bridged sensor telemetry, the brown/cream/gold brand.

### 2.5 Bevly — back-office workflow patterns (with the §0 caveat)

Bevly is a liquor-store POS from a payments ISO; most of its surface answers questions a
restaurant does not ask. Two verified negatives against the brief's assumptions: no source
describes offsetting live sales during a count, and there is no invoice OCR (intake is
EDI/API/SFTP feeds plus a CSV/PDF drop), so Terroir's invoice scan is ahead. What transfers is
a handful of well-built workflow screens.

| # | Adopt | Maps onto | Do better | Size |
|---|---|---|---|---|
| 1 | Section-scoped, multi-counter count session with counted-vs-expected variance | `cellar/reconcile`, `reconcile_batches`, `bins` | Build the half Bevly never documents: per-line accept / recount / investigate, reason code on every adjustment, a named committer; freeze an expected-at-timestamp per section and replay depletions recorded after it so a bottle sold mid-count is not shrink | L |
| 2 | Receiving screen with inline colour-coded exceptions (cost changed, margin below target) and a four-step commit | `scan`, `invoice_scans` | Feed Terroir's typed line items straight into it: cost delta vs last-paid, margin vs list price, unmatched-line resolution. **Best single interaction idea in the five apps for the restaurant side** | M |
| 3 | Exception-count alert rail (severity dot, plain-language defect, count, deep link) | `insights`, `cellar_health` | Bottles without a bin, wines without vintage, open bottles past window, list items out of stock, unreconciled invoice lines, priced below cost; show the trend too | S |
| 4 | "Run Reports" launcher rail with an inline parameter dropdown | `insights` | Plain-English restaurant-native report names | S |
| 5 | Restock suggestion from velocity, pars and on-order | new | Advisory only, weighted by list intent, vintage availability and allocation; not a PO/vendor module | L |
| 6 | Scan-empties-to-decrement close-out with waste/partials/comps logged separately, offline-tolerant | `bottle_closeouts`, `pour_events` | A second, faster close-out path for finished BTG bottles; separate reason codes so variance is explainable | M |
| 7 | Per-category margin targets checked at receiving | `pricing_recommendations` | Targets per list section (BTG, bottle, reserve); flag below cost *and* mispriced against market via `price-comparison` | M |
| 8 | Data hygiene as top-level nav: missing-attribute report + bulk edit | `catalogue`, `atlas` | Missing vintage/producer, unlinked LWIN/X-Wines, no bin, no image — as a worklist with bulk resolve | M |

Do not copy: state-minimum/MSRP enforcement, shelf-label printing, eCommerce/loyalty, EDI
payment rails and AP, multi-store UPC cloning (wrong identity key), "dead stock → delete", the
assumption that every bottle is replenishable.

### 2.6 Bevrly — the restaurant inventory cycle, end to end

Bevrly is the one app in the set built for exactly Terroir's restaurant job: periodic counts
against POS depletion, variance you can explain, and a guest wine list rendered from live
stock. Its public manual and build manifest gave up the full 78-route map, permission keys,
feature flags, a nine-provider POS enum and the exact variance-grid columns, so the brief is
unusually concrete. Terroir already has things Bevrly does not: real physical bins, per-pour
millilitre variance, open-bottle state, invoice OCR and LWIN identity.

| # | Adopt | Maps onto | Do better | Size |
|---|---|---|---|---|
| 1 | The inventory cycle as a first-class object: a period with a start, an inventory date, a sales-pause boundary and a manual close; counted values become the next period's baseline | nothing today; `/cellar` state is continuous | Make the close reconcile open bottles too, which Bevrly's 0–1 decimal cannot | L |
| 2 | Variance row that shows its own arithmetic: `Starting · Purchases · Sales · Adjustments · Running · Actual · Variance qty/cost/%` as adjacent columns | `/insights`, `reconciliation/variance.ts` | Add a pour-variance column from the ml data Bevrly cannot compute | M |
| 3 | Blind Counting Mode: staged counts, three tabs (Counting / History / Confirm), floating keyboard, scan-to-increment, manager confirm | new, inside `/cellar` | Scan a bin label first so every count in the session is location-bound; Bevrly's "distribution" step exists only because its counts arrive without a location | L |
| 4 | Audit Mode: per-action impact preview with *propagate / don't propagate / cancel*; ending audit is a lock, not a recalculation | nothing today | Show the delta per bin and log actor + reason for every propagation decision | M |
| 5 | Daily digest email, and a Home page that *is* the digest (sales, average and median bottle price, top bottle/BTG sales, recently 86'd, sleepy inventory) | `/insights`; no email, no day-scoped home | Make it a worklist of three deep-linked things to do today, not a scoreboard | M |
| 6 | Correct variance at the source: a cause→record taxonomy (miscount → stocktake, missing receiving → invoice, loss → adjustment with reason, location → movement, timing → date boundary) and a standing refusal to force counted = expected without evidence | reconcile + stock-adjustments | Require a note above a configurable dollar threshold and carry it into the export | M |
| 7 | List style engine: separate web and print style records, uploaded fonts, five configurable columns, per-row sold-as prices | `/lists`, `src/app/list/[slug]/` | Bevrly's guest list has zero media queries and a fixed 900px page, and its flagship customer fakes page breaks with invisible Unicode group names. Ship responsive, a real page-break primitive, guest search, a BTG filter and live availability | L |
| 8 | Permission keys instead of fixed roles, plus `simple_mode`: one switch that hides binning for venues that will never use it | `/team` owner/manager/staff | Terroir serves collectors and restaurants from one codebase, so make personal-cellar mode the default and let a restaurant opt into the machinery | M |

Also worth taking, smaller: the partial-bottle slider with quarter presets and a live-filling
bottle graphic on top of Terroir's ml precision (S); a "recently added" receiving holding
location plus a `needs placement` count on the cellar header (S); a per-call AI cost ledger
keyed on feature × model × tenant with cost-per-successful-extraction as the headline (M);
"sleepy inventory" crossed with drinking windows to flag wine that is both unsold and
running out of window (S); a public Feature Vocabulary table ("say this / don't say / what it
means / primary page") written before the next feature, not after (S).

Do not copy: the demo-only go-to-market (they take customers' BinWise logins to migrate
them), the non-responsive guest list, 78 routes for a two-person company, or a home-grown
universal wine catalogue when Terroir already has LWIN.

---

## 3. The cross-app programme — what the five audits agree on

Read across the five lists, the same six moves keep appearing. These are the candidates for
the next planning round, in the order the audits' own evidence suggests:

1. **Bulk label capture from the phone's photo library, async, confidence-tiered review**
   (Delectable 1–3). Converts "photograph the whole rack and walk away" into a supported
   workflow, on Terroir's existing scanning ledger and vision model. S–M then M.
2. **The location document and Locate-everywhere** (InVintory 1–3, 5–6). The prerequisite
   for beating InVintory's 3D and for the service pull list. M + M.
3. **Drinking window as two integers rendered against the cellar** (Vinous 1, InVintory 14,
   Vivino 5). Cheapest high-visibility win in the set. S.
4. **Provenance and honesty as component contracts** (Vivino 5, Vinous 4/10, InVintory 8,
   Bevly 12): every derived number carries its basis; every excerpt carries source, URL and
   date; every adjustment carries a reason code and committer. S–M spread across surfaces.
5. **The wine page**: aggregate-from-house-notes taste block, dual house/reference score,
   vintage rail, operational badges, Nocturne-derived rating and flavour ramps (Vivino 1/3/4,
   Delectable 4/8, Vinous 8). M in total.
6. **Receiving with inline exceptions, and the exception rail on cellar health** (Bevly 2–3).
   M + S, and it turns the invoice scan Terroir already leads on into a finished workflow.
7. **The inventory cycle: period, blind count bound to bins, variance that shows its
   arithmetic, correct-at-source** (Bevrly 1–4, 6; Bevly 1). This is the restaurant-side
   programme, and the largest: L + L + M + M. It is what makes reconcile a business process
   rather than a screen.

Deferred by evidence, not by preference: Vinous data licensing (contract-gated; build the
schema, prototype co-subscription), a PO/vendor module (Bevly 5), photo-to-rack (InVintory 4),
wine-list OCR overlay (Vivino 6), multi-venue org groups (Bevrly 15, only when a real group
asks). Explicitly out: anything in the "do not copy" lists, and any
import of another product's palette or type — Terroir's identity stays contracted in
`DESIGN.md`.

---

## 4. Open items for Devin

- **Bevly vs Bevrly** (§0). Both are now audited; say which login you actually hold, and the
  vault entry's URL follows.
- **Passwords** into the five vault entries via `zsvault edit <id>`, then connect the Chrome
  extension for the logged-in walkthroughs that close each brief's "Gaps" section.
- **Pick from §3.** Each move above goes through brainstorming and a design before code, per
  the repo's working contract; nothing here authorises implementation.
- The Vivino screenshot mentioned in the brief never arrived; send it and it gets folded into
  §2.1.
