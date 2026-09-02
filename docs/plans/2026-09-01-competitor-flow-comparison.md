# Competitor Flow Comparison: Terroir vs Vivino, InVintory, Bevrly, Vinous

**Date:** 2026-09-01
**Status:** evidence brief, public sources

## 1. Purpose

Devin has an investor demo tomorrow and needs a fast, honest read on where Terroir
stands next to the four wine apps most likely to come up in questions. This brief
compares flow by flow, using only public marketing pages, help centers, and App
Store listings for the competitors (no logins were attempted, per instructions) and
grep/file evidence from this repo for Terroir. Every Terroir claim below was checked
against actual code or docs before inclusion; nothing here asserts a capability that
was not found. Use section 5 as the talking-points script and section 6 to know what
not to claim with confidence.

## 2. Flow-by-flow comparison

| Flow | Terroir today | Vivino | InVintory | Bevrly | Vinous |
|---|---|---|---|---|---|
| Search | One box over cellar + LWIN (211,498) + X-Wines (100,646), typed vintage/country/region/colour filters, body-preference ranking [T1] | Faceted `/explore` browser with a live result count on every facet value; no cellar merge (consumer-only) [V1] | One box parses vintage-leading years, 6-digit codes, barcodes; filters live in a separate panel; four separate tabs (Wines/Collection/Activity/Reviews) [I1] | No search on the one public artifact; empty accessibility tree, zero interactive elements [B1] | Four separate tabbed searches (Reviews/Vintages/Wines/Producers) plus three standalone tools (chart/glossary/guide), no unified index [N1] |
| Scan/recognition | Bottle-label scan calls Claude directly; invoice scan (Azure Doc Intelligence OCR + Claude) is currently broken upstream [T2] | Camera label scan, 1-2s, no barcode; Match% and list-scan gated to $4.99/mo Premium [V2] | Two scans: label-scan adds inventory (auto/multi-candidate/no-match states); wine-list scan feeds AI chat and explicitly does not add inventory [I2] | Separate iOS app pairs Socket Mobile hardware barcode scanners for physical counts, not vision label recognition [B2] | Camera label scan is a lookup shortcut into the paywalled review archive; does not create an inventory record [N2] |
| Cellar/inventory | Cellar list/grid/bins, physical bin placement, wine imagery on cellar/bin rows, open-bottle tracking, reconciliation [T3] | Quantity/notes/reminders; no bin or shelf field exists at all (still unaddressed since a 2020 review); desktop access Premium-gated [V3] | VinLocate: self-built 3D model, per-bottle coordinate, fully gated off the free tier [I3] | Markets Toast POS depletion sync and "advanced binning" in copy only; no product screenshots found [B3] | No first-party cellar; outsources to a linked CellarTracker account, quarterly sync, content vanishes if the subscription lapses [N3] |
| Wine detail | Corpus facts (grape, body, acidity, pairings), community rating with sample size, per-vintage history, imagery honestly captioned label/producer/representative [T4] | Rich detail page, crowd flavor-tag mention counts, 4-axis taste slider, no image-provenance disclosure [V4] | Wine Guide page works pre-purchase, progressive disclosure, Structure meters, market price history [I4] | No wine-detail surface found anywhere in public materials [B4] | One critic's score plus prose; no community aggregate, no sample size, no structured body/acidity/pairing fields [N4] |
| Lists/menus/pricing | Wine lists / branded menus with a public guest menu [T5] | None; consumer-only, no restaurant list-building tool [V5] | Printable/shareable list (PDF/link/QR), 3-level grouping, but the shared link is a frozen snapshot with no revoke and no history [I5] | Static branded list per venue, no search/filter/images even on four-figure bottles [B5] | None; sells physical AVA maps instead of a menu tool [N5] |
| Insights | `/insights` covers drink windows, pricing, and staff [T6] | Personal drink-window flags and estimated value on Premium only; no staff or pricing tooling [V6] | 10 dashboard cards, tap-through filters; blended valuation figure needed its own help article to stop user confusion [I6] | Markets cost/waste/profitability plus a daily email digest; no dashboard shown publicly [B6] | Editorial only (Vintage Chart prose); no computed per-user insight [N6] |
| Onboarding | `/api/dev-login` into a seeded venue: 250-bottle cellar, 100,646-wine corpus, 211,498 LWIN catalog [T7] | Free tier plus $4.99/mo Premium; paywall creep drew visible App Store backlash [V7] | Free unlimited-bottle tier (3D/AI gated); guided import from CellarTracker/Vivino/spreadsheet [I7] | No self-serve signup; every CTA is "Book a Demo" [B7] | One-tap consumer-vs-trade persona split before paywalled $140-210/yr plan cards [N7] |

### References

Terroir: [T1] `src/app/api/search/route.ts`, `src/lib/cellar-facets/index.ts`, `src/lib/unified-search/search-filters.ts` &middot; [T2] `src/app/api/scan-bottle/route.ts` (Anthropic SDK), `src/lib/scanner/azure.ts`, `src/lib/scanner/ocr-service.ts`, `src/lib/jobs/invoice-extract-handler.ts` &middot; [T3] `src/app/(app)/bins/`, `src/app/(app)/cellar/bin-data.ts`, `src/app/api/open-bottles/`, `src/lib/reconciliation/`, `src/lib/reconcile-queue/` &middot; [T4] `docs/runbooks/investor-demo.md`, `src/app/(app)/cellar/page.tsx` (image_kind select), `src/app/(app)/cellar/[wineId]/wine-detail-view.tsx` &middot; [T5] `src/app/list/[slug]/public-menu-share.tsx`, `src/app/list/[slug]/menu-freshness.ts` &middot; [T6] `src/app/(app)/insights/` &middot; [T7] `docs/runbooks/investor-demo.md`

Vivino: [V1] vivino.com/explore?wine_type_ids[]=1 &middot; [V2] vivino.com/en/wine-news/how-the-vivino-label-scanner-works &middot; [V3] vivino.com/en/wine-news/discover-vivinos-wine-cellar-feature &middot; [V4] vivino.com/en/us-justin-isosceles/w/1169307 &middot; [V5] same as V2 (no dedicated page; capability absent) &middot; [V6] same as V3 &middot; [V7] vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience

InVintory: [I1] help.invintory.com/en/articles/16596544 &middot; [I2] help.invintory.com/en/articles/14301437 &middot; [I3] help.invintory.com/en/articles/9900232 &middot; [I4] help.invintory.com/en/articles/16609710 &middot; [I5] help.invintory.com/en/articles/11117324 &middot; [I6] help.invintory.com/en/articles/16581603 &middot; [I7] invintory.com/pricing

Bevrly: [B1], [B4], [B5] bevrly.com/list/550-madison-wine-list &middot; [B2] apps.apple.com/ca/app/bevrly-inventory-scanner/id6740220524 &middot; [B3], [B7] bevrly.com/switch &middot; [B6] bevrly.com

Vinous: [N1], [N4] vinous.com/wines &middot; [N2] apps.apple.com/us/app/vinous-wine-reviews-ratings/id1010711422 &middot; [N3] support.cellartracker.com/article/40-integration-with-vinous &middot; [N5] vinous.com/statics/maps &middot; [N6] vinous.com &middot; [N7] vinous.com/users/plan; pricing figures per cluboenologique.com/story/wine-websites-behind-the-paywall-vinous

## 3. Where Terroir is ahead

- **One search box, four fewer tools.** Vinous splits search into four separate
  tabs plus three standalone tools; InVintory splits filters from the search box and
  keeps a separate tab per result type; Bevrly's guest list has no search at all.
  Terroir's single box already spans the cellar and both reference corpora
  (`src/app/api/search/route.ts`).
- **Non-LLM companion, stated plainly.** Vivino's "Vivino Sommelier" and
  InVintory's "Vincent" are both explicitly LLM-backed with no disclosed
  hallucination guardrail; a real InVintory user reported distrusting its
  drink-window guidance enough to override it. Terroir's companion parses into a
  whitelisted struct against closed vocabularies and says "I did not understand
  narnia" rather than guess (`docs/runbooks/investor-demo.md`).
- **Honest image provenance.** None of the four competitors disclose whether a
  wine photo is the actual label, the same producer's other cuvée, or an unrelated
  stock photo. InVintory's own marketing describes "virtual wine labels and bottle
  colors" without saying which is real. Terroir's `image_kind` vocabulary
  (label/producer/representative) is captioned in the UI (`docs/runbooks/investor-demo.md`,
  select in `src/app/(app)/cellar/page.tsx`).
- **A single product across collector and restaurant.** Vivino and Vinous have zero
  restaurant surface. InVintory's Hospitality product is a separate, sales-gated
  offering behind a Calendly call, not self-serve. Terroir's lists, menus, insights,
  bins, and reconciliation are one app (`src/app/(app)/insights/`, `src/lib/reconciliation/`).
- **Live guest menu vs. a frozen snapshot.** InVintory's shared list link/QR is
  explicitly a point-in-time export with no revoke and no history; the docs warn
  "drink a bottle and the list still shows it." Terroir's public list carries its
  own freshness tracking (`src/app/list/[slug]/menu-freshness.ts`).
- **Bin placement solves a five-year-old unaddressed request.** A 2020 Vivino App
  Store review explicitly asked for row/column cellar location tracking; it is
  still absent. Terroir has bin cards with wine imagery today
  (`src/app/(app)/bins/`, `src/app/(app)/cellar/bin-data.ts`).

## 4. Where Terroir is behind or different

| Gap | Competitor with it | Effort to close |
|---|---|---|
| Live result-count per facet value on filters | Vivino `/explore` | hours (UI only, data already computed) |
| Named scan-confidence states ("Reading label...", "Match found!") | InVintory | hours |
| Invoice scan currently broken upstream | n/a (own regression) | unknown until root-caused; lead with bottle-scan instead |
| 3D bin visualization | InVintory (VinLocate) | weeks; different bet (Terroir uses bin cards + imagery, not a rendered 3D model) |
| Graceful "couldn't identify, try manual search or submit for review" scan failure copy + human-review queue | Vivino | hours for copy; weeks for a real review queue |
| Aggregate collection valuation total | InVintory (blended market-price figure) | days; Terroir has per-bottle retail bands (`retail_min/median/max`) but no rolled-up total surfaced today |
| Crowd-sourced flavor-tag taxonomy with mention counts | Vivino | not buildable soon; needs review volume Terroir does not have |
| Catalogue breadth, community size, brand trust signals | Vivino (16M wines, 70-74M users), InVintory ($1B tracked, 4.8 stars/4.6k ratings), Vinous (450k reviews) | n/a, structural; do not compete on scale, compete on operational depth |

## 5. Demo talking points

- "One box searches your cellar plus a 211,498-wine LWIN catalogue and a
  100,646-wine X-Wines corpus, with typed vintage, country, region, and colour
  filters. Vivino, InVintory, and Vinous each split this into separate tabs or
  panels; Bevrly's guest list has no search at all."
- "The wine assistant is not an LLM. It parses your question into a whitelisted
  struct against closed vocabularies, so it can say 'I did not understand narnia'
  instead of guessing. Compare that to Vivino's Sommelier chat and InVintory's
  Vincent, both explicitly LLM-backed."
- "Every wine photo is honestly captioned: label, producer, or representative,
  with counts behind each. None of the four competitors we looked at disclose
  photo provenance at all."
- "Community ratings show their sample size on every wine. Vinous, with 450,000
  reviews in its archive, still shows you one critic's single number."
- "This is one product for both the collector and the restaurant floor: bins,
  reconciliation, staff pricing, insights. Vivino and Vinous have no restaurant
  surface whatsoever, and InVintory's restaurant product is a separate sales-gated
  offering behind a demo call."
- "Bin placement plus a photo on every wine-naming surface answers the exact
  question a real Vivino user asked for in a 2020 App Store review and still
  doesn't have: which bottle in Bin A5 is it."
- "The public guest menu tracks its own freshness. InVintory's shared list is a
  frozen PDF/QR snapshot with no revoke and no history once it's sent."
- "Everything is tested down to 390px, not as an afterthought. That's the phone
  a sommelier is holding on the floor."
- Honest caveat to have ready: "Invoice scanning is down upstream right now;
  bottle-label scan, which calls Claude directly, is the one to show."
- "We are not trying to out-catalogue Vivino's 16 million wines or Vinous's
  archive. The bet is operational depth for a working cellar and a working
  restaurant, not breadth."

## 6. Not verified

Competitor surfaces behind logins, app-only, or that failed to render for an
unauthenticated crawl, per each source brief's own access notes:

- **Vivino:** the live in-app camera scan UI and its real-time guidance, the
  Sommelier chat's actual behavior, the in-app Premium paywall flow, the live
  restaurant wine-list bulk-scan feature, and App Store screenshot images
  themselves (only listing text was read).
- **InVintory:** the app.invintory.com dashboard (login required, no account was
  created), the exact Free-vs-Premium UI boundary, VinLocate's actual 3D
  rendering, and most of the 60+ help-center articles (only about 10 were read in
  full; Devices & Integrations and Sharing & Collaboration categories were not
  pulled individually).
- **Bevrly:** the staff dashboard, reports UI, purchase-order builder, binning UI,
  and any real pricing, since `/pricing`, `/features`, and `/product` all redirect
  unauthenticated visitors to `/login`; two referenced subdomains
  (`searchdemo.bevrly.com`, `list.bevrly.com`) could not be reached at all.
- **Vinous:** individual tasting-note text and scores (paywalled, no login
  attempted); several SPA pages (Vintage Chart, Glossary, Grape Guide) did not
  hydrate for an unauthenticated crawl and are described only from App Store/Play
  listing copy; current live pricing-card contents (figures cited here are from a
  2020 third-party review and 2018-era App Store text).
- **A pending authenticated pass** against all four competitors was not performed
  for this brief; every claim above is public-evidence only, per instructions.
- **Terroir's invoice-scan "broken upstream" status** is carried from the task
  brief for this document and was not independently reproduced with a live run in
  this pass; treat it as unverified-as-of-today rather than freshly confirmed.
- **Terroir's own flows** were checked by reading code and docs, not by driving
  the running app or capturing live screenshots in this pass.
