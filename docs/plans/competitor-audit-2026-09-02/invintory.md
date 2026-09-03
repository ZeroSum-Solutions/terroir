# InVintory — competitor audit for Terroir

*Scope: InVintory (invintory.com; iOS/Android/web), the collector-facing wine cellar manager built around 3D "VinLocate" bottle finding. Prepared 2026-09-02 for the Terroir project (Next.js 16 + Supabase restaurant & personal cellar app: invoice scanning, label scan, cellar/bin placement, cellar health, wine lists, unified wine search with an AI companion, wine identity spine). **Public sources only** — no account was created, no credential entered, no gated screen accessed. Every figure carries `[PUBLISHED]` (byte-verified against fetched page bytes) or `[ESTIMATE]`.*

---

## TL;DR

InVintory's real moat is not the rendering — it is a **strict three-level location model (storage → section → slot) with a human-readable `R3, C5, D1` coordinate**, wired to a `Locate` affordance on every surface where a wine can appear, and backed by a help centre that documents the whole model honestly. Everything else — text-on-label scanning, credential-based CellarTracker import, drink windows, Liv-ex valuation, ten analytics cards, an AI sommelier with write access — is well-executed table stakes. The 3D itself is **built by hand by the user, entirely paywalled, and on Premium shows one rack at a time**; the single stitched room is an Elite deliverable that InVintory's own in-house "Elite Cellar Builder" models in Unity and then **locks**, removing Create/Modify/Duplicate/Delete from the customer. That combination — hours of manual setup, a slot-editing tool InVintory's own App Store replies admit users cannot find, no way to place bottles from an import, no custom slot labels, and an AI that explicitly cannot place a bottle in a slot — is the seam. Terroir's opening: **generate the layout instead of making the user build it** (from a form, a rack photo, or an import column), keep it as an editable declarative document rather than a bespoke artist-built model, and answer "where is it" at three fidelities (text coordinate → 2D shelf map → 3D room) so the useful part is never gated behind a WebGL scene, a phone OS floor, or a paid tier.

---

## Confirmed vs. inferred

| Confidence | What we know |
|---|---|
| **CONFIRMED [PUBLISHED]** | The full VinLocate object model, shape menus, coordinate rules, placement/move/reorganise semantics; the complete four-plan gating matrix; Premium price; the App Store IAP ladder; drink-window provenance; valuation method; sensor hardware; NFC design; wine-list builder limits; collaborator roles; company HQ, founder, funding rounds and the presence of a Unity developer and an "Elite Cellar Builder" on staff. |
| **REPORTED (secondary)** | Founding year 2018 and 2021-era team size/self-funding (trade press, uncorroborated on InVintory's own pages); a $119/yr web price seen by one independent reviewer in Feb 2026 that matches neither the site nor the App Store. |
| **INFERRED / ESTIMATE** | Elite's price (**not publicly available** — deliberately gated). Setup-time cost. That the 3D engine is Unity (a Unity developer is on staff and the iOS binary is 209.2 MB — strong, but not stated). All Terroir build-size tags (S/M/L) — my engineering judgement, not published facts. |
| **CONFLICTS / STALE** | InVintory states its own wine-database size as **1M+, 1.5M+ and 2M+** on different live pages. Tier naming differs between the site (Free/Premium/Elite/Enterprise) and the App Store SKUs (Aspire/Prestige/Premium). InVintory's own blog credits CellarTracker with "more than 5 million unique wines" — larger than InVintory's own highest claim. |

---

## 1. Feature inventory

### 1.1 Plans — four, not three, and the plan belongs to the collection

"InVintory has four plans — Free, Premium, Elite and Enterprise — and the plan belongs to the collection rather than to you, so everyone who shares a collection works with the same one" ([Understanding InVintory plans](https://help.invintory.com/en/articles/16596461-understanding-invintory-plans)). Enterprise "is set up with us rather than bought in the app".

| Allowance / feature | Free | Premium | Elite | Enterprise | Tag |
|---|---|---|---|---|---|
| Bottles | Unlimited | Unlimited | Unlimited | Unlimited | [PUBLISHED] |
| Cellars & fridges | Up to 10 | Up to 20 | Unlimited | Unlimited | [PUBLISHED] |
| Tags | Up to 10 | Unlimited | Unlimited | Unlimited | [PUBLISHED] |
| Vincent (AI) | One conversation | ✅ | ✅ | ✅ | [PUBLISHED] |
| Wine-list scans | One | Unlimited | Unlimited | Unlimited | [PUBLISHED] |
| Photos you add to a wine | — | Up to 6 | Unlimited | Unlimited | [PUBLISHED] |
| VinLocate 3D (per section) | — | ✅ | ✅ | ✅ | [PUBLISHED] |
| Whole cellar in one 3D view | — | — | ✅ | ✅ | [PUBLISHED] |
| Temperature & humidity sensors | — | — | ✅ | ✅ | [PUBLISHED] |
| Hiding market values, custom reports, restaurant pricing | — | — | — | ✅ | [PUBLISHED] |

Source for the whole table: [Understanding InVintory plans](https://help.invintory.com/en/articles/16596461-understanding-invintory-plans), fetched 2026-09-02.

| Price item | Value | Tag | Source |
|---|---|---|---|
| Free | $0 | [PUBLISHED] | [Pricing](https://invintory.com/pricing/) |
| Premium | $149.99 / year, or $14.95 a month | [PUBLISHED] | [Pricing](https://invintory.com/pricing/) — "Premium is $149.99 a year." |
| Elite | Not published — "For Elite, please contact us for pricing." Wine Spectator adds: "Price depends on cellar complexity, and clients can contact InVintory directly to get on the waitlist." | [PUBLISHED] (as a gap) | [Pricing](https://invintory.com/pricing/), [Wine Spectator](https://www.winespectator.com/pages/invintory) |
| Enterprise | Not published | [PUBLISHED] (as a gap) | [Plans](https://help.invintory.com/en/articles/16596461-understanding-invintory-plans) |
| iOS IAP ladder | Prestige Monthly $9.99 · Prestige Annual $99.99 · Premium Monthly $12.99 and $13.95 · Premium Annual $124.99 and $149.99 | [PUBLISHED] | [App Store id1434754695](https://apps.apple.com/us/app/invintory-wine-cellar-manager/id1434754695) |
| Legacy tier names | Aspire (free) and Prestige at "$9.99 per month or $99 annually" | [PUBLISHED] | [Wine Spectator](https://www.winespectator.com/pages/invintory) |
| Independent reviewer's web price (Feb 2026) | "The Premium tier ($14.95/month or $119/year)" — matches neither the site nor the App Store | [PUBLISHED] (as a conflict) | [Baker On Tech](https://bakerontech.com/invintory-a-clever-app-for-managing-your-wine/) |
| InVintory's stated CellarTracker ladder | "$40/year for 100 bottles, $60/year for 250 bottles, $80/year for 500 bottles, $160/year for 1,000 bottles, $320/year for 2,500 bottles, $500/year for 2,500+ bottles" | [PUBLISHED] | [Pricing FAQ](https://invintory.com/pricing/) |

**Free is a real product, not a trial**: "The free plan is a full version of InVintory rather than a trial: it does not expire, it does not cap how many bottles you can keep." Ungated on every plan: "Adding bottles by scanning a label, searching our wine database, writing reviews … past bottles, the activity feed, saved lists, exporting to CSV, market values on individual wines and collaborators." Paid-only: "The 3D cellar, your collection's total value, analytics, quick filters, custom fields, deliveries, barcode labels, printed wine lists and individual critic reviews." Note the neat split on critics: "The average critic score for a wine shows on every plan — it is the individual reviews behind it that need a paid plan."

Allowances are recoverable rather than lifetime: delete a Vincent conversation and you get another; delete a storage and the slot frees up ([Plan limits](https://help.invintory.com/en/articles/16596464-understanding-your-plan-s-limits)).

### 1.2 Getting wine in

| Path | Detail | Tag |
|---|---|---|
| Label scan | **Reads the label text, not a barcode** — "It reads the **text** on the label, not a barcode — so the front or the back both work", and explicitly "We don't scan commercial barcodes." | [PUBLISHED] — [Scan a label](https://help.invintory.com/en/articles/14301437-how-to-add-wines-by-scanning-a-label) |
| Add form | Quantity quick-adds of 1, 3, 6, 12, 24 | [PUBLISHED] — same |
| Restaurant wine-list scan | **Adds nothing.** "Scanning a list is a recommendation, not an import — no bottles, no wines, no records." Vincent reads the pages and recommends what to order; unconfirmed wines are dropped rather than guessed; prices read in the printed currency with no FX conversion. Multi-page scanner is iPhone/iPad only | [PUBLISHED] — [Scan a restaurant wine list](https://help.invintory.com/en/articles/16596584-how-to-scan-a-restaurant-wine-list) |
| CellarTracker import | Credential-based and fully automatic: "Sign in with your CellarTracker username and password … the matching runs on its own — no file to prepare, no queue, and nobody reviewing it. It is the only source you can start inside the iPhone, iPad and Android apps as well as on the web." Uses CellarTracker's public export; InVintory states it does not store the credentials. History → Past bottles, Wishlist → a saved list | [PUBLISHED] — [Import from CellarTracker](https://help.invintory.com/en/articles/16591122-how-to-import-from-cellartracker) |
| **Import privacy trap** | "Every CellarTracker note that has a date on it is imported as a **public** review on that wine, with comments open" — and of the five toggles, "In the apps they all start **on** ; on the web they all start **off**." | [PUBLISHED] — same |
| Vivino / spreadsheet | Vivino via its own export; spreadsheet via a template. Only the spreadsheet gets human review — "our team reads it, and rows we could not match come back by email as a spreadsheet". Reviewing or cancelling an import is web-only | [PUBLISHED] — [Organise a cellar from scratch](https://help.invintory.com/en/articles/10011588-how-to-organise-a-cellar-from-scratch), [Welcome](https://help.invintory.com/en/articles/14301217-welcome-to-invintory) |
| Import semantics | "An import creates a cellar for every name it does not recognise." Blanks land in "My Cellar". An import "**always adds** — it never merges" | [PUBLISHED] — [Organise a cellar from scratch](https://help.invintory.com/en/articles/10011588-how-to-organise-a-cellar-from-scratch) |
| **Import cannot place bottles** | "**No import can place bottles into 3D positions.** Not spreadsheets, not CellarTracker, not Vivino." | [PUBLISHED] — same |
| Missing wines | Submitted for approval by InVintory's sommeliers rather than created by the user | [PUBLISHED] — [WifiHifi](https://wifihifi.com/invintory-app-wine-cellar-fridge-organize/), 2021-05-20 |

### 1.3 The rest of the collector feature set

- **Drink windows** — free on every plan, and mostly computed in-house: "we work out when a wine should be at its best from its style, region, grapes and vintage year, and we lean on published critic drink windows for that exact wine and vintage wherever we have them", supplemented by "windows from wine databases and merchant listings we have matched to it". A user edit "Always wins. It sticks through every later update we make to that wine." Non-vintage wines are anchored to purchase or add date ([Drink-window sources](https://help.invintory.com/en/articles/10280468-where-we-source-our-drink-window-data)).
- **Valuation** — "InVintory pulls market data from Liv-ex and Wine Labs to value every bottle." Two design details worth stealing: "Every market price carries a **source tag**. Tap it to see exactly where that particular price came from"; and the total is honest about its own imputation — "Bottles we have no price for are estimated from the average price of the bottles that do have one, so the total is an estimate rather than an appraisal."
- **Analytics** (paid, blurred rather than hidden on Free) — ten cards: "Bottles Added, Bottles Consumed, Spend, Top Regions, Top Grapes, Top Vintages, Top Price Ranges, Top Countries, Top Wine Types, and Top Storages". Three are time-series with a timeframe menu; seven are whole-collection. The pattern to copy: "**Every breakdown card is a shortcut into your collection.** Tap a row … and you land on exactly those bottles, filtered and ready to work with." The trap to avoid: "**Only bottles removed as Consumed reach Bottles Consumed.** Remove a bottle as **Broken** , **Donated** , **Expired** , **Gifted** , **Missing** or **Sold** and it leaves your collection without appearing on that chart."
- **Restaurant-style wine list** (paid) — up to three nested grouping levels (Wine Type / Country / Region / Sub-Region outermost; Grape Variety and Alphabetical below), each level offering only dimensions that still subdivide the one above; "Three is the maximum, because the PDF only styles three levels of heading." Printable per-bottle fields: "Price, drink window, quantity, origin, grapes, bottle size, storage location". Exports as PDF, link or QR. **Four hard limits**: logo removal needs Elite/Enterprise; "**Selling price is part of Enterprise.**"; "The app does not keep a list of the wine lists you have built"; and a shared link is a permanent static snapshot — "The PDF is written once. Drink a bottle and the list still shows it" and "There is no way to switch it off | A link you have sent keeps working." ([Print a restaurant-style wine list](https://help.invintory.com/en/articles/11117324-how-to-print-a-restaurant-style-wine-list)).
- **Sharing** — four stacking roles, Owner / Admin / Editor / Viewer. A Viewer can still "locate bottles in 3D, read analytics and the activity feed, and export everything to a spreadsheet". Two structural limits: "**There is no way to give someone one cellar and not another**", and "Ownership itself cannot be handed over in the app, in any role." ([Collaborator roles](https://help.invintory.com/en/articles/16609408-understanding-collaborator-roles-and-permissions)).
- **AI sommelier "Vincent"** — sees the collection (including where a bottle sits), private notes, "A taste profile built automatically from what you own and what you have drunk and rated, refreshed daily", the catalogue and vintage guides. It **writes**: "add bottles, edit details such as price, notes, cellar or drink window, and mark bottles consumed, gifted or sold. It confirms with you first, works in small batches, and will only act on bottles it has just looked up in front of you", refusing for view-only collaborators. Stated hard limits: cannot buy wine, browse the web, read external spreadsheets, change billing, or contact anyone. **And the gap Terroir should exploit:** "**Vincent can move a bottle to a different cellar or fridge, but not into a particular slot inside one.** It reads where a bottle sits — down to the shelf and row — to work out which bottle you mean, but has no way to change it." Premium/Elite also get "a monthly summary of your collection from Vincent, by email and in the app."
- **CellarStickers (NFC)** — "A CellarSticker is a small NFC sticker you put on a rack, case, bin or bottle and link to that exact spot in InVintory — then hold your iPhone to it to open that location or bottle in the app." Notably serverless: "The link lives on the sticker itself, not in your account — nothing is registered with InVintory." iPhone-only (iPad has no NFC; Android/web can only buy them). Sold from `shop.invintory.com`.
- **Sensors** (Elite+) — exactly two supported models, a Minew S1 beacon and the **Govee H5179**, matched by Bluetooth advertising name. There is no cloud: "Your iPhone or iPad is the bridge … InVintory picks the readings up while the app is open and your device is within range"; "Scanning starts up to a minute and a half after you open the app, then samples every 30 seconds." Pairing the Govee in Govee's own app breaks it. Charted over Hour / Day / Week / Month ([Connect a sensor](https://help.invintory.com/en/articles/9868552-how-to-connect-a-sensor)).
- **Multi-cellar / multi-collection** — many storages per collection, plus switching whole collections.
- **Web app** at `app.invintory.com` — same data, "Best for importing a spreadsheet, editing a lot of bottles at once, and reading analytics."
- **Business products** — *Hospitality*: "Instantly see where every bottle is stored—whether in your main cellar, a wine fridge, or off-site storage", custom removal types for by-the-glass/pairing/event, "customizable permissions and unlimited users", turnover/sales/profitability reports, InVintory-led 3D cellar setup, and POS wiring via the Partner API. *Wine clubs / storage*: white-labelled dashboards, staff adding arriving shipments straight into members' virtual cellars, and a named **"Session-Only Mode"** for a shared club iPad "ensuring members see only their collection data" — with a real multi-tenant case study: "InVintory created virtual 3D renderings of all locker units, providing a master view for the Drayman House and individual access for members."

---

## 2. Information architecture and navigation

**iPhone: four tabs plus a persistent AI bar.** "Four tabs run along the bottom, with the **Ask Vincent** bar above them" — **Home**, **Collection**, **Explore** ("What other InVintory members are drinking, and what they thought of it"), **Profile**. Android differs: "five tabs — Home, Collection, a camera button in the middle, Reviews and Profile". The web app puts the same list in a left sidebar ([Welcome](https://help.invintory.com/en/articles/14301217-welcome-to-invintory)).

**Home is a dashboard the user assembles.** Fixed block: collection name with a plan badge (tap → Switch collection / Collection settings), one search field that searches "your whole collection and our wine database" with a camera icon straight to label scan, and two headline figures — Bottles and Market value. Below it, "**nine sections you can drag into any order, or switch off entirely**": Quick filters, Cellars & fridges, Ready to drink, Deliveries, Saved Lists, Past Bottles, Recent Activity, Analytics, Plans and tips. "A section with nothing in it yet hides itself." The arrangement is per-device. On the web this becomes a **Dashboard** with a fixed order ([Navigating the home screen](https://help.invintory.com/en/articles/14301522-navigating-the-home-screen)).

**The + button** is a nine-tile reorderable grid: Add, Remove, Scan wine, Search, Create review, Create list, Create menu, Create delivery, Scan CellarSticker.

**Collection is grouped by identity, not by bottle.** "The Collection tab groups your bottles by wine _and_ vintage — one row per label … Six bottles of the same wine and vintage are one row, not six." Each row carries "The label thumbnail, with **a cube badge if any of those bottles has a 3D position**", coloured pills and a size-aware bottle count; tapping opens the wine "where the individual bottles live, each with its own code, price, storage and 3D slot". Search covers "the producer, the grapes, and the region and subregion — and your own private bottle notes"; `2019 Opus One` parses the leading year as a vintage; a six-digit bottle code or ten-digit barcode resolves to one bottle. Four chips (Wine type, Storages, Tags, Drink status) sit under the field, with **Drink status** derived precisely: "**Ready To Drink** spans this year, **Drink Soon** ends within two years, **Hold** starts next year or later, **Past Prime** ended last year or earlier." The full panel filters on **cellars, sections and bottle location text** alongside every wine attribute. Bulk edit and tagging cap at 500 bottles ([Understanding your collection page](https://help.invintory.com/en/articles/14301769-understanding-your-collection-page)).

**Help-centre IA** (a fair proxy for the product's own mental model): Start here · Adding & removing bottles · Storages · Wine data & pricing · Importing & exporting · Vincent & discovery · Account, plans & billing · Troubleshooting · Best practices · Your collection · **VinLocate 3D** · Insights & reports · Devices & integrations · Sharing & collaboration · Android (beta).

---

## 3. The cellar visualisation model, in detail

### 3.1 Object model

"a **storage** holds **sections** , a section holds **slots** , and a slot holds one bottle" ([Common VinLocate terms](https://help.invintory.com/en/articles/9945386-common-vinlocate-terms)).

| Level | What it is | Example |
|---|---|---|
| Storage | The cellar or fridge itself | "Basement Cellar" |
| Section | One physical unit — a rack, a bin, or a wine case (a **shelf** on a fridge) | "Left Wall Rack" |
| Slot | A single position holding one bottle | Row 3, column 5 |

Three section kinds with **three honest precision levels** — the sharpest idea in the product:

| Type | Holds | When you locate a bottle |
|---|---|---|
| **Rack** | One bottle per fixed slot | "We point you at the exact slot" |
| **Bin** | Any number of bottles, piled together | "We point you at the bin" |
| **Wine case** | A case kept intact as one unit | "We point you at the case" |

"Bins are the honest choice when bottles are piled on each other and shift as you pull them out. Racks are the choice when you want an exact answer."

### 3.2 Geometry

Three integer steppers — **Column** (across), **Row** (high), **Depth** (front-to-back; "Depth 2 means one bottle behind another"). Racks offer all three, bins Column and Row only, cases none.

Shape menus: "**Rack** groups its shapes as **Trellis** (Grid, Lattice), **Wall Mounted** (Horizontal, Flat), **Shelves** (Horizontal, Vertical, Flat, Tilted) and **Special Display** (Rotating). **Bin** groups them as **Rectangles** (Square, Rectangle, Cross Rectangle, Half Rectangle, Diamond), **Isosceles Triangles** and **Right Triangles**. A fridge offers six shelf types instead: Flat, Lattice, Horizontal, Vertical, Tilted and Bins."

**Irregular racks are handled by subtraction, not by a richer grid**: build the full rectangle, then use `Remove bottle slots` (behind a gear icon, top right) to switch off positions that do not exist — "Slots you don't have — a corner cut out, a shelf that stops short — are removed afterwards with **Remove bottle slots** , not by shrinking the whole section."

**Bottle direction is decorative** — eight values, "Purely how the bottle is drawn; it never changes where one is found". Fridge shelves add Alternating Front / Alternating Back, which "flip the direction row by row, the trick many fridges use to pack bottles closer."

Sizing heuristic, published: "**Build the units you actually own, not one big box.** A configured storage typically ends up with about three sections — one per rack, shelf or case that physically exists."

### 3.3 The coordinate

"Every position also reads as a coordinate like `R3, C5, D1` — row, column, depth. It shows on the bottle in the app and can be printed onto shelf labels, so you can find a wine standing in the cellar without unlocking your phone."

Numbering origin is one of four corners (Bottom Left default; the web renames them Row Descending / Both Descending / Both Ascending / Column Descending). "The origin is set once for the whole collection, not per section." Renumbering never moves a bottle.

**Custom labels are explicitly refused**: "Do you support custom coordinates? **No.** … **You cannot letter your columns, rename a row, or type your own label for a slot.**" The only naming affordance is renaming the *section*, giving *Left Wall ❯ R3, C5, D1*.

### 3.4 Placing and finding

"**VinLocate knows where a bottle is only because you put it there.** Nothing is detected or guessed. You build the layout first, then place each bottle into a slot." Unplaced bottles are a first-class queue behind a **Without a 3D position** filter.

Finding is the strong half. `Locate` appears on: the wine's collection card, a list-row swipe, `Locate all` on the wine page, a single bottle's screen, the multi-select action bar, and inside a wine case. "If you own six of a wine and have placed four, **Locate** highlights all four at once, so you can pick whichever is easiest to reach." Three answers avoid 3D entirely: read the coordinate off the bottle; filter by **Sections** for a stocktake of one rack; filter by **Without a 3D position** for the inverse.

Moving: open the slot → tap the bottle → `⋯` → *Move within this section* / *Move to different section, cellar or fridge* / *Remove from 3D position* / *Remove from collection*. "**Tapping an occupied slot swaps the two bottles**", with the displaced bottle rejoining the waiting list. Bulk: select in Collection → `Relocate Bottles` or `Add to 3D position` → place them "one tap each from a single 3D session".

### 3.5 What the 2D and 3D views show

- **2D**: section rows showing "how many slots are open"; a home card per storage "with its bottle count, open slots and a button to view it in 3D"; and on the web a **minimap** — "**Row** and **Column** buttons across the top, then a tile per slice labelled **R1** , **R2** , **R3** … each showing how many of its slots are filled."
- **3D**: a rendered rack with virtual labels and bottle colours. Interaction is **drill-down, not free orbit** — racks open in row view; a `Row`/`Column` toggle re-slices; tapping drills into one slice; step arrows walk adjacent slices (continuing shelf-to-shelf on a fridge); a `Jump to Row` picker lists every row. "Every section starts in row view again next time you open it; the choice is not remembered." Bins and cases have no toggle.
- **Scope of view is a pricing axis**: on any paid plan the 3D view is "One section at a time. You open a rack or shelf and look at that"; only on "Elite and above" is it "The whole cellar stitched into a single room you can move around in" — and InVintory says so plainly: "The single stitched cellar you may have seen in marketing is the wider of the two views."
- **Ready-made fridge models**: at create-fridge time only, pick a brand and model and "Every shelf is built for you". "Brands are listed alphabetically with up to ten models each"; each card shows model number and capacity. "**The model can only be chosen while you create the fridge.**" Not on Android.
- **Elite builds**: "We build you a custom full 3D model of your home wine cellar with all its unique details, down to the wooden cases and artwork", coordinated by a wine manager "in-person, so you never have to lift a finger", and delivered on hardware — the launch release describes a model "unlocked on an iPad that is stationed at the cellar door". Wine Spectator: "a custom 3D model of their cellar, replete with wood paneling and décor". The Elite page's persuasion device is a before/after drag slider: "Drag the slider to see how we transform real wine cellars into stunning 3D digital replicas."

### 3.6 Known limitations and user complaints

| Limitation | Evidence | Tag |
|---|---|---|
| Free tier gets no 3D at all | "Free collections get no VinLocate at all" | [PUBLISHED] |
| The 3D view is "One section at a time" on **any paid plan**; "Your whole cellar in one 3D view" is ticked only for Elite and Enterprise | VinLocate table ("Any paid plan" vs "Elite and above") + the plans table | [PUBLISHED] |
| Bespoke Elite cellars are **locked** | "on a storage we've modelled, the **Create** , **Modify** , **Duplicate** and **Delete** options disappear from its sections … come back to us for changes"; "A storage whose 3D model our team built for you cannot be deleted from the app at all" | [PUBLISHED] |
| Irregular-shelf tooling undiscoverable — conceded in InVintory's App Store Developer Response | User: "there are limitations when setting up shelves with varying bottle capacities". Developer: "Your feedback has us looking at how to make that far more obvious than a gear icon, because you're clearly not the only person who's missed it." | [PUBLISHED] |
| No whole-shelf scan view — stated as roadmap, not shipped, in InVintory's App Store Developer Response | Developer Response: "A proper "scan this whole shelf at once" view is now on our roadmap." | [PUBLISHED] |
| No free rotation of the 3D scene | User: "I wish you could freely rotate the cellar visualization" | [PUBLISHED] |
| No custom slot or column labels | "You cannot letter your columns, rename a row, or type your own label for a slot." | [PUBLISHED] |
| Imports can never place bottles | "No import can place bottles into 3D positions." | [PUBLISHED] |
| One silent data-loss path | "Changing a bottle's cellar or fridge from the edit screen clears its 3D position with no warning" | [PUBLISHED] |
| Setup is a long manual job | "A large cellar is a sit-down job rather than a two-minute one." Independent: "After spending a few afternoons pulling every bottle from my cabinet, scanning each one, and placing it back in any available location" | [PUBLISHED] |
| Android 3D half-wired | "**Relocate Bottles** and **Add to Position** — Android … Both appear when you select bottles in your collection, and neither does anything yet"; coordinate origin "is not saved" | [PUBLISHED] |
| Not supported on macOS | "VinLocate needs a real iPhone or iPad." | [PUBLISHED] |
| AI cannot place into a slot | "Vincent can move a bottle to a different cellar or fridge, but not into a particular slot inside one." | [PUBLISHED] |
| Scan / database coverage gaps | "Not all bottles scan so I've had to input maybe 25 percent of them manually"; forum: "I'm trying InVintory and I seem to be adding quite a bit of my wine manually that's not already in the system." | [PUBLISHED] |
| Drink-window quality — conceded in InVintory's App Store Developer Response | Developer Response: "On drinking windows - fair criticism, and it's live work for us right now." | [PUBLISHED] |
| Paywall depth is the top recurring gripe | "I just wish majority of the app wasn't restricted behind a monthly paywall"; a competitor roundup names "free-tier depth (much of the value is paywalled)" | [PUBLISHED] |
| Overbuilt for smaller collections | "The downside is that InVintory can feel overbuilt and expensive for a casual collection." | [PUBLISHED] (vendor-authored roundup — treat as opinion) |

---

## 4. Design language

*Observed from public assets, not from a brand guide.*

- **Type**: Canela (display serif — `Canela-Light.woff2`, `font-family:Canela,serif`) over Lexend Deca (UI sans). The web app repeats the pair (`font-family:Canela Web`, `font-family:Lexend Deca,sans-serif`). [PUBLISHED — fonts served from invintory.com and app.invintory.com, fetched 2026-09-02]
- **Palette**: near-black grounds (`#161616`, `#1a1a1a`, `#0c0c0c`), warm brown→cream gradients (`#2a2318` → `#f4ebdb`), and a champagne-gold accent family (`#d0b070`, `#c4a460`, `#b8904a`, `#9c7b3f`, `#f0dcae`). The gold is confirmed as brand primary by their own Calendly embeds: `background_color=1a1a1a&text_color=ffffff&primary_color=d0b070`. [PUBLISHED]
- **Voice**: object-as-artwork, stewardship, futurism. "Your collection is a work of art. Let's manage it like one." · "Step into the wine cellar of the future" · "Stop searching. Start enjoying." · "Our wine collections are our prized possessions. Care for yours the way it deserves." · "Collecting wine is not just about amassing bottles."
- **Proof furniture**: an editorial logo wall (Wine Spectator, Decanter, Robb Report, Veranda, Goop, Sharp, Canada's 100 Best), an Apple "App of the Day" badge, a headline stat trio, and testimonials sized by cellar ("Enrico, 5,050 bottle cellar"). Wine Spectator's own framing — "is the iPhone of wine technology" — is quoted back throughout.
- **Signature interaction**: the Elite before/after drag slider pairing a photograph of the real cellar with the rendered replica. It is the single most persuasive artefact on the site and the one piece of *interaction design* worth copying outright.
- **Documentation voice** — arguably their best design work, and free to study: short declarative subtitles, a ⭐ plan-requirement callout at the top of every article, "what survives what" tables, explicit admissions of platform gaps, and a **"Copy for LLM"** button on every page. They are deliberately optimising docs for agent consumption.

---

## 5. Public architecture, data and platform facts

| Item | Value | Tag | Source |
|---|---|---|---|
| Wine database — App Store & Jan-2026 blog | "sommelier-curated database of over 2 million wines" | [PUBLISHED] | [App Store](https://apps.apple.com/us/app/invintory-wine-cellar-manager/id1434754695), [blog](https://invintory.com/blog/best-wine-apps-top-tools-for-collectors-compared/) |
| Wine database — Partner API / Hospitality / AI page | "1.5M+ wine labels" · "over 1.5 million wine labels" · "over 1.5 million wines" | [PUBLISHED] | [Partner API](https://invintory.com/api/), [Hospitality](https://invintory.com/hospitality/), [AI Sommelier](https://invintory.com/ai-sommelier/) |
| Wine database — Pricing page | "sommelier-managed database of 1M+ wines" | [PUBLISHED] | [Pricing](https://invintory.com/pricing/) |
| InVintory's own figure for CellarTracker | "more than 5 million unique wines cataloged and over 1,000 new wines added daily" | [PUBLISHED] | [InVintory blog](https://invintory.com/blog/invintory-vs-cellartracker-which-app-fits-serious-collectors/) |
| Curation model | "Our database is managed by sommeliers, not crowd-sourced." Led by "Martine McLarney, DipWSET, Director of Wine" | [PUBLISHED] | [Pricing FAQ](https://invintory.com/pricing/), [About](https://invintory.com/about/) |
| Market-price sources | Liv-ex and Wine Labs | [PUBLISHED] | [Pricing FAQ](https://invintory.com/pricing/) |
| Headline metrics | "100k+ Monthly active collectors 10M+ Bottles tracked $1B US Wine value tracked" | [PUBLISHED] | [Home](https://invintory.com/) |
| App Store rating | 4.8 / 5 from 4.6K ratings (site says "4,000+"; Jan-2026 blog says "over 4,200 reviews") | [PUBLISHED] | [App Store reviews](https://apps.apple.com/us/app/invintory-wine-cellar-manager/id1434754695?see-all=reviews) |
| Google Play installs | 1K+ (no rating or review text exposed in the fetched listing) | [PUBLISHED] | [Play](https://play.google.com/store/apps/details?id=com.invintory.app) |
| iOS version / cadence | 6.33.0 at capture, released 2 days earlier; roughly weekly releases | [PUBLISHED] | App Store |
| iOS minimum OS | "Requires iOS 18.0 or later." | [PUBLISHED] | App Store |
| iOS binary size | 209.2 MB | [PUBLISHED] | App Store |
| Languages | English, French, German, Italian, Japanese, Portuguese, Simplified Chinese, Spanish | [PUBLISHED] | App Store |
| **3D engine** | The About page's staff list names a "Senior Unity Software Developer" (Victor Truong) and an "Elite Cellar Builder" (Moven Chan) among 11 people. Combined with the 209.2 MB binary and the "same 3D engine" claim across iOS/Android/web, **the 3D is almost certainly Unity** | The two job titles [PUBLISHED]; the engine conclusion [ESTIMATE] | [About](https://invintory.com/about/) |
| Legal entity | InVintory Wines Incorporated; developer address Thornhill, Ontario; press datelines Toronto | [PUBLISHED] | Play developer block, [Press](https://invintory.com/press/) |
| Founder / CEO | "Joshua Daiter — CEO & Co-Founder"; origin story is his father Jeff smashing a bottle while hunting for it | [PUBLISHED] | [About](https://invintory.com/about/) |
| Founding year | 2018 | [PUBLISHED] as a secondary report | [Baker On Tech](https://bakerontech.com/invintory-a-clever-app-for-managing-your-wine/) |
| Funding | "$1.5M Fundraise Led by its Community of Wine Collectors" (Oct 2022); "$2.3M USD in seed round funding" (Nov 2024) to expand into hospitality and storage. NBA investors JJ Redick and Josh Hart | [PUBLISHED] | [Press](https://invintory.com/press/) |
| Elite lineage | Launched Nov 2023 as **"Opus"**, later renamed Elite | [PUBLISHED] | [Press](https://invintory.com/press/) |
| Recent enterprise motion | Superyacht Bar / Superyacht Wine Club partnership, June 2026 | [PUBLISHED] | [Press](https://invintory.com/press/) |
| 3D IP | "our patent-pending 3D tech, with which collectors can create custom, digital cellar sections and fridges, assign bottles to specific slots" | [PUBLISHED] | [Glory Media](https://www.glory.media/invintory-founders-jeff-and-josh-daiter-merge-technology-and-wine/) |
| Partner API | `POST https://api.invintorywines.com/partners/v1/wines/actions/scan-image`, `x-api-key` header, returns `resolution` / `producer_name` / `year` / `results[].score`. Surfaces: "Programmatic access to cellars, bottles, locations, and movements", image scan, catalogue search, POS/ERP/reservation integrations, and "Webhooks keep your stack in sync as bottles move through the cellar". Security model: "Scoped API keys, role-based permissions". Docs at `api.invintorywines.com/partners/docs`. Priced by quote | [PUBLISHED] | [Partner API](https://invintory.com/api/) |
| Marketing site stack | Vite static bundle, Tailwind (`--tw-*`), **Sanity** CMS (`cdn.sanity.io`), **Cloudinary** imagery, Cloudflare, GTM + Ahrefs, OneLink deep links, Intercom/Fin help centre | [PUBLISHED] | HTML/CSS fetched 2026-09-02 |
| Web app stack | Vite build with chunks named `createServerFn`, `fileRoute`, `lazyRouteComponent`, `useSearchParams`, `queryclient` — the TanStack Start / TanStack Router + TanStack Query signature. Tailwind v4-style tokens. Cloudflare edge (`cf-placement`) | Asset names [PUBLISHED]; framework identification [ESTIMATE] | `app.invintory.com/login` fetched 2026-09-02 |
| Partner network | Sorrells, Vineyard Wine Cellars (Dallas), Cellar Maison, Wine Racks America, Joseph & Curtis — physical cellar builders who resell InVintory as a differentiator | [PUBLISHED] | [Home](https://invintory.com/), [Partners](https://invintory.com/partners/) |

**Conflicts to carry forward.** (a) The wine-database figure is 1M+, 1.5M+ or 2M+ depending on the page — never cite it as a benchmark, and note InVintory's own blog puts CellarTracker at 5M+. (b) The App Store sells *Aspire / Prestige / Premium* SKUs while the site sells *Free / Premium / Elite / Enterprise*, and an independent reviewer saw $119/yr in Feb 2026 where the site says $149.99/yr — the ladder is mid-migration with the legacy Prestige tier ($99.99/yr) still live.

---

## 6. Estimates (triangulated, not company-confirmed)

| Item | Estimated range | Basis (n, date range) | Notes |
|---|---|---|---|
| Elite annual price | **Not publicly available** | 0 dated independent reports found | Gated behind a Calendly call, a quote form and a waitlist. Wine Spectator confirms only that "Price depends on cellar complexity". Fewer than 3 dated reports exist, so no range is invented. |
| Enterprise price | **Not publicly available** | 0 reports | "set up with us rather than bought in the app" |
| Time to build a cellar in VinLocate | Hours, not minutes — "a few afternoons" for ~300 bottles in a cabinet; "about an hour" for five cellars and 80 bottles; "about 5 hours setting up new shelving and reorganizing" | n=3 dated first-hand accounts, 2023-06-05 → 2026-02-19 | Two App Store reviews plus one independent blog. Scope differs per account — an order of magnitude, not a benchmark. |
| Label-scan miss rate | roughly 4%–25% of bottles needing manual entry | n=3 dated first-hand accounts, 2021-05-20 → 2026-02-19 | "only 1 or 2" of ~24 (2021); "~90% were recognized by scanning" (2023); "maybe 25 percent of them manually" (2024). Not a company figure. |

---

## 7. Ranked "adopt for Terroir" list

Terroir today models location as `cellar_config` (`rows`, `columns`, `labels` jsonb holding a `sections` array — a flat SVG grid per named cellar) plus a first-class `bins` table (`code`, `zone`, `capacity`, `priority`, `sort_order`, `retired_at`) with `inventory_items.bin_id`, and `wine_lists.show_bin_codes`. That is a flat grid plus a code namespace: **no section geometry, no depth, no per-bottle slot**. Ranked by leverage per unit of work.

| # | Adopt | What to copy | What to do better | Size |
|---|---|---|---|---|
| 1 | **Three-level model with a readable coordinate** | storage → section → slot, and a `Section ❯ R3, C5, D1` string that prints on a shelf label and works with no screen | Keep `bins.code` as the service-facing name and make the coordinate an *alias* of it, so a sommelier says "R4-S3" and a runner reads "Wall A ❯ R3, C5, D1". Make axis labels configurable (numeric / alpha / custom) — the thing InVintory flatly refuses | **M** |
| 2 | **Rack / Bin / Case as three honest precision levels** | "we point you at the exact slot / at the bin / at the case" is the best single idea in the product | Add a restaurant-specific fourth: **Zone** (floor, service station, off-site locker) answering "which room" before "which slot", mapped onto Terroir's existing `bins.zone`. Always show the precision level so nobody is misled | **S** |
| 3 | **Locate on every surface** | A `Locate` chip on the collection card, the list swipe, the bottle screen, multi-select and inside a case; multi-bottle highlight so you can "pick whichever is easiest to reach" | Put it on **AI companion answers**, **invoice-scan results** and **wine-list lines** too, and make the *first* fidelity a text coordinate + 2D shelf map that renders instantly — never a WebGL scene as the only answer | **M** |
| 4 | **Generate the layout instead of building it** (see §7.1) | Ready-made fridge models (pick brand → shelves built) prove the demand | Three generators — spec form, **rack photo**, and **import column** — and allow a model to be applied to an *existing* storage, which InVintory explicitly cannot do | **L** |
| 5 | **Non-destructive reorganisation, stated as a contract** | Their "what survives what" table is exactly the right artefact: rename, reorder, renumber and view-switching never move a bottle; only five actions clear a position, four with a warning | Kill the silent fifth. Every geometry edit runs a dry run ("this unplaces 3 bottles — review them"), and moving a bottle between locations re-homes it into an equivalent free slot where one exists | **S** |
| 6 | **Unplaced as a first-class queue** | The `Without a 3D position` filter; a cube badge on rows that have a position | `0057_bins.sql` already declares "Unplaced is a queue state, never a pseudo-bin" — finish it with a persistent "N bottles need a home" card and a one-tap placement session | **S** |
| 7 | **Per-tenant scoping and Session-Only Mode** | The wine-club pattern: "virtual 3D renderings of all locker units, providing a master view … and individual access for members", plus a shared-iPad mode "ensuring members see only their collection data" | InVintory cannot scope a *collaborator* to one cellar ("There is no way to give someone one cellar and not another"). Terroir already has per-restaurant RLS — extend it to **location → room → section** so a bar lead sees the back bar and not the reserve cellar, and ship a service-device kiosk mode | **M** |
| 8 | **Provenance on every number** | "Every market price carries a **source tag**"; and a total that admits its own imputation — "estimated from the average price of the bottles that do have one, so the total is an estimate rather than an appraisal" | Terroir has real invoice data, so the source tag can be *the actual invoice line* rather than a market feed — a materially stronger claim than InVintory can make | **S** |
| 9 | **Analytics rows as navigation** | Every breakdown row is a filter into the collection | Point the same mechanism at cellar health: tap "dead stock 90+ days" and land on those bottles *with their slots*, ready to become a pull list. Also copy the honesty about exclusions ("Only bottles removed as Consumed reach Bottles Consumed") | **S** |
| 10 | **Wine-list builder with nested grouping + QR** | Heading / Subheading / Sub-subheading, each level offering only dimensions that still subdivide the one above; PDF + link + QR; printable fields incl. storage location | Fix their four failures: persist every list, make the link **live and revocable**, never paywall logo removal or selling price, and use `show_bin_codes` so a service list doubles as a pull sheet | **M** |
| 11 | **AI companion that acts, with guardrails** | Confirms first, works in small batches, only acts on records it just looked up, refuses on view-only roles, and states its own hard limits plainly | **Beat the headline gap**: let the companion place and move bottles *into specific slots* — "put the six Chablis in Wall B row 4" — with a preview diff. InVintory cannot do this | **M** |
| 12 | **Physical anchors: printed codes and NFC** | Printing barcodes straight from the cellar view; NFC tags bound to a rack, case, bin **or a single bottle** | InVintory writes the binding onto the tag ("The link lives on the sticker itself, not in your account") and it is iPhone-only. Terroir should keep a server-side registry (so a lost tag can be re-bound and an audit trail exists) and use QR as the cross-platform fallback. A tag per bin should open a **count-this-bin** flow feeding cellar health and reconcile | **M** |
| 13 | **Grouped-by-wine+vintage list with per-bottle drill-down** | One row per label with a count; drill in for each bottle's own code, price, storage and slot; a badge for "has a position" | Terroir's wine identity spine already supports this — add per-bottle provenance so each bottle row shows what was paid on which invoice | **S** |
| 14 | **Drink-status as four computed states** | Ready To Drink / Drink Soon / Hold / Past Prime with precise date rules, and "your own edit always wins" | Publish the rule in-product the way they do. Given the weakness of their windows that InVintory itself concedes, treat this as a **methodology opportunity**, not just a copy | **S** |

### 7.1 How Terroir's 3D storage should beat VinLocate — concrete proposal

**The thesis.** InVintory made the cellar a *bespoke artefact*: either you hand-build it stepper by stepper, or you pay an in-house cellar builder to model it and lose the ability to change it. Terroir should make the cellar a **declarative document** — a small versioned JSON layout that everything renders from. That one decision cascades into every advantage below.

**A. The layout document.** One row per storage:
`{ origin, sections: [ { id, name, kind: rack|bin|case|zone, shape, cols, rows, depth, disabled_slots: [[r,c,d]], label_scheme: { row: numeric|alpha|custom, col: … }, transform: {x,y,z,rot} } ] }`.
Slots are *derived*, not stored — only occupancy is persisted (`bottle_slots(bottle_id, section_id, r, c, d)`). Consequences: an Elite-class room is just a layout with transforms plus a room shell and stays fully user-editable; duplicating a rack is a JSON copy; layouts can be versioned, diffed, previewed and rolled back; and the same document renders a printed shelf map, a 2D plan and a 3D room. It also slots cleanly beside the existing `bins` table — a bin *is* a section with `kind: bin`. **Size: M**, and it is the prerequisite for everything else.

**B. Three ways to get a layout, none of them "sit down for an afternoon".**
1. **Spec form** — the InVintory path (kind → shape → cols/rows/depth), kept because it is genuinely fast for a regular rack. **S.**
2. **Photo → rack** — point the camera at a rack or fridge shelf; detect the slot lattice; propose `cols × rows × depth` plus the cut-outs as an overlay the user corrects by tapping. This answers *both* the discoverability failure InVintory itself concedes ("more obvious than a gear icon") and the "shelves with varying bottle capacities" complaint, because subtraction becomes derived rather than hunted for. Terroir already runs label and invoice vision pipelines, so this is a new prompt/model over existing plumbing. **L.**
3. **Import → placement** — accept a `bin_code` or `R,C,D` column on spreadsheet/CellarTracker import and place bottles automatically. A flat-out capability InVintory says it does not have; for a restaurant migrating off a spreadsheet it is the difference between adoption and abandonment. **M.**

**C. Progressive fidelity, never a hard gate.** "Where is it" resolves at three tiers, each usable alone: (1) **text** — `Wall A ❯ R3, C5, D1`, on every plan, every device, offline, printable; (2) **2D shelf map** — an SVG of the section with the slot pulsing and neighbouring labels legible, which is precisely what the reviewer who asked to "view an entire shelf … so you can visually scan all labels at once" wanted and InVintory still has on its roadmap; (3) **3D room** — a generated scene with **free orbit** (the other outstanding user request). Because the scene is generated from the layout doc rather than modelled by hand, the *whole room* is the default, not an Elite upsell. **M** for tiers 1–2, **M–L** for tier 3.

**D. Rendering approach.** An instanced-mesh WebGL scene (one bottle geometry, per-slot transforms) generated from the layout document keeps thousands of bottles cheap and runs in the browser — Terroir is a Next.js app, so it works everywhere InVintory does not ("VinLocate needs a real iPhone or iPad", iOS 18.0+ floor, a 209 MB binary). Label textures load lazily and only for the slice in view; the 2D tier is the fallback wherever WebGL is unavailable. *(This is my recommendation, tagged [ESTIMATE]; InVintory's engine is inferred as Unity from a staff role, not stated.)*

**E. Restaurant multi-location, which InVintory structurally cannot do.** Their roles are collection-wide. Terroir should scope membership to **location → room → section**, then build the service loop on top: a pull list from a wine list or a reservation resolves each line to a slot, orders the stops in walk order, and a runner marks each pull — writing depletion straight into cellar health and reconcile. Add a kiosk/session mode for a shared service iPad, borrowing the wine-club "Session-Only Mode" idea. That is a workflow no collector app has, and it is why Terroir's 3D can be a *tool* rather than a showpiece.

**F. Safety by contract.** Every layout mutation is preview-then-apply with an explicit "N bottles will be unplaced" list and a one-click undo; a location change re-homes rather than silently clearing. Small work; removes InVintory's one documented silent-data-loss path.

**Overall size for the 3D programme: L**, decomposing into shippable steps: layout document + text coordinate (**M**) → 2D shelf map + Locate everywhere (**M**) → import-to-placement (**M**) → 3D room with free orbit (**M–L**) → photo-to-rack (**L**).

---

## 8. What NOT to copy, and why

1. **Gating location-finding behind a paid tier.** Free gets "no VinLocate at all", and the loudest recurring App Store complaint is that "majority of the app wasn't restricted behind a monthly paywall"; a competitor roundup names "free-tier depth (much of the value is paywalled)" as the top miss. For Terroir, finding a bottle *is* the job — a restaurant that cannot find stock has no reason to keep the app open.
2. **Section-at-a-time as the only paid view, with the whole room reserved for the top tier.** It creates an expectation gap InVintory's own help centre has to walk back: "The single stitched cellar you may have seen in marketing is the wider of the two views." Never ship marketing the docs must apologise for.
3. **Vendor-built, customer-locked models.** On a modelled storage "the **Create** , **Modify** , **Duplicate** and **Delete** options disappear", and it "cannot be deleted from the app at all". Restaurants reconfigure racking constantly; a layout the operator cannot change is a liability — and a services business Terroir does not want.
4. **Refusing custom slot labels.** "You cannot letter your columns, rename a row, or type your own label for a slot." Real cellars are already labelled; a system that insists the shelf agree with it forces relabelling and guarantees drift.
5. **Cosmetic-only configuration.** Bottle direction is eight values that are "Purely how the bottle is drawn". A setting that carries no meaning is a support cost. If Terroir models orientation, make it do work — bottle-size fit, capacity checks, breakage risk.
6. **Defaulting imported dated notes to public.** "Every CellarTracker note that has a date on it is imported as a **public** review on that wine, with comments open", and "In the apps they all start **on** ; on the web they all start **off**." A privacy-relevant default that differs by platform — and that converts a dated note written elsewhere into a public, comment-open review — is a bug wearing a feature's clothes. Terroir should import private-by-default, everywhere, with one explicit publish step.
7. **Ephemeral, unrevocable shared documents.** "The app does not keep a list of the wine lists you have built", the PDF "is written once", and "There is no way to switch it off | A link you have sent keeps working." For a restaurant, a guest-facing list must be live, versioned and revocable.
8. **Paywalling the parts a restaurant cannot operate without.** Logo removal needs Elite/Enterprise; "**Selling price is part of Enterprise.**"; QR export needs Elite on iOS but any paid plan on Android/web. A wine list that cannot show the selling price is not a wine list.
9. **Bins as the default answer for stacked wine.** "We point you at the bin" is honest for a collector, too vague for service. Use bin-level precision only where the count is shown and reconcile can verify it.
10. **Collection-wide-only sharing.** Fine for a household, wrong for a restaurant group — and exactly the constraint Terroir's per-restaurant RLS already avoids. Do not regress toward it for convenience.
11. **A sommelier-gated database as a hard blocker on adding a wine.** Users report submitting missing wines "for approval by Invintory's team of sommeliers" and waiting. Terroir's identity spine should let an unmatched wine exist immediately as a provisional identity and reconcile later — an invoice arriving at 6pm cannot wait for a curation queue.
12. **Publishing three different database sizes.** 1M+, 1.5M+ and 2M+ appear across InVintory's own live pages. Quote one number from one query, or none.
13. **Their brand language.** Warm brown/cream grounds with champagne gold and a Canela display serif is a coherent luxury system — and it is theirs. Terroir's own `DESIGN.md` ("Terroir — Nocturne") specifies cool near-black grounds, one claret red, Source Serif 4 over Source Sans 3, and states that **brown and cream are banned outright, in every mode**. Copy the *structure* of their help centre and the Elite before/after slider; copy none of the palette or type.
14. **An indefinitely-behind platform with dead controls.** InVintory documents Android buttons where "neither does anything yet" and a setting that "is not saved". Shipping a visible control that does nothing is worse than not shipping it.
15. **Sensor telemetry bridged through the user's own iPhone or iPad.** "Your iPhone or iPad is the bridge … while the app is open and your device is within range", sampling every 30 s. Readings are picked up only while the app is open and the device is in range, so for a cellar that must be watched overnight this is not monitoring. If Terroir does conditions, use a gateway that reports without a human present.

---

## 9. Gaps — what is not publicly available

- **Elite and Enterprise pricing.** Gated behind a Calendly call, a quote form and a waitlist; no dated independent report of a paid figure exists.
- **Elite build inputs and turnaround.** No InVintory page states what the customer supplies (photos, drawings, measurements, a site visit) or how long a build takes — only that a wine manager coordinates set-up in person and price depends on complexity.
- **The 3D engine, definitively.** A Unity developer on staff is strong circumstantial evidence, not a statement.
- **Hospitality / wine-club pricing, and whether multi-venue is genuinely modelled** — both pages route to a sales call.
- **Whether the whole-cellar stitched view is a licence check or a modelling dependency** — the docs tie it to "Elite and above" without saying which.
- **Google Play rating and review text** — the fetched listing exposed installs only.
- **Current headcount and revenue** — the team page lists 11 people but is not dated; the only staffing figure found is from 2021.

---

## 10. How to verify the gated numbers

1. **Elite price and build process** — book the public Calendly (`calendly.com/zack-invintory/elite-client-call-google`) or submit the `/elite` quote form. Ask: price basis (per cellar / per bottle / flat), what inputs the build needs, turnaround, and whether the model stays editable afterwards.
2. **Hospitality pricing and multi-venue** — the separate hospitality Calendly (`calendly.com/parkerstansbury/book-a-meeting`).
3. **Partner API surface** — the docs are advertised as public at `https://api.invintorywines.com/partners/docs`. Read the OpenAPI spec for the real location/movement object model rather than inferring it from the marketing page; it is the fastest route to their actual slot schema.
4. **In-app behaviour** — install on iOS 18+ and use the free trial to observe the 3D drill-down, the gear-icon slot editor and the Locate flow first-hand. Not done here: this brief is public-source only.
5. **Play Store metrics** — read the listing in a browser with reviews expanded, or via a store-intelligence source.
6. **The 3D engine** — inspect the shipped iOS bundle for `UnityFramework`, or the web app's authenticated chunks for a WebGL/Unity loader.

---

## 11. Sources

**Primary — InVintory**
[Home](https://invintory.com/) · [Pricing](https://invintory.com/pricing/) · [Elite](https://invintory.com/elite/) · [FAQ](https://invintory.com/faq/) · [AI Sommelier](https://invintory.com/ai-sommelier/) · [Hospitality](https://invintory.com/hospitality/) · [Wine clubs / storage](https://invintory.com/wine-clubs/) · [Partner API](https://invintory.com/api/) · [Partners](https://invintory.com/partners/) · [About](https://invintory.com/about/) · [Press](https://invintory.com/press/) · [InVintory vs CellarTracker](https://invintory.com/cellartracker/) · [Blog: vs CellarTracker](https://invintory.com/blog/invintory-vs-cellartracker-which-app-fits-serious-collectors/) · [Blog: best wine apps 2026](https://invintory.com/blog/best-wine-apps-top-tools-for-collectors-compared/)

**Help centre** — [Home](https://help.invintory.com/en/) · [Welcome](https://help.invintory.com/en/articles/14301217-welcome-to-invintory) · [Navigating the home screen](https://help.invintory.com/en/articles/14301522-navigating-the-home-screen) · [Understanding your collection page](https://help.invintory.com/en/articles/14301769-understanding-your-collection-page) · [Understanding VinLocate](https://help.invintory.com/en/articles/9900232-understanding-vinlocate) · [Common VinLocate terms](https://help.invintory.com/en/articles/9945386-common-vinlocate-terms) · [Common VinLocate layouts](https://help.invintory.com/en/articles/16772757-understanding-common-vinlocate-layouts) · [Customise VinLocate slots](https://help.invintory.com/en/articles/9868589-how-to-customise-vinlocate-slots) · [Find a bottle in VinLocate](https://help.invintory.com/en/articles/16772721-how-to-find-a-bottle-in-vinlocate) · [Move bottles in VinLocate](https://help.invintory.com/en/articles/10826028-how-to-move-bottles-in-vinlocate) · [Change the coordinates](https://help.invintory.com/en/articles/10825958-how-to-change-the-coordinates-in-vinlocate) · [Row / column view](https://help.invintory.com/en/articles/10825872-how-to-switch-from-row-view-to-column-view-in-vinlocate) · [Create a cellar or fridge](https://help.invintory.com/en/articles/10824599-how-to-create-a-cellar-or-fridge) · [Create sections in a storage](https://help.invintory.com/en/articles/10824650-how-to-create-sections-in-a-storage) · [Create a VinLocate shelf for your fridge](https://help.invintory.com/en/articles/14290806-how-to-create-a-vinlocate-shelf-for-your-fridge) · [Ready-made fridge model](https://help.invintory.com/en/articles/16772027-how-to-build-a-fridge-from-a-ready-made-model) · [Reorganise without losing positions](https://help.invintory.com/en/articles/16772698-how-to-reorganise-a-storage-without-losing-bottle-positions) · [Organise a cellar from scratch](https://help.invintory.com/en/articles/10011588-how-to-organise-a-cellar-from-scratch) · [Meet Vincent](https://help.invintory.com/en/articles/14303285-meet-vincent-your-ai-wine-assistant) · [Collection analytics](https://help.invintory.com/en/articles/16581603-understanding-your-collection-analytics) · [Collaborator roles](https://help.invintory.com/en/articles/16609408-understanding-collaborator-roles-and-permissions) · [Print a restaurant-style wine list](https://help.invintory.com/en/articles/11117324-how-to-print-a-restaurant-style-wine-list) · [Understanding InVintory plans](https://help.invintory.com/en/articles/16596461-understanding-invintory-plans) · [Understanding the free plan](https://help.invintory.com/en/articles/16596463-understanding-the-free-plan) · [Plan limits](https://help.invintory.com/en/articles/16596464-understanding-your-plan-s-limits) · [Import from CellarTracker](https://help.invintory.com/en/articles/16591122-how-to-import-from-cellartracker) · [Import your collection](https://help.invintory.com/en/articles/16590058-how-to-import-your-collection) · [Add wines by scanning a label](https://help.invintory.com/en/articles/14301437-how-to-add-wines-by-scanning-a-label) · [Scan a restaurant wine list](https://help.invintory.com/en/articles/16596584-how-to-scan-a-restaurant-wine-list) · [Drink-window sources](https://help.invintory.com/en/articles/10280468-where-we-source-our-drink-window-data) · [CellarStickers](https://help.invintory.com/en/articles/12683698-how-to-use-cellarstickers) · [Connect a sensor](https://help.invintory.com/en/articles/9868552-how-to-connect-a-sensor) · [Name storages and sections well](https://help.invintory.com/en/articles/16596422-how-to-name-storages-and-sections-well)

**Stores** — [Apple App Store id1434754695](https://apps.apple.com/us/app/invintory-wine-cellar-manager/id1434754695) and its [ratings & reviews page](https://apps.apple.com/us/app/invintory-wine-cellar-manager/id1434754695?see-all=reviews) · [Google Play com.invintory.app](https://play.google.com/store/apps/details?id=com.invintory.app)

**Press and independent review** — [Wine Spectator](https://www.winespectator.com/pages/invintory) · [Glory Media founder interview](https://www.glory.media/invintory-founders-jeff-and-josh-daiter-merge-technology-and-wine/) · [WifiHifi (2021)](https://wifihifi.com/invintory-app-wine-cellar-fridge-organize/) · [Baker On Tech (2026)](https://bakerontech.com/invintory-a-clever-app-for-managing-your-wine/)

**Comparable set / community (secondary — [ESTIMATE]-grade sourcing)** — [WineBerserkers thread](https://www.wineberserkers.com/t/what-wine-inventory-app-do-you-use/173521) ([page 2](https://www.wineberserkers.com/t/what-wine-inventory-app-do-you-use/173521?page=2)) · [cellared.ai roundup](https://cellared.ai/blog/best-wine-cellar-apps-2026) — **vendor-authored**, discloses "I built Cellared" · [sommo.app roundup](https://sommo.app/blog/best-wine-cellar-apps-2026/) — **vendor-authored**; its comparison table contradicts InVintory's own store copy and should not be relied on · [Vineyard Wine Cellars](https://vineyardwinecellars.com/) (partner builder; the `/invintory/` path 404s)

**Terroir-side reference (local, grounding the adopt list)** — `supabase/migrations/0005_cellar_config.sql` · `supabase/migrations/0057_bins.sql` · `src/app/(app)/cellar/sections.ts` · `DESIGN.md`

---

## Run metadata

- Depth: **standard**. Sources fetched: 64 pages (67 crawl4ai attempts, 3 ERRs) plus 6 raw asset files. **Firecrawl calls: 0** — the local crawl4ai scraper succeeded on every URL that mattered (3 URLs ERRed and were not needed). Gemini discovery ERRed → the built-in WebSearch was used for discovery only; no search-engine prose is quoted as fact anywhere in this brief.
- Every `[PUBLISHED]` quote was byte-verified with `cite-check.sh` against the fetched page bytes.
- An adversarial verification pass judged 18 load-bearing claims against their quotes alone. It returned 13 `supported` and 5 `overreach`; all five were corrected in this brief before publication — the tier scope of the section-at-a-time 3D view, the removal of an unsupported "OCR" mechanism claim, the "note that has a date on it" qualifier on the CellarTracker public-review behaviour, the iPhone-or-iPad device scope on sensor bridging, and attributing the three vendor concessions specifically to InVintory's labelled App Store Developer Responses.
- Not attempted, by rule: any login, any account creation, any paid-tier screen, the billed Anthropic API, and any read of `~/.config/zs-api-keys.env`.

---

## 12. Logged-in walkthrough (web app) — 2026-09-02

Signed in to `app.invintory.com` through Devin's Google identity in his own Chrome session.
Devin's account is a **Viewer** on a friend's real collection (about 150 bottles across two
Eurocaves, two kitchen fridges and an off-site fridge), so the walkthrough was read-only by
permission as well as by intent: the app itself refused "Add wine" with "As a Viewer of this
collection, you don't have permission…". No bottle, note, chat or setting was touched, and
the collection's contents and values are not recorded here.

### 12.1 Information architecture, as shipped on the web

Top bar: a **collection selector** (the account can switch between its own empty collection
and the shared one), global "Search wine", dark/light toggle, Help, notifications, avatar.
Sidebar: **Quick Actions** (Add Bottle, Remove Bottle, Create Review) · Dashboard ·
Collection (`/collection/bottles`) · Purchases (`/collection/deliveries`) · Analytics ·
Activity · Past bottles · Explore · Reviews · **Vincent** (the AI sommelier) · Saved lists
(Wishlist) · Quick filters (Premium-gated, "Upgrade to premium to save a set of filters") ·
Tags · **Cellars & Fridges** (one row per storage with its bottle count). No 3D anywhere on
the web: the storage page is analytics + a section list, confirming §3.5's "VinLocate is
iOS-only". Two routes the brief guessed (`/collection`, `/purchases`) 404; the real ones are
above.

### 12.2 Dashboard

Header counts: bottles, labels, market value, purchase value, **slots open**. Actions: Add,
Remove, Review, Ask Vincent, "Hide values". Then: **Cellar and fridges** (a card per storage
with "N slots open" and a bottle count), **Ready to drink** (ready + expiring-soon bottles,
each card "N btl · Best through YYYY", linking to the collection pre-filtered by
`drink_window_status`), Saved lists, Recently removed, a right rail with Upcoming deliveries
and "Latest community reviews", and a Get Started checklist on an empty collection (Add
bottles · Import from CellarTracker · Import from Vivino · Upload a spreadsheet). The empty
collection also shows an iOS-app banner; Android is "in progress".

### 12.3 Collection table and the bottle panel

Filters: Wine Type · Storage · Tags · Drink Status · Filters; actions: Import, Add wine,
Change columns, Export CSV, **Print barcodes**, **Create Wine List**, Custom column. Twenty
sort orders (A–Z, added date, vintage, quantity, purchase/market price, **start year / end
year** of the window, critic score). Columns: name (with flag, region path, grape chip), size,
purchase price, market value, qty, **Window** (a status word — Ready to drink / Drink soon /
Hold / Past prime — over the year range), critic score with "View reviews", ABV, Body,
Sweetness, Acidity, Tannin, Photos (up to 5). Clicking a row opens a right-hand **bottle
panel**: name, region, grape, est. value, Add, **Wine guide**, bookmark, more; then per-bottle
rows with size, an internal id, added date and the **coordinate breadcrumb** `Storage › Shelf
N › R2, C8, D1`, plus **Locate all**. Locate opens a full-screen "Located Bottles" view for the
shelf with a search box over the located set. The coordinate model in §3.3 is exactly what
ships.

### 12.4 Storage page

`/storage/<id>`: name and kind (Fridge), Add Wine / Add photo / More; **Analytics** (slots
occupied "90 of 132", bottle count, labels, consumed, market and purchase value); **Cases**
("Create"); **Sections** — one card per shelf with a rendered thumbnail of the slot lattice,
"Bottle Slots 6/12", a fill bar and a **Type: Rack / Bin** badge (a Bin section shows
"0/0"); then Labels / Bottles tabs listing what the storage holds. Sections are the unit;
there is no whole-storage view on the web.

### 12.5 Explore and the wine page

Explore: tiles by Type, Countries, Regions, Food Pairing, with a Type · Grapes · Country ·
Region · Subregion · Pairing filter bar. A wine page has a tab strip that scrolls to sections:
**Vintage score** (a regional average labelled "Excellent" with the explicit caveat "A regional
average for this grape and vintage. An individual producer can sit well above or below it",
growing-season and "the wine" prose, "All Vintages"), **Grapes** (blurb), **Drink window** (a
green-to-red slider with the current position and a status line "Ready to drink — the wine
is at its peak"), **Pairings** (tiles), **Market price** ("We could not find a market value"
when absent), **Region** (blurb), **Producer**, **Reviews** (rating / value ★ / maturity
split, Loved-Liked-Disliked bars, per-review chips Off Dry · Acidity · Tannin · Body), and
"More from <producer>". Left column: vintage picker, bottle image, grape chip, name in an
italic display serif, Add, Ask Vincent, producer, region path, est. value, drinking window,
avg critic, review count.

### 12.6 Analytics, Activity, Purchases, Reviews

**Analytics**: Est. Market Value with the footnote "calculated using a combination of Wine
Searcher and InVintory community pricing. For prices that aren't available, we use an
algorithm to make our best estimation"; Activity (bottles added / consumed / spend, period
picker); Collection breakdowns as tappable rows (top countries, regions, cellars, wine types,
vintages, grapes, purchase-price bands) — every row is a filter into the collection, as §7 #9
described. **Activity**: a ledger (date, user, bottle, size, action) filterable by
collaborators, storage, event type, removal type, date range, wine type, tags. **Purchases**:
list with source filter, CSV export, Create. **Reviews**: Community / My Reviews, a
"Write a review" composer, and cards with rating, value, reaction, maturity and structure
chips.

### 12.7 Vincent (AI sommelier)

A chat with "New" and **Preferences** ("Tell Vincent about your wine preferences, what you
like, what you don't like" — one free-text field), a "Previous Chats" rail, and ten seeded
prompts that mix the collection with context ("Which aged Nebbiolo should I finally enjoy
from my collection", "Pair a bottle with a casual dinner tonight from my cellar", "Suggest a
crisp white that I can enjoy in this clear weather"). Not exercised, to avoid writing chat
history into a shared collection. Nothing in the UI suggests it can place or move bottles
(§7 #11 stands).

### 12.8 Import and add

Import modal: **Import to** (collection picker) and **Import from** Vivino · CellarTracker ·
spreadsheet ("using our provided csv template"). Add wine is the search-first flow. Both
were viewed, not used.

### 12.9 Design, first-hand

Near-black ground with warm dark-grey cards, a muted rose accent for the primary action,
gold for the wordmark and ratings, an italic display serif for wine names over a geometric
sans, dense but well-spaced tables, and rendered slot-lattice thumbnails for sections. It is
a considered dark UI — and it is theirs; the palette is exactly what `DESIGN.md` excludes.

### 12.10 What this changes in §7

- **Confirms** #1–#3 and #6 as shipped: the coordinate, the precision-level idea (Rack / Bin
  as a section *type*), Locate everywhere, and slots-open as a headline number.
- **Adds** (S): **status word over the window** in the collection table and a
  `drink_window_status` filter in the URL — the same six-state idea Vinous uses, here as a
  first-class column and deep link.
- **Adds** (S): the **regional vintage score with its own caveat** ("an individual producer
  can sit well above or below it") — the honesty pattern Terroir should reuse when a wine has
  no note but its region-vintage does.
- **Adds** (M): **collaborator roles that actually block writes in the UI** (Viewer), which
  is what Terroir's per-location scoping should feel like on the floor.
- **Downgrades** nothing; the web is faithful to the docs. The whole-room 3D and photo-to-rack
  proposal (§7.1) remains Terroir's opening, because on the web InVintory has no spatial
  view at all.
