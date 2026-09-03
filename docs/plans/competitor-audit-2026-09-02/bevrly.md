# Bevrly — competitor audit for Terroir

*Scope: bevrly.com (web app + public docs + public list API), the iOS/Android apps, and every
public record of the company behind them. Prepared 2026-09-02. Public sources only; no logins
were attempted and no credentials were entered. Supersedes and deepens the Bevrly rows in
`docs/plans/2026-09-01-competitor-flow-comparison.md`, several of which were wrong.*

---

## 1. TL;DR

Bevrly is a **beverage-operations** product, not a wine-cellar product: its unit of work is the
**inventory cycle** (count → variance → close → audit), and wine is one of five item families it
tracks. It is genuinely excellent at three things Terroir does not do at all — a blind,
count-from-zero **Counting Mode** with staged counts and a manager finalisation step; a
**variance ledger** that reconciles `Starting Qty + Purchases − Sales ± Adjustments` against a
physical count in units, cost and percent; and an **Audit Mode** that reopens the just-closed
cycle with a per-action impact preview and an explicit propagate-or-not choice. Its list builder
is also far deeper than Terroir's, with a 187-field style record, custom uploaded fonts, and
separate web and print styles.

**The owner's premise does not survive contact with the evidence.** Bevrly Inc. lists **2
employees** and **53 followers** on LinkedIn [PUBLISHED], has **zero** SEC Form D filings
[PUBLISHED], **zero** App Store ratings [PUBLISHED], a Google Play install bucket of **1+**
[PUBLISHED], **no** listing in the Toast partner directory [PUBLISHED], and does not appear in the
Tranco top-1,000,000 domains [PUBLISHED]. Its own homepage runs a rip-and-replace campaign against
BinWise ("Frustrated with BinWise?") — a challenger's move, not a leader's. It has not won the
market; it has built an unusually well-specified product for roughly 15 named venues, most of them
in Brooklyn and Manhattan.

Copy the **operational spine** (cycle, blind count, variance ledger, audit propagation, daily
digest, list style engine). Do **not** copy the go-to-market, the identity model, the
non-responsive guest page, or the surface area.

---

## 2. Confirmed vs. inferred

| Confidence | What we know |
|---|---|
| **CONFIRMED [PUBLISHED]** | The complete authenticated route map (78 routes) from the public Next.js build manifest; the full docs site (48 pages of first-party workflow documentation at `bevrly.com/docs`); the full main-nav tree, permission keys, feature-flag list with descriptions, POS provider enum, variance table columns, insights panels, and wine field taxonomy, all read out of public JS bundles; the public list API's data and 187-field style schema; company size, funding absence, app ratings, Toast-directory absence, traffic rank absence. |
| **REPORTED (secondary)** | "Kirby Campbell" as the second LinkedIn employee — a subagent's scrape rendered the name; my own scrape rendered "LinkedIn Member". `kirby@bevrly.com` as the Play Store support address IS byte-verified, as is the in-app string "Access request sent to Kirby". |
| **INFERRED / ESTIMATE** | Real customer count (15 logos is the marketing-maximal set; actual paying venues are almost certainly in the low tens) [ESTIMATE]. Revenue, pricing, and headcount beyond the LinkedIn band. |
| **CONFLICTS / STALE** | The 2026-09-01 brief said `/pricing`, `/features` and `/product` "redirect unauthenticated visitors to `/login`". **They do not** — all three return HTTP 404 [PUBLISHED]; those pages have never existed. It also said Bevrly markets "advanced binning" with "no product screenshots found" — in fact `bevrly.com/docs` publishes 31 distinct annotated product screenshots across 42 placements. Two legacy marketing surfaces disagree with each other: `/landing` still says "© 2024 Bevrly Inc." and lists only Square and Toast, while `/` says "© 2026 Bevrly" — treat `/landing` as stale. |

---

## 3. How big is Bevrly, really?

| Item | Value | Tag | Source | Date |
|---|---|---|---|---|
| Employees listed on LinkedIn | "Discover all **2** employees"; "Company size 2-10 employees" | [PUBLISHED] | [LinkedIn](https://www.linkedin.com/company/bevrly) | 2026-09-02 |
| LinkedIn followers | 53 | [PUBLISHED] | [LinkedIn](https://www.linkedin.com/company/bevrly) | 2026-09-02 |
| Founded | 2020; "Privately Held" | [PUBLISHED] | [LinkedIn](https://www.linkedin.com/company/bevrly) | 2026-09-02 |
| Legal entity | "Bevrly Inc.", 17 Park Ave APT 1501, New York, NY 10016 | [PUBLISHED] | [Google Play developer block](https://play.google.com/store/apps/details?id=com.bevrly) | 2026-09-02 |
| SEC Form D filings | **0 hits** for "bevrly" (`forms=D`) | [PUBLISHED] | [EDGAR FTS](https://efts.sec.gov/LATEST/search-index?q=%22bevrly%22&forms=D) | 2026-09-02 |
| Disclosed funding | none found in EDGAR, Tracxn (404), NY DOS registry (no match) | [PUBLISHED] | as above | 2026-09-02 |
| iOS app ratings | "This app hasn't received enough ratings or reviews"; API `userRatingCount: 0` | [PUBLISHED] | [App Store id6740220524](https://apps.apple.com/us/app/bevrly-inventory/id6740220524) · [iTunes lookup](https://itunes.apple.com/lookup?id=6740220524) | 2026-09-02 |
| iOS app age | `releaseDate 2025-10-28`, current `1.5.1` released `2026-07-06`, 5 versions total | [PUBLISHED] | iTunes lookup API | 2026-09-02 |
| Android installs | "1+" (lowest Play bucket); no star rating shown; updated Jul 24, 2026 | [PUBLISHED] | [Google Play](https://play.google.com/store/apps/details?id=com.bevrly) | 2026-09-02 |
| Toast partner directory | `toasttab.com/integrations/bevrly` → **HTTP 404** | [PUBLISHED] | toasttab.com | 2026-09-02 |
| Web traffic rank | Tranco returns `{"ranks": [], "domain": "bevrly.com"}` — outside the top 1,000,000 | [PUBLISHED] | [Tranco](https://tranco-list.eu/api/ranks/domain/bevrly.com) | 2026-09-02 |
| Named customers | 15 logos, no count claimed anywhere: Four Horsemen, Penny, Cote Miami, Stars Wine Bar, Rude Mouth, Claud, Wrigley Mansion, Market Table, Plus de Vin, Santi, Le Chêne, The Mary Lane, Roya Austin, Cucina Alba, Wayward Fare | [PUBLISHED] | [bevrly.com](https://bevrly.com/) | 2026-09-02 |
| Actual paying venues | low tens | [ESTIMATE] | inference from 15 logos + 2 staff + 0 funding; not company-confirmed | 2026-09-02 |

**Comparable-set scale** (each figure is the competitor's own public claim, not a verified count):

| Company | Public scale claim | Tag |
|---|---|---|
| Partender | "over 15,000 bars" | [PUBLISHED] |
| BinWise | "Used in 500+ wine programs worldwide"; "30+ POS system integrations"; names The French Laundry, Daniel, EMP, Carbone | [PUBLISHED] |
| BevSpot | $22.4M raised, Series B, founded 2014 | [PUBLISHED] |
| WISK.ai | "integrates with over 60 POS systems" | [PUBLISHED] |
| Bevrly | **no count published** | [PUBLISHED] |

**Verdict: the "won the market" premise is false.** The tell is Bevrly's own site. A market leader
does not build a page called `/switch` whose headline is "Stop fighting your software." and whose
homepage asks "Frustrated with BinWise? We can migrate you in 20 minutes." That is a challenger
attacking an incumbent's installed base. What Bevrly *has* won is a specific, high-taste slice —
the NYC natural-wine and fine-dining scene — and it has built product depth well beyond what a
two-person company usually manages. **Respect the product; discount the market position.**

One honest caveat: absence of press is weaker evidence than presence of press. A quiet company
serving thirty wine bars profitably would look exactly like this. But "quietly serving a few dozen
NYC venues" and "won the restaurateur market" are not close to the same claim.

---

## 4. Feature inventory

### 4.1 The operating model

Bevrly's spine is the **inventory cycle**: "the period between two official inventory counts…
When you count and end the cycle, your counted values become the starting point for the next one"
[PUBLISHED, `/docs/inventory/cycle-overview`]. Everything else hangs off it.

Running stock is stated as a formula: **"Running Stock = Last Count + Received − Sold"**
[PUBLISHED, `/docs/invoicing`], elaborated as "last count + received − sold − adjustments +/−
movements" [PUBLISHED, `/docs/inventory/running-stock`].

| Capability | What Bevrly ships | Tag | Source |
|---|---|---|---|
| Count/audit flow | Two modes. **Inventory Mode** writes a real count for one item/location directly. **Counting Mode** is "blind count-from-zero" — staged entries that only become stocktakes after a manager's Confirm/distribution step | [PUBLISHED] | `/docs/inventory/counting` |
| Hardware scanners | Socket Mobile **S720, S740, S760, D740** paired inside the main iOS app (not a separate scanner app); camera scan is the alternative | [PUBLISHED] | `/docs/mobile/scanner` |
| Bulk count intake | CSV upload of `barcode`, `count`, optional `location_id` straight into staged counts, processed async | [PUBLISHED] | `counting-mode` JS bundle |
| Binning model | Named **Locations** with parent/child hierarchy (2–3 levels recommended), a `priority` field, an `available` toggle, and a system receiving location called **Recently Added**. There is no per-bottle slot or coordinate | [PUBLISHED] | `/docs/locations` |
| Depletion priority | Distribution "should follow reverse depletion priority… backstock/storage first, then front-bar/high-depletion locations" | [PUBLISHED] | `/docs/workflows` |
| POS depletion | 9 providers in the enum: `TA` Toast API, `TO` Toast SFTP, `SQ` Square, `SP` SpotOn, `MI` Micros, `BC` Lightspeed, `SH` Shopify, `S4` Shift4, `SY` Micros Simphony | [PUBLISHED] | POS chunk `{TA:"Toast API",TO:"Toast SFTP",SQ:"Square",…}` |
| Match types | Three: **Inventory** (deplete one item by a chosen "depletion size"), **Recipe** (deplete N ingredients), **Freehand** (carry cost, deplete nothing) | [PUBLISHED] | `/docs/pos-integration/item-matching` |
| Variance computation | `Counted stock − Expected stock = Variance`, where expected = "Last count + invoices − sales ± adjustments and movements" | [PUBLISHED] | `/docs/inventory/variance` |
| Variance benchmarks | Published thresholds — Liquor <1% excellent / >3% investigate; Wine <2% / >4%; Draft beer <3% / >6%; Overall <2% / >5% | [PUBLISHED] | `/docs/inventory/variance` |
| Invoice / receiving | Manual invoice creation is the launched path (vendor, rep, number, date, consignment flag, one row per inventory item). Statuses: Draft, Complete, Quick Invoice, Closed | [PUBLISHED] | `/docs/invoicing` |
| AI invoice scanning | Behind a feature flag: "upload invoice images for extraction, matching, and draft order creation (web + mobile)". Docs say mobile capture "does not automatically complete invoices" | [PUBLISHED] | feature-flags chunk; `/docs/mobile/invoice-scanning` |
| Purchase orders | Draft → send PDF to vendor rep → convert to linked invoice → complete. "Sending or exporting a PO does not receive stock." | [PUBLISHED] | `/docs/purchase-orders` |
| Recipes / batching | Recipe = ingredients + pour cost; Batching produces a *stocked* output item from a recipe, scalable by servings, output containers, or actual ingredient quantities, with labor + misc cost | [PUBLISHED] | `/docs/recipes`, `/docs/batching` |
| List publishing | Groups/subgroups, multiple sold-as prices per row, custom list-only price overrides, freehand rows, layout elements, separate WEB and PRINT styles, public URL + script embed + saved/downloadable PDF | [PUBLISHED] | `/docs/lists` |
| Reporting | 18 named reports across Inventory/Variance, Sales & Depletion, POS, and Purchasing; filter mode is per-report (Cycle, Date Range, or either) | [PUBLISHED] | `/docs/reporting` |
| Scheduled reports | Relative date presets ("Past 7 Days") rather than fixed dates, plus frequency, send time, recipients | [PUBLISHED] | `/docs/reporting` |
| Daily digest | Separate from scheduled reports: an org-level daily email with enable toggle, send time, and recipient list, configured in Settings → Notifications | [PUBLISHED] | `/docs/notifications` |
| Roles | Not a fixed role matrix — a permission-key grid, gated by a `feature_permissions` flag whose description is "Enable role-based access control. **When OFF, all users have full access.**" Keys seen: `inventory_read/write`, `items_read/write`, `invoices_read/write`, `variance_read/write`, `pos_read/write`, `pos_match_write`, `pos_ignore_write`, `reports_read`, `settings_read/write`, `costs_read`, `cycle_management_write` | [PUBLISHED] | feature-flags + permissions chunks |
| Multi-venue | `/org-group` with Home, Items, Locations, Reports, Sales, Users, Tickets, and roll-ups "Combined Last Night", "Combined 7-Day", "Combined Inventory Value" | [PUBLISHED] | build manifest + org-group chunk |
| In-app support | `feature_support_tickets`: "the ticket icon in the navbar, the Tickets settings tab, and the customer-facing thread of what they asked for and what we did about it" | [PUBLISHED] | feature-flags chunk |
| Pricing / business model | **No pricing is published anywhere.** `/pricing` → 404. Every CTA is "Book a Demo" → a Google Calendar booking link, framed as "15 minutes. No pressure. Just a conversation." A Billing tab exists inside Settings | [PUBLISHED] | bevrly.com; `/docs/settings` |

### 4.2 The full feature-flag list (their own roadmap, in their own words)

Every flag below is byte-verified from the public `admin-portal/feature-flags` bundle [PUBLISHED]:

| Flag | Description |
|---|---|
| `feature_permissions` | "Enable role-based access control. When OFF, all users have full access." |
| `feature_reports` | "Enable advanced reporting features with scheduling and cloud upload" |
| `feature_pos_item_matching` | "Enable Sold-As section and POS menu matching features" |
| `feature_chain_switching` | "Enable chain to next item and bulk POS item switching" |
| `feature_modifiers` | "Enable POS modifiers column and modifier management on sales page" |
| `feature_replacement_items` | "Enable replacement item suggestions and management" |
| `feature_invoice_scanning` | "Enable AI invoice scanning: upload invoice images for extraction, matching, and draft order creation (web + mobile)" |
| `feature_invoice_placement_confirm` | "…whether a placement modal pops up to confirm where each line's stock lands… When OFF, completing always auto-places stock at the default location (Recently Added)." |
| `feature_location_history` | "…what was ever stored in a location, what is there now, and where the rest of it went… Read only." |
| `feature_wine_reservations` | "Enable wine reservation system with channels, holds, and notifications" |
| `feature_support_tickets` | "Enable customer ticket tracking… the customer-facing thread of what they asked for and what we did about it." |
| `feature_r365_export` | "Enable Restaurant365 export functionality" |
| `feature_audit_settings` | Audit Settings |
| `require_inventory_date` | "Require users to set inventory date when starting inventory" |
| `simple_mode` | "Hide locations from the org entirely… The org keeps one location under the hood so stock still has somewhere to live. Turning this ON is refused for an org that already has more than one location. Turning it OFF is permanent in practice." |

`simple_mode` is the single most instructive line in the whole corpus: they shipped a
**complexity escape hatch** for venues that will never bin, and they wrote down the migration
trap in the flag description itself.

---

## 5. Information architecture

### 5.1 Web app — the real route map

The public build manifest exposes **78 route entries** [PUBLISHED], 15 of them under
`/admin-portal`. The main nav is defined verbatim in the shared bundle:

```
Home        → /insights
Inventory   → /inventory                        [perm: inventory]
              ├ All Locations   /inventory?location=all   (hidden in simple_mode)
              ├ Variance        /variance
              ├ Value Tracker   /value-tracker            [perm: costs]
              ├ Counting Mode   /counting-mode
              └ Location History /location-history        [flag: locationHistory]
Items       → /items                            [perm: items]
              ├ All Items · Recipes · Batches · Freehand Items
              ├ Sold Out · New Items
              ├ List Builder    /builder                  [perm: price_lists]
              └ Barcodes        /barcodes
Invoices    → /invoices (or /vendors)           [perm: invoices]
              └ All Invoices · Vendors · Consignment · Purchase Order
POS         → /pos                              [perm: pos]
              └ Menu · Sales · Modifiers [flag] · Shopify Pricing (only if an SH provider is active)
Reports     → /reports                          [flag: reports]
Org Group   → /org-group                        (only when the org belongs to a group)
```

Three structural notes worth stealing:

1. **Home is the daily insight page, not a landing page.** `/` for a signed-in user means
   yesterday's numbers, not a dashboard of navigation tiles.
2. **Every nav entry carries a `permission` and some carry a `featureFlag`.** The nav is
   computed, not static — an org with no POS never sees a POS tab.
3. **Counting Mode is a top-level destination under Inventory**, not a modal. Counting is a
   place you go and stay for an hour, and the IA respects that.

Routes not surfaced in the nav but present in the build: `/staged-counts`, `/counting/finalize`,
`/matching`, `/new-items`, `/price-optimizations`, `/ecomm-pricing`, `/wine-reservations`
(+`/channels`, `/settings`), `/chat`, `/chat-search`, `/ai-questions`, `/tickets`,
`/invoice-processing`, `/item-details`, `/docs/[[...slug]]`, and a 15-page `/admin-portal/*`
internal console.

### 5.2 The internal admin console (their operational tell)

`/admin-portal` groups into four sections [PUBLISHED, admin nav chunk]:

- **Overview** — Homebase, Tickets
- **Data Cleanup** — Data Monitor, Cleanup Runs, Field Rules, Local Items ("Raise-Up Queue"), Vendors ("Canonical Links")
- **Organizations** — Org Groups, Create Org ("Provision"), Demo Orgs ("Sandbox"), Delete Org ("Danger Zone")
- **Platform** — Feature Flags ("Toggles"), AI Costs ("Usage Ledger")

The existence of a *Data Cleanup* section with its own queue, rules engine and cleanup-run history
tells you the truth about this category: **catalogue hygiene is the real product**, and it is
labour, not magic.

### 5.3 iOS app

Store name is **"Bevrly Inventory"** (the `bevrly-inventory-scanner` slug 301-redirects), subtitle
"Restaurant Operations Platform", category Utilities, free, iOS 17.0+, 34.3 MB, bundle
`com.zvndev.BevrlyMobileV3` [PUBLISHED]. The entire App Store description is one sentence:
*"Bevrly Mobile allows you to take inventory of your restaurant's beverage program using barcode
scanning hardware."* [PUBLISHED]

Documented app structure [PUBLISHED, `/docs/mobile`]:

| Tab | Contents |
|---|---|
| Inventory | Browse/search/filter, cached for low-signal cellars, **Write Mode** (= direct Inventory Mode), Product Detail |
| Counting | four sub-modes — **Scan** (Camera or Socket Mobile), **Manual**, **History** (edit/delete before finalisation), **Done** |
| Search | by item name, barcode, or vintage |
| Settings | Organization switcher, Hardware Scanner + Setup & Debug, Count Sheets / Upload History, Help → How to Count (replayable tutorial) and Refresh Inventory, About, Sign Out |

Note the discipline: **the scanner lives inside the one app**, and the docs say so explicitly —
"Socket Mobile scanning is built into the main Bevrly mobile app. Do not direct users to download
a separate scanner app." Note also the offline-first affordances: refresh-cache-before-you-go, and
an upload history you can inspect after the fact.

---

## 6. The count → variance → close flow, step by step

This is the part of Bevrly worth studying line by line.

**1. Prepare.** Process pending invoices and record known Adjustments *before* counting —
"Unprocessed deliveries create false negative variance" [PUBLISHED].

**2. Set the inventory date.** "The official timestamp marking the last POS sales that should be
included in the cycle you are closing." A separate **pause time** is "the exact boundary when POS
polling and cycle routing stop applying activity to the old cycle" [PUBLISHED]. The UI shows both:
the counting-mode header renders a "Sales pause" timestamp.

**3. Choose the uncounted policy up front.** Not at the end — at the start. **Zero Out Uncounted**
("anything not counted is treated as zero at cycle close") vs **Keep Uncounted** ("uncounted items
keep calculated running stock"). The docs warn plainly: "If you count only spirits and zero out
uncounted, wine and beer can be reset to zero." [PUBLISHED]

**4. Count blind.** "Counting Mode is intentionally blind and count-from-zero: counters report
what they physically see. They should not see expected running stock." The rationale is stated:
"Without blind counting, counters tend to 'find' the expected number. Seeing 'Expected: 12' and
counting 11, they might convince themselves they missed one. This hides real variance."
[PUBLISHED]

The counting surface itself: search on 2–3 characters, barcode scan (a rescan of a visible item
increments by 1), `+`/`−` for small deltas, a *floating keyboard that stays open between items*
for direct entry, and a **partial-bottle slider** with 1/4 · 1/2 · 3/4 · Full presets and an
animated bottle graphic that fills as you drag. "Partials are stored as decimals (half-full =
0.5)." [PUBLISHED] The docs even quantify why it matters: "Twenty bottles off by 0.1 each = 2 full
bottles of variance every cycle."

**5. Stage, don't write.** Mobile and desktop Counting Mode entries land in a staging queue.
Three tabs — **Counting** (everyone), **History** (counters + managers: edit/delete your own
entries, filterable by user, by location, and by upload batch), **Confirm** (managers only).

**6. Distribute.** Where counts lack an exact location, the Confirm tab proposes **distribution
rows** allocating the counted quantity across locations, following reverse depletion priority
(backstock first). The manager can edit any row before writing. On write, if a location already
has a stocktake this period, a modal asks: "Choose whether the new counts should add on top of the
existing counts or replace them." [PUBLISHED]

**7. Write.** "Write Selected (N)" / "Write All (N)" turn staged rows into official stocktakes.
Guard rails in the UI: "Count uploads are still processing - wait to write", "No staged counts
found for selected items", and a banner distinguishing "Writing to Current Inventory" from
"Writing to Previous Inventory".

**8. Read variance.** The `/variance` grid's columns, verbatim from the bundle [PUBLISHED]:

> Item Name · Category · Barcode · Type · Location · Consigned · **Starting Qty · Purchases ·
> Sales · Manual Adjustments · Running Count · Actual Count** · Unit Cost · Actual Count Cost ·
> **Variance Qty · Variance Cost · Variance %** · Actual COGS $ · Actual COGS % · All Depletions
> COGS $ · All Depletions COGS % · Running Count Value · Actual Value · Value Variance · Sales
> Revenue · COGS $ · COGS %

That middle run is the whole idea: **the variance row shows its own arithmetic.** A manager reads
left to right and sees exactly which input produced the gap. Advice is equally concrete: "Always
start with cost variance, not percentage. A 50% variance on a $5 mixer matters less than a 3%
variance on a $200 bottle of wine."

**9. Correct at the source, never at the count.** The Correct Variance flow maps each cause to the
record that should be fixed [PUBLISHED, `/docs/inventory/variance-corrections`]:

| Source problem | Correct in | Example |
|---|---|---|
| Miscount | Count / stocktake correction | Counter missed the back shelf |
| Missing receiving | Invoice | Delivery arrived before the inventory date, invoice not completed |
| Known stock loss | Adjustment | Breakage, waste, comp, theft, spill |
| Location mismatch | Movement | Product moved from cellar to bar during the count |
| Sales depletion issue | POS matching | POS item unmatched or mapped to the wrong bottle/recipe |
| Timing issue | Inventory date / pause time | Sale or invoice belongs on the other side of cycle close |

with the standing rule: **"Do not manually force counted stock to expected stock without
evidence."**

**10. Close.** Explicit checklist, then a manual **End Cycle** button — the date boundary alone
never closes a cycle. Counted values become the next cycle's baselines.

**11. Audit.** With Audit Mode on, the closed cycle enters a review window (duration configurable,
"the app currently allows up to 20 days" [PUBLISHED]) while the new cycle keeps running. A
floating **Current Cycle / Previous Cycle (Audit)** toggle re-targets writes. Every previous-cycle
edit that could touch the current cycle shows an **impact preview** with old and new values in
both cycles, and three buttons: *Save and propagate* · *Save without propagating* · *Cancel*.
The docs are explicit that this is per-action, not a batch job: "Because propagation happens per
action, ending audit mode is a lock step, not a recalculation step." A closed audit can be
reopened, but only for the immediately previous cycle.

**Why this design is good.** It separates four things Terroir currently blurs: *what the count
said*, *what the system expected*, *which record was wrong*, and *whether fixing history should
change today*. Most inventory tools collapse the last two and quietly rewrite the present.

---

## 7. How a wine enters the system, and how identity is matched

There is **no LWIN, no Wine-Searcher, no Vivino and no GS1 identifier** anywhere in Bevrly's
client bundles [PUBLISHED — a case-insensitive grep across all 135 public JS chunks returns zero
hits for `liv-ex`, `wine-searcher`, `vivino` and `gs1`; the single `lwin` hit is the substring
inside the package name `react-tailwindcss-datepicker`]. Their identity model is entirely
home-grown and has two tiers:

**Tier 1 — Universal Items.** A shared master catalogue. In the matching UI, a universal item with
`organization_id == null` is a **global parent**; one with an `organization_id` is a **local
parent**. The filter is literally labelled "Global + Local Parents", and the empty state reads
"All inventory items have been matched to universal items, or there are no items to display."
[PUBLISHED]

**Tier 2 — Inventory Items.** The org's own countable rows, each matched up to a universal item.
The admin "Local Items" queue is subtitled **"Raise-Up Queue"** and its states are *Merge conflict
review*, *Ready to promote*, *Needs enrichment*, *Broken type*, *All local*, *Unmatched inventory*
[PUBLISHED] — i.e. a local item earns promotion into the global catalogue after enrichment and
conflict review.

**The field taxonomy** is a two-letter typed vocabulary, each value carrying a UUID that points at
a canonical dictionary row. From the bundle [PUBLISHED]:

> PR Producer · BD Brand · WN Winery · TY Subtype · VN Vintage · CA Category · CT Country ·
> RG Region · SG Subregion · AP Appellation · VT Variety · VY Vineyard · DG Designation ·
> AV ABV · PF Proof · TG Tag · NT Note · CM Custom · BR Brewery · DS Distillery ·
> MZ Mezcallery · KU Kura (Sake Brewery) · CD Cidery · BT Bottler · CO Cooperage ·
> MA Maltster · GR Grapes · ST Style · AG Aging · BL Blend · FN Finish · RP Rice Polishing ·
> SM SMV (Sake Meter Value) · BA Barrel · FP Flavor Profile · OR Origin · AT Agave Type · MT …

And a **per-family field rulebook** drives cleanup, verbatim for wine [PUBLISHED]:

```
item_type_code: "WI", family: "Wine"
required:      ["CT Country", "PR Producer"]
recommended:   ["RG Region", "AP Appellation", "VT Variety", "SG Subregion"]
optional:      ["DG Designation", "VY Vineyard", "CA Category", "GR Grapes", "TN Tasting notes"]
inventory_specific: ["VN Vintage", "CM Custom/barcode/vendor codes", "SKU/UPC when vendor-specific"]
disallowed:    ["BR Brewery", "IB IBU", "HP Hop type", "MT Malt type", "DS Distillery",
                "MZ Mezcalero", "KU Kura", "RC Rice polishing", "SM Sake meter value", "PF Proof"]
missing_dictionary_concepts: ["country aliases", "region/appellation hierarchy",
                              "variety/blend aliases", "designation/vineyard phrase normalization"]
```

Note that **vintage is `inventory_specific`, not part of universal identity** — a deliberate,
debatable modelling choice: the universal item is the *wine*, the inventory item is the *bottling*.

**The four entry paths** [PUBLISHED, `/docs/getting-started/adding-items`]:

1. **Onboarding import** — the Bevrly team does it, from BinWise (they will take BinWise *login
   credentials* through a "secure onboarding process" and pull the Perpetual Inventory Detailed
   report plus recipes), a POS menu sync, or a spreadsheet.
2. **Manual creation** with name, type, size, and any barcode/vintage/cost/vendor.
3. **Invoice line item** — creating the item while receiving it.
4. **POS menu item** — which is explicitly *not* an inventory item; it must be matched to one.

**Matching is AI-assisted but human-gated at every level.** "Matching suggestions are a pre-match
assist… but a user still needs to verify the match." [PUBLISHED] The AI cost ledger names the
distinct matching pipelines: `pos_item_matching`, `pos_match_ingest`, `universal_item_matching`,
`item_enrichment`, `field_matching`, `invoice_extraction`, `invoice_matching` [PUBLISHED].

**Barcodes are org-local, not global.** The `/barcodes` page is a *print-job* builder ("Click the
Create New Job button to print your first batch of barcodes"), and Cote's public list shows a
`barcode` of `"3683"` — a four-digit house bin number, not a UPC [PUBLISHED]. Freehand items get
an "auto-generated barcode". So the barcode field is a **shelf-label identifier the venue prints
and sticks on**, which is why a hardware scanner works at all on wine that has no scannable trade
barcode.

---

## 8. Design language

### 8.1 The application

- **Stack signature**: Next.js **Pages Router** on Vercel, Tailwind + **HeroUI** (NextUI's
  successor — 1,776 references in the bundles), AG Grid for the data grids, Recharts for charts,
  SWR + React Query, Zod, jsPDF + html2canvas + pdf.js for PDF, xlsx/exceljs + PapaParse for
  spreadsheets, Sentry (a `/monitoring` rewrite and a `/sentry-example-page` route), trigger.dev
  for background jobs, PostHog in the admin console, Slack webhooks, Linear for issues
  (`linear.app/bevrly`) [PUBLISHED, all from public bundles].
- **Palette**: indigo primary (`--accent-primary: #4f46e5` light / `#6366f1` dark), slate ink
  (`--ap-ink: #0f172a`, `--ap-ink-dim: #64748b`), emerald success, rose/red danger, amber warning.
  Radius `--ap-radius: 14px`. Two-layer shadows. **Full dark mode** — every component class in the
  bundle carries a `dark:` variant [PUBLISHED].
- **Semantic colour is load-bearing, not decorative**: amber = staged/pending, green = written,
  red = variance, indigo = interactive. The counting rows use `border-l-2` colour bars rather than
  fills, so a long list stays readable.
- **They built their own table primitive**, prefixed `yable-` (`yable-th`, `yable-td`, `yable-tr`,
  `yable-bg-row-hover`, `yable-accent`, `yable-transition-fast`) — 1,951 references [PUBLISHED].
- **Microcopy is the strongest thing about the product.** Not "Error: constraint violation" but
  "*The item locations you're writing already have stocktakes in the current inventory period.
  Choose whether the new counts should add on top of the existing counts or replace them*";
  "*Uploaded data may take a minute or two to process — new counts will appear here
  automatically*"; "*You need the Inventory Close permission to close inventory*"; "*nothing to
  write (all counts were 0)*". Every refusal explains itself and names the next move.

### 8.2 The public guest lists

The guest page is fully public and unauthenticated. It fetches two endpoints:
`/api/public-apis/list-viewer?id=<slug>` and `/api/public-apis/<slug>/styles?type=WEB|PRINT`
[PUBLISHED].

Cote's live list (`/list/550-madison-wine-list`, "COTE 550 List") contains **1,685 items across
320 groups** [PUBLISHED, counted from the API response].

The style record has **187 fields** [PUBLISHED]. Highlights:

| Aspect | How it works |
|---|---|
| Typography | Up to six independently-styled roles (header, level-1/2/3+ subgroup headers, body text, description), each either a Google Font (auto-`@import`ed) or a **custom TTF the venue uploads**, injected as `@font-face`. Cote uses SangBleu Sans Regular/Italic/Bold from Backblaze B2 |
| Columns | Five configurable columns; each has content, style, width, alignment. Content enum: `ITEM_NAME · VINTAGE · PRICE · BARCODE · BIN · SIZE · REGION · SUBREGION · STYLE · VINEYARD · APPELLATION · DESIGNATION · PRODUCER · NONE` |
| Colour | Per-role colours. Cote: gold `#97760F` headers, forest `#00472E` body, white ground |
| Numbers | `render_decimals`, `show_currency_symbol`, `show_price_commas` as separate toggles — Cote renders a bare `100` with no currency symbol and no decimals [PUBLISHED] |
| Web vs print | Two independent records. Cote's print style is LETTER portrait, 60pt side margins, 65pt section spacing, page numbers off, a styled table of contents; the web style is 900px wide, 20px margins, page numbers on, no TOC |
| Images | Six image slots — logo, top, bottom, section-split, page-top, page-bottom — each with width %, four margins, and alignment |
| Rich text | Item rows can carry raw HTML: Cote's Bollinger row is `custom_text: "<p>NV Bollinger, Special Cuvée, Brut</p>"`, rendered via `dangerouslySetInnerHTML` |

**And here is the flaw.** The generated stylesheet contains **zero `@media` queries** [PUBLISHED —
verified by parsing the generator template in the public bundle]. `.list-container` is
`max-width: ${page_width}px; margin: 0 auto;` with `grid-template-columns` in fixed percentages.
Cote's page_width is 900. So on a phone, the guest gets a 900px page scaled down — a PDF pretending
to be a web page. There is no search, no filter, no images on rows, no by-the-glass toggle, and no
availability signal, on a list with 1,685 wines.

**And here is the workaround it forces.** Because there is no page-break primitive, Cote's list
contains **six separate top-level groups all named "CHAMPAGNE"** (out of 84 top-level groups) and subgroups whose names are
strings of invisible Unicode characters (`"‎ ‎ ‎ ‎ ‎ "`) used purely as vertical spacers
[PUBLISHED, visible in the API response]. A sommelier is hand-simulating pagination with
zero-width characters. That is a product gap wearing a customer's clothing.

---

## 9. Public architecture and data facts

| Fact | Value | Tag |
|---|---|---|
| Web framework | Next.js Pages Router, `buildId: build-TfctsWXpff2fKS`, deployed on Vercel (`data-dpl-id="dpl_JEF1ZsMx4e3zmyo3DjP67p3Ec481"`) | [PUBLISHED] |
| Route count | 78 entries in the build manifest, of which 15 are `/admin-portal/*` | [PUBLISHED] |
| Mobile | Native SwiftUI ("Full Native Swift App Rebuild", v1.4.2 release notes); docs reference the "SwiftBevrly Settings view" | [PUBLISHED] |
| Background jobs | trigger.dev (`api.trigger.dev`, `id.trigger.dev`) | [PUBLISHED] |
| Error monitoring | Sentry (`/monitoring` rewrite, `sentry-example-page` route, per-chunk debug IDs) | [PUBLISHED] |
| Product analytics | PostHog, admin-only; the UI degrades gracefully — "PostHog isn't configured on this deploy" | [PUBLISHED] |
| Issue tracker | Linear (`linear.app/bevrly/issue/`) linked from in-app tickets | [PUBLISHED] |
| Asset storage | Backblaze B2 (`f005.backblazeb2.com/file/bev-lists/`) for list fonts | [PUBLISHED] |
| POS endpoints seen | `restaurantapi.spoton.com/posexport/v1`; `bevrly.com/api/pos/simphony/ingest`; a deep link to `toasttab.com/restaurants/admin/menus/bulk` | [PUBLISHED] |
| Toast write-back | `/new-items` builds **Toast buttons** — "Create Toast Buttons", "Toast Button Name", "Toast Menu", "Toast Menu Group", "Awaiting Toast sync", with `visible_to_kiosk` / `visible_to_online` flags | [PUBLISHED] |
| Accounting export | Restaurant365 (`feature_r365_export`) | [PUBLISHED] |
| AI cost ledger | Per-call ledger with Total cost, AI calls, Input/Output/**Cached** tokens, Errors, filterable by Feature × Provider × Model × Organization, with a daily-cost bar chart | [PUBLISHED] |
| AI features metered | `invoice_extraction`, `invoice_matching`, `invoice_processing`, `assistant_chat`, `assistant_agent`, `assistant_find_element`, `in_app_feedback`, `pos_item_matching`, `pos_match_ingest`, `universal_item_matching`, `item_enrichment`, `field_matching`, `ai_chat` (legacy), `ai_pipeline`, `benchmark`, `ai_test` | [PUBLISHED] |
| AI evaluation | An `/ai-questions` page titled "AI Agent Benchmarks" with Total Questions, per-run quality grading, and a human-approved-for-training toggle | [PUBLISHED] |
| Marketing surface | Home, `/switch`, `/landing` (stale, © 2024), `/docs`, `/privacy`, `/login`, `/list/*`. `/pricing`, `/features`, `/product`, `/blog`, `/careers`, `/case-studies`, `/integrations`, `/help`, `/security`, `/terms` all **404** | [PUBLISHED] |
| Subdomains | `reserve.bevrly.com` is referenced twice in the wine-reservations code but **does not resolve in DNS** — the feature ships in the bundle but is not publicly live | [PUBLISHED] |
| Data collection declared | App Store: "The developer does not collect any data from this app." Play: "No data shared with third parties / No data collected." | [PUBLISHED] |

---

## 10. Adopt for Terroir — ranked

Terroir today has `/scan`, `/cellar` (bins, open bottles, pour, reconcile), `/atlas`, `/lists`,
`/insights`, `/team`, plus a reconcile queue with LWIN-based suggestions
(`src/lib/reconcile-queue/types.ts`) and per-bottle pour variance in millilitres
(`src/lib/reconciliation/variance.ts`). The gaps below are ranked by value-per-unit-of-build.

| # | Adopt | Maps onto | Copy this | Do better | Size |
|---|---|---|---|---|---|
| **1** | **The inventory cycle as a first-class object** — a period with a start, an inventory date, a sales-pause boundary, a manual close, and counted values that become the next period's baseline | Nothing in Terroir today; `/cellar` state is continuous with no periods | The vocabulary and the boundary discipline: *inventory date* ≠ *pause time* ≠ *close click*. Baselines carry forward | Terroir already has richer per-bottle state (open bottles, partial ml). Make the cycle close *reconcile open bottles too*, which Bevrly cannot do — it only stores a 0–1 decimal | **L** |
| **2** | **Variance row that shows its own arithmetic** — `Starting Qty · Purchases · Sales · Manual Adjustments · Running Count · Actual Count · Variance Qty/Cost/%` as adjacent columns | `/insights` + `src/lib/reconciliation/variance.ts` (currently ml-only, per open bottle) | The column order. A manager should never have to click to learn *why* a number moved | Terroir has real per-pour data. Add a **Pour Variance** column alongside unit variance — the ml-level gap Bevrly structurally cannot compute | **M** |
| **3** | **Blind Counting Mode with staged counts and a manager Confirm step** | New surface, sits inside `/cellar` or as a sibling tab | Blind-by-default with the stated rationale; three tabs (Counting / History / Confirm); floating keyboard that stays open; `+`/`−` for 1–2 units, tap-the-number for big changes; scan-to-increment | Bevrly's distribution step exists *because* counts arrive without a location. Terroir has real bins — let a counter scan a bin label first and every count in that session is location-bound, so distribution is rarely needed at all | **L** |
| **4** | **Audit Mode with per-action impact preview and explicit propagation** | Nothing in Terroir | The three-button choice — *Save and propagate* / *Save without propagating* / *Cancel* — plus a before/after preview across both periods, and the rule that ending audit is a lock, not a recalculation | Show the propagation delta **per bin**, not per item, and log an audit trail row for every propagation decision with the actor and the reason | **M** |
| **5** | **Daily digest email + a Home page that is that digest** | `/insights` exists; there is no email and no day-scoped home | The exact panel set: Total Sales · Check Total · Average Bottle Price · Median Bottle Price · Average Bottle Profit · Top Bottle Sales · Top BTG Sales · Top Liquor Sales · Top Cocktail Sales · Consignment Sales · Recently 86'd Items · Beverage Breakdown (Type/Units/Revenue) · Sleepy Inventory (unsold 90 days). Plus prev/next-day arrows and per-org send time + recipient list | Bevrly's digest is a scoreboard. Terroir's should be a **worklist**: three things to do today, each deep-linked — driven by the existing `briefing-alert-card` and cellar-health signals | **M** |
| **6** | **Correct-Variance-at-the-source, with an evidence taxonomy** | `/cellar` reconcile + `stock-adjustments` API | The cause→record mapping table (miscount → stocktake; missing receiving → invoice; loss → adjustment with reason code; location → movement; depletion → POS match; timing → date boundary), the configurable reason codes (breakage, waste, comp, spill, theft, receiving error, found item, count correction), and the standing refusal to let a user force counted = expected without evidence | Require a note on any correction over a configurable dollar threshold, and surface the note in the variance export | **M** |
| **7** | **List-builder style engine: separate web and print styles, custom uploaded fonts, five configurable columns** | `/lists`, `src/app/list/[slug]/` | Two independent style records per list (WEB / PRINT); per-role typography with venue-uploaded font files; the column-content enum (`ITEM_NAME · VINTAGE · PRICE · BIN · REGION · APPELLATION · PRODUCER · …`); separate `render_decimals` / `show_currency_symbol` / `show_price_commas` toggles; multiple sold-as prices per row with list-only price overrides | **Make the web version actually responsive** — Bevrly's has zero media queries and a fixed 900px page. Ship a real page-break primitive so no one ever again names a group with invisible Unicode. Add guest-side search, a BTG filter, and live availability, which Terroir's live cellar data makes trivial and Bevrly's does not | **L** |
| **8** | **A feature-flag + permission-key layer, with `simple_mode` as the model** | `/team` has owner/manager/staff roles today | Permission *keys* not fixed roles (`inventory_read/write`, `costs_read`, `variance_write`, `cycle_management_write`), a nav computed from them, and above all `simple_mode`: one switch that hides binning entirely for venues that will never use it, refused if the org already has multiple bins, and honestly documented as effectively one-way | Terroir serves both collectors and restaurants from one codebase, so this matters *more* than it does for Bevrly. Make the personal-cellar mode the default and let a restaurant opt into the machinery | **M** |
| **9** | **Partial-bottle capture as a slider with presets** | Terroir already stores open-bottle volume in ml | The interaction — tap the count badge → slider + 1/4 · 1/2 · 3/4 · Full, with a bottle graphic that fills live; and the training content (calibration exercise, keg weights, "if in doubt, round down") | Terroir's ml precision beats a 0–1 decimal. Offer both: the fast slider for a floor count, exact ml when the bottle is weighed. Bevrly documents the weight formula but does not implement it — Terroir should | **S** |
| **10** | **Location model: hierarchy + `priority` + `available` toggle + a "Recently Added" receiving queue** | `/bins` and `src/app/(app)/cellar/bin-data.ts` | The receiving-queue concept above all: stock that has arrived but has no shelf yet lands in a named holding location, and cleaning it out is an explicit chore. Plus `available` (retire a location without deleting it) and `priority` (drives depletion order) | Terroir's bins are physical slots, which is strictly better. Add a *depletion priority* on the bin so service pulls from the right place, and a bin-level "needs placement" count on the cellar header | **S** |
| **11** | **AI cost ledger + AI benchmark harness** | Terroir calls Claude for bottle scan and invoice extraction with no metering | A per-call ledger keyed on feature × provider × model × org, tracking input / output / **cached** tokens and errors, with a daily cost chart; plus a golden-question set with per-run quality grading and a human-approved-for-training flag | Terroir's scan pipeline is the exact place this pays for itself. Add cost-per-successful-extraction as the headline metric, not raw spend | **M** |
| **12** | **"Sleepy Inventory" and list-coverage filters** | `/insights` has cellar health; `/lists` has no coverage view | *Sleepy Inventory* = has stock, no sales in 90 days. And the `/new-items` filters "Show only items that are on no list" / "on a list", plus the `Needs Binning` / `Needs Matching` status chips | Terroir can do better than sleepy: cross drink-window data with sales to flag **wine that is both unsold and approaching the end of its window** — capital at risk of becoming worthless, not merely idle | **S** |
| **13** | **Documentation as product surface** | Terroir has `docs/runbooks/` for internal use | 48 public MDX pages with a QuickPath box at the top of every page, an explicit **Feature Vocabulary** table ("Say This / Do Not Say / What It Means / Primary Page"), and a Workflow Coverage Map listing every route with its real-life job and its correction branch | The vocabulary table is the cheapest, highest-leverage artefact here — write Terroir's before the next feature, not after | **S** |
| **14** | **Report scheduling with relative date presets** | Terroir has exports, no schedules | "Scheduled reports use relative date presets, not hard-coded calendar dates" — a weekly schedule uses "Past 7 Days" so every delivery is a fresh rolling window | Ship the audience→report→frequency defaults with it (GM: variance summary weekly; buyer: sleepy + sold-out weekly; accountant: invoices monthly) | **S** |
| **15** | **Multi-venue org groups** | `/team` is single-venue | The roll-up vocabulary — Combined Last Night, Combined 7-Day, Combined Inventory Value, plus per-venue status chips (Current / Paused / Audit / Counting) and a counting-progress bar | Only build this when a real group asks. Bevrly's `/org-group` is a thin mirror of the main nav | **M** |

---

## 11. What NOT to copy, and why

1. **The go-to-market.** No pricing page, no self-serve signup, every CTA a demo booking. That
   choice caps you at what two people can onboard by hand — and Bevrly's onboarding literally
   involves the vendor taking a customer's *BinWise login credentials* to run the migration
   [PUBLISHED, `/docs/onboarding/binwise-migration`]. Terroir should never ask for third-party
   credentials, and should publish a price.

2. **The non-responsive guest list.** Zero media queries, a fixed 900px page, no search, no
   filter, no images, no availability, on a 1,685-wine list. Guests read wine lists on phones.
   This is Bevrly's single clearest product weakness and Terroir's clearest opening.

3. **Faking pagination with invisible Unicode.** The absence of a page-break primitive pushed a
   real customer into naming groups `"‎ ‎ ‎ ‎ ‎ "`. Ship the primitive.

4. **Surface-area sprawl.** 78 route entries for a two-person company, including `/chat`,
   `/chat-search`, `/ai-questions`, `/price-optimizations`, `/ecomm-pricing`, `/value-tracker`,
   `/consignment`, and a `/wine-reservations` module whose own `reserve.bevrly.com` subdomain does
   not resolve. Terroir's deliberate 5-tab IA (documented in `src/app/(app)/nav-links.tsx` as a
   7→4→5 consolidation to survive a 390px phone) is the better instinct. Keep it.

5. **A home-grown universal catalogue with no external anchor.** Bevrly built its own two-tier
   Universal/Local item model, its own dictionary tables, its own promotion queue, its own field
   rules, and its own AI enrichment — and then needed a whole admin section (Data Monitor, Cleanup
   Runs, Field Rules, Raise-Up Queue, Canonical Vendors) to keep it upright. Terroir already has
   LWIN (211,498 rows) and X-Wines (100,646). **Anchor on the public identifier and spend the
   saved effort on the count flow.** Bevrly's model is the right answer for spirits, beer and sake,
   where no LWIN exists — adopt the *typed-field-with-dictionary-UUID* pattern, not the
   build-your-own-wine-catalogue conclusion.

6. **Barcodes as the primary identity.** Bevrly's `barcode` field is really a printed shelf label
   (Cote's Bollinger is `"3683"`). That works because they print the labels. It does not
   generalise, it breaks on any wine that arrives unlabelled, and it is strictly worse than
   Terroir's label-scan + LWIN path for wine specifically. Keep barcodes as an *accelerator* for
   repeat counting, never as the identity.

7. **Vintage as an inventory-only attribute.** Defensible for a bar; wrong for a cellar. Terroir's
   per-vintage history is a real advantage — do not flatten it to match Bevrly's model.

8. **Permissions off by default.** `feature_permissions` OFF means "all users have full access."
   For a product touching cost, pricing and staff analytics that is the wrong default. Ship
   least-privilege on, with a documented escape hatch.

9. **A separate legacy marketing page.** `/landing` still says © 2024, still lists only Square and
   Toast, and still serves hero images from **Discord's CDN** (`media.discordapp.net/...`), which
   will rot. Two live marketing pages that disagree is a maintenance smell.

10. **Their App Store listing.** One sentence, category "Utilities", zero ratings, and a name that
    still 301-redirects from an old slug. Meanwhile the Play listing has a completely different and
    better pitch ("Manage Inventory, Scan invoices with AI, scan barcodes, count…"). Two stores,
    two stories, no reviews. Terroir should ship one story and ask for reviews.

---

## 12. Gaps — what is NOT publicly available

- **Pricing.** No figure exists anywhere public. Not on the site, not in an app store, not in a
  review site, not in a press mention.
- **Customer count, retention, ARR, headcount beyond the LinkedIn 2–10 band.** Never published.
- **Funding.** Zero SEC Form D, no Tracxn or Crunchbase profile reachable. An unreported angel
  round cannot be excluded; an institutional round is very unlikely given the Form D absence.
- **The authenticated UI itself.** No screenshots of the live app beyond the 31 published in
  `/docs`. Counting Mode, Variance, Audit Mode and the Builder were all reconstructed from
  first-party documentation plus public JS strings, not from using the product.
- **The daily email's actual rendered content.** The Insights panel set is byte-verified; whether
  the email mirrors it exactly is inferred from the docs' framing of both as "summary" surfaces.
- **Whether the wine-reservations module is live for any customer.** It ships in the bundle behind
  a flag and references a subdomain that does not resolve.
- **G2 / Capterra / Reddit sentiment.** None found. This is a genuine void, not a search failure.

---

## 13. How to verify the private numbers

1. **Pricing** — book the demo at the public Google Calendar link on bevrly.com and ask directly;
   or ask any of the 15 named venues' beverage directors, several of whom are publicly reachable.
2. **Customer count** — the `/api/public-apis/list-viewer` endpoint is unauthenticated and
   slug-addressed. Public list slugs found in the wild (or guessed from venue names) each confirm
   one live customer using Lists. That is a floor, not a total, and only counts list users.
3. **Funding** — re-run the EDGAR full-text search quarterly (`efts.sec.gov`, `forms=D`) and check
   Delaware/NY registries under "Bevrly Inc." rather than "Bevrly".
4. **Real app adoption** — watch the Google Play install bucket. It steps 1+ → 5+ → 10+ → 50+ →
   100+; each step is a public signal. Watch the App Store rating count for a first non-zero.
5. **Toast relationship** — re-check the partner directory. A listing appearing would mean a
   certified integration and a distribution channel; its continued absence means the Toast path is
   private API + SFTP only.
6. **Team size** — LinkedIn's "Discover all N employees" count is the cheapest recurring signal.

---

## 14. Sources

**Primary (Bevrly, first-party)**
[bevrly.com](https://bevrly.com/) ·
[bevrly.com/switch](https://bevrly.com/switch) ·
[bevrly.com/landing](https://bevrly.com/landing) ·
[bevrly.com/docs](https://bevrly.com/docs) and its 48 sub-pages, notably
[workflows](https://bevrly.com/docs/workflows),
[cycle-overview](https://bevrly.com/docs/inventory/cycle-overview),
[running-stock](https://bevrly.com/docs/inventory/running-stock),
[counting](https://bevrly.com/docs/inventory/counting),
[counting-modes](https://bevrly.com/docs/inventory/counting-modes),
[counting-mode-guide](https://bevrly.com/docs/inventory/counting-mode-guide),
[partial-bottles](https://bevrly.com/docs/inventory/partial-bottles),
[stocktakes](https://bevrly.com/docs/inventory/stocktakes),
[variance](https://bevrly.com/docs/inventory/variance),
[variance-corrections](https://bevrly.com/docs/inventory/variance-corrections),
[setting-inventory-date](https://bevrly.com/docs/inventory/setting-inventory-date),
[ending-cycle](https://bevrly.com/docs/inventory/ending-cycle),
[audit-mode](https://bevrly.com/docs/inventory/audit-mode),
[adjustments](https://bevrly.com/docs/inventory/adjustments),
[movements](https://bevrly.com/docs/inventory/movements),
[mobile-counts](https://bevrly.com/docs/inventory/mobile-counts),
[pos-integration](https://bevrly.com/docs/pos-integration),
[item-matching](https://bevrly.com/docs/pos-integration/item-matching),
[matching-suggestions](https://bevrly.com/docs/pos-integration/matching-suggestions),
[invoicing](https://bevrly.com/docs/invoicing),
[processing-invoices](https://bevrly.com/docs/invoicing/processing-invoices),
[purchase-orders](https://bevrly.com/docs/purchase-orders),
[recipes](https://bevrly.com/docs/recipes),
[batching](https://bevrly.com/docs/batching),
[freehand-items](https://bevrly.com/docs/freehand-items),
[lists](https://bevrly.com/docs/lists),
[locations](https://bevrly.com/docs/locations),
[reporting](https://bevrly.com/docs/reporting),
[notifications](https://bevrly.com/docs/notifications),
[permissions](https://bevrly.com/docs/permissions),
[users](https://bevrly.com/docs/users),
[settings](https://bevrly.com/docs/settings),
[onboarding](https://bevrly.com/docs/onboarding),
[binwise-migration](https://bevrly.com/docs/onboarding/binwise-migration),
[adding-items](https://bevrly.com/docs/getting-started/adding-items),
[mobile](https://bevrly.com/docs/mobile),
[mobile/scanner](https://bevrly.com/docs/mobile/scanner),
[mobile/counting](https://bevrly.com/docs/mobile/counting),
[mobile/invoice-scanning](https://bevrly.com/docs/mobile/invoice-scanning),
[mobile/settings](https://bevrly.com/docs/mobile/settings)

**Primary (Bevrly, public application artefacts)**
`https://bevrly.com/_next/static/build-TfctsWXpff2fKS/_buildManifest.js` (74-route map) ·
135 public JS chunks under `https://bevrly.com/_next/static/chunks/` (nav tree, feature flags,
permission keys, POS enum, field taxonomy, variance columns, insights panels, AI cost ledger,
list-style generator) ·
6 public CSS bundles under `https://bevrly.com/_next/static/css/` ·
[public list page](https://bevrly.com/list/550-madison-wine-list) and its two unauthenticated APIs
`https://bevrly.com/api/public-apis/list-viewer?id=550-madison-wine-list` and
`https://bevrly.com/api/public-apis/550-madison-wine-list/styles?type=WEB|PRINT` ·
[privacy policy](https://bevrly.com/privacy)

**App stores**
[App Store — Bevrly Inventory id6740220524](https://apps.apple.com/us/app/bevrly-inventory/id6740220524) ·
[iTunes lookup API](https://itunes.apple.com/lookup?id=6740220524) ·
[Google Play — com.bevrly](https://play.google.com/store/apps/details?id=com.bevrly)

**Company records**
[LinkedIn — Bevrly](https://www.linkedin.com/company/bevrly) ·
[SEC EDGAR full-text, Form D](https://efts.sec.gov/LATEST/search-index?q=%22bevrly%22&forms=D) ·
[SEC EDGAR company search](https://www.sec.gov/cgi-bin/browse-edgar?company=bevrly&type=D&action=getcompany) ·
[Tranco rank API](https://tranco-list.eu/api/ranks/domain/bevrly.com) ·
[Toast integrations directory](https://www.toasttab.com/integrations/bevrly) (404)

**Comparable set**
[BinWise](https://home.binwise.com/wine-inventory-software) ·
[Partender](https://www.partender.com/) ·
[WISK.ai](https://www.wisk.ai/) ·
[Backbar](https://www.getbackbar.com/restaurant-inventory-software) ·
[Toast partner directory](https://pos.toasttab.com/partners/directory/beverage-metrics)

**Terroir (this repo, for the mapping in §10)**
`src/app/(app)/nav-links.tsx` · `src/lib/reconciliation/variance.ts` ·
`src/lib/reconcile-queue/types.ts` · `src/app/(app)/insights/` · `src/app/(app)/bins/` ·
`src/app/(app)/lists/` · `src/app/api/` · `docs/plans/2026-09-01-competitor-flow-comparison.md`

---

## 15. Run notes

- **Firecrawl calls: 0.** Everything was fetched with the local crawl4ai wrapper or plain `curl`
  against public, unauthenticated endpoints. No credentials were entered anywhere; no billed
  Anthropic API was called.
- **Sources fetched:** 48 documentation pages, 135 JS chunks, 6 CSS bundles, 3 public JSON APIs,
  2 app-store listings + 4 iTunes API queries, 1 LinkedIn page, 1 Play listing, plus route/DNS
  probes for 13 marketing paths and 6 subdomains.
- **Cite-check:** every quoted string in this brief was verified as a literal substring of the
  fetched bytes via `cite-check.sh` or a direct `grep -F` against the saved artefact. Run
  directory: `~/.local/share/deep-dive/run/competitor-bevrly/`.
- **Known limitation:** the authenticated application was never accessed. Where this brief
  describes in-app behaviour, the evidence is Bevrly's own published documentation plus strings
  and data structures shipped in its public client bundles — strong evidence of what the code
  does, not proof of what a user experiences.

---

## 16. Logged-in walkthrough — 2026-09-02

Devin holds an admin seat on a live production organisation (a friend's restaurant). The
walkthrough was **read-only**: navigation, page reads, and report generation only; no
adjustment, edit, delete, count, publish or setting was touched. Business figures, people,
vendors and item-level data are deliberately omitted here. Everything below is product
mechanics observed first-hand, and it supersedes the reconstructions in §5–§7 where they
differ.

### 16.1 Navigation, as shipped

Top bar: **Home** (`/insights`) · **Inventory** ▾ (All Locations, Variance, Value Tracker,
Counting Mode) · **Items** ▾ (All Items, Recipes, Batches, Freehand Items, Sold Out, New
Items, List Builder, Barcodes) · **Invoices** ▾ (All Invoices, Vendors, Consignment, Purchase
Order) · **POS** ▾ (Menu, Sales, Modifiers) · **Reports**. Right side: Requests, dark-mode
toggle, global search, an **organisation switcher** (the account belongs to two
organisations), and an avatar menu (Account Settings, Switch Organization, Help & Docs, Sign
out). Settings (`/settings?tab=…`) has fifteen sections: Account, Organization, Users,
Permissions, Billing, Point of Sale, Ordering, Sizes, Reasons, Types, Notifications, Locations,
Audit Mode, R365 Export, Tickets.

### 16.2 Home is the daily digest, date-scoped

`/insights` renders one business day (previous day's activity) with previous/next-day arrows
and a date picker. Panels, in order: Summary (revenue, beverage revenue and its share, beverage
profit with COGS %) · Total Sales / Check Total · Average Bottle Price (45-day average, with
last month beside it) · Median Bottle Price · Average Bottle Profit · **Beverage Breakdown**
table + pie by type (units, revenue, %) with a footnote for the non-beverage share that is not
charted · Top Bottle Sales · Top BTG Sales · **Recently 86'd Items** (units sold, revenue,
stock — negative stock is shown as-is) · Top Liquor Sales · Top Cocktail Sales · **Sleepy
Inventory** (empty state: "You have no sleepy inventory items. Great job!"). This confirms the
§4 panel set byte-for-byte and adds that the page is a day, not a dashboard.

### 16.3 Inventory page and the period banner

Header KPIs: item count, stock count, inventory value. Controls: location selector, **Start
Inventory Mode**, Stock Pull, Export, search, category, and four state chips — **Empty
Locations · Stale · Variance · Uncounted** — plus Columns. A banner states the current period:
"Inventory Date: <date> · Sales pause: <timestamp>" with an Edit link. Rows show barcode, a
colour dot + name, price, last cost, **locations as breadcrumb chips** (`Walker Storage ›
Rack 10 › R10 - Shelf 3`; the holding location "Recently Added" renders in red), running
count, total quantity, last-inventory timestamp, and a per-row **Adjust running stock**
action. Running counts are fractional (a bottle poured by the glass reads 5.29).

### 16.4 Variance, Counting Mode, Value Tracker — what they actually show

**Variance** (`/variance`): banner with Inventory Date and "Sales Paused as of"; toggles
**Zero out uncounted** and **Show uncounted**; actions **Correct Variance**, Export, **Reopen
Audit**, **Close Inventory**. Two views: *Summary* (Category · Running Count Value · Actual
Value · Value Variance · Variance % · Sales · COGS $ · COGS % · COGS % with Variance) and *All
Items* (23 columns, per item). Rows with variance are tinted pink.
**Observed defect worth designing against:** with no counts submitted, the summary treats
every item as counted at zero — every category shows −100 % value variance and one shows
"Infinity %" COGS. The page cannot tell "not counted yet" from "counted zero". Terroir's
variance view must carry an explicit *uncounted* state and refuse to compute variance against
it (the "Keep Uncounted / Zero Out" toggle on the Variance *report* shows Bevrly knows this,
but the live page does not apply it by default).

**Counting Mode** (`/counting-mode`): three tabs — **Counting** (header "Total Counted"; a
location picker "Tap to select a location"; one field "Search items or scan barcode…"; "Click
an item to add +1 count"; a "Your recent counts" list; **Upload CSV**) · **History** (filters
All Users / All Uploads; "Counts will appear here as your team scans and uploads inventory")
· **Confirm** (KPIs Items / Total Counts / Variance; "No counts to confirm — start counting
items first"). Blind counting is an organisation setting ("Hide counts while counting —
counters will not see running totals; managers and admins still see all totals").

**Value Tracker** (`/value-tracker`): Opening Value (since last inventory) · Purchases
(received since) · Value Sold (COGS since) · **Current Value = opening + purchases − value
sold + other movement (adjustments, comps, cost changes)** · Change; an "Inventory Value Over
Time" chart; a by-category table with the same five columns.

### 16.5 The item record

Item detail is a modal over the list: header (vintage + name, Print Barcodes, barcode, last
cost) and seven tabs — **Inventory · Purchase History · Sales · Inventory Activity · Location
History · Details · Related Items**.
- *Inventory*: one card per location with running count, last-updated timestamp, **Adjust
  Count** and **Move Stock**; an "86'd this inventory" toggle; and the sentence "Grab the
  dots to change the order of depletion from location" — **depletion order across locations
  is set per item by drag**. Beside it, **Sold As**: every POS item mapped to this inventory
  item, each with a custom name, a **depletion size** (🍷 1 oz, 2.5 oz, 5 oz, 10 oz carafe,
  750 ml bottle…) and price, plus a "No Match" state and an Edit per row; footers "Sold As
  Count" and "Recipe Count".
- *Inventory Activity*: a ledger — user, date, location, type (e.g. Sale Depletion), qty & unit
  (`1× 🍷2.5 oz`), new qty, change, previous qty, total qty.
- *Location History*: location, last seen, status.
- *Details*: Custom Name, Vintage, Size, **Bevrly Global Item Name** (the link to their global
  catalogue), Type; "Add New Field".

### 16.6 Receiving-side pages

**New Items** (`/new-items`): the "Recently Added" holding location made into a worklist. KPIs
*Needs Binning* / *Needs Matching*; chips **Unmatched Only · Needs Binning · Unlisted ·
Listed**; columns barcode, name, **Sold As** match state, last unit cost, last purchase date,
location, running count, total qty; actions Create Invoice, Export.
**Sold Out** (`/sold-out`): KPI count; columns barcode, name, last sale price, last sale date,
last vendor, last ordered qty, last cost, locations (negative counts in red), total qty;
vendor filter.
**Invoices**: status filter, Export, **Distribution**, Upload Invoice, Add Invoice; columns
invoice no, vendor, invoice date, cost, entered by, status, consigned, line total, entered on,
shipping, other fees, vendor credit; row Edit/Delete. Detail modal: vendor, invoice number,
ordered date, vendor note; tabs Details / Activity; vendor rep, entered by/on, invoice date,
consigned; **Set Invoice Status** (Completed / Closed); Print Barcodes; Export; line grid
(barcode, name, qty, unit $, total $) with Add New Item; Attachments; Notes; Subtotal,
Shipping, Other Fees, Credit, Total. Organisation setting **Invoice Placement**: "Confirm
placement when completing an invoice" opens a modal to place each line's stock; when off,
stock lands automatically at a default placement location (defaults to "Recently Added").
Ordering setting: **Blend shipping & fees into item costs** (spread by quantity into last
cost, average cost, inventory value, COGS and the R365 export).
**Vendors**: name, address, class, default rep, order count, total paid. **Purchase Order**:
Draft / Complete, same column shape as invoices (empty on this org). **Consignment**:
consignor filter, KPIs items sold / revenue / cost; views Sales / Inventory / Consignors.

### 16.7 POS side

**POS Menu**: every POS item with price, a **Match** state (Accept / Ignore / Match / Unmatch;
"Not an inventory item" for ignored), the matched inventory item + depletion size, source
menu, updated and last-sale dates. **POS Sales**: Line Items / Tickets views with status
(Matched…) and date filters. **POS Modifiers**: modifier → action mapping with match status
and usage count. **Recipes**: name, category, ingredient count, POS item match, price, cost,
profit, COGS %. Settings › Point of Sale: a Toast API instance (sync menu, sync tickets,
location IDs, **ignored menus**), **void-reason behaviour synced from Toast** (whether a void
still depletes), a Shopify connector, **serving-size defaults per type for the POS matcher**,
and an **AI POS suggestions** switch ("automatic after catalog syncs, and manual").

### 16.8 List Builder and its style engine

`/builder` lists lists (name, Draft/Published, item count, created, updated). The editor:
Publish · **Styling & Preview** · Create List Group; Published Status select; public link slug
+ Save link; a **Table of Contents (print only)**; groups → subgroups → items with drag
handles, item counts, Edit Description, Subgroup, Hide. Styling opens a modal with tabs **Web
Style / Print Style / Fonts**, sections Basic (style name), Columns, Header Typography,
Description Styles (font family, style, size, colour, alignment, line height, bottom margin),
Level 1 / Level 2 description overrides with "Reset to Base" and an enable checkbox, and a
live **Web Preview** column. Matches §5's reconstruction; the two-record (web/print) style
model is confirmed.

### 16.9 Reports, verified by running two

Sidebar: Favorites · Recommended (4) · Inventory (7) · Sales & Depletions (6) · Invoices &
POs (4) · Point of Sale (1) · Scheduled Reports · Report History. Each card has **Run Report**
and a "+" to schedule. Inventory: Inventory, **Detailed Inventory** (producer, region,
variety…), Inventory by Location, **Sleepy Inventory** (no sales or purchases in 90 days with
stock; tied-up capital and potential profit), **Variance Report** (per item: starting qty,
purchases, sales, running vs actual, variance costs; **Keep Uncounted / Zero Out** toggle),
Variance Summary, Out of Stock. Sales & Depletions: Sales, Sales Summary, Consignment,
Depletions, **Manual Adjustments** (reason codes), **Void Reason**. Invoices & POs: Invoices,
Invoice Line Items, Purchase Orders, PO Line Items. The runner page: filter bar (Date Range vs
Inventory Date, type, reason) → Generate → a results grid marked "Saved" with Export CSV /
Excel and a Past Reports counter. Manual Adjustments output columns: item, adjustment type,
sub type, quantity, reason, reason note, user, location, inventory date, adjustment date.

### 16.10 Settings that encode the model

- **Organization**: start-of-day hour ("used for inventory calculations"); create new items
  for new consignment vendors; hide counts while counting; invoice placement (above).
- **Permissions**: "The platform currently supports three controls: Inventory Close, Audit
  Mode, and View Costs. Organization admins and Bevrly staff always see costs." Every seat on
  this org is Admin. The finer permission keys in the JS bundle (§5) are not exposed here.
- **Audit Mode**: closing an inventory opens an audit period; corrections to counts,
  invoices and movements for the previous period; ending the audit makes corrected counts the
  starting point; sales keep deducting from the current period meanwhile. Switches: Use Audit
  Mode; **Enforce Inventory Cooldown** (no close within 5 days of the previous close);
  Auto-close; Audit Duration slider (20 days here).
- **Locations**: a hierarchy table (name, **priority**, **available** toggle, stocked items,
  children) with a "Navigate to" drill-down; naming in the wild is `Storage › Rack › Shelf`
  and `Cellar › Shelf B › B - S8`.
- **Sizes**: global vs local size definitions (name, volume ml, inventory size) — the same
  list backs depletion sizes and POS serving defaults. **Types**: a global taxonomy (name,
  code, reporting category) with item counts across the *global* catalogue (tens of
  thousands of reds and whites), i.e. the home-grown universal catalogue is real and large.
- **Reasons**: reason codes with an active toggle (this org has one, named "0" — reason
  discipline is optional in practice). **Notifications**: generate daily metrics (feeds Home
  and Insights; turning it off turns off emails), daily email on/off, send hour, timezone,
  recipient list. **Tickets / Requests**: an in-app request tracker ("everything you have
  asked us for, and what we have done about it").

### 16.11 Design, first-hand

Dark navy top bar, light grey ground, one violet accent for primary actions, Inter-class sans
at small sizes, dense data tables with a colour dot for wine colour, breadcrumb location chips,
pink row tint for variance, red for the holding location and negative stock. Modals for
detail records rather than routes. Competent, undifferentiated SaaS; nothing to copy visually,
per `DESIGN.md`.

### 16.12 What this changes in §10

- **Add** (S): the "Recently Added" holding location + invoice-placement modal as one
  receiving contract — every received bottle either gets a slot at completion or lands in a
  named queue the New Items page drains. Terroir has `bins` and an "unplaced is a queue
  state" rule already; this is the UI for it.
- **Add** (S): **per-item depletion order across locations**, set by drag — the answer to
  "which bottle gets pulled first" that `bins.priority` only half-answers.
- **Add** (M): **Sold-As mapping with depletion sizes** driving fractional running counts,
  and per-type serving-size defaults for the matcher. Terroir's `pour_events` already hold
  millilitres; the missing piece is the POS-item → inventory-item → size mapping surface.
- **Strengthen** #2 (variance arithmetic): the live page's "uncounted = zero" failure is the
  concrete reason Terroir's variance must model *uncounted* explicitly.
- **Strengthen** #1 (inventory cycle): the cooldown, the sales-pause timestamp with an Edit
  affordance, and start-of-day hour are all first-class settings; copy all three.
- **Downgrade** #8 (permission keys): the shipped UI exposes three controls, not a key
  system; `simple_mode` is not visible in settings. Keep the idea, drop the claim that
  Bevrly ships it.
