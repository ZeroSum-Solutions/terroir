# Vivino — competitor audit for Terroir: what to adopt, what to beat, what to leave

*Scope: the Vivino consumer app (iOS/Android) and vivino.com, audited from public sources only — no login, no account, no paid tier. Prepared 2026-09-02 for the Terroir project (Next.js 16 + Supabase; invoice scan, bottle-label scan, cellar/bin placement, wine lists, unified search with an AI companion, canonical_wines/wine_variants identity spine). Research run: deep-dive STANDARD depth.*

---

## 1. TL;DR

Vivino is not primarily a cellar app — it is a **crowd-rating engine bolted to a marketplace**, and every design decision follows from that. Its real moat is a self-reinforcing data loop: over 1 million label scans per day [PUBLISHED] feed a database its own About page currently counts at 20.4 million+ wines and 3.48 billion+ scanned labels [PUBLISHED], which in turn make the 5-star crowd rating dense enough to be useful on obscure bottles. The two mechanics Terroir should study hardest are (a) **deriving structured taste data from unstructured review text** — the Taste Characteristics block aggregates the most commonly used descriptor words from community reviews and lets you tap a flavour to read every review that mentions it [PUBLISHED] — and (b) **Match for You**, a 0–100% personal compatibility score printed on every wine page, computed from the grapes/styles/regions/flavour profiles of wines you rated cross-referenced against the whole database [PUBLISHED].

Vivino's weaknesses are precisely Terroir's opening. Its cellar is a quantity-and-filter list, not a physical map: an App Store review from December 2020 asks for exactly the row/column bin placement Terroir already ships, and none of Vivino's own current cellar documentation mentions a location field [PUBLISHED — user request, 2020; current absence not independently confirmed]. Its ratings compress into a narrow band (a competitor measures most ratings between roughly 3.5 and 4.2 [PUBLISHED as that competitor's claim]), and its free tier has been narrowing — restaurant wine-list scanning is now Premium-only [PUBLISHED]. Terroir should copy the *information architecture and the derived-data patterns*, not the commerce funnel, the ad slots, or the palette.

Eight adoption candidates follow; seven are S or M, and three of the top five are extensions of components Terroir already has (`AxisBar`, `CommunityRating`, `Section`, `Fact` in `src/components/detail-sections.tsx`).

---

## 2. Confirmed vs. Inferred

| Confidence | What we know |
|---|---|
| **CONFIRMED [PUBLISHED]** | Feature set, free-vs-Premium split, Premium price and per-country tiering, Match for You mechanics and score bands, Taste Characteristics derivation from review text, rating-system design and its expert-score correlation claim, wine-page block order and buying-block anatomy (web), label recognition via PTC Vuforia Cloud Recognition, wine-list scanning via server-side ABBYY FineReader OCR, marketplace merchant model via integration partner Actenzo, the full CSS design-token set on the live wine page. |
| **REPORTED (secondary / one source)** | Kooaba as the original recognition vendor; OCR raising label-match success past 86% in early 2013 (productmint, a business blog, last updated 2022); commission rate on marketplace sales (no primary source found — see Gaps); rating compression to 3.5–4.2 (sommo.app, a direct competitor). |
| **INFERRED / [ESTIMATE]** | Nothing in this brief rests on a triangulated estimate — Stage 5 did not fire. Items marked `[ESTIMATE]` below are engineering judgements about Terroir's build size, labelled as such, not measurements of Vivino. |
| **INFERRED FROM SILENCE** | That Vivino's cellar still has no physical bin/location field. The 2020 user request is verbatim and dated; the *present-day* absence is inferred from Vivino never mentioning a location field in its current cellar guide or release notes. Flagged by adversarial verification; confirm in-app before repeating it externally. |
| **CONFLICTS / STALE** | Vivino publishes six different user/wine counts across its own surfaces on the same day (see §5.1). The PTC case study still says "20 million users" — years stale. The diginomica OCR architecture is from 2016 and may no longer describe the current pipeline (a decade is long enough for a full re-architecture). Google Play shows 4.7 / 237K reviews against Vivino's own claim of 4.5 / 194K. |

---

## 3. Feature inventory

Sources: Vivino's own "complete guide" (last updated May 2026), the Premium page, the cellar guide, the scanner guide, the App Store and Play Store listings, and the live wine page.

### 3.1 Scan

| Feature | Detail | Tag | Source |
|---|---|---|---|
| Label scan | Camera at a bottle → community rating, price range, tasting notes, food pairings | [PUBLISHED] | [Complete guide](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience) |
| Three scanner modes | Tap the camera icon, then choose **Label** (one bottle), **Wine List** (a restaurant menu), **Quick Compare** (many bottles one by one, compared) | [PUBLISHED] | [Wine scanner guide, 2025-08-11](https://www.vivino.com/en/wine-news/vivino-wine-scanner) |
| Wine-list scan | Premium-only. Scan a full restaurant list, see a star rating for every wine on it | [PUBLISHED] | [Complete guide](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience), [Premium](https://www.vivino.com/en/premium) |
| OS-level scan | On iPhone the scanner also works natively through Apple's Visual Intelligence — the app need not be opened | [PUBLISHED] | [Complete guide](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience) |
| Scan volume | Over 1 million label scans per day globally | [PUBLISHED] | [Complete guide](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience) |

### 3.2 Search and browse

| Feature | Detail | Tag | Source |
|---|---|---|---|
| Search axes | By grape, region, style, or dish | [PUBLISHED] | [App Store listing](https://apps.apple.com/us/app/vivino-drink-the-right-wine/id414461255) |
| Explore filters (web) | Wine type, price range (slider), minimum rating, country, grape, food pairing — all encoded in the `/explore` querystring | [PUBLISHED] | vivino.com `/explore` links on wine-news pages |
| Browse spines | Grapes, Regions, Countries, Wineries by region/country, Toplists, Wine Styles, Wine Style Awards | [PUBLISHED] | vivino.com global footer + wine page |
| Shop screen | Rebuilt in the current release: "fresh new design, faster browsing, and better search for buyable wines" | [PUBLISHED] | [App Store release notes v2026.35.0](https://apps.apple.com/us/app/vivino-drink-the-right-wine/id414461255) |

### 3.3 Wine page

Covered block-by-block in §5. Headline: 5-star crowd rating, Match for You %, Taste Characteristics (structure sliders + flavour groups), flavour-mention drill-through into reviews, Wine Highlights badges, facts table, food pairing, wine-style essay, winery block, vintage comparison, buying block.

### 3.4 Cellar

| Feature | Detail | Tag | Source |
|---|---|---|---|
| Add a bottle | Scan or search → **Actions** → **Add to Cellar** (icon described as "the little icon with the 5 circles") | [PUBLISHED] | [Cellar guide](https://www.vivino.com/en/wine-news/discover-vivinos-wine-cellar-feature) |
| Track | Quantities, tasting notes, personal reminders | [PUBLISHED] | [Cellar guide](https://www.vivino.com/en/wine-news/discover-vivinos-wine-cellar-feature) |
| Filters | Region, Grape, Vintage, Food pairing; plus sorting and community reviews inline | [PUBLISHED] | [Cellar guide](https://www.vivino.com/en/wine-news/discover-vivinos-wine-cellar-feature) |
| Drinking windows | Premium. Suggested window per wine, plus a user-set personal window; the app highlights "what's ready now" vs. what to save | [PUBLISHED] | [Cellar guide](https://www.vivino.com/en/wine-news/discover-vivinos-wine-cellar-feature) |
| Cellar overview | Current release: "complete overview of your wines broken down [by] type, grapes, regions and drinking windows" | [PUBLISHED] | [App Store release notes v2026.33.0+](https://apps.apple.com/us/app/vivino-drink-the-right-wine/id414461255) |
| Free-tier cap | Free users can add "a limited number of wines"; Premium unlocks the full collection plus desktop access and estimated collection value | [PUBLISHED] | [Complete guide](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience) |
| **Likely missing: physical location** | An App Store review asks to "specify the physical location in my cellar/fridge… Row A, Column 2" and to browse a fridge graphic. Vivino's own current cellar documentation and release notes describe quantities, notes, reminders, drinking windows and type/grape/region breakdowns — **no location field is mentioned anywhere** | [PUBLISHED] — the *request* is verbatim and dated; the *current* absence is inferred from Vivino's silence, not confirmed | [App Store review, 2020-12-29](https://apps.apple.com/us/app/vivino-drink-the-right-wine/id414461255); [Cellar guide](https://www.vivino.com/en/wine-news/discover-vivinos-wine-cellar-feature) |

### 3.5 Wishlist, journal, social

| Feature | Detail | Tag | Source |
|---|---|---|---|
| Wishlist | "Add to Wishlist" is a first-class action on the wine page, sibling to "Add to cellar" | [PUBLISHED] | live wine page (inspected 2026-09-02) |
| Journal | Every wine scanned or tasted logged with the user's own rating, review, notes; favourites; photos | [PUBLISHED] | [App Store listing](https://apps.apple.com/us/app/vivino-drink-the-right-wine/id414461255) |
| Community Stories | Friends' recent activity on Home, **grouped by person** rather than one post per row; like, comment, follow | [PUBLISHED] | [Home page update](https://www.vivino.com/en/wine-news/the-vivinos-app-home-page-got-more-personal) |
| Off-platform share | Current release: turn a rating into a shareable post in one tap | [PUBLISHED] | [App Store release notes v2026.33.0+](https://apps.apple.com/us/app/vivino-drink-the-right-wine/id414461255) |
| Friends signal | The wine page shows a "Friends" highlight — how many of your friends tried and enjoyed this wine | [PUBLISHED] | [Full wine page guide](https://www.vivino.com/en/wine-news/discover-the-full-vivino-wine-page) |

### 3.6 Market / checkout

| Feature | Detail | Tag | Source |
|---|---|---|---|
| Marketplace reach | 500+ vetted merchants, buy in-app with delivery | [PUBLISHED] | [Complete guide](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience) |
| Buying block | Price, "Price is per ½ bottle" unit note, quantity stepper, Add to cart, "Sold by *merchant*", "Show all buying options" | [PUBLISHED] | live wine page (inspected 2026-09-02) |
| Checkout | "Seamless two-click checkout" is the merchant-facing pitch | [PUBLISHED] | [Merchant signup](https://www.vivino.com/en/merchants/signup) |
| Free shipping | Premium: free shipping from $100 (US page) | [PUBLISHED] | [Premium](https://www.vivino.com/en/premium) |
| Promoted inventory | Sponsored cards render inline on the wine page, served from `promotions.vivino.com` with a `zkcdn.net` creative and a base64 targeting payload carrying `premium`, `country`, `state`, `buyable`, `winery`, `wine_type`, `style`, `region`, `grape`, `food` keys | [PUBLISHED] | live wine page (inspected 2026-09-02) |

### 3.7 Preferences and personalisation

| Feature | Detail | Tag | Source |
|---|---|---|---|
| Match for You | 0–100% personal compatibility on every wine page. Basic on free, exact score for every wine on Premium | [PUBLISHED] | [Match for You explainer](https://www.vivino.com/en/wine-news/vivinos-match-for-you-score-explained-how-we-learn-your-taste) |
| Manual preference editing | "You can also actively log the grapes, styles, and wine-making regions you love or loathe — not just through ratings, but directly in your taste profile settings (click a Match for You rating and start adding)" | [PUBLISHED] | [Match for You explainer](https://www.vivino.com/en/wine-news/vivinos-match-for-you-score-explained-how-we-learn-your-taste) |
| Taste Profile, per type | Current release splits the profile by Red, White, Rosé, Sparkling, Fortified, Dessert — "each with its own taste scales and styles/regions/grapes breakdown. Tap Edit preferences if we got you wrong." | [PUBLISHED] | [App Store release notes v2026.35.0](https://apps.apple.com/us/app/vivino-drink-the-right-wine/id414461255) |
| Home-page feedback loop | Recent-scans stack on Home with thumb-up / thumb-down, then rate and favourite — "every rating, like, or dislike gives Vivino another signal about your preferences" | [PUBLISHED] | [Home page update](https://www.vivino.com/en/wine-news/the-vivinos-app-home-page-got-more-personal) |
| Recommendation blend | "our unique scanning, rating, and purchase behaviour, combined with ratings from the wider community. The community data acts as a quality filter; your personal history determines relevance" | [PUBLISHED] | [Match for You explainer](https://www.vivino.com/en/wine-news/vivinos-match-for-you-score-explained-how-we-learn-your-taste) |

### 3.8 Premium

| Item | Value | Tag | Source |
|---|---|---|---|
| US price | 4.99 USD/month, 47.90 USD/year — identical on iOS and Android [PUBLISHED] | [PUBLISHED] | [Premium pricing guide](https://www.vivino.com/en/articles/premium-pricing-guide-en) |
| UK price | 4.99 GBP/month, 47.90 GBP/year [PUBLISHED] | [PUBLISHED] | [Premium pricing guide](https://www.vivino.com/en/articles/premium-pricing-guide-en) |
| Cheapest tier seen | Argentina, Burkina Faso, Cambodia, Cameroon and others at 1.99 USD/month, 19.99 USD/year [PUBLISHED] | [PUBLISHED] | [Premium pricing guide](https://www.vivino.com/en/articles/premium-pricing-guide-en) |
| Most expensive tier seen | Bermuda / Cayman / BVI at 5.99 USD/month, 59.90 USD/year [PUBLISHED] | [PUBLISHED] | [Premium pricing guide](https://www.vivino.com/en/articles/premium-pricing-guide-en) |
| What Premium buys | Vivino Sommelier (AI chat) unlimited; full cellar + desktop + estimated collection value + drinking windows; free shipping; wine-list scanner; Quick Compare; enhanced insights; ad-free; Wine Adventures | [PUBLISHED] | [Complete guide](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience), [Premium](https://www.vivino.com/en/premium) |
| Free vs Premium matrix | Vivino publishes an 11-row feature comparison table with three states — ✓, –, and a qualifier word ("Basic", "Limited", "Enhanced (desktop + value)") | [PUBLISHED] | [Complete guide](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience) |
| Sommelier definition | "Sommelier combines your personal taste profile with all of Vivinos wine data within an easy-to-use AI chat" | [PUBLISHED] | [Premium](https://www.vivino.com/en/premium) |
| Sign-up path | "Head over to the Profile section of the app, find Premium on the list, and tap 'Join.'" | [PUBLISHED] | [Premium](https://www.vivino.com/en/premium) |

---

## 4. Information architecture and navigation model

**Mobile app.** Vivino does not publish a nav diagram, so this is assembled from what its own docs assert about screen locations plus the owner's first-hand use.

| Element | Evidence class | Detail |
|---|---|---|
| Bottom tab bar with an always-reachable camera | Owner-observed; corroborated in shape | Vivino's scanner guide says "Open the app and tap the camera icon to use the scanner" — the camera is a persistent chrome affordance, not a screen you navigate to [PUBLISHED]. The owner reports it as a floating element on the bottom bar. |
| Home | [PUBLISHED] | Recent-scans rating stack, Taste Profile widget, Community Stories from friends |
| Cellar | [PUBLISHED] | "Open your Vivino app, head to the Cellar section" |
| Shop | [PUBLISHED] | Named as a distinct screen in the current release notes |
| Profile | [PUBLISHED] | Hosts the Premium entry point; hosts taste-preference editing |
| Scanner as a mode-picker | [PUBLISHED] | One camera entry, then a mode icon row: Wine List / Label / Quick Compare |
| Scan result → slide-up card with alternatives | Owner-observed | Not documented publicly. Vivino only concedes the failure path exists by publishing a "what to do when it can't identify a wine" guide. Treat the disambiguation sheet as an unverified but plausible pattern. |

**Web.** Global top nav is deliberately tiny: **Shop · Wines · Wineries · Premium**, plus a ship-to country selector, a state selector, a language selector, and a cart icon [PUBLISHED, inspected 2026-09-02]. The shop home stacks merchandising rails — "Best offers for you", "Bestsellers in <state>", "Price drops", "Explore popular styles" [PUBLISHED]. Note the shop home is *localised to state*, not just country — a legal necessity for US alcohol shipping and a pattern Terroir will meet if it ever sells.

**The IA lesson for Terroir.** Vivino's navigation is organised around *verbs at the moment of decision* (scan, shop) plus *two persistent objects* (your cellar, your profile). Terroir's current 5-tab bar — Scan / Cellar / Atlas / Lists / Insights (`src/app/(app)/nav-links.tsx`) — is already the same shape, with Atlas and Lists standing where Vivino puts Shop. The one structural idea Terroir does not yet have is Vivino's **Home**: a personalisation surface whose only job is to harvest cheap preference signal from things the user already did (see adoption candidate #2).

---

## 5. Wine-page anatomy, top to bottom — and where each block's data comes from

Verified block order on the live web wine page (`/en/the-prisoner-saldo-zinfandel/w/1361944?year=2021`, inspected 2026-09-02). The app adds Match for You, the taste sliders and reviews inline; the web page renders the same information spine.

| # | Block | What is in it | Data source | Tag |
|---|---|---|---|---|
| 1 | Bottle image | Large cut-out PNG, transparent background, label-forward, served from `images.vivino.com/thumbs/<hash>_pb_x600.png` — width-suffixed variants (`_pb_x600`, `_pb_x960`) for card vs. page | Per-wine bottle photography, one asset per wine entity, CDN-resized | [PUBLISHED] |
| 2 | Identity | Winery link (own page) · wine name link (all vintages) · vintage year | Canonical wine record + vintage record | [PUBLISHED] |
| 3 | Facet chip row | Country · Region · Winery · Wine type · Grape — each a link into `/explore` | Canonical taxonomy (countries, regions, wineries, types, grapes) | [PUBLISHED] |
| 4 | Rating block | `4.2` + `2704 ratings`, anchored to `#all_reviews` | Aggregated community 5-star ratings | [PUBLISHED] |
| 5 | Actions | **Add to Wishlist** · **Add to cellar** (badged *Premium*) | User-scoped lists | [PUBLISHED] |
| 6 | Highlight badges | Icon + label, e.g. "Oldest vintage available". The documented badge vocabulary: **Great Value for Money** (price vs. other wines of that style and rating), **Featured In** (membership of a Vivino toplist), **Popular** (>1,000 ratings), **Friends** (how many friends tried and liked it), **Wine Style Award Winner**, **You Like / Haven't Tried This Style** | Derived: price-vs-cohort stats, toplist membership, rating count, social graph, awards table, personal taste profile | [PUBLISHED] |
| 7 | Buying block | Price · unit note ("Price is per ½ bottle") · quantity stepper · **Add to cart** · "Sold by *merchant*" · "Show all buying options" | Live retailer/merchant price feed, ranked; one merchant surfaced, rest behind a disclosure | [PUBLISHED] |
| 8 | Sponsored card | Full-width promo with a "Sponsored" label, headline, one-line body, image | Ad server, targeted on the *current wine's* attributes | [PUBLISHED] |
| 9 | **"What does this wine taste like?"** | (App: structure sliders + flavour groups + mention counts.) Vivino's own description: a section that "aggregates the most commonly used words to describe wines in an approachable format", "a visual representation of the wine's structural profile focuses on traits like sweetness, body and acidity", then a flavour profile of "the most commonly used flavors… all sourced from the crowd" where "you can select a flavor and view all the reviews that mention that flavor" | **Community review free text, mined and aggregated.** This is the single most important architectural fact in the audit | [PUBLISHED] |
| 10 | Facts table | Winery · Grapes (with %) · Region · Wine style · Alcohol content · Allergens ("Contains sulfites") · Wine description | Structured producer/reference data + editorial description | [PUBLISHED] |
| 11 | Food pairing | "Our wine experts think this Californian Zinfandel wine would be a match made in heaven with these dishes" → chips (Beef, Lamb, Poultry) each linking to a long-form pairing guide | Editorial pairing rules keyed to **wine style**, not to the individual wine | [PUBLISHED] |
| 12 | Wine style essay | Style name + country + a several-paragraph history/character piece, truncated with "Read more" to the style's own page | Editorial content on the *style* entity, reused across every wine in that style | [PUBLISHED] |
| 13 | Winery block | Winery name + place, wine count (`49 Wines`), aggregate rating (`4.3`), `303,466 total ratings`. Elsewhere Vivino also runs a "Meet the Winery" module with a winery background video and a winery-authored article | Winery entity roll-up + a paid/partnered winery content programme | [PUBLISHED] |
| 14 | Compare Vintages | "Sort and explore the best vintages of *X*" — each vintage carries its own highlights, ratings and reviews | Vintage-level records under one canonical wine | [PUBLISHED] |
| 15 | Community reviews | Individual notes, filterable; flavour chips drill into the subset of reviews mentioning that flavour | User reviews | [PUBLISHED] |

**Owner-observed blocks not verifiable from public sources**: the settings/overflow menu on the wine page (change wine / add to wish list / share / personal note / place / price / drinking window), the "show more / show less of wines like this" preference control, and the numeric mention counts ("642 mentions of oaky"). The mention-count *mechanic* is confirmed by Vivino's own Taste Characteristics description above; only the specific numeral is unverified. The "show more / less like this" control is consistent with Vivino's documented statement that users can "actively log the grapes, styles, and wine-making regions you love or loathe" [PUBLISHED] — a per-wine version of the same lever.

### 5.1 The numbers conflict — read this before quoting any Vivino statistic

Vivino publishes six different counts across its own surfaces, all live on 2026-09-02:

| Surface | Users | Scanned labels | Wines | Wineries | Tag |
|---|---|---|---|---|---|
| [About page](https://www.vivino.com/en/about), "Vivino in numbers" | 77.4 million+ | 3.48 billion+ | 20.4 million+ | — | [PUBLISHED] |
| [Complete guide](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience), "by the numbers" list | 74 million+ | — | 19 million+ | 245,000+ | [PUBLISHED] |
| Same guide, opening paragraph | over 70 million | — | more than 16 million | 245,000 | [PUBLISHED] |
| [Merchant signup](https://www.vivino.com/en/merchants/signup) | 71 million | — | — | — | [PUBLISHED] |
| [Match for You explainer](https://www.vivino.com/en/wine-news/vivinos-match-for-you-score-explained-how-we-learn-your-taste) | — | — | over 16 million | — | [PUBLISHED] |
| [PTC case study](https://www.ptc.com/en/case-studies/vivino) (undated, clearly stale) | 20 million | — | — | — | [PUBLISHED] |

The About page reads as a live counter; everything else is copy written at some past date and never revised. **Use the About page figure and date-stamp it.** Store-rating figures conflict the same way: Vivino's Premium page claims "4.8 in App Store 548K Ratings / 4.5 in Google Play 194K Reviews" [PUBLISHED], while the US App Store storefront shows 4.8 with 136K ratings and Google Play shows 4.7 with 237K reviews and 10M+ downloads [PUBLISHED] — Vivino is almost certainly summing storefronts and the stores are showing one.

---

## 6. Design language

All values below were read off the live wine page's computed styles and CSS custom properties on 2026-09-02 [PUBLISHED, direct inspection].

**Type.** One family does the whole page: `GraphikWeb, Verdana, sans-serif`. No serif anywhere. The measured size distribution on the wine page: 13px (274 elements) · 14px (162) · 16px (132) · 12px (21) · 20px (18) · 24px (12) · 40px (5) · 26px · 28px. Weights: 400 (584 elements) · 500 (30) · 600 (14) · 700 (2). The read: **a 13/14px body-dominant, near-monoweight page** that creates hierarchy through size and colour, not through bold. The 40px step is reserved for the few display moments.

**Colour.** A full token ramp is declared on `:root` — 67 custom properties. The families:

| Ramp | 200 | 300 | 400 | 500 | 600 | 700 |
|---|---|---|---|---|---|---|
| red | `#fdedef` | `#ffd1d8` | `#f77985` | `#ba1628` | `#800f1c` | `#3b070d` |
| green | `#e9f7ef` | `#c5e8d5` | `#5aaf89` | `#00845f` | `#006b4d` | `#002e21` |
| blue | `#e2f5fd` | `#cfeffc` | `#60abe6` | `#007ac4` | `#00598f` | `#0e283f` |
| orange | `#ffebda` | `#ffd7b5` | `#fcbf98` | `#ee803e` | `#804928` | `#3f2e23` |
| yellow | `#fcfada` | `#f3efaf` | `#f5d267` | `#b98c04` | `#986801` | `#332c19` |
| purple | `#fcedfc` | `#e8d9f7` | `#c6a7e6` | `#9a70c2` | `#855180` | `#40273f` |
| gray | `#fafafa` | `#f0f0f0` | `#d9d9d9` / 400 `#bfbfbf` | `#757575` | `#575757` | `#1e1e1e` |

Plus `--yeast-200: #f9f2ec` (a warm off-white; the page also paints a `rgb(247,243,240)` warm surface behind editorial sections) and semantic aliases `--gray-always-bold: #1e1e1e`, `--gray-always-light: #fff`.

Two purpose-built sub-systems are the interesting part:

- **A rating ramp** — `--rating-0-stars #d9d9d9`, `1 #fbcf4e`, `2 #fc9b23`, `3 #fd7907`, `4 #d54409`, `5 #8e041a`. The star colour *warms into wine-red as the score rises*. A 4.2 wine and a 3.1 wine are distinguishable at a glance across a dense list without reading the numeral.
- **A flavour-group ramp** — one colour per aroma family, semantically chosen: `--flavor-oaky #8c5433`, `--flavor-red-fruit #c73a31`, `--flavor-black-fruit #2c3e80`, `--flavor-plum #6f6198`, `--flavor-citrus #ee803e`, `--flavor-tropical #e99228`, `--flavor-tree-fruit #819632`, `--flavor-vegetal #9c9a2a`, `--flavor-earthy #b59b6f`, `--flavor-floral #f86676`, `--flavor-spices #b19157`, `--flavor-dried-fruit #b9655d`, `--flavor-ageing #9e6e40`, `--flavor-yeasty #c38349`.

Applied colour on the page is restrained: primary ink `#1e1e1e` (565 elements), secondary `#575757` (33), red `#ba1628` on 4 elements, green `#02a78b` on 3. The commerce green `#00845f` is reserved for the primary Add-to-cart button. The red is reserved for brand/marketing.

**Imagery.** Every wine has its own bottle photograph — a cutout PNG on transparency, shot square-on so the label is legible at card size, served width-suffixed from an image CDN. Editorial pages use wide 16:9 header photography via an imgproxy pipeline over a Contentful CMS (`images.ctfassets.net` behind `imgproxy.vivino.com` with `skip_processing:jpg:jpeg:png:gif:webp`). Icons are SVG. The winery module runs *background video*.

**Shape and controls.** Measured radii on the wine page: `80px` and `40px` (full pills, 4 and 3 uses), `16px` (7 — cards/sheets), `50%` (3 — avatars), `7px` (8), `8px`, `4px`, `2px`. So: **pill buttons, 16px cards, small radii for chips and inputs.** Measured button spec, identical across the three primary actions:

| Control | Background | Text | Radius | Padding | Size | Weight | Height |
|---|---|---|---|---|---|---|---|
| Add to cart | `rgb(0,132,95)` | white | 80px | `7px 16px 9px` | 16px | 500 | 40px |
| Add to Wishlist | transparent | `rgb(30,30,30)` | 80px | `7px 16px 9px` | 16px | 500 | 40px |
| Add to cellar | transparent | `rgb(30,30,30)` | 80px | `7px 16px 9px` | 16px | 500 | 40px |

Note the asymmetric vertical padding (7 top / 9 bottom) — an optical-centring correction for the typeface's baseline. Note also that the 40px control height is *below* the 44px touch-target floor Terroir's own frontend defaults require; do not copy that number.

**Card and sheet patterns.** Merchandising rails are horizontal-scroll card rows with a section heading and a "See all" link that carries the full filter state into `/explore`. Shop cards are: cutout bottle · name · vintage · rating with a rating-basis qualifier ("4.3 (based on all vintages)" vs "4.2 (112 ratings)") · discount badge (`−68%`) · sale price · struck original price · **Add**. That rating-basis qualifier is a small honesty device worth stealing outright.

---

## 7. Architecture and data facts that are public

| Fact | Detail | Tag | Source + date |
|---|---|---|---|
| Label recognition engine | **Vuforia** computer vision (PTC's product; the case study's "Products Used" field names *Vuforia Engine*). "Vivino relies on Vuforia's advanced computer vision technology to identify the exact wine label captured by the app." | [PUBLISHED] | [PTC case study](https://www.ptc.com/en/case-studies/vivino), undated |
| Recognition index | **Vuforia Cloud Recognition Service** stores every label image as an image target. "By hosting the images in the cloud, Vivino can update this database dynamically, and manage millions of image targets for a single app without updating the app itself." | [PUBLISHED] | [PTC case study](https://www.ptc.com/en/case-studies/vivino) |
| Recognition granularity | Must discriminate not only brand-from-brand but **vintage within a brand** | [PUBLISHED] | [PTC case study](https://www.ptc.com/en/case-studies/vivino) |
| Founder on scale | "We have millions of pictures of wine labels in our system and are adding thousands more daily" — Heini Zachariassen | [PUBLISHED] | [PTC case study](https://www.ptc.com/en/case-studies/vivino) |
| Wine-list OCR pipeline | Photo compressed on device → sent to **ABBYY FineReader Engine** running on Vivino's back-end server → text extracted → keywords matched against the Vivino database → results returned **superimposed on the user's original image**, tap a name to open the wine page | [PUBLISHED] *(2016 — may be stale)* | [diginomica, 2016-02-25](https://diginomica.com/uncorking-wine-information-with-ocr-technology-at-vivino) |
| Why ABBYY | Chosen for speed of response, recognition accuracy, and **ability to handle low-light restaurant images** | [PUBLISHED] *(2016)* | [diginomica, 2016-02-25](https://diginomica.com/uncorking-wine-information-with-ocr-technology-at-vivino) |
| Launch date of list scanner | November 2014 | [PUBLISHED] | [diginomica, 2016-02-25](https://diginomica.com/uncorking-wine-information-with-ocr-technology-at-vivino) |
| Original recognition vendor | Kooaba (Swiss) | REPORTED (secondary) | [productmint](https://productmint.com/vivino-business-model-how-does-vivino-make-money/), updated 2022-12-23 |
| OCR accuracy step-change | Adding OCR in early 2013 "increased its success rate of matching wine labels to over 86 percent"; the July 2011 v1 shipped with 450,000 wines and ~60% recognition | REPORTED (secondary) | [productmint](https://productmint.com/vivino-business-model-how-does-vivino-make-money/) |
| Database size (current) | 20.4 million+ wines, 3.48 billion+ scanned labels, 77.4 million+ users | [PUBLISHED] | [About](https://www.vivino.com/en/about), read 2026-09-02 |
| Taste-profile derivation | Taste Characteristics "aggregates the most commonly used words to describe wines" from the community; structural profile visualises sweetness/body/acidity; flavour profile is "all sourced from the crowd" and each flavour links to the reviews that mention it | [PUBLISHED] | [Taste Characteristics, 2018-09-28](https://www.vivino.com/en/wine-news/understanding-wine-taste-characteristics) |
| Personal-taste derivation | "The algorithm draws on the grapes, styles, regions, and flavour profiles of the wines you've rated, and cross-references them against every other wine in the database." Bands: 70–100% will enjoy, 40–70% average/risky, <40% unlikely. Improves with volume — "A profile built on 5 ratings gives you a starting point. A profile built on 50 or 100 ratings gives you precise recommendations." | [PUBLISHED] | [Match for You explainer](https://www.vivino.com/en/wine-news/vivinos-match-for-you-score-explained-how-we-learn-your-taste), updated June 2026 |
| Rating design rationale | 5 stars (not 100 points) because it is "familiar to consumers… popularized by companies like Amazon, TripAdvisor". Validated against >100,000 expert ratings: "a 4.0 Vivino rating correlates with a 90 point expert rating". Coverage argument: "only about 20 percent [of world-class wines] have an expert rating", and "More than 75% of wines available are never rated by experts" | [PUBLISHED] | [Rating system](https://www.vivino.com/en/wine-news/vivino-5-star-rating-system); [diginomica](https://diginomica.com/uncorking-wine-information-with-ocr-technology-at-vivino) |
| Rating distribution | Vivino states the average rating is 3.6; 4.0 is "better than 85 percent" and 4.5 "better than 99 percent" of the database | [PUBLISHED] | [Rating system](https://www.vivino.com/en/wine-news/vivino-5-star-rating-system) |
| Ratings independence claim | "never increased or decreased by advertising, sponsorship, or other factors" | [PUBLISHED] | [Rating system](https://www.vivino.com/en/wine-news/vivino-5-star-rating-system) |
| Pricing model | Freemium subscription, **priced per country** in local currency across iOS and Android, US 4.99 USD/mo or 47.90 USD/yr [PUBLISHED]; a global price table is published as a public article | [PUBLISHED] | [Premium pricing guide](https://www.vivino.com/en/articles/premium-pricing-guide-en) |
| Marketplace model | Merchants integrate via third-party partner **Actenzo** ("may require a monthly subscription to Actenzo and a storefront running on specific e-commerce platforms"). Requirements: registered wine business in a marketplace country, connectable inventory/order system, tracks inventory *and vintages*, ships in 1–2 working days, uses a professional logistics service. Vivino provides a Merchant Dashboard with analytics, runs multi-step order QC, and pitches "two-click checkout" | [PUBLISHED] | [Merchant signup](https://www.vivino.com/en/merchants/signup) |
| Revenue streams | Marketing/commission fees on marketplace sales, subscriptions, advertising, and sale of aggregated (non-personal) rating data | REPORTED (secondary) | [productmint](https://productmint.com/vivino-business-model-how-does-vivino-make-money/) |
| Engineering blog | **Does not exist any more.** `engineering.vivino.com` returns HTTP 301 to the commerce homepage | [PUBLISHED] | fetched 2026-09-02 |
| Front-end stack signal | Server-rendered pages with an OneTrust consent layer, a Contentful CMS behind imgproxy, Typeform for merchant intake, and a first-party ad server on `promotions.vivino.com` | [PUBLISHED] | live pages, 2026-09-02 |

---

## 8. Ranked "adopt for Terroir" list

Build-size tags are engineering judgements about Terroir's codebase, not measurements — all `S/M/L` values are `[ESTIMATE]`. S ≈ under a day, M ≈ 2–5 days, L ≈ a sprint or more.

### #1 — Aggregate-from-reviews taste block, with drill-through — **M**
**Copy:** the whole mechanic. Aggregate the most-used descriptor words across a wine's notes, render them as chips with a mention count, and make every chip a filter that opens exactly the notes containing it. Pair it with a small set of structural axes (light↔bold, smooth↔tannic, dry↔sweet, soft↔acidic).
**Do better:** Vivino's counts come from millions of strangers. Terroir's corpus is a *single house* — the sommelier's own notes, the staff's, the guest feedback. That is far smaller but far more relevant, and it is the only place a mention count means something operationally ("six of our people called this oaky" is a service fact). Attribute the aggregate to a named scope ("across 14 house notes") instead of hiding the n, and show the axes only when n clears a floor — Vivino's failure mode is a confident-looking slider built on four reviews.
**Terroir position:** `AxisBar` already exists in `src/components/detail-sections.tsx`; the aggregation and the drill-through are the new work.

### #2 — A Home surface whose job is harvesting preference signal — **M**
**Copy:** the recent-scans stack with a one-tap thumb up/down, positioned as the first thing on Home, plus the "Taste Profile" widget next to it. Vivino is explicit that this exists to feed the model: "every rating, like, or dislike gives Vivino another signal about your preferences."
**Do better:** Terroir's equivalent signal is richer and less annoying to collect, because it is a *byproduct of service*. What poured tonight, what got 86'd, what came back untouched — those are stronger preference signals than a thumb, and the staff generate them anyway. Build the Home stack around confirming inferences ("You poured three Loire Chenins this week — surface more?") rather than begging for ratings.
**Terroir position:** no Home surface today (`src/app/page.tsx` routes by role straight into a tab). This is genuinely new.

### #3 — Highlight-badge vocabulary on the wine row and wine page — **S**
**Copy:** the badge idea and its discipline — a *small, closed, documented* vocabulary of derived flags, each with a one-line explanation the user can read. Vivino's six: Great Value for Money, Featured In, Popular, Friends, Wine Style Award Winner, You Like / Haven't Tried This Style.
**Do better:** Terroir's badges should be operational, not social: *Drink now*, *Last bottle*, *Slow mover*, *Below cost*, *Off-list*, *Mis-binned*. Every badge must be derivable from the tenant's own data and must state its rule on tap — Vivino publishes its badge rules in a blog post nobody reads; put them in the UI.
**Terroir position:** small; badges compose from data Terroir already has (bins, stock, pricing, reconcile queue).

### #4 — The rating-colour ramp and the flavour-group colour ramp — **S**
**Copy:** the *technique*, not the hexes. Two purpose-built colour scales: one that maps rating to warmth so a dense list is legible without reading numerals; one that gives every aroma family a semantically-chosen constant colour so a flavour chip is recognisable pre-attentively.
**Do better:** Terroir already has a defined identity (`DESIGN.md` — Nocturne: claret `#96122A` on cool near-black, Source Serif 4 / Source Sans 3, "brown and cream banned outright"). **Do not import Vivino's palette** — several flavour tokens (`--flavor-earthy #b59b6f`, `--flavor-oaky #8c5433`, `--flavor-ageing #9e6e40`) are exactly the browns Terroir's contract bans. Derive both ramps inside the Nocturne palette, add them to `DESIGN.md` as new token families, and lint them.
**Terroir position:** token work plus a `DESIGN.md` version bump; the render sites (`AxisBar`, `CommunityRating`) exist.

### #5 — Rating-basis honesty labels — **S**
**Copy:** Vivino's shop cards say `4.3 (based on all vintages)` or `4.2 (112 ratings)` — the rating always carries the basis of its own confidence.
**Do better:** apply the same rule to every derived number Terroir shows: a drinking window says whose window it is, a price says whether it is invoice cost, last-paid, or a market comparison, and a taste axis says how many notes it stands on. Terroir's catalogue detail view already does this in prose ("says out loud what it does not know"); make it a component contract rather than a per-page habit.

### #6 — Restaurant wine-list scanning as an OCR-plus-overlay pattern — **L**
**Copy:** the interaction, which is a decade proven and still Vivino's most-praised premium feature: photograph a list → server-side OCR → keyword-match against the canonical wine table → **return results superimposed on the user's own photo**, tappable. The overlay is the clever half: it preserves the user's spatial memory of the page instead of dumping an unordered result list.
**Do better:** Terroir already runs an OCR-plus-LLM extraction pipeline for invoices (Azure Document Intelligence → Claude → typed line items). A wine list is the same shape of problem with a different schema, and the match target is `canonical_wines`/`wine_variants` rather than a merchant catalogue. The competitive twist: Terroir can score a *competitor's* list against the house cellar — what we carry, what we don't, where we're cheaper — which Vivino structurally cannot do.
**Terroir position:** L, but on rails Terroir already laid.

### #7 — A vintage-comparison spine under one canonical wine — **M**
**Copy:** Vivino's "Compare Vintages" — one wine entity, many vintage records, each with its own rating, highlights and reviews, switchable in place.
**Do better:** Terroir's `canonical_wines`/`wine_variants` split is already the right shape for this; Vivino only compares consumer signals, while Terroir can compare *what the house actually paid, poured and sold* per vintage. That turns a browsing toy into a buying tool.

### #8 — Per-country price tiering, published openly — **S**
**Copy:** the practice of a public, per-market price table with iOS and Android columns, and the discipline of price tiers rather than one global number (Vivino ranges 1.99–5.99 USD/month equivalents [PUBLISHED]).
**Do better:** Terroir sells to restaurants, so the axis is venue size or list size, not country. The transferable move is the *transparency*: a public pricing page a prospect can read without a sales call, with the tier boundaries stated. Vivino's own pricing guide is a plain article and it works.

**Also worth taking, below the top eight:** the merchandising-rail pattern where "See all" carries full filter state into a URL (Terroir's `/explore` equivalent); the three-state feature comparison table (✓ / – / qualifier word) for a pricing page; the mode-picker scanner (Label / List / Quick Compare) as one camera entry rather than three routes; and the "what to do when the scanner can't identify a wine" help page — publishing your failure path builds more trust than pretending there isn't one.

---

## 9. What NOT to copy, and why

1. **The commerce funnel on the wine page.** Vivino's wine page is a storefront: a buy block sits *above* the taste information, and a sponsored card sits above it too. Terroir's user is standing in their own cellar, not a shop. Putting price-and-buy above taste would invert the job.
2. **Sponsored placements inside the primary object.** The inline ad on the wine page is targeted on the very wine the user is reading about, with `sponsored`, `buyable` and `premium` flags in the payload. Terroir's credibility with a sommelier is its only asset; a promoted bottle on a wine page spends that asset for pennies.
3. **The 40px control height.** Measured, and below the ≥44px touch-target floor in Terroir's own frontend defaults.
4. **A single global 5-star average as the headline number.** A competitor measures most Vivino ratings clustering between roughly 3.5 and 4.2 [PUBLISHED as sommo.app's claim] — the scale has compressed to the point where the number barely discriminates. Vivino's own data agrees: the average is 3.6 and 4.0 already beats 85% of the database [PUBLISHED]. Terroir's n per wine will be tiny by comparison, which makes a bare average worse, not better. Prefer a rating *with basis* (#5) and a personal/house match score over a global star.
5. **Gating the operationally-critical feature behind the paywall.** Vivino moved restaurant wine-list scanning from free to Premium; the change is a documented sore point [PUBLISHED as sommo.app's claim] and shows up in App Store reviews as churn ("five dollars a month is simply insulting… we are leaving your app" [PUBLISHED]). For Terroir the analogue is bin placement or reconciliation — the things a venue cannot run service without. Gate depth and analytics, never the daily job.
6. **The cellar-as-list model.** Vivino's cellar is quantities, notes and filters; users have been asking for row/column placement since at least December 2020 [PUBLISHED], and Vivino's own current cellar documentation still describes no location dimension. This is Terroir's existing advantage — do not regress toward Vivino's model in the name of familiarity. (Worth a five-minute in-app check before quoting this to anyone: the absence is inferred from Vivino's silence, not confirmed.)
7. **Vivino's palette and type.** GraphikWeb at 13px near-monoweight over warm off-white, with brown-leaning flavour tokens, is a consumer-marketplace look that directly contradicts Terroir's `DESIGN.md`. Take the *systems* (§8 #4), leave the values.
8. **Publishing statistics you don't maintain.** Six Vivino surfaces disagree about how many users and wines it has (§5.1). One live counter, one source of truth.

---

## 10. Gaps — what is NOT publicly available

- **The marketplace commission rate.** Search results surface a "15% commission" figure on aggregator blogs, but no primary Vivino source states any rate, and the merchant signup page is silent. Not verified; deliberately excluded from §7.
- **Recognition accuracy today.** No current published number. The circulating "92.3% accuracy / 1.4s median latency / pHash > 0.91" figures trace to a low-quality SEO page with no primary attribution and are **not** used in this brief. The only sourced accuracy datapoints are historical (~60% at launch 2011, >86% after OCR in 2013) and secondary.
- **Whether Vuforia and ABBYY are still in the stack.** The PTC case study is undated and the ABBYY article is from 2016. Both are plausible-but-unconfirmed as current architecture.
- **Any engineering blog or public tech writing.** `engineering.vivino.com` now 301s to the shop. Nothing public on the recommender, the review-mining pipeline, or the Sommelier LLM.
- **The Sommelier's model, retrieval design, or guardrails.** Only marketing copy ("combines your personal taste profile with all of Vivinos wine data within an easy-to-use AI chat").
- **In-app screen dimensions, exact bottom-nav composition, and the scan-result disambiguation sheet.** Not documented; the owner's first-hand account is the only evidence and is flagged as such throughout.
- **Revenue, GMV, take rate, subscriber count, current valuation.** Private company; last public datapoints are years old.

---

## 11. How to verify the private numbers

1. **Scan-result sheet, bottom nav, wine-page overflow menu, mention counts, "show more/less like this."** Install the app and screen-record one scan-to-wine-page flow. Ten minutes closes most of §4 and §5's owner-observed rows. Do this before committing to adoption candidate #1's UI.
2. **Recognition latency and accuracy.** Build a 30-bottle fixture set from the venue's own cellar (mix: mainstream, small producer, damaged label, low light) and time scan→identified for Vivino and for Terroir's `/scan-bottle`. That gives a real baseline instead of an SEO number, and it doubles as a regression fixture.
3. **Whether Vuforia/ABBYY are still live.** Proxy the app's traffic (mitmproxy on a test device) and read the hostnames the scanner talks to. Public-source research cannot answer this; a packet capture can.
4. **Commission rate.** Ask a merchant. The Actenzo integration path means any Vivino merchant partner knows the number; a supplier the venue already buys from is the cheapest route.
5. **Rating distribution.** Sample 200 wine pages across price bands via the public `/explore` filters and plot the ratings. That verifies or kills the "3.5–4.2 compression" claim from a source that has a commercial reason to make it.
6. **Sommelier behaviour.** One month of Premium at 4.99 USD [PUBLISHED] is the cheapest competitive-intelligence purchase available and the only way to see the AI chat, drinking windows and collection value.

---

## 12. Sources

**Primary — Vivino-owned**
- [About Vivino — "Vivino in numbers"](https://www.vivino.com/en/about)
- [The complete guide to the Vivino experience](https://www.vivino.com/en/wine-news/the-complete-guide-to-the-vivino-experience) (last updated May 2026)
- [Vivino's Match for You score explained](https://www.vivino.com/en/wine-news/vivinos-match-for-you-score-explained-how-we-learn-your-taste) (last updated June 2026)
- [The Wine Taste Characteristics: Understanding the New Feature](https://www.vivino.com/en/wine-news/understanding-wine-taste-characteristics) (2018-09-28)
- [The Vivino wine rating system: Credibility of the crowd](https://www.vivino.com/en/wine-news/vivino-5-star-rating-system)
- [Discover the Full Vivino Wine Page](https://www.vivino.com/en/wine-news/discover-the-full-vivino-wine-page) (2020-06-25)
- [Discover Vivino's Wine Cellar feature](https://www.vivino.com/en/wine-news/discover-vivinos-wine-cellar-feature)
- [Vivino wine scanner](https://www.vivino.com/en/wine-news/vivino-wine-scanner) (2025-08-11)
- [The Vivino's app home page got more personal](https://www.vivino.com/en/wine-news/the-vivinos-app-home-page-got-more-personal)
- [Vivino Premium](https://www.vivino.com/en/premium) · [Pricing Guide Vivino Premium](https://www.vivino.com/en/articles/premium-pricing-guide-en)
- [Sell your wine on Vivino — merchant signup](https://www.vivino.com/en/merchants/signup)
- [2021 The Prisoner Saldo Zinfandel wine page](https://www.vivino.com/en/the-prisoner-saldo-zinfandel/w/1361944?year=2021) — the live page inspected for §5 and §6

**App stores**
- [App Store — Vivino: Drink The Right Wine](https://apps.apple.com/us/app/vivino-drink-the-right-wine/id414461255)
- [Google Play — Vivino: Drink the Right Wine](https://play.google.com/store/apps/details?id=vivino.web.app&hl=en_US)

**Press / vendor / analysis**
- [PTC — Vivino and Vuforia's Image Recognition Solution Make a Great Pairing](https://www.ptc.com/en/case-studies/vivino)
- [diginomica — Uncorking wine information with OCR technology at Vivino](https://diginomica.com/uncorking-wine-information-with-ocr-technology-at-vivino) (2016-02-25)
- [productmint — The Vivino Business Model](https://productmint.com/vivino-business-model-how-does-vivino-make-money/) (updated 2022-12-23) — secondary
- [Expanded Ramblings — Vivino Statistics (2026)](https://expandedramblings.com/index.php/vivino-facts-statistics/) (2026-03-05) — secondary, restates Vivino's About page

**Competitive set (author has a commercial interest — treat as advocacy)**
- [Sommo — Best Vivino Alternative 2026](https://sommo.app/alternatives/vivino/)
- [Sommo — Best Wine Scanner Apps 2026](https://sommo.app/blog/best-wine-scanner-apps-2026/)

---

## 13. Run notes

- **Depth:** standard. **Firecrawl calls: 0** — every source was fetched with the local crawl4ai scraper (free, uncapped). One target (`winebusiness.com`) failed and was dropped rather than escalated. WebFetch: 0.
- **Sources harvested:** 25 pages; 24 load-bearing quotes byte-verified with `cite-check.sh` (100% OK). One quote (`over 1 million label scans per day`) initially MISSed on a partial string and passed on the full sentence.
- **Design-language evidence** came from direct computed-style and CSS-custom-property inspection of the live wine page, not from a screenshot or a description.
- **Adversarial verification:** GPT-5.6 Sol (`verify-codex.sh`) failed with a tripped circuit breaker; verification fell back to a Claude adversarial subagent per the skill's failure path. 15 claims judged: 10 supported, 5 partially supported, 0 contradicted. Every `partially_supported` verdict was applied — the cellar-location claim was demoted from fact to inference-from-silence, the Vuforia/PTC attribution was narrowed to what the case study's own "Products Used" field states, and the guide-vs-About figure comparison was restated as a table of what each surface says rather than a directional claim. Two verdicts (the sub-40% Match band, and community-review sourcing of Taste Characteristics) were re-checked against the harvested bytes and confirmed — the claims file had quoted a shorter span than the brief uses. Two `STALE` flags (2016 OCR architecture, 2020 cellar review) are carried into §2 and §10 rather than being dropped.
- **Not used:** an SEO page circulating unattributed accuracy/latency/pHash figures for Vivino's matcher. Excluded on credibility grounds even though the text was fetchable.

---

## 14. Logged-in walkthrough (web) — 2026-09-02

Signed in via Devin's Google identity in his own Chrome session; no password was typed by an
agent. Read-only: nothing was rated, added to a cellar or list, or purchased.

**What the web account exposes.** The avatar menu is the whole logged-in surface: Cellar
(`/cellars/<id>`), My Wines (`/users/<id>/wines` — tabs Latest Ratings / Top Ratings / Wish
List), My Lists (`/lists`, "Create List"), Orders, Profile, Invite Friends, Settings
(`/settings` — Public profile / Account management / Privacy & sharing / Notifications, with a
banner that changes here "will automatically be reflected in the settings in your Vivino
app"), Log out. Devin's account is fresh (no ratings), so the empty states were what rendered:
the Cellar page's entire pitch is one sentence — "Storing wine at home? Keep track of the wines
you own, so you'll always know what you have on hand" — with a placeholder of three bottle
rows carrying +/− steppers and a grape glyph, which confirms §9's point that Vivino's cellar is
a quantity list with no location dimension. My Wines' empty state sends the user to the app:
"Scan using the app, or search and rate here."

**The web wine page, logged in,** is the same page as logged out plus Add to Wishlist / Add to
cellar (Premium badge on the latter). Order of blocks, verified on a live page: buy box (price
per bottle, bottle stepper defaulting to 12, vintage select, Add to cart, "You are saving 36 %",
delivery estimate, merchant) → two highlight badges (Featured in Top 25 …, Featured in Wine
Style Awards) → a Sponsored card → Facts about the wine (winery, grapes, region path, wine
style, alcohol, allergens, description) → Compare Vintages (per vintage: a one-line reason such
as "A top rated year for this wine" / "Among top 1 % of all wines in the world" / "Popular among
Vivino users", rating, count, availability, price) → the four taste axes → **Wine Lovers Taste
Summary** ("based on 5,266 user reviews", thirteen aroma families each with a mention count,
largest first) → food pairing ("Our wine experts think…") → winery card (wines, total ratings).
No rating control is offered on the web page at all; rating is app-only.

**Premium, as sold on the web (2026-09-02):** free shipping from $100, **Unlimited Sommelier**
("combines your personal taste profile with all of Vivino's wine data within an easy-to-use AI
chat"), and the **Wine List scanner** ("reveal the star rating for every wine on the list").
Both AI features are app-only; the web has no Sommelier entry point.

**Explore facets, logged in:** the same URL-encoded filter state as logged out (§3.2); a
"Sponsored" tile leads the grid, and each card carries the "Popular among Vivino users. More
than N ratings" sentence — the same rating-basis honesty pattern as §8 #5.

**What this changes in §8.** Nothing in the ranking. It sharpens two points: (a) the wine
page's block order puts commerce first even for a signed-in user with no purchase intent
(§9 #1 stands); (b) every experience Devin praised — camera scan, slide-up suggestion card,
floating nav, Sommelier — lives only in the iOS/Android app, which no browser session can
reach. **To audit those flows, Devin's own phone screenshots or a screen recording are the
evidence; the web account cannot produce them.**
