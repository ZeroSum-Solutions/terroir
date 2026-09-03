# Delectable (Vinous) — competitor audit for Terroir

*Scope: the Delectable consumer wine app (iOS `id512106648`, Android `com.delectable.mobile`, web `delectable.com`), owned by Vinous Group LLC since December 2016. Prepared 2026-09-02 for the Terroir project (Next.js 16 + Supabase; invoice scanning, vision-model bottle scan, cellar/bin placement, wine lists, unified wine search with AI companion, `canonical_wines`/`wine_variants` identity spine). Public sources only; no accounts created, no logins used.*

---

## TL;DR

Delectable's durable advantage was never its OCR — it was an **asynchronous capture model**. The app treats a label photo as a first-class object ("capture") that lands in your profile *immediately*, unidentified, and gets resolved later by a pipeline that falls back to Delectable staff. That is why bulk photo-library import works so smoothly, and why the app feels fast even when identification is slow: the web client still exposes `/v2/accounts/captures_and_pending_captures` and `/v2/captures/from_pending_capture` [PUBLISHED]. Its data model is a two-tier spine — a vintage-agnostic `base_wine` owning per-vintage `wine_profile` rows [PUBLISHED] — which is the same shape as Terroir's `canonical_wines`/`wine_variants`, minus bottle size. Its wine page fuses **two scores** (crowd average and expert average) on one card [PUBLISHED], and its unified search federates wines, producers, people and hashtags behind one endpoint [PUBLISHED].

Two owner observations need correcting. **Bulk photo-library import is real and confirmed** by Delectable's own documentation and release notes [PUBLISHED]. **"Very fast" is only half true**: the *capture* is instant, but historical identification was deliberately slow — an independent 2014 six-app test found Delectable identified 6/6 labels with 100% accuracy and no corrections, scoring 10/10, while taking "no more than 15 minutes on average" per label, "a system that clearly sacrifices speed for accuracy" [PUBLISHED]. The perceived speed comes from the UI never blocking on identification.

Delectable is also a **decaying asset**: its licensed webfont stylesheet now returns only a deactivation comment, its last iOS version entry is 5.9.5 dated 09/14/2021 [PUBLISHED], and a 2026 competitor review lists "Development has slowed in recent years" as a weakness [PUBLISHED]. Terroir should copy the *architecture and the flow*, not the app's current surface.

---

## Confirmed vs. inferred

| Confidence | What we know |
|---|---|
| **CONFIRMED [PUBLISHED]** | Multi-select bulk upload from the camera roll; the pending-capture async model (visible in the shipped API surface); `base_wine` → `wine_profile` two-tier identity; the X-to-reject + "Request Expert Review" correction path; Premium at $5.99/month with Vinous reviews, priority transcription, ad-free and a badge; the dual crowd/expert score on every wine page; unified federated search; Whitney typeface + claret-red accent in the web CSS; the Dec 2016 Vinous acquisition including the engineering team. |
| **REPORTED (secondary)** | "Human transcription" as the fallback mechanism — Delectable's *own* copy says "priority wine transcription" and "have the label identified by our team" / "Request Expert Review", which is a human-in-the-loop by any reading, but no source states headcount, SLA, or whether the queue still runs in 2026. Turnaround "no more than 15 minutes on average" is a single reviewer's 2014 experience. Database size is described only comparatively ("significantly smaller than Vivino's") by a rival vendor. |
| **INFERRED / ESTIMATE** | That the pending-capture queue is still staffed today [ESTIMATE]. That Delectable's "Instant Match" is a client-side/first-tier automatic matcher distinct from the expert queue [ESTIMATE] — the naming and the release-note phrasing "Improved identification when Instant Match fails: use Search to add a wine" strongly imply it, but no source describes the tiering. |
| **CONFLICTS / STALE** | **Speed conflicts sharply by source and era.** Vendor press page quotes "Two-point-five-second recognition" and "returns a dossier on the vintage almost instantly"; an independent 2014 test says up to 15 minutes; a rival founder in 2014 called it "an offline approach to recognition, which can take time"; an AVC commenter timed four simultaneously-uploaded labels at 10/39/42/46 minutes [PUBLISHED, all]. Best reading: two tiers with very different latencies. **All architecture facts derive from a web bundle last built no later than the site's current deploy** — the mobile apps may differ. |

---

## 1. Feature inventory

| Feature | What Delectable does | Tag | Source | Date |
|---|---|---|---|---|
| Label scan | Camera-first capture; "take a photo of a wine label and instantly get ratings and descriptions"; works for wine, beer and spirits | [PUBLISHED] | App Store listing, `id512106648` | fetched 2026-09-02 |
| Photo-library import | Camera screen has a gallery affordance beside the shutter: "press the arrow button to upload an image from your library" | [PUBLISHED] | [10 Tips for Using Delectable](https://delectable.com/feeds/10_tips_delectable) | fetched 2026-09-02 |
| **Bulk import** | "You can upload multiple wines simply by tapping on each desired image and hit \"Done\"" — and, per the release notes, "Now you can simultaneously upload multiple label photos from your camera roll. Select several images and they'll all appear in your profile ready to be reviewed and rated." | [PUBLISHED] | 10 Tips; App Store version 5.8.5 / 5.8.6 notes | 04/10/2019, 04/11/2019 |
| Auto-identification | Branded "Instant Match"; release note "Improved identification when Instant Match fails: use Search to add a wine" | [PUBLISHED] | App Store version 5.6.1 notes | 03/21/2016 |
| Human fallback | "press \"Request Expert Review,\" and our team will add the post to your profile"; developer response: "have the label identified by our team or search for it manually" | [PUBLISHED] | 10 Tips; App Store developer response | 04/20/2018 |
| Turnaround | "each label took some time to be identified (although no more than 15 minutes on average, from my experience)… a system that clearly sacrifices speed for accuracy" | [PUBLISHED] | [JancisRobinson.com, Richard Hemming MW](https://www.jancisrobinson.com/articles/label-scanner-apps-which-is-best) | 2014-02-27 |
| Manual correction | "you can tap to correct the wine and add the vintage yourself" | [PUBLISHED] | App Store version 5.5 notes | 12/18/2015 |
| Unified search | "Unified Search: Now you can search for wines, people, and even tasting notes all in one place" | [PUBLISHED] | App Store version 5.3 notes | 06/17/2015 |
| Custom categories | Saved searches pinned to the home screen that auto-update: "Pin the results to your home screen— your Custom Categories update automatically" | [PUBLISHED] | App Store version 5.4 notes | 08/03/2015 |
| Wine page | Dual scoring: "Two sets of scores appear for each wine—the average of all reviews and the average of expert reviews" | [PUBLISHED] | [PUNCH](https://punchdrink.com/articles/how-the-delectable-app-is-eliminating-wines-third-wall/) | 2014 |
| Journal / privacy | 10-point rating with a personal note, taggable with people and location; per-post padlock making a review "Private to you", and the padlock is sticky for subsequent posts | [PUBLISHED] | App Store listing + developer response | 07/11/2018 |
| Wishlist | "click the heart icon to add a bottle to your wishlist"; visible on your own and friends' profiles | [PUBLISHED] | 10 Tips | fetched 2026-09-02 |
| Taste Insights | "explore your most frequently tasted wine varieties and regions, revisit your top scored bottles, and even check out how your friends measure up" | [PUBLISHED] | 10 Tips | fetched 2026-09-02 |
| Social graph | Follow model with contacts / Facebook / Twitter friend-finding plus suggested Wine Pros; likes, comments, @-mentions, #hashtags | [PUBLISHED] | 10 Tips; wine-page markup | fetched 2026-09-02 |
| Editorial | "Featured" tab of articles, weekly tasting-note roundups, a "Decorked" Q&A column | [PUBLISHED] | 10 Tips; delectable.com | fetched 2026-09-02 |
| Price check | "New price check feature allows users to see the average price of a wine, sourced from global listings (available to all users)" | [PUBLISHED] | [PR Newswire](https://www.prnewswire.com/news-releases/antonio-gallonis-delectable-wine-app-launches-new-premium-version-300485294.html) | 2017-07-10 |
| Commerce | Buy button routed to the sister app Banquet / shopbanquet.com | [PUBLISHED] | 10 Tips; delectable.com | fetched 2026-09-02 |
| Premium | "Fully integrated Vinous wine reviews and ratings • Priority wine transcription for hard to match labels • Ad-free experience • Delectable Premium profile badge" | [PUBLISHED] | App Store listing | fetched 2026-09-02 |

### Pricing

| Item | Value | Tag | Source | Date |
|---|---|---|---|---|
| Delectable (core app) | Free; "Scan an unlimited number of wines for free" | [PUBLISHED] | App Store listing | fetched 2026-09-02 |
| Delectable Premium | $5.99 USD/month | [PUBLISHED] | App Store listing; PR Newswire launch release | 2017-07-10 |
| Ad-free only | $1.99 USD/month (listed alongside Premium in the same subscription-terms sentence; the listing does not describe the two as independent purchases) | [PUBLISHED] | App Store listing | fetched 2026-09-02 |

---

## 2. Information architecture and navigation model

Delectable runs a **five-destination mobile IA** with a persistent capture affordance. Reconstructed from the store screenshots and the web client's route table.

| Layer | Structure | Tag |
|---|---|---|
| Top-level | Feed/Discover · Search · Notifications · Profile — carried in a single top app bar (logo mark + wordmark left; magnifier, bell, avatar right), with a **persistent red circular camera FAB bottom-right on every screen** | [PUBLISHED] |
| Discover | A horizontally-scrolling category tab rail above the content (`…NG | FEATURED | GERMAN RIESLING | NAPA CAB…`), active tab underlined in red; content is full-bleed editorial photo cards with a hairline-outlined title plate centred over the image | [PUBLISHED] |
| Search | One field, results **grouped by entity type** with a section header and a red `MORE` pill per group (producers, then wines); backed by `/v2/search/all` with per-entity endpoints `/v2/base_wines/search`, `/v2/producers/search`, `/v2/accounts/search`, `/v2/hashtags/search` | [PUBLISHED] |
| Profile | Blurred cover photo → circular avatar → name + verified check → bio → stat row ("1008 wines • 16730 followers • 483 following") → follow button → **three segmented tabs: ACTIVITY / TASTE INSIGHTS / WISHLIST** | [PUBLISHED] |
| Wine page | Producer eyebrow → wine name → dual score row → region → grapes → pairings → related chips → vintage rail → notes list | [PUBLISHED] |
| Web taxonomy | 65 curated category pages combining region×grape ("Napa Valley Cabernet Sauvignon", "Mosel - Saar - Ruwer Riesling") alongside vibe/occasion categories ("Rich and Bold", "Pizza", "Unicorn", "QPR", "Coravin") | [PUBLISHED] |
| Canonical URLs | `/wine/<producer-slug>/<wine-slug>/<vintage>` for a vintage; `/base_wine/:base_wine_id` for the vintage-agnostic parent | [PUBLISHED] |
| Help | **There is none.** `/faq`, `/about`, `/help`, `/premium` and `/support` all serve the marketing homepage or 404; the "10 Tips" feed post is the de facto documentation | [PUBLISHED] |

Nothing in this IA is a cellar. Delectable is a **journal + social graph**, not an inventory system — its "collection" is the list of things you have drunk, not the list of things you hold. That is the single biggest structural difference from Terroir.

---

## 3. The capture-to-identified flow, step by step

Reconstructed from Delectable's own documentation, its release notes, its developer responses and the shipped web API surface. Steps marked [ESTIMATE] are inferred from naming and behaviour, not documented.

1. **Enter capture.** Tap the persistent red camera FAB. The screen is a full-bleed live viewfinder; the bottom bar carries three controls — dismiss (X) left, large red circular shutter centre, **gallery icon right** [PUBLISHED, store screenshot]. The library path is a peer of the shutter, not buried in a menu.
2. **Either shoot, or multi-select from the library.** "press the arrow button to upload an image from your library… You can upload multiple wines simply by tapping on each desired image and hit \"Done\"" [PUBLISHED]. Single-image uploads additionally get crop/rotate controls: "Labels being uploaded from your camera roll one at a time now have formatting options so the image looks just right" [PUBLISHED] — bulk uploads deliberately skip that step to stay fast.
3. **Captures land immediately, unidentified.** "Select several images and they'll all appear in your profile ready to be reviewed and rated" [PUBLISHED]. The API confirms these are a distinct entity class: the profile list endpoint is `/v2/accounts/captures_and_pending_captures` [PUBLISHED], i.e. identified captures and not-yet-identified pending captures render in **one merged list**. This is the whole trick behind the perceived speed.
4. **Automatic match runs ("Instant Match").** The vendor's press page carries "Two-point-five-second recognition" and "it returns a dossier on the vintage almost instantly" [PUBLISHED, vendor-selected quotes]. A rival founder in 2014 characterised the system differently: "Delectable has taken an offline approach to recognition, which can take time" [PUBLISHED].
5. **The user judges the match, and can reject it.** "Should the app pull up the wrong selection, simply click the \"X\" to mark the scan as incorrect" [PUBLISHED]. Delectable's own developer response frames rejection as the normal path, not an error state: "When uploading a photo to create an entry you can always reject the automatic match that is generated if it is incorrect and either have the label identified by our team or search for it manually" [PUBLISHED].
6. **Three resolution routes from a bad or missing match**, all offered in the same place [PUBLISHED]:
   - **Search by name** — falls through to `/v2/captures/from_wine_profile`, creating the capture from a chosen wine instead of from the photo.
   - **Correct it yourself** — "you can tap to correct the wine and add the vintage yourself" [PUBLISHED].
   - **"Request Expert Review"** — "our team will add the post to your profile" [PUBLISHED]. Premium buys queue priority: "Priority wine transcription for hard to match labels" [PUBLISHED].
7. **Resolution is asynchronous and promotes the pending row in place.** The API exposes `/v2/captures/from_pending_capture` [PUBLISHED] — the pending capture is upgraded into a real capture carrying the user's note, rather than being replaced by a new row. The user's photo, note, tags and position in their own timeline all survive identification.
8. **How the user is told.** No source documents an explicit notification for a resolved capture, so this is a **gap** — but the mechanism is visible: because pending captures render in the profile feed alongside real ones, the user sees the row fill in. Delectable does ship a notifications bell in the top bar [PUBLISHED, screenshot]; whether transcription completion fires into it is [ESTIMATE].
9. **Rate and enrich.** "Once the bottle has been identified, press \"Rate\" to add your rating and record your tasting notes. Click \"Who are you drinking with?\" to tag your drinking buddies, and add a location by clicking the \"Where are you?\" button" [PUBLISHED]. A padlock toggle makes the post private, and the toggle is **sticky across subsequent posts** [PUBLISHED].

**Observed turnaround, individual reports.** A formal `[ESTIMATE]` range is *not* produced here: only two independent dated reports exist, below this method's three-report floor. The individual published data points are: "no more than 15 minutes on average" (JancisRobinson.com, 2014-02-27) and one commenter's timing of four simultaneously-uploaded labels at "10 min 39 min 42 min 46 min" (AVC comment thread, 2014-02-14) [PUBLISHED, both]. Both are twelve years old and may not describe today's queue.

---

## 4. Design language

Verified against the live stylesheet, the homepage HTML and the store screenshots.

| Dimension | Delectable | Tag |
|---|---|---|
| Typeface | `font-family:"Whitney A","Whitney B",Helvetica,Arial,sans-serif` — Whitney, a humanist sans, licensed via `cloud.typography.com`; system stack `-apple-system,'Helvetica Neue',HelveticaNeue,Roboto,'Segoe UI'` for UI chrome | [PUBLISHED] |
| Typeface status | The homepage still links `//cloud.typography.com/6518072/679044/css/fonts.css`, but that file now returns only `/* DEACTIVATED */` — the licensed webfont no longer loads and the site silently falls back to Helvetica/Arial | [PUBLISHED] |
| Wordmark | A rosette/medallion mark + "DELECTABLE" set in letterspaced small caps | [PUBLISHED] |
| Accent | One claret red — `#cd595a`, the single most-used non-neutral in the stylesheet (58 occurrences), with `#c74547` and `#d36d6d` as darker/lighter siblings. Used for the shutter FAB, the add FAB, the active tab underline, "Buy $58" and the `MORE` pill | [PUBLISHED] |
| Neutrals | White `#fff` (132 occurrences) on a `#f5f5f5` page ground — also declared as `<meta name="theme-color" content="#f5f5f5">`; grey ramp `#303030` / `#606060` / `#909090` / `#dedede` / `#efefef` | [PUBLISHED] |
| Secondary accents | A teal `#13baa6` (score chips), a sage `#93c1ac`, a tan `#dbc5b0` | [PUBLISHED] |
| Imagery | **The user's own label photograph is the design.** Full-bleed photo hero on the wine page with chrome overlaid; label photos as the background texture of Taste Insights tiles; label thumbnails as search-result avatars. Editorial cards are full-bleed photos with a hairline-outlined title plate | [PUBLISHED] |
| Card pattern | White card lifted onto the photo hero. Inside: **producer as a small-caps letterspaced grey eyebrow**, wine name as the dark heading, then a dual-score row, then icon-led metadata rows (pin = region, coloured dot = grape/colour), then a commerce row | [PUBLISHED] |
| Score treatment | Numeric 10-point scores rendered in teal, always paired with their count ("9.1 49 ratings" / "9.1 16 pro ratings"); on note rows the score becomes a small solid teal chip aligned right | [PUBLISHED] |
| Note card | Circular avatar · display name · earned badges (Influencer, Premium) · professional title and employer · score · note body · "N likes · N comments" · relative date · overflow ⋮ | [PUBLISHED] |
| Overall register | "Clean, visually appealing interface" per a 2026 rival review; PUNCH describes the tone as "a voyeur's window into this very particular subculture" where "winemakers are known on a first-name basis" | [PUBLISHED] |

The transferable idea is **restraint plus photography**: one accent colour, a near-monochrome grey ramp, and all of the warmth carried by user photographs rather than by surfaces. Terroir's own `DESIGN.md` ("Terroir — Nocturne": `primary #96122A`, `canvas #F4F5F6`, Source Serif 4 over Source Sans 3, "the wine is the only colour in the room; photography carries the warmth so no surface has to") already commits to the same principle from a different palette. **Do not import Delectable's tokens** — Terroir's identity is contracted in `DESIGN.md` and stays the source of truth. Copy the *patterns*: the producer-eyebrow card, the dual-score row, the photo-as-texture stat tiles.

---

## 5. Public architecture and data facts

| Item | Value | Tag | Source | Date |
|---|---|---|---|---|
| Identity spine | Two tiers: `base_wine` (vintage-agnostic) owns keyed `wine_profiles`. Route `baseWineProfile:{path:"/base_wine/:base_wine_id",method:"get",page:"wineProfile"`; loader `baseWinesContext(c).then(function(t){var n=t.payload.base_wine;n.wine_profiles=` | [PUBLISHED] | delectable.com JS bundle | fetched 2026-09-02 |
| Capture entity | Captures are separate from wines and have a pending state: `accountsCapturesAndPendingCaptures=function(e){return this._execute("/v2/accounts/captures_and_pending_captures",e)}` and `capturesFromPendingCapture=…"/v2/captures/from_pending_capture"` | [PUBLISHED] | delectable.com JS bundle | fetched 2026-09-02 |
| Full v2 API surface | 49 endpoints across `accounts` (follow/followers/following, wishlist, search, context, profile, payment methods, shipping addresses, producer roles), `base_wines` (context, search), `captures` (list, context, rate, comment, edit_comment, like, notes, featured_feed, from_pending_capture, from_wine_profile), `producers/search`, `hashtags/search`, `search/all`, `wine_profiles` (source, purchase, wishlist), `registrations`, `oauth` | [PUBLISHED] | delectable.com JS bundle | fetched 2026-09-02 |
| Identification method | "The scanner uses OCR and database matching to identify bottles" — note this is a **rival vendor's** characterisation, not Delectable's own | [PUBLISHED] | [sommo.app](https://sommo.app/blog/best-wine-scanner-apps-2026/) | 2026-03-21 |
| Human-in-the-loop | Delectable's own product copy: "Priority wine transcription for hard to match labels"; "Request Expert Review… our team will add the post"; "have the label identified by our team" | [PUBLISHED] | App Store listing; 10 Tips; developer response | 2018–2026 |
| Accuracy benchmark | 6/6 wines identified, 100% identification accuracy, 10/10 — the only perfect score in a six-app head-to-head | [PUBLISHED] | JancisRobinson.com | 2014-02-27 |
| Crowd corpus | "more than 5 million user reviews" | [PUBLISHED] | PR Newswire (Galloni quote) | 2017-07-10 |
| Critic corpus | "nearly 250,000 critic reviews" from Vinous (210,000 at acquisition in Dec 2016) | [PUBLISHED] | PR Newswire ×2 | 2016-12-08, 2017-07-10 |
| Catalogue size | Never published as a number. Described comparatively: "the database is significantly smaller than Vivino's, and the scanner struggles with wines outside the mainstream" (rival vendor); the Play screenshot claims "millions of wines" | [PUBLISHED] | sommo.app; Play listing | 2026 |
| Vinous integration | Premium "seamlessly integrates Delectable's library of more than 5 million user reviews with Vinous' database of nearly 250,000 critic reviews" — surfaced as a *second* score on the same wine card, not a separate section | [PUBLISHED] | PR Newswire; store screenshot | 2017-07-10 |
| Ownership | Acquired by Vinous 2016-12-08; "The Delectable and Banquet engineering team will join Vinous as part of the acquisition, and both apps will continue to operate as they do today"; footer today reads "©2026 Vinous Group LLC" | [PUBLISHED] | PR Newswire; delectable.com | 2016-12-08 |
| Scale at acquisition | "downloaded over a million times and has over 120,000 monthly loyal, unique users"; "the second most downloaded app in wine" | [PUBLISHED] | PR Newswire | 2016-12-08 |
| Scale today | iOS 4.7 from 26K ratings; Play 3.9 from ~6.05K reviews, "500K+ Downloads" | [PUBLISHED] | App Store; Play Store | fetched 2026-09-02 |
| Maintenance | iOS version history's newest entry is "Version 5.9.5 09/14/2021"; Play "Updated on Apr 15, 2024"; rival review lists "Development has slowed in recent years" | [PUBLISHED] | App Store; Play Store; sommo.app | 2026 |
| Founding | "the company was founded in 2011"; raised a $3M Series A in 2014 | [PUBLISHED] | PUNCH; TechCrunch | 2014 |

---

## 6. Supporting context

Delectable's founding insight, stated best by Fred Wilson in 2014, was **"Shazam for Wine Labels": "you take a photo of the wine label and Delectable figures out what wine it is, what vintage it is, etc… All of that important metadata comes in automatically just because you took a photo"** [PUBLISHED]. PUNCH framed the same thing as an input-quality argument: "photo recognition largely solves this, as users upload a photo of the label, rather than have the chance to misspell wine names" [PUBLISHED]. That is precisely Terroir's argument for the vision-model bottle scan against manual entry, and it is worth keeping in the product's own language.

The second insight was **whose palate you trust**. Rather than a single averaged score, Delectable shows the crowd average and the expert average side by side and lets you follow specific people, so the number you weight is the one from a palate you have chosen [PUBLISHED]. Its 2026 rival concedes the point: "their notes tend to be more detailed and informed than what you'll find on a mass-market platform" and "Higher-quality tasting notes than most crowd-sourced platforms" [PUBLISHED].

The Vinous acquisition converted that from a community property into a licensed one: nearly 250,000 professional reviews behind a $5.99/month gate [PUBLISHED]. Delectable never published a database-size number, and the honest read is that its catalogue is a by-product of its capture pipeline — every expert-reviewed label adds a row. That is a slow, high-quality flywheel and it is exactly why it lost the coverage race to Vivino ("over 60 million users and arguably the largest wine database in the world", per the same rival source) [PUBLISHED].

Terroir's position is different in a way that matters: it does not need coverage of everyday supermarket wine at Vivino scale. It needs to identify *the bottles in one restaurant's cellar and one collector's racks*, it already has an LWIN and X-Wines catalogue backbone in `supabase/migrations/` (`0127_match_lwin_deterministic_tiebreak.sql`, `0131_xwines_catalog.sql`, `0134_match_xwines_top_n.sql`, `0146_xwines_search.sql`), and it has a vision model rather than OCR-plus-fuzzy-string. The scarce resource for Terroir is not label data — it is **user patience during bulk onboarding**, which is exactly the problem Delectable's pending-capture design solves.

---

## 7. Ranked: adopt for Terroir

Ranked by (value to Terroir × confidence it works) ÷ build size. Each item states what to copy, what to do better, and a size tag.

### 1 — Pending-capture async model · **M**
**Copy.** Make a scanned or uploaded label photo a first-class row that exists *before* identification. Delectable's `/v2/accounts/captures_and_pending_captures` renders identified and pending captures in one merged list [PUBLISHED]; `/v2/captures/from_pending_capture` promotes a pending row in place rather than replacing it [PUBLISHED].
**Do better.** Terroir's `src/app/(app)/scan-bottle/scan-bottle-state.ts` is a synchronous single-bottle machine (`scanning → matched → correcting → location → confirmed`) that blocks the user on the vision call. Introduce a `bottle_captures` table with `status ∈ (pending, matched, needs_review, rejected)` and an optional `wine_variant_id`, written on upload and resolved by a worker — Terroir already runs a Railway worker (`railway.worker.toml`) and already has async scan infrastructure in `src/domains/scanning/` (`invoice-scan-service.ts`, `stalled-scans.ts`, `scan-telemetry.ts`). Reuse that ledger + stalled-detector pattern instead of inventing a second one. Terroir can beat Delectable outright by making resolution *usually* instant and the pending state the exception, rather than the norm.

### 2 — Bulk photo-library import · **S–M**
**Copy.** A gallery affordance sitting immediately beside the shutter, multi-select, and "hit Done" — no per-image confirmation. "Select several images and they'll all appear in your profile ready to be reviewed and rated" [PUBLISHED]. Crop/rotate controls exist for single uploads only [PUBLISHED]; bulk deliberately skips them.
**Do better.** On the web this is one line of intent — `<input type="file" accept="image/*" multiple>` (plus `capture="environment"` on a separate camera button) — which on iOS Safari and Android Chrome opens the native multi-select photo picker directly. Terroir needs no native app to match this. Then: upload to Supabase Storage with a bounded concurrency (4–6 in flight), one `bottle_captures` row per file, and hand the batch to the worker. Delectable's ceiling was a serial human queue; Terroir's vision model is parallel, so a 40-bottle rack shoot should resolve in under a minute rather than in Delectable's 46 [PUBLISHED, AVC timing]. **This is the single highest-leverage item for cellar onboarding** — it converts "photograph the whole rack, then walk away" into a supported workflow.

### 3 — Batch review queue with confidence-tiered triage · **M**
**Copy.** Delectable's three exits from a bad match, all offered together: reject (X), search by name, or escalate to a human [PUBLISHED].
**Do better.** Delectable makes the user adjudicate every capture one at a time. Terroir should sort the batch by model confidence and let the user **bulk-confirm the high-confidence tier in one action**, then work only the ambiguous tail. Terroir already has a `/reconcile-queue` route and `scan-review.tsx` — extend those rather than build a new surface. Emit a per-capture confidence into `scan-telemetry.ts` so the auto-accept threshold is tunable from real data (the threshold itself is a configurable hypothesis, not a sourced default).

### 4 — Producer-eyebrow wine card with a dual-score row · **S**
**Copy.** Producer as a small-caps letterspaced grey eyebrow, wine name as the heading, then two scores side-by-side each with its own count, then icon-led region/grape rows [PUBLISHED]. Delectable's rationale, per PUNCH: "Two sets of scores appear for each wine—the average of all reviews and the average of expert reviews" [PUBLISHED].
**Do better.** Terroir's two scores are not crowd-vs-critic — they should be **house vs. reference**: the restaurant's own accumulated staff notes against the external critic/catalogue score. Render in Terroir's `DESIGN.md` tokens (`primary #96122A`, Source Serif 4 headings), never Delectable's teal and claret. Cheap, high-visibility, reusable in cellar rows, list rows and search results.

### 5 — Photo-as-texture insight tiles · **S**
**Copy.** Delectable's Taste Insights is a mosaic where each tile's background is *one of the user's own label photographs*, overlaid with a country and a count ("France 477 wines"), plus a "View all" tile and a "TOP RATED" list beneath [PUBLISHED].
**Do better.** Terroir's `/insights` route already exists and it has richer facts than Delectable ever had — bin location, cost, depletion rate, margin. Use a captured label photo per facet as the tile ground so the cellar's own imagery carries the warmth, exactly as `DESIGN.md` prescribes. Terroir also already stores label imagery (`0130_wine_image_storage.sql`, `0138_xwines_catalog_imagery.sql`, `0142_anon_wine_hero_image_grant.sql`), so the assets are in place.

### 6 — Federated unified search with per-entity "MORE" · **M**
**Copy.** One field; results grouped under entity headers with a `MORE` affordance per group; one aggregate endpoint (`/v2/search/all`) over per-entity searches for wines, producers, people and hashtags [PUBLISHED]. Shipped as "Unified Search: Now you can search for wines, people, and even tasting notes all in one place" [PUBLISHED].
**Do better.** Terroir's `/search` and its `search-everywhere.tsx` already point this way, and `0144_wines_fuzzy_search.sql` / `0146_xwines_search.sql` give the substrate. Add entity grouping over Terroir's real entity set — wines, producers, bins, lists, invoices/scans, staff — and let the AI companion consume the same grouped payload so it answers from the identical result set the user sees. Delectable never had an assistant; this is where Terroir can be structurally better rather than merely equal.

### 7 — Region×grape composite category pages · **S–M**
**Copy.** 65 auto-generated composite taxonomy pages ("Napa Valley Cabernet Sauvignon", "Willamette Valley Pinot Noir") sitting alongside human/vibe categories ("Rich and Bold", "Pizza", "QPR") [PUBLISHED], with the same chips appearing on every wine page as "Explore related" [PUBLISHED].
**Do better.** Generate Terroir's facets from the cellar's actual composition rather than a global list, so the taxonomy describes *this* cellar. Feed the same chips into wine-list building — the composite facet is exactly the unit a by-the-glass list is assembled from.

### 8 — Vintage rail on the wine page · **S**
**Copy.** One page per wine identity with an "All years" selector enumerating every vintage that has notes [PUBLISHED], and a parent route `/base_wine/:base_wine_id` for the vintage-agnostic entity [PUBLISHED].
**Do better.** This is a near-free win because Terroir's spine is already shaped for it: `canonical_wines` ≈ `base_wine`, `wine_variants` ≈ `wine_profile`, and Terroir additionally keys `size_ml` (`0098_wine_variants.sql`), which Delectable does not model at all — so Terroir's rail can be a vintage × format grid. **Watch the one real divergence:** `wine_variants` is `restaurant_id`-scoped by deliberate design, whereas Delectable's `wine_profile` is global. The public/shared wine page must therefore read from `canonical_wines` plus an aggregate, never from one tenant's variants.

### 9 — "Request expert review" as a first-class exit · **M**
**Copy.** When the machine cannot resolve a label, offer escalation rather than a dead end — and make the paid tier's benefit *queue priority*, not access ("Priority wine transcription for hard to match labels") [PUBLISHED].
**Do better.** Terroir's "expert" should be the sommelier or GM on the same account, not an outsourced queue: an unresolved capture becomes an in-house review task in `/reconcile-queue`, assigned by role. Same UX affordance, no staffing cost, and the correction feeds `canonical_wines` for every future scan.

### 10 — Sticky-privacy note posting · **S**
**Copy.** The padlock that makes a post private, and *stays* set for subsequent posts until deliberately changed [PUBLISHED].
**Do better.** Terroir's analogue is private staff note vs. shared house note. Copy the stickiness — it is the detail that made the control usable — but fix Delectable's mistake by defaulting per-account rather than per-post (see §8).

### 11 — Tag people and place on a capture · **S**
**Copy.** "Who are you drinking with?" and "Where are you?" attached at rating time [PUBLISHED].
**Do better.** In Terroir these become *service* metadata: which staff member poured, which table/service, which event. Note that the top user complaint on the App Store listing is the absence of a location filter over one's own history — "it would be a huge improvement if I could sort my wines according to where I had been" [PUBLISHED]. Capture it **and** filter on it; Delectable did the first and not the second.

### 12 — Editorial "Featured" surface · **L**, low priority
**Copy.** A curated content tab with weekly roundups. **Do better / defer.** This is an ongoing editorial commitment, not a build. For Terroir it is only worth it as *auto-generated house content* — "what the cellar drank this month" — sourced from data Terroir already has. Rank it last.

---

## 8. What NOT to copy, and why

| Anti-pattern | Why not |
|---|---|
| **Public-by-default personal notes** | Delectable's worst public failure. A 1-star reviewer: "they began to use my notes, alongside my full name and picture… To opt individual wines out of this process, you needed to individually mark each wine as private— they provided no default status for a user's entire account and there was no option to go back and mark older wines as private" [PUBLISHED]. Terroir handles restaurant cost, margin and staff commentary — **private by default, account-level default, retroactive bulk toggle.** |
| **A human transcription queue as core infrastructure** | It bought Delectable 100% accuracy [PUBLISHED] and cost it the speed race — "an offline approach to recognition, which can take time" against a rival's "under 2 seconds" [PUBLISHED], and a user verdict of "their OCR (or whatever) is way to slow to become a reflex" [PUBLISHED]. Terroir's vision model gets most of that accuracy at machine latency. Keep the *escalation affordance*; do not staff a queue. |
| **Selling identification quality as a subscription** | "Priority wine transcription" makes correct identification a paid tier [PUBLISHED]. In a restaurant tool, correct identification is the product. Gate depth (critic content, analytics, multi-site) — never accuracy. |
| **Two apps for scan and buy** | Delectable pushes purchase into the separate Banquet app [PUBLISHED], and users complained the buy path routinely failed anyway: "Delectable almost never can find a supplier. I end up having to use google" [PUBLISHED]. Terroir's procurement stays in one app. |
| **The status/leaderboard feed** | PUNCH, sympathetically: "a wine enthusiast's social media feed often begins to look uncomfortably like the Rich Kids of Instagram parody account. It's competitive consumption as entertainment" [PUBLISHED]. Terroir's social layer is a *team* layer — an internal service log, not a flex feed. Skip public follower counts, influencer badges and global leaderboards. |
| **Identity-poor bulk uploads** | Delectable's bulk path drops the crop/format step [PUBLISHED] and drops context entirely — no bin, no section, no quantity. Terroir must carry bin/section through the batch, or bulk import creates a reconciliation backlog instead of a cellar. |
| **Social-login dependency** | Facebook and Twitter friend-finding are load-bearing in Delectable's onboarding [PUBLISHED], and its final iOS release was a "Facebook login fix" [PUBLISHED]. Those graphs have degraded; Terroir's graph is the restaurant roster. |
| **Its current surface as a design reference** | The licensed webfont is deactivated, the newest iOS version entry is dated 09/14/2021, and `/faq`, `/about` and `/support` all render the marketing homepage [PUBLISHED]. Take the 2015–2019 patterns; do not mirror the 2026 site. |
| **Delectable's palette and type** | Terroir's identity is contracted in `DESIGN.md` ("Terroir — Nocturne"). Importing Whitney and `#cd595a` would violate both that contract and the client-owned-identity rule. Copy structure, not tokens. |

---

## 9. Gaps — not publicly available

- **Delectable's catalogue size.** Never published as a number, at any point, by Delectable or Vinous. Only comparative statements exist, and the sharpest one is authored by a rival.
- **Whether the transcription queue still operates in 2026**, its staffing, its SLA, or its current turnaround. The last turnaround figures found are from 2014.
- **Whether Instant Match is OCR, embedding-based image retrieval, or a hybrid.** Delectable never published an engineering post; no talk, paper or repository was located. The "OCR and database matching" description is a competitor's characterisation, and one contemporaneous commenter's "Mechanical Turking" account is explicitly labelled a personal theory [PUBLISHED as a theory, not as fact].
- **The identification accuracy rate at scale.** The only measured figure is a six-bottle test from 2014.
- **Whether transcription completion fires a push notification.**
- **Current Premium pricing and subscriber count.** The $5.99 figure is verifiable on the live App Store listing but was set in 2017; no subscriber number has ever been published.
- **Mobile API surface.** All architecture facts here come from the *web* client bundle; the iOS/Android clients may expose more (there is no capture-creation endpoint in the web bundle, so capture creation is mobile-only).

## 10. How to verify the private numbers

1. **Turnaround, today.** Install the free app, upload one deliberately obscure label (a grower Champagne or an off-vintage German estate), tap "Request Expert Review", and time it. Repeat 5×. That is the only way to know whether the queue still runs — and it costs nothing.
2. **Bulk behaviour under load.** Photograph 30 bottles, multi-select all 30, and record: whether the picker caps the selection, how quickly rows appear as pending, and the resolution spread. This directly sizes Terroir's own batch target.
3. **Instant Match vs. queue.** Scan a mainstream Napa Cabernet (should resolve instantly) beside an obscure label (should go pending). The latency gap is the tiering.
4. **Catalogue coverage.** Query `/v2/base_wines/search` behaviour through the public web search UI with 50 wines drawn from Terroir's own X-Wines/LWIN catalogue and record the hit rate — a direct, free coverage benchmark against Terroir's existing spine.
5. **Premium contents.** The App Store subscription sheet lists the current price without purchase. Actual Premium behaviour requires a paid subscription — a business decision, not a research step.
6. **Mobile API.** A proxy capture of the iOS client would expose the capture-creation endpoints absent from the web bundle. Note this may conflict with Delectable's Terms of Use; check `delectable.com/terms` before doing it.

---

## 11. Sources

**Primary — Delectable / Vinous**
- [Delectable homepage](https://delectable.com/) · [application CSS](https://delectable.com/stylesheets/application-6dcea5b6.css) · [JS bundle](https://delectable.com/javascripts/bundle-ec126861.js) · [typography CSS](https://cloud.typography.com/6518072/679044/css/fonts.css)
- [10 Tips for Using Delectable](https://delectable.com/feeds/10_tips_delectable) — the de facto product documentation
- [Delectable wine page: Sassicaia 2010](https://delectable.com/wine/tenuta-san-guido/bolgheri-sassicaia-cabernet-sauvignon-cabernet-franc/2010) · [Categories index](https://delectable.com/categories) · [Press](https://delectable.com/press)
- [App Store — Delectable, id512106648](https://apps.apple.com/us/app/delectable-scan-rate-wine/id512106648) (listing, version history, developer responses)
- [Google Play — com.delectable.mobile](https://play.google.com/store/apps/details?id=com.delectable.mobile&hl=en_US) (listing + screenshots)
- [PR Newswire — Vinous Acquires Delectable & Banquet Apps, 2016-12-08](https://www.prnewswire.com/news-releases/vinous-acquires-delectable--banquet-apps-300375364.html)
- [PR Newswire — Delectable Launches Premium, 2017-07-10](https://www.prnewswire.com/news-releases/antonio-gallonis-delectable-wine-app-launches-new-premium-version-300485294.html)

**Independent press and review**
- [JancisRobinson.com — "Label-scanner apps – which is best?", Richard Hemming MW, 2014-02-27](https://www.jancisrobinson.com/articles/label-scanner-apps-which-is-best) — the only rigorous head-to-head found
- [PUNCH — "How the Delectable App Is Eliminating Wine's Third Wall", 2014](https://punchdrink.com/articles/how-the-delectable-app-is-eliminating-wines-third-wall/)
- [AVC (Fred Wilson) — "Feature Friday: Recognizing Wine Labels", 2014-02-14](https://avc.com/2014/02/feature-friday-recognizing-wine-labels/) — includes timing reports and a rival founder's comment
- [Washington Post — "App review: Even you can be a wine guru", Dave McIntyre, 2015-06-04](https://www.washingtonpost.com/lifestyle/magazine/app-review-even-you-can-be-a-wine-guru/2015/05/29/d7fc120a-ed0e-11e4-8abc-d6aa3bad79dd_story.html)
- [TechCrunch — Delectable raises $3M Series A, 2014-05-07](https://techcrunch.com/2014/05/07/wine-app-delectable-raises-3m-series-a/)

**Comparative — treat as interested parties**
- [sommo.app — "Best Wine Scanner Apps 2026", 2026-03-21](https://sommo.app/blog/best-wine-scanner-apps-2026/) — **competitor content marketing**; ranks its own product first
- [api4.ai — Wine Label Recognition: Vivino, TinEye, API4AI, Delectable](https://api4.ai/blog/wine-label-recognition-comparing-vivino-tineye-api4ai-and-delectable) — **vendor content marketing**

**Terroir-side references (local, for the adopt list)**
`supabase/migrations/0098_wine_variants.sql` · `src/app/(app)/scan-bottle/scan-bottle-state.ts` · `src/app/(app)/nav-links.tsx` · `src/domains/scanning/` · `DESIGN.md`

---

## Run record

- **Depth:** standard. **Firecrawl scrapes: 0** — every source resolved on the free local crawl4ai tier; no Firecrawl credits spent, no billed Anthropic API used.
- **Sources harvested:** 25 documents (21 via crawl4ai, 4 saved directly: the live CSS, the typography CSS, the JS bundle and the homepage HTML) + 6 store screenshots read visually.
- **Discovery:** `gemini-search.sh` timed out (rc=124) → fell back to the built-in WebSearch tool, as the skill prescribes.
- **Verification:** `verify-codex.sh` failed both batches (rc=1, circuit breaker tripped) → Claude verify subagent covered the full claim set. The verifier returned `overstated`/`unsupported_by_source` on 10 of 18 claims for **under-scoped quotes**; every one was re-quoted with a wider self-contained span and re-passed `cite-check.sh`. All 54 `cite-check.sh` runs across the final claim set returned OK — every quoted span byte-verifies against its harvest file.
- **Stage 5 (triangulate) deliberately not run:** the one gated fact (current transcription turnaround) has only two independent dated reports, below the three-report floor. No range was invented — see §3.

---

## Logged-in attempt — 2026-09-02

Devin's Delectable account was created with Google sign-in. `delectable.com/sign-in` and
`/register` offer only **Connect with Facebook** or email + password (plus a reCAPTCHA on
register); there is no Google or Apple option on the web, so a Google-created account cannot
be used there at all. The web surface is the marketing feed, category pages and wine search
described in §2; the capture, bulk-import, feed and profile flows in §1 and §3 exist only in
the iOS/Android app. **To audit them first-hand, Devin's phone screenshots or a screen
recording of the capture → pending → identified flow and the photo-library multi-select are
the evidence; no browser session can produce them.** Nothing here changes §7.
