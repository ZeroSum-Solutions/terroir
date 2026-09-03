# Vinous — competitor audit for Terroir: search, information design, content model, and what could be licensed

_Scope: vinous.com and the Vinous iOS/Android apps (Vinous Media LLC, New York). Public sources only — no login, no paywall bypass. Prepared 2026-09-02. Depth: standard._

---

## 1. TL;DR

Vinous is a critic-authored wine publication whose product value sits in three places Terroir can learn from directly: a **faceted review search over a canonical wine spine**, a **review record with a strict, machine-readable shape** (score + drinking-window begin/end years + tasting text + author + review date + article provenance), and a **content ladder that keeps free surfaces genuinely useful** (vintage chart, glossary, grape guide, free "Vinous Favorites" notes) while gating the archive. The single most valuable discovery in this run is that Vinous's own public server-rendered pages expose its content model verbatim: a `baseWine` canonical entity carrying a Liv-ex `lwin7`, a `wine_vintages` list carrying `lwin11`, a per-vintage review with `drinking_window_begin`/`drinking_window_end`, and a nested `producer` — which is almost exactly Terroir's `canonical_wines` / `wine_variants` split, with LWIN as the interoperability key Terroir currently lacks.

On sourcing the data: **do not plan on it cheaply.** Vinous licenses reviews through a published commercial ladder — Pro US$500/yr [PUBLISHED] (500 notes concurrent), Enterprise US$2,000/yr [PUBLISHED] (1,500 notes, plus API access via Liv-ex), Enterprise+ and Enterprise Max (email for pricing, 3,000 and 4,000 notes) — and the Terms of Service explicitly forbid third-party apps embedding Vinous content via APIs, forbid scraping, and forbid using any portion of the content "within any algorithmic ratings system" without written permission. The only documented programmatic route is the **Vinous/Liv-ex API**, which requires a Vinous Enterprise subscription *and* Liv-ex Gold-tier membership. Enterprise Max is explicitly the tier "Required for content resellers."

The realistic read: copy the information architecture and the record shape; treat Vinous data as a paid, contract-first integration for a later stage, not a scrape.

---

## 2. Confirmed vs. inferred

| Confidence | What we know |
|---|---|
| **CONFIRMED [PUBLISHED]** | Consumer and commercial pricing tiers; the full search facet and sort inventory; the review-card anatomy; the complete public content-model field list (from Vinous's own SSR payloads); the ToS reuse/citation/scraping/API clauses; the Vinous/Liv-ex API gating; the Delectable acquisition and Delectable Premium's Vinous integration at US$5.99/mo; the published 100-point rating scale; the CellarTracker partner integration; the site's typeface and red utility colour. |
| **REPORTED (secondary)** | The "fire sale" characterisation of the Delectable acquisition price (The Drinks Business, citing the New York Post, Dec 2016) — one outlet, uncorroborated. App-store rating counts and install bands are platform-reported, undated. |
| **INFERRED / ESTIMATE** | No Stage-5 triangulation was needed or run — every facts-needed item resolved to a primary source or to an explicit "not published". There are **no [ESTIMATE] figures in this brief**. Judgement calls (build sizes, adopt/skip rankings in §7–§9) are my recommendations, clearly labelled as such, not sourced facts. |
| **CONFLICTS / STALE** | **Archive size is stated three different ways**: vinous.com says "over 450,000 wine reviews" (current, 2026-09-02); the iOS App Store listing says "nearly 400,000" (listing last versioned 1.3.9, 07/09/2023 — stale); Google Play says "over 200,000" (listing updated Apr 2, 2024 — stale). Use 450,000 as the live figure and treat the store listings as unmaintained. Both mobile listings are years old, so mobile feature descriptions may not reflect the current apps. |

---

## 3. Feature inventory

### 3.1 Search and its facets

The public "Tasting Notes Index" at `vinous.com/wines` is the core search surface, and its full control set is visible without logging in.

| Item | Value | Tag | Source | Date |
|---|---|---|---|---|
| Result-type tabs | Reviews · Vintages · Wines · Producers (four distinct search modes: `reviews`, `wineVintage`, `baseWine`, `producer`) | [PUBLISHED] | [vinous.com/wines](https://vinous.com/wines) + page JS chunk | 2026-09-02 |
| Sort options | Default, Vintage, Producer, Name, Score, Author, Drinking Window, Review Date — with a direction toggle | [PUBLISHED] | [vinous.com/wines](https://vinous.com/wines) | 2026-09-02 |
| Range facets | Vintage between (1927–2026), Score between (85–100 visible), Price between (0–1000), Review Date between | [PUBLISHED] | [vinous.com/wines](https://vinous.com/wines) | 2026-09-02 |
| List facets | Country (28 listed, Argentina→Wales), Color (13 values incl. Orange, Sweet Sparkling Rosé, Fortified/Spirits), Author (12 named critics + "Vinous" + "Past Authors") | [PUBLISHED] | [vinous.com/wines](https://vinous.com/wines) | 2026-09-02 |
| Facet UI | Long facet lists collapse behind a "Show More / Less Options" expander; "Show Advanced Options" is the **mobile filter-drawer toggle**, not a second tier of facets | [PUBLISHED] | `wines-0473aa4704f32f45.js` | 2026-09-02 |
| Query params | `wine_filter[...]` namespace, e.g. `wine_filter[score_range_min]`, `wine_filter[vintage_range_max]`, `wine_filter[review_date_year_range_min]`, `wine_filter[color]`, `wine_filter[country]`, `wine_filter[author]` — all URL-addressable and shareable | [PUBLISHED] | `wines-0473aa4704f32f45.js` | 2026-09-02 |
| Year-in-query parsing | The free-text box scans the typed terms for a 4-digit number between 1900 and the current year, strips it out, and applies it as a vintage filter. Typing "2015 barolo" becomes term "barolo" + vintage 2015 automatically. | [PUBLISHED] | `wines-0473aa4704f32f45.js` | 2026-09-02 |
| Empty query | Defaults to the wildcard `"*"` rather than an empty result set | [PUBLISHED] | `wines-0473aa4704f32f45.js` | 2026-09-02 |
| Typeahead | 1000 ms debounce; suggestions rendered with `react-highlight-words` — matched substring gets `underline font-semibold` with a red underline (`#dc2626`); a red banner reads "PRESS ENTER FOR FULL RESULTS"; picking a suggestion that carries both `slug` and `vintage` routes straight to `/wines/{slug}/{vintage}` | [PUBLISHED] | `443-9c6d5b4d4a9a7401.js` | 2026-09-02 |
| Backend | Elasticsearch — result documents arrive wrapped in `_index: "wines"`, `_id`, `_score`, `_source` | [PUBLISHED] | `vinous.com/wines` SSR payload | 2026-09-02 |

**This confirms the owner's observation.** Search *is* the product's spine: highlighted typeahead, region/country and vintage facets, a URL-addressable filter state, and — the detail worth stealing outright — the year-sniffing query parser.

### 3.2 Archive size, content types and tools

| Item | Value | Tag | Source | Date |
|---|---|---|---|---|
| Archive (live, site) | "over 450,000 wine reviews plus thousands of articles, videos" | [PUBLISHED] | [vinous.com/users/plan](https://vinous.com/users/plan?selected=consumer) | 2026-09-02 |
| Archive (iOS listing — stale) | "nearly 400,000 tasting notes and scores" | [PUBLISHED] | [App Store id1010711422](https://apps.apple.com/us/app/vinous-wine-reviews-ratings/id1010711422) | listing v1.3.9, 2023-07-09 |
| Archive (Play listing — stale) | "over 200,000 tasting notes and scores" | [PUBLISHED] | [Google Play com.vinous.android](https://play.google.com/store/apps/details?id=com.vinous.android) | listing updated 2024-04-02 |
| Archive at IWC acquisition | "more than 180,000 professional wine reviews and more than 1,000 articles" | [PUBLISHED] | [Vinous, IWC acquisition](https://vinous.com/articles/vinous-to-acquire-stephen-tanzer-s-international-wine-cellar-nov-2014) | 2014-11-18 |
| Editorial scope | "in depth coverage of new releases, retrospectives and verticals of older wines, videos with winemakers, interactive maps, restaurant recommendations and more, all published in a continual, daily stream of articles" | [PUBLISHED] | [vinous.com/about](https://vinous.com/about) | 2026-09-02 |
| Reach | "subscribers in over 100 countries" | [PUBLISHED] | [vinous.com/about](https://vinous.com/about) | 2026-09-02 |
| Vintage chart | "our free Vintage Chart, which describes growing conditions and overall quality for every major wine-producing area in the world" — but `/vintages` renders a sign-in form to anonymous visitors, i.e. free-with-registration, not open | [PUBLISHED] | App Store listing; [vinous.com/vintages](https://vinous.com/vintages) | 2026-09-02 |
| Glossary, Grape Guide | Present as top-nav "Tools" items (`/glossary`, `/grape_guide`); both render behind the same registration gate | [PUBLISHED] | [vinous.com](https://vinous.com/) nav; page fetches | 2026-09-02 |
| Maps | Alessandro Masnaghetti's vineyard cartography — physical maps sold via `billing.vinous.com/products/vinousmaps` plus in-app maps; **the store page and map catalogue are client-rendered and returned no public price list in this run** | [PUBLISHED] (existence) | [vinous.com/statics/maps](https://vinous.com/statics/maps); App Store listing | 2026-09-02 |
| Verticals / retrospectives | A first-class editorial format, visible on the public homepage: e.g. "Vatan Sancerre Clos La Néore: 2005-2022" (13-vintage vertical), "The Original Napa Valley Icon: Stag's Leap Wine Cellars Cabernet Sauvignon S.L.V." (retrospective to 1973) | [PUBLISHED] | [vinous.com](https://vinous.com/) | 2026-09-02 |
| Free note formats | "Vinous Favorites" (score + price + full tasting note + critic initials, ungated) and "Cellar Favorites" (older-bottle notes) run on the public homepage | [PUBLISHED] | [vinous.com](https://vinous.com/) | 2026-09-02 |
| Restaurant coverage | "Vinous Table" — a recurring restaurant/hotel recommendation format | [PUBLISHED] | [vinous.com](https://vinous.com/) | 2026-09-02 |
| Community | `forum.vinous.com` ("Your Say") — a subscriber forum, separate property | [PUBLISHED] | [vinous.com](https://vinous.com/) nav | 2026-09-02 |
| Adjacent properties | Cellar Watch (`cellar-watch.com`, collection valuation, acquired from Liv-ex Dec 2019) and Delectable (`delectable.com`) both sit in the primary nav | [PUBLISHED] | [vinous.com](https://vinous.com/) nav; [Cellar Watch acquisition](https://vinous.com/articles/vinous-acquires-cellar-watch-from-liv-ex-dec-2019) | 2019-12-05 |

### 3.3 Label camera → Delectable

Vinous runs **two** scan paths, and they have different histories.

| Item | Value | Tag | Source | Date |
|---|---|---|---|---|
| Vinous app's own camera | "Among other features, the Vinous app includes a camera that allows you to take a photo of a label and link to our database, also optimized for iPhone." (developer reply to a review) | [PUBLISHED] | App Store id1010711422 | 2018-07-13 |
| Vinous app launch positioning | "allows wine lovers to scan labels to instantaneously get scores and tasting notes from the world's top wine critics" | [PUBLISHED] | [PR Newswire](https://www.prnewswire.com/news-releases/vinous-announces-launch-of-revolutionary-wine-app-300189621.html) | 2015-12-08 |
| Android listing | "Type a wine name or scan a label to search Vinous' archive" | [PUBLISHED] | Google Play | listing updated 2024-04-02 |
| Delectable acquisition | "Vinous CEO and Founder Antonio Galloni announced today the acquisition of the wine apps Delectable and Banquet. Known as the 'Instagram of wine,' Delectable has been downloaded over a million times and has over 120,000 monthly loyal, unique users." | [PUBLISHED] | [PR Newswire](https://www.prnewswire.com/news-releases/vinous-acquires-delectable--banquet-apps-300375364.html) | 2016-12-08 |
| Delectable's scan promise | "Take a photo and Delectable will identify the wine in seconds • Get reviews and tasting notes on any wine from the world's leading wine community • Scan an unlimited number of wines for free" | [PUBLISHED] | [App Store id512106648](https://apps.apple.com/us/app/delectable-scan-rate-wine/id512106648) | fetched 2026-09-02 |
| Human-in-the-loop fallback | Delectable Premium includes "Priority wine transcription for hard to match labels" — i.e. unmatched labels go to a manual transcription queue, and paying gets you to the front of it | [PUBLISHED] | App Store id512106648 | fetched 2026-09-02 |
| Delectable app staleness | Latest version-history entry is "5.9.5 09/14/2021 — Facebook login fix"; ratings 4.7 across 26K ratings | [PUBLISHED] | App Store id512106648 | 2021-09-14 |
| Delectable ownership today | Footer reads "©2026 Vinous Group LLC" | [PUBLISHED] | [delectable.com](https://delectable.com/) | 2026-09-02 |

**Verdict on the owner's observation:** correct in substance. Delectable is the label-scan surface and it is Vinous-owned, but the routing is *editorial and commercial* rather than technical — the Vinous app has had its own camera since 2015, and Delectable is a separately-branded, community-first app that Vinous bought and then wired its professional reviews into as a paid upgrade.

### 3.4 Subscription tiers and prices

| Tier | Price | Tag | What it includes (verbatim highlights) | Source |
|---|---|---|---|---|
| Classic (consumer) | US$140/year [PUBLISHED] | [PUBLISHED] | "Full access to vinous.com and iOS/Android Apps"; "Delectable Premium upgrade included and CellarTracker compatible"; "Live and historic pricing data from Liv-ex"; "Direct links to Wine-Searcher listings" | [vinous.com/users/plan](https://vinous.com/users/plan?selected=consumer) |
| Premium (consumer) | US$210/year [PUBLISHED] | [PUBLISHED] | Classic plus "Priority access to events and tastings"; "Additional special offers" | same |
| Basic Pro (trade) | US$500/year [PUBLISHED] | [PUBLISHED] | "Use up to 500 reviews, maximum 50/article, in-stock wines only (wineries exempt)"; single user; "Copying/pasting enabled on website" | same + [commercial subscriptions](https://vinous.com/statics/commercial_subscriptions_july_2023_update) |
| Enterprise | US$2,000/year [PUBLISHED] | [PUBLISHED] | "Unlimited number of users"; "Use up to 1,500 reviews"; no per-article limit; may quote pre-arrivals/futures; "Reviews available via the Vinous/Liv-ex API" | same |
| Enterprise+ | "Email for pricing details" — not published | [PUBLISHED] (as unpublished) | Up to 3,000 reviews; "Reviews sent as a spreadsheet each month, matched to Liv-ex LWIN codes"; exclusive regional Vintage Reports as PDF | [commercial subscriptions](https://vinous.com/statics/commercial_subscriptions_july_2023_update) |
| Enterprise Max | "Email for details" — not published | [PUBLISHED] (as unpublished) | Up to 4,000 reviews; "48-hr Preview for all Reviews and Scores"; "Access to Vinous Editorial Calendar"; **"Required for content resellers."** | same |
| Mobile-only (in-app) | US$7.99/mo, US$20.99/3mo, US$35.99/6mo, US$59.99/yr [PUBLISHED] | [PUBLISHED] | "Subscribe to Vinous Mobile to gain access to all aspects of the Vinous app including full reviews and ratings." | [Google Play](https://play.google.com/store/apps/details?id=com.vinous.android) (listing updated 2024-04-02) |
| Delectable Premium | US$5.99/month [PUBLISHED]; Delectable Ad Free US$1.99/month [PUBLISHED] | [PUBLISHED] | "Fully integrated Vinous wine reviews and ratings • Priority wine transcription for hard to match labels • Ad-free experience • Delectable Premium profile badge" | [App Store id512106648](https://apps.apple.com/us/app/delectable-scan-rate-wine/id512106648) |

Note the pricing architecture: the annual web subscription (US$140/yr [PUBLISHED]) is cheaper than twelve months of the in-app mobile tier (US$59.99/yr [PUBLISHED] — actually the cheaper of the two), and the US$5.99/month [PUBLISHED] Delectable Premium is a deliberate low-friction on-ramp that sells the *same review corpus* to a scan-first audience. Three price points, one corpus, three intents.

---

## 4. Information architecture and navigation model

**Primary nav (persistent, every page):** Home · Articles · Videos · Maps · Cellar Watch · Delectable · Events · **Tools** (→ Vintage Chart, Glossary, Grape Guide) · Your Say.

**Footer, in three named columns:**
- **Content** — Advanced Search, Articles, Videos, Maps
- **Engage** — Events, Your Say, Consumer Resources, Subscriptions & Gifts, Sample Submissions, Contact Us
- **Vinous** — About, Core Values, Press, Reference Materials, Young Wine Writer Fellowship, Products

Four observations worth carrying into Terroir:

1. **Two nouns, not one.** The IA separates *reviews* (structured, searchable, per-vintage) from *articles* (narrative, dated, authored). Every review carries `article_id`, `article_title`, `article_slug` and `full_article_url` — so a note is always one click from the report it came from, and a report is a container of notes. That bidirectional link is the whole information design.
2. **Tools are a first-class nav peer.** Vintage Chart / Glossary / Grape Guide are not buried in a help section; they are a labelled top-nav group. They're also the registration gate — the free-account carrot.
3. **Adjacent products live in the same nav.** Cellar Watch (valuation) and Delectable (scan/social) appear beside the publication's own sections, treating them as parts of one estate rather than external links.
4. **The homepage is a set of named recurring formats**, not a feed: Latest Articles, Vinous Table (restaurants), Vinous Favorites (ungated value picks), Cellar Favorites (older bottles), Multimedia, Team, plus an events/preview rail. Each format has its own "More →" index page.

**URL model (clean, guessable, shareable):**

| Entity | Pattern | Example |
|---|---|---|
| Canonical wine | `/wines/{producer-wine-slug}` | `/wines/domaine-bousquet-sauvignon-blanc` |
| Wine + vintage | `/wines/{producer-vintage-wine-slug}` and `/wines/{slug}/{vintage}` | `/wines/domaine-bousquet-2026-sauvignon-blanc` |
| Producer | `/producers/{slug}` | `/producers/domaine-bousquet` |
| Article | `/articles/{slug}` | `/articles/chianti-classico-looking-up` |
| Search | `/wines?wine_filter[...]` | URL-addressable filter state |

---

## 5. Page anatomy — search results, wine pages, producer pages

### 5.1 The review card (search result)

Reconstructed from the rendered page and the component source. Left column, top to bottom:

- **`{vintage} {wine_name}`** as an `h1`, bold, turning brand-red on hover; vintage `0` renders as **"NV"**
- `Producer: **{producer_name}**`
- `Release Price: **${price} ({vintage})**` — shown only when the price parses above zero, and annotated with which vintage that price belongs to
- `Color: **{color}**`

Right column, right-aligned:

- **Score** — `score_raw` in `text-xl`, `text-red`, `font-bold`. It is the single loudest element on the card.
- `Drinking Window: **{begin} - {end}**` — rendered **only** when `drinking_window_begin > 0`, so wines without a window simply omit the line rather than showing an empty field
- `**{author}, {date}**`

Below, full width:

- The tasting note, rendered as HTML, with a byline `- By {author}, {tasted_on || article_date}` in `opacity-40 italic text-sm`. Note the date fallback: the *tasting* date wins over the *article* date when present.
- A per-card expander (`max-h-0` → `max-h-96`, 500 ms) opens a vintage list for that wine — i.e. you can pivot from one vintage to the producer's whole vertical without leaving the result list.

**The locked state is a design decision worth studying.** Rather than truncating, Vinous renders a real-looking card with lorem-ipsum body text at `blur(6px)` and 50 % opacity, overlaid with a padlock icon, "Subscriber Access Only", and "Log In or Sign Up". The *structural* facts — vintage, wine name, producer, release price, colour — stay fully readable and indexable; only the score and the note are hidden. Anonymous visitors still get a working, useful catalogue.

### 5.2 The wine page

Server-renders a `baseWine` object with: the canonical wine (name, grape variety, colour, region, country, LWIN7 slot), a nested `producer`, a `wines[]` array of per-vintage reviews, a `wine_vintages[]` array (vintage, LWIN11, cases produced, release date), and a `base_wine_prices[]` array of `{price, vintage}` — a **price history per vintage**, which is a distinct entity from the review.

### 5.3 The producer page

Server-renders `producer` (name, `region_2`, `region_3`, country, slug, `importer` as HTML) with a `base_wines` list, plus a paged result set (`initialWines.wines`, `initialWines.wines_total`) and an `initialDisplayType` toggle currently set to `"wine"` — so the same producer page can be viewed as a list of *wines* or a list of *reviews*.

### 5.4 How scores, drinking windows and notes are presented

- **Score**: 100-point, stored twice (`score` as `"91.0"`, `score_raw` as `"91"`), displayed as the raw integer in brand red. Vinous publishes the scale's meaning openly: "96-100 Exceptional. A profound and emotionally moving wine that exemplifies the very best attributes of its kind." … "80-84 Average. A wine with no flaws, but no distinction" … "Below 75 Not worth your time."
- **Drinking window**: two integers, not a string. `drinking_window_begin: 2026, drinking_window_end: 2031`. There are also raw string fields (`drinking_window`, `drinking_window_raw`) retained alongside the parsed integers — an import-provenance pattern.
- **Note**: HTML in `tasting_note`, plus a separate `producer_commentary` field for prose about the estate rather than the bottle. Vinous is explicit about the hierarchy: "We spend just as much, if not more, time writing the text for each review and the accompanying producer commentaries than we do assigning numerical ratings."
- **Method transparency**: "The conditions under which wines were tasted are indicated within each article."

---

## 6. Design language

| Element | Value | Tag | Source |
|---|---|---|---|
| Stack | Next.js (pages router, `getServerSideProps`) + Tailwind CSS; Elasticsearch behind the search | [PUBLISHED] | page source, 2026-09-02 |
| Typeface | The global stylesheet contains exactly three `font-family` declarations: `Josefin Sans` (with a system sans fallback stack), a `ui-monospace` stack, and `font-family:inherit`. Josefin Sans is therefore the only display/UI typeface the stylesheet sets. | [PUBLISHED] | `0ab2cf23d346426e.css` |
| Accent | A `red` colour token used as `.text-red` / `.bg-red` / `.border-red` / `stroke:#ba3c40`, resolving to `rgb(186 60 64)` — a muted claret. Applied to scores, hovered titles, links inside gates, and the typeahead banner. | [PUBLISHED] | `0ab2cf23d346426e.css` |
| Neutrals | Tailwind greys — `#6b7280`, `#9ca3af`, `#e5e7eb`; white surfaces, `hover:bg-gray-200` rows | [PUBLISHED] | same |
| Gating treatment | `.blur{filter:blur(6px)}` plus `opacity-50 select-none` behind an absolutely-positioned overlay | [PUBLISHED] | same |
| Copy protection | Tasting notes carry a `nocopy` class (`user-select:none`) unless the viewer is `role === "publisher"` or `is_user_pro`; an `onCopy` handler calls `preventDefault()` and `stopImmediatePropagation()` and logs "Per Vinous Terms of Service, copy/cut of tasting notes is prohibited." | [PUBLISHED] | `443-9c6d5b4d4a9a7401.js` |
| Legacy | A persistent "Prefer the old site? Launch →" banner points at `v1.vinous.com` on every page | [PUBLISHED] | every page fetched |

The overall register: editorial, restrained, typographically light (`font-light` on metadata lines), one warm accent doing all the emphasis work, no imagery in the chrome. It reads like a journal, not a marketplace — which is precisely why the score in red carries so much weight.

---

## 7. Content and data model — the public facts

Vinous's server-rendered pages expose the full field set. This is the single most transferable artefact in the audit.

**Canonical wine (`baseWine`):** `id`, `wine_name`, `wine_name_2`, `grape_variety`, `color`, `producer_id`, `vineyard_id`, `region_1`, `region_id`, `country`, **`lwin7`**, `slug`, `lwin_details { lwin_match, wine_importer { import_row_id } }`, `created_at`, `updated_at`.

**Vintage (`wine_vintages[]`):** `id`, `base_wine_id`, `vintage`, **`lwin11`**, `cases_produced`, `release_date`.

**Review (`wines[]` / Elasticsearch `_source`):** `id`, `vintage`, `wine_name`, `wine_name_2`, `grape_variety`, `color`, `score`, `score_raw`, `price`, `release_price`, `issue` (e.g. `"Jun-26"`), `drinking_window`, `drinking_window_raw`, `drinking_window_begin`, `drinking_window_end`, `tasting_note` (HTML), `producer_commentary`, `author`, `review_date`, `review_date_year`, `date_tasted`, `tasted_on`, `article_id`, `article_date`, `article_title`, `article_slug`, `full_article_url`, `full_wine_url`, `article_published`, `region_1`, `region_2`, `region_id`, `country`, `producer_id`, `producer_name`, `importer`, `vineyard_id`, `vineyard_name`, `cases_produced`, `label_image_file_name` / `_content_type` / `_file_size` / `_updated_at`, `import_row_id`, `cluster`, `slug`, `searchable`, `searchable_name`, `indexable_wine_producer_name`, `tsv_body`.

**Producer:** `id`, `producer_name`, `region_2`, `region_3`, `country`, `slug`, `importer` (HTML), `deleted_at`.

**Price history (`base_wine_prices[]`):** `{ id, base_wine_id, price, vintage }`.

Seven things this tells you that a feature list never would:

1. **Canonical/variant split is real and load-bearing** — `base_wine_id` joins reviews across vintages. Terroir's `canonical_wines` / `wine_variants` is the same shape.
2. **LWIN is the interoperability key.** `lwin7` on the canonical wine, `lwin11` on the vintage, plus `lwin_match: false` as an explicit *unmatched* flag. Vinous stores whether the match succeeded, not just the result.
3. **Drinking windows are two integers**, with the original strings retained beside them.
4. **Provenance is stored, not derived** — `import_row_id` (`"argentinawhitewinesjune092026a109"`) traces every review back to the spreadsheet row it was imported from.
5. **Two prose fields, two subjects** — `tasting_note` (bottle) and `producer_commentary` (estate).
6. **Three date fields for one event** — `review_date`, `article_date`, `tasted_on`/`date_tasted`. The UI prefers `tasted_on` and falls back to `article_date`.
7. **Denormalised search fields exist on purpose** — `indexable_wine_producer_name`, `searchable_name`, `tsv_body` are populated for the index, not the UI.

### 7.1 Licensing and partner programme — what is actually permitted

Terms of Service, last modified **2023-07-07**. The relevant clauses, verbatim:

| Clause | Text | Tag |
|---|---|---|
| Citation format | "Your citation of the Company Content must include: (i) the name of the author … (ii) a citation to Company (acceptable citations are Vinous, Vinous Media, Vinous.com, V) and (iii) if feasible and published in electronic format, a hyperlink to the cited material… Standalone scores without the tasting note should be preceded or succeeded with 'V', for example V 94 or 94 V." | [PUBLISHED] |
| Consumer licence | "you may not copy, display, modify, perform, prepare derivative works of, distribute, publish or commercialize any Company Content from the Community in any way (including, but not limited to, scores alone)" — one downloaded copy, one computer, strictly personal non-commercial use | [PUBLISHED] |
| Aggregator / algorithm ban | "…any portion of Company Content, including scores alone, on behalf of any digital applications, data aggregators or media sites, or use any portion of Company Content within any algorithmic ratings system, without prior written permission from Vinous." | [PUBLISHED] |
| Third-party embedding ban | "this Agreement does not authorize you to allow third party application developers to link to or embed Company Content that is available through your website or internal database(s) within such third party applications via APIs or any other means" | [PUBLISHED] |
| Sub-licence ban | Subscriptions are "not transferable or sub-licensable to, or usable by, any other third party including, but not limited to, app developers" | [PUBLISHED] |
| Scraping ban | "use any robot, spider, site search/retrieval application, or other manual or automatic device or process to download, retrieve, index, 'data mine,' or in any way reproduce…" and "…crawlers or spiders, that are designed to systematically download the Content in any manner, is specifically and strictly prohibited." | [PUBLISHED] |
| Pro cap | "limiting the use of Company Content to five hundred (500) individual tasting notes and scores at any given time (but no more than 50 reviews from any single article). Reviews quoted must be for wines that are physically in-stock and available for sale… No permission is granted to companies providing reviews for reuse by third-party commercial enterprises." | [PUBLISHED] |
| Enterprise caps | 1,500 notes (Enterprise), 3,000 (Enterprise+), 4,000 (Enterprise Max), each "at any given time" | [PUBLISHED] |
| Enterprise distribution surfaces | "Full access to Vinous content via vinous.com, iOS/Android Apps, CellarTracker, and Delectable. Reviews available via the Vinous/Liv-ex API or via the Wine Hub platform, or other similar business services with which Vinous may collaborate in the future." | [PUBLISHED] |

**The API.** The only documented programmatic route found in this run is the **Vinous/Liv-ex API Service** (page updated 2022-05-09): "Subscribers to the Vinous/Liv-ex API Service ('Service') will be able to download via an API provided by Liv-ex Vinous reviews, ratings and drinking windows, all matched to Liv-ex's LWINs." Availability: "Vinous Enterprise subscribers who have access access to the Liv-ex APIs (Gold tier membership level and above)." Cost: "No additional charge is made for Vinous Enterprise users. Certain terms can be tailored to need with additional licenses." Usage cap follows the subscription tier — "Enterprise subscribers may quote on a public facing website a maximum of 1500 wine notes." Contact: info@vinous.com.

**Confirmed third-party embedding precedents** (all first-party partnerships, not open programmes):
- **Delectable Premium** — US$5.99/month [PUBLISHED], "Fully integrated Vinous wine reviews and ratings"; shipped in Delectable v5.7.6 on 2017-10-07.
- **CellarTracker** — listed on CellarTracker's Partner Integrations page: "Antonio Galloni's Vinous / www.vinous.com — Co-subscribers can see reviews and scores in their cellar." The integration predates the Vinous era: "Dating back to October, 2005, CellarTracker has featured fully automated integration of professional reviews from Stephen Tanzer's International Wine Cellar (which is now part of Antonio Galloni's Vinous)." The model is **co-subscription** — the user must hold both subscriptions; CellarTracker is not relicensing the data.
- **Liv-ex / Cellar Watch** — Vinous acquired Cellar Watch from Liv-ex on 2019-12-05; Liv-ex supplies "Live and historic pricing data" into the Classic consumer tier, and the API flows the other way.
- **Wine-Searcher** — the Classic tier advertises "Direct links to Wine-Searcher listings", i.e. outbound deep links, not data ingestion. (`wine-searcher.com` returned HTTP 403 to public fetches; no further detail obtainable without bypassing a block, which was not attempted.)

**No public developer programme, no self-serve API, no published API pricing, no affiliate/partner sign-up page was found.** That is an evidenced absence across the site's own statics pages, both app-store listings, and web search — not a failure to look.

---

## 8. Adopt for Terroir — ranked

Build sizes (S ≤ ~1 day, M ≈ ~2–5 days, L ≈ ~1–3 weeks) are **my estimates for Terroir's stack**, not sourced figures.

| # | Adopt | What to copy | Do better | Size |
|---|---|---|---|---|
| 1 | **Two-integer drinking window + retained raw string** | `drinking_window_begin` / `drinking_window_end` as integers on the variant, with `drinking_window_raw` preserved from whatever the source said. Render the line only when a window exists. | Vinous shows a bare `2026 - 2031`. Terroir knows the user's cellar: render it as *"in window — 4 years left"* / *"1 year early"* / *"past window"*, colour-coded, and make it a first-class cellar filter ("what should I drink this month?"). That is the single highest-leverage upgrade available. | S |
| 2 | **Year-sniffing in the search box** | Parse any 4-digit 1900–current token out of the free-text query and apply it as a vintage filter automatically; strip it from the term. | Extend it: also sniff bottle formats (magnum, 1.5L), producer aliases, and bin codes, and show a removable chip for each auto-extracted facet so the user can see *why* results narrowed. Vinous does it silently. | S |
| 3 | **Structural facts stay public, judgement gets gated** | The locked review card keeps vintage, wine name, producer, release price and colour readable, blurring only score and note. | Terroir's analogue: when a wine has no licensed critic note, still render the full identity card and say plainly what is missing, rather than an empty state. Never show lorem ipsum — use the real structure with an honest "no note on file" affordance. | S |
| 4 | **Bidirectional note ↔ source link** | Every review stores `article_id`, `article_title`, `article_slug`, `full_article_url`; every article is a container of its notes. | Terroir's enrichment layer should store the same provenance triple on every excerpt — source name, source URL, publication date — and surface it inline. This is also what makes the licensing story defensible later. | M |
| 5 | **Adopt LWIN as the canonical external key** | `lwin7` on `canonical_wines`, `lwin11` on `wine_variants`, plus an explicit `lwin_match` boolean so an unmatched wine is a recorded state rather than a null. | Vinous stores the flag but the public record shows `lwin7: null` and `lwin_match: false` on a real wine — matching coverage is visibly incomplete. Terroir should track match *confidence* and a match *method*, and make unmatched wines a work queue. LWIN is also the join key to Liv-ex pricing and to a future Vinous licence. | M |
| 6 | **Facet set + URL-addressable filter state** | Vintage range, score range, price range, review-date range, country, colour, author/critic; sorts on vintage, producer, name, score, critic, drinking window, review date; every filter in the URL. | **No region or appellation facet appears in the public filter set** despite Vinous storing `region_1`/`region_2`/`region_3` — a real gap the owner should not inherit. Terroir should ship a hierarchical region facet (country → region → subregion → appellation) plus grape, and add the facets Vinous cannot: *in my cellar*, *bin location*, *on this wine list*, *ready to drink*. | M |
| 7 | **Publish the rating scale, and the tasting conditions** | A `/reference` page defining every score band in plain language, plus "The conditions under which wines were tasted are indicated within each article." | Terroir aggregates *other people's* scales. Build a scale-normalisation reference that shows, per source, what 92 means — and never silently average across incompatible scales. | S |
| 8 | **Split `tasting_note` from `producer_commentary`** | Two prose fields with two subjects: the bottle and the estate. Producer commentary is reusable across every vintage of that producer. | Terroir should add a third: *house note* — the restaurant's or owner's own words on why this bottle is on the list or in the cellar. That is the field Vinous structurally cannot have. | S |
| 9 | **Free-tier "Favorites" format** | Ungated, complete notes with score + price + critic initials on the public homepage — proof of quality that costs nothing to give away. | For Terroir: a weekly "drink this now from your cellar" card, generated from drinking windows already in the data. Same trick, zero editorial cost. | S |
| 10 | **`import_row_id` provenance on every ingested row** | Store the exact source row identifier on each review/enrichment record. | Terroir's invoice scanning and enrichment pipeline should carry the same: source document, page, line, and the OCR/model confidence. Makes reprocessing and dispute-resolution trivial. | S |
| 11 | **Vintage chart as the registration carrot** | A genuinely useful free tool behind a free account, not behind payment. | Terroir's equivalent free hook is stronger than a chart: cellar entry itself. Keep the chart idea for a *public* marketing surface. | M |
| 12 | **Per-card vertical expander** | From any search result, expand in place to see every other vintage of that wine. | Terroir should show, in the same expander, which of those vintages the user actually owns and where they are binned. | M |
| 13 | **Verticals / retrospectives as a content type** | A first-class format for "this wine across 13 vintages". | Terroir owns purchase history — generate a personal vertical automatically from the user's own bottles and past invoices. No editorial effort. | L |
| 14 | **Typeahead with highlighted matches and direct-to-vintage routing** | Debounced suggestions, matched substring visibly highlighted, selecting a suggestion with a vintage deep-links straight to that vintage. | Vinous's 1000 ms debounce is sluggish; 150–250 ms is the modern expectation. Also mix entity types in one dropdown (wine, producer, region, grape, *your bin*) with type labels. | M |

### 8.1 Could we source this data? — assessment and legal caveats

**Short answer: only by contract, and the contract is more restrictive than it first looks.**

| Route | Verdict | Detail |
|---|---|---|
| Scrape vinous.com | **No.** | Explicitly prohibited: robots/spiders/data-mining are "specifically and strictly prohibited". Enforced technically too (`nocopy`, blocked copy events). This is a bright line; do not cross it. |
| Consumer subscription (US$140/yr [PUBLISHED]) | **No.** | Licence is "strictly personal, non-commercial", one copy, one computer, and explicitly bans commercialising "scores alone". |
| Pro (US$500/yr [PUBLISHED]) | **Insufficient for Terroir.** | 500 notes concurrent, max 50/article, **in-stock wines available for sale only** — which excludes exactly the older/unsold vintages the owner values. And: "No permission is granted to companies providing reviews for reuse by third-party commercial enterprises" — a SaaS serving restaurants is arguably precisely that. |
| Enterprise (US$2,000/yr [PUBLISHED]) | **The realistic entry point.** | 1,500 notes concurrent, no per-article limit, futures/pre-arrivals quotable, and API access via Liv-ex. Still a *concurrent-display* cap, not a corpus licence. |
| Enterprise+ / Enterprise Max | **The correct tier if Terroir is a product, not a shop.** | 3,000 / 4,000 notes; monthly LWIN-matched spreadsheets; Enterprise Max is stated to be "Required for content resellers." Pricing is not published — email only. |
| Vinous/Liv-ex API | **Available, doubly gated.** | Requires Vinous Enterprise **and** Liv-ex Gold-tier membership or above. No extra Vinous charge, but Liv-ex Gold membership is its own cost (not published by Vinous). Delivers "reviews, ratings and drinking windows, all matched to Liv-ex's LWINs". |

**Legal caveats to put in front of counsel before any integration:**

1. **The algorithmic-ratings clause is the one that bites Terroir.** "…or use any portion of Company Content within any algorithmic ratings system, without prior written permission." Terroir's AI companion and enrichment layer plausibly constitute exactly that. Get this named and permitted in writing, or architect the AI to never read Vinous text.
2. **Caps are on concurrent display, not on stored volume** — but a cellar app naturally wants a note attached to *every* bottle. 1,500–4,000 concurrent notes is a real ceiling that has to be designed around (e.g. show Vinous notes only on wines currently in a cellar or on an active list).
3. **The in-stock restriction at Pro tier is fatal to the older-vintage use case.** It disappears at Enterprise ("May quote reviews for pre-arrivals/virtual stock/futures").
4. **Citation is mandatory and formatted**: author name + "Vinous"/"V" + hyperlink where feasible; standalone scores must read `V 94` or `94 V`. Build this into the render component, not into editorial discipline.
5. **Sub-licensing is banned.** If Terroir is multi-tenant and restaurants are separate legal entities, a single Terroir licence may not cover displaying Vinous content to each restaurant's own staff and guests. This needs explicit drafting.
6. **CellarTracker's model is the safe pattern**: co-subscription. The end user brings their own Vinous subscription and Terroir renders their entitled content. That sidesteps most of the reuse caps and is demonstrably acceptable to Vinous. **[my recommendation, not a Vinous statement]**
7. **Cheaper adjacent sources exist** for the same shape of data — CellarTracker community notes, Liv-ex pricing, and open vintage data — and should be evaluated before committing to a US$2,000+/yr contract with display caps.

**Recommended sequence:** build the record shape now (drinking-window integers, LWIN slots, provenance triple) so the schema is ready; ship with unlicensed sources and the restaurant's own notes; email info@vinous.com for Enterprise+/Max pricing only once there is a paying customer asking for Vinous by name; and prototype the co-subscription pattern first, because it is the cheapest legally-clean route.

---

## 9. What NOT to copy, and why

1. **The registration wall on the reference tools.** Vintage Chart, Glossary and Grape Guide are marketed as free but render a sign-in form to anonymous visitors. It buys emails at the cost of the SEO and goodwill those pages would otherwise earn. Terroir's reference surfaces should be genuinely open.
2. **Lorem-ipsum placeholder text behind the paywall blur.** It is dishonest-feeling, it pollutes the DOM with fake sentences, and screen readers will read it. Blur *real* structure or render an explicit locked state.
3. **`user-select:none` and blocked copy events.** They do not stop anyone determined, they break legitimate accessibility and note-taking, and they make the product feel hostile. Enforce licensing in contract and in what you serve, not in the browser.
4. **Three different archive sizes across three surfaces.** 450,000 on the site, ~400,000 on iOS (2023), 200,000 on Play (2024). Store listings that have not been touched since 2021–2024 are a live credibility leak. Pick one number, source it from the database, and render it everywhere.
5. **Abandoned mobile apps.** Vinous iOS last shipped 1.3.9 on 2023-07-09 with "Performance updates and bug fixes"; Delectable last shipped 2021-09-14 with a Facebook login fix. Delectable holds 4.7 across 26K ratings while the Vinous app sits at 4.3 across 353 ratings and 3.1 across 14 reviews on Play — the good app is the neglected one. Do not accumulate app surfaces you will not maintain.
6. **The "Prefer the old site? Launch →" banner on every page.** Shipping a permanent escape hatch to a legacy version advertises that the new one is worse. Migrate, then delete.
7. **No region facet on a wine search.** Vinous stores `region_1`, `region_2` and `region_3`, but the rendered filter set offers only Country, Color and Author — no region or appellation filter. It is the most obvious hole in an otherwise excellent search, and Terroir should treat hierarchical region/appellation faceting as table stakes.
8. **Result-count that reports the index cap.** The public search payload reports `wines_total: 10000` on an unfiltered query [PUBLISHED] — a suspiciously round figure that reads as a result-window ceiling rather than a true count of an archive the site elsewhere describes as over 450,000 reviews. Whatever its cause, reporting a capped number as a total is misleading; return an honest "10,000+" or compute the real count.
9. **A 1000 ms typeahead debounce.** Copy the highlighting, not the latency.
10. **Score as the loudest element on every card.** Correct for a critic's publication; wrong for Terroir. In a cellar app the loudest element should be *drinkability now* and *where the bottle is*, with the critic score as supporting evidence.

---

## 10. Gaps — not publicly available

- **Vinous Maps catalogue and prices.** `vinous.com/statics/maps` and `billing.vinous.com/products/vinousmaps` are client-rendered against an API that returned no product data to public fetches.
- **Vintage Chart, Glossary and Grape Guide content and structure.** All render a sign-in form to anonymous visitors. Their internal data model is unknown.
- **The logged-in wine page and search result.** Score placement, note rendering and any cellar/pricing widgets for authenticated subscribers were not observed; §5 reconstructs them from component source and the anonymous render.
- **Enterprise+ and Enterprise Max pricing.** Explicitly "email for pricing".
- **Liv-ex Gold-tier membership cost**, which is a prerequisite for the API.
- **Whether Vinous would licence to a multi-tenant restaurant SaaS at all**, and on what sub-licensing terms.
- **Wine-Searcher's side of the relationship** — `wine-searcher.com` returns HTTP 403 to public fetches; not pursued further.
- **Subscriber counts, revenue, headcount.** Vinous Media LLC is private; nothing published.
- **Delectable's current match-rate or catalogue size.** Never published.

## 11. How to verify the gated numbers

1. **Enterprise+/Max pricing and reseller terms** — email `info@vinous.com` (the address published on both the plan page and the commercial-subscriptions page) stating you are a wine software product and asking for Enterprise Max reseller terms plus the algorithmic-ratings permission.
2. **Vinous/Liv-ex API specifics** — approach Liv-ex directly for Gold-tier membership pricing and the API schema; Vinous's own page says the API is "provided by Liv-ex".
3. **The gated tools** — a free Vinous account (the site's own copy positions the Vintage Chart, Glossary and Grape Guide as free-with-signup) would reveal their structure without any paid access. That is a decision for the owner to make personally, under his own account; it was deliberately not done in this run.
4. **The logged-in search and wine page** — same route; a paid Classic subscription at US$140/yr [PUBLISHED] is the cheapest way to audit the authenticated experience properly.
5. **CellarTracker co-subscription mechanics** — CellarTracker's own support docs and its Partner Integrations page describe the linking flow; testing it requires holding both subscriptions.
6. **Maps catalogue** — the store is a live commerce surface; opening it in a normal browser session will render the product list and prices that the server-side fetch did not return.

---

## 12. Sources

**Primary — Vinous**
- [Vinous homepage](https://vinous.com/) · [About](https://vinous.com/about) · [Tasting Notes Index / Advanced Search](https://vinous.com/wines) · [Subscription plans](https://vinous.com/users/plan?selected=consumer) · [Reference Materials (rating scale, how we taste)](https://vinous.com/statics/reference_materials) · [Terms & Conditions](https://vinous.com/statics/terms_and_conditions) · [Commercial Subscription Options, July 2023](https://vinous.com/statics/commercial_subscriptions_july_2023_update) · [Vinous/Liv-ex API Service](https://vinous.com/statics/vinous-liv-ex-api) · [Vintage Chart (gated)](https://vinous.com/vintages) · [Maps](https://vinous.com/statics/maps)
- Example entity pages: [wine](https://vinous.com/wines/domaine-bousquet-2026-sauvignon-blanc) · [producer](https://vinous.com/producers/domaine-bousquet)
- Front-end assets (public): `/_next/static/css/0ab2cf23d346426e.css`, `/_next/static/chunks/pages/wines-0473aa4704f32f45.js`, `/_next/static/chunks/443-9c6d5b4d4a9a7401.js`

**Primary — apps and adjacent properties**
- [Vinous: Wine Reviews & Ratings — App Store id1010711422](https://apps.apple.com/us/app/vinous-wine-reviews-ratings/id1010711422)
- [Vinous — Google Play com.vinous.android](https://play.google.com/store/apps/details?id=com.vinous.android)
- [Delectable: Scan & Rate Wine — App Store id512106648](https://apps.apple.com/us/app/delectable-scan-rate-wine/id512106648) · [delectable.com](https://delectable.com/)

**Press and corporate**
- [Vinous Acquires Delectable & Banquet Apps — PR Newswire, 2016-12-08](https://www.prnewswire.com/news-releases/vinous-acquires-delectable--banquet-apps-300375364.html)
- [Vinous Announces Launch of Revolutionary Wine App — PR Newswire, 2015-12-08](https://www.prnewswire.com/news-releases/vinous-announces-launch-of-revolutionary-wine-app-300189621.html)
- [Antonio Galloni acquires Delectable — The Drinks Business, 2016-12-08](https://www.thedrinksbusiness.com/2016/12/antonio-galloni-acquires-delectable/)
- [Vinous to Acquire Stephen Tanzer's International Wine Cellar — Vinous, 2014-11-18](https://vinous.com/articles/vinous-to-acquire-stephen-tanzer-s-international-wine-cellar-nov-2014)
- [Vinous Acquires Cellar Watch from Liv-ex — Vinous, 2019-12-05](https://vinous.com/articles/vinous-acquires-cellar-watch-from-liv-ex-dec-2019)

**Comparable set / partners**
- [CellarTracker Partner Integrations](https://www.cellartracker.com/getcontent.asp?FF=1) · [CellarTracker: Integrated Professional Reviews](https://support.cellartracker.com/article/39-integrated-professional-reviews)

---

## 13. Run record

- **Depth:** standard. **Firecrawl scrapes used: 0** — every page was fetched with the local crawl4ai scraper or, for JS-rendered pages, a browser render; no credits spent.
- **Sources harvested:** 42 files in `~/.local/share/deep-dive/run/competitor-vinous/harvest/`.
- **Discovery:** `gemini-search.sh` returned ERR on all four queries; fell back to the built-in WebSearch tool per the skill's failure path.
- **Cite-check:** 68 quotes byte-verified with `cite-check.sh`; 2 initial misses were re-verified against the minified source and passed. No claim in this brief lacks a byte-verified quote.
- **Adversarial verify:** `verify-codex.sh` tripped its circuit breaker (both batches rc=124, GPT-5.6 Sol unavailable/rate-limited); fell back to a Claude adversarial verifier per the skill's exit-1 path. It returned 11 `supported`, 3 `unsupported_by_source` and 1 `stale` out of 15 claims. **All five corrections were applied**: the archive-size comparison is now shown as an explicit conflict with dates rather than a single claim; "the API exists only through Liv-ex" was softened to "the only documented route found"; the copy-block exemption is now stated as `role === "publisher"` or `is_user_pro` rather than "non-Pro"; Delectable's Vinous ownership is now sourced to the 2016 acquisition release rather than to the App Store listing; and the design-token claims are now stated as what the stylesheet literally declares.
- **Stage 5 (triangulation):** not triggered — no facts-needed item was gated behind an absent primary source in a way that ≥3 dated third-party reports could have filled. There are no [ESTIMATE] figures in this brief.
- **Hard rules observed:** public sources only; no login attempted; no paywall bypassed; no credentials read or entered; no billed Anthropic API call.

---

## 14. Logged-in walkthrough — 2026-09-02

Signed in on a subscriber account Devin was given access to (Devin typed the password in his
own browser; no agent handled it). Read-only: nothing was favourited, printed, posted or
changed, and the account holder's details are not recorded here. The account is on the
**Classic, one-year, personal / non-commercial** plan, which matters for §8.1: what a
restaurant person is actually using day to day is the consumer licence.

### 14.1 What the subscription unlocks, exactly

Every review card and wine page renders in full: score (or barrel range in parentheses),
integer drinking window, article title with month/year as a link, tasting text, author and
date. Nothing else changes structurally versus the locked state in §5 — the gate is the
score and the note, as the brief said. Two trade tools appear on every wine page for a
subscriber: **Print Wines** and **Make Shelftalkers**. Prices come from a Wine-Searcher
"powered by" block plus a Banquet (Vinous's own commerce app) badge; on a new-release
Argentine white the retailer block was empty.

### 14.2 Search, as it behaves

The header box has a scope dropdown (**Reviews / Articles / Videos**) and submits to
`/wines?term=…` — the `q=` parameter the brief guessed is ignored and returns the default
index, so the query key is `term`. Results have four tabs over the same query:
- **Reviews** — one card per review (score, drinking window, author, date, note, "Read More").
- **Vintages** — the same cards without the note text: a dense list for scanning scores and
  windows across years.
- **Wines** — one row per wine identity with **every reviewed vintage as a clickable year chip
  and a "View All"**; this is the vertical rail the brief (§8 #12) recommended, shipped.
- **Producers** — one row per producer with "N wines, N vintages, N reviews" counts.
The left rail is the filter set from §3.1 (sort; vintage, score, price and review-date
ranges; country; colour incl. sparkling/sweet/fortified sub-colours; author). **Still no
region or appellation facet**, logged in or out. A search for a producer name returned the
producer's own wines first, then homonym producers, then loose token matches ("Hermitage" →
"Herman", "Hermanos"), so relevance is token-based, not entity-based.

### 14.3 Producer and wine pages

Producer page: Reviews / Wines tabs, sort by vintage, a per-card expander. Wine page: left
column *Wine Details* (producer, place-of-origin hierarchy country → region → subregion,
colour, grape/blend), a **vintage chip list**, Print Wines, Make Shelftalkers; main column
*Reviews & Tasting Notes* (score, window, source article, note, author/date) and *Prices &
Retailers*. Region hierarchy exists on the record (three levels) but is not a filter.

### 14.4 Vintage Chart, Grape Guide, Maps, Articles

**Vintage Chart** (`/vintages`): tabs Highlights / Countries / Vintage; twelve highlight
regions (Bordeaux both banks, three Burgundy splits, Champagne, Barbaresco, Barolo,
Brunello, Chianti Classico, Napa, Sonoma Pinot). A region page lists every vintage with a
**score, a maturity status word (Not Yet Released / Hold / Drink or Hold / Drink / Mature /
Past Peak), a dated, initialled prose assessment, and a "see all wines" link** — back to the
1950s for Bordeaux. This is the reference-quality artefact of the site and it is entirely
static content.
**Grape Guide**: a sortable table of grape → colour dot → body ("Light", "Medium to full").
**Maps**: a shop for printed AVA maps, not an interactive surface. **Articles**: list with
a category facet (e.g. a country) and author facet; an article page has the prose with
photos, a right rail of **"Producers in this Article"** (each a link filtered to that
article), "Related Articles" grouped by year, and a **"Show all the wines (sorted by score)"**
link to the article's own review index. Notes therefore live in three places at once —
article, wine page, producer page — all keyed off the same review record.

### 14.5 Design, first-hand

Serif display (Antonio Galloni's wordmark), light sans body, red accent only for scores,
links and the user name; generous white space; cards separated by hairlines; almost no
imagery outside articles. Score is always the loudest element on a card (§9 #10 stands).
The "Prefer the old site? Launch →" banner is on every page.

### 14.6 What this changes in §8

- **Confirms** #2 (year-sniffing) and #12 (per-wine vintage rail): both are live, and the
  Wines tab's chip rail is the pattern to copy — with Terroir adding "which of these do we
  own, and where".
- **Confirms** #6's gap: no region facet even for subscribers, despite a three-level region
  hierarchy on every wine record. Terroir's hierarchical region facet is a genuine edge.
- **Adds** (S): a **maturity status vocabulary** on top of the drinking window — Vinous's six
  words (Not Yet Released / Hold / Drink or Hold / Drink / Mature / Past Peak) are exactly the
  states a cellar filter needs; derive them from the window and the current year, and let
  the house override.
- **Adds** (S): **provenance links in three directions** (article ↔ note ↔ producer, with
  `article_id` carried in the producer link) — the same record rendered in three contexts,
  which is how Terroir's enrichment excerpts should behave on wine, producer and list pages.
- **Adds** (S): shelf-talker / print export from a wine record — cheap for Terroir given the
  branded list renderer already exists.
- **Licensing note for §8.1**: a subscriber sees the trade tools on a personal plan, but the
  plan's terms remain personal/non-commercial; nothing seen here loosens the contract
  analysis.
