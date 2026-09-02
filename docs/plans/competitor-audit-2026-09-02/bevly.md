# Bevly — competitor audit for the Terroir restaurant side

_Scope: public sources only, US market. Prepared 2026-09-02. Depth: deep-dive STANDARD._

**Premise correction up front.** The brief was commissioned on the view that Bevly is "the app that has won the operator market." The evidence does not support that. Bevly's public traction signals are small: the Android app shows "10+" downloads [PUBLISHED], the iOS app has 0 ratings [PUBLISHED], the LinkedIn page has 25 followers [PUBLISHED], and there is **no listing at all** on Capterra, G2, Software Advice, GetApp or TrustRadius, no YouTube demo, and no Reddit or forum discussion. A self-published slide claims "900+ Retailers on the Platform" but is watermarked © 2023 and marked internal-only. Treat Bevly as **a well-designed reference implementation of beverage-retail back-office workflow, not a market winner**. Copy its workflow logic; do not copy it because "it won."

Second correction: **bevly.co and bevlypos.com are the same WordPress site** (bevly.co's sitemap points at bevlypos.com URLs). There is no separate product-docs site. The vendor is Cobalt Payments Inc. of Rocky Hill, CT.

---

## TL;DR

Bevly is a beverage-retail back office — inventory, distributor invoices, purchase orders and reports — sold by a Connecticut payments ISO, positioned both as a Clover App Market add-on and (on a newer page) as a standalone POS licence at $259/mo [PUBLISHED]. Its genuinely valuable ideas for Terroir are four: (1) a **section-scoped, multi-counter stock audit** that runs during trading hours and reports counted-vs-expected variance; (2) a **receiving screen** that turns a distributor invoice into inventory in four steps with colour-coded exceptions — changed cost highlighted yellow, sub-target margin highlighted pink; (3) a **draft purchase order** that is pre-built from par levels and velocity and shows, per line, current stock + on-order + projected future inventory + recommended quantity, with a this-year-vs-last-year sales graph; and (4) a **"Run Reports" launcher rail** of one-click exception reports (Low/Out of Stock, Dead Products, Price below Bottle Cost, Products without <field>, Negative Margins, 30/60/90). Its **BarBack** module — scan-empties-to-decrement, waste/comps/partials logging, optional recipe depletion — is the one part built for restaurants and bars rather than shops, and is the closest analogue to Terroir's close-out. What should *not* transfer is the retail-store spine: state-minimum/MSRP price policing, shelf-label printing, eCommerce storefronts, loyalty, multi-store cloning, EDI distributor payment rails, and the whole "SKU velocity" model that treats every bottle as replenishable — a cellar's allocated Burgundy is not a case of Tito's.

---

## Confirmed vs. Inferred

| Confidence | What we know |
|---|---|
| **CONFIRMED [PUBLISHED]** | Feature copy on 27 bevlypos.com pages (byte-verified quotes); Google Play + Apple iTunes API metadata; the Bevly web-app dashboard IA read directly off product screenshots published on bevlypos.com; the `/build-your-own-pos/` price list; design tokens read out of the site's own stylesheet. |
| **REPORTED (secondary, vendor-asserted)** | Every functional description is vendor marketing copy or a vendor blog post. No independent review, analyst listing, demo video or customer account exists to corroborate that any of it ships as described. The adversarial verifier flagged `vendor_claim: yes` on all 18 tested claims. |
| **INFERRED / ESTIMATE** | Nothing. Stage 5 triangulation was not run — the gated facts (real customer count, actual audit UI) had fewer than 3 independent dated reports, so they are reported as "not publicly available" rather than estimated. |
| **CONFLICTS / STALE** | (a) **Product model conflict:** bevlypos.com positions Bevly as a Clover App Market app that adds features *to* Clover; `/build-your-own-pos/` sells a standalone "BevlyPOS License … Cloud POS … Unlimited stations" with its own non-Clover hardware. Both are live. Do not assert which is current. (b) **Pricing conflict:** the same page shows a $259/mo builder base price and separate $59/$79/$99 tier cards. (c) **Scale claim stale:** the "900+ retailers / 6300+ distributors / 42 states" slide is watermarked © 2023. (d) **Broken page:** `/purchase-order-ocr-capture/` has an OCR title but its body is the Automatic Discount App — **no source anywhere describes OCR of a photographed paper invoice**. |

**Two explicitly verified negatives**, both directly relevant to the commissioning brief:

- **Audits during trading hours with a live-sales offset: NOT DOCUMENTED.** Bevly says counts run "during normal operations" without closing, and that it "compares POS sales, inventory, and received orders." No source describes a mechanism that mathematically offsets sales ringing through *mid-count*. Their own blog tells stores to "Schedule after business hours" for the annual full count.
- **Invoice OCR: NOT DOCUMENTED.** Intake is digital only — distributor feeds (EDI/API/SFTP/Fintech) plus a CSV/PDF drag-and-drop fallback. Terroir's invoice-scan-to-typed-line-items is ahead of Bevly here, not behind.

---

## 1. Feature inventory

### 1a. Stock audit / shrink control

| Item | Value | Tag | Source | Date |
|---|---|---|---|---|
| Section-scoped counting | "No need to close your store. Run audits on specific aisles, shelves, or product categories during normal operations." | [PUBLISHED] | [Audits & Shrink Control](https://bevlypos.com/pos-solutions/audits-shrink-control/) | 2026-02-20 |
| Count sections (mobile) | "assign sections (aisle, shelf, back room, walk-in), and compare counted vs. expected to spot shrink" | [PUBLISHED] | [Google Play](https://play.google.com/store/apps/details?id=com.bevlyliquor.pos) | upd. 2026-08-07 |
| Multi-counter | "Multiple staff can count different areas simultaneously. Bevly combines those results automatically into one complete report." | [PUBLISHED] | Audits & Shrink Control | 2026-02-20 |
| Merge semantics | "Bevly merges all entries, removing duplicates and highlighting inconsistencies." | [PUBLISHED] | Audits & Shrink Control | 2026-02-20 |
| Variance basis | "Automatically compares POS sales, inventory, and received orders to pinpoint missing bottles or cases." | [PUBLISHED] | Audits & Shrink Control | 2026-02-20 |
| Audit log | "Every count, adjustment, and variance is logged for full transparency and compliance." | [PUBLISHED] | Audits & Shrink Control | 2026-02-20 |
| Shrink attribution | "See exactly where losses occur — by product, vendor, or employee." | [PUBLISHED] | Audits & Shrink Control | 2026-02-20 |
| Scanning input | "Use your phone camera or handheld device for instant counts." | [PUBLISHED] | [Bevly Mobile](https://bevlypos.com/pos-solutions/bevly-mobile/) | 2026-02-20 |
| Bar variant (BarBack) | "Scan empties at disposal (end of shift or mid-shift) to deduct the bottle from stock." | [PUBLISHED] | [BarBack Inventory](https://bevlypos.com/pos-solutions/barback-inventory/) | 2026-02-20 |
| Waste capture | "Log waste/spills, partials, comps, and returns for clean variance reporting." | [PUBLISHED] | BarBack Inventory | 2026-02-20 |
| Recipe depletion | "Optional recipes can deplete bottles for cocktails and flights." | [PUBLISHED] | BarBack Inventory | 2026-02-20 |
| Offline | "Keep scanning; syncs when connection returns." | [PUBLISHED] | BarBack Inventory | 2026-02-20 |
| Parallel bar sections | "let teams count in parallel—front bar, back bar, storage—then auto-merge" | [PUBLISHED] | BarBack Inventory | 2026-02-20 |
| Variance resolution UI | Not publicly documented — no source describes a per-line review/approve/commit step, thresholds, blind counts or recounts. | — | (gap) | — |

### 1b. Purchase orders and receiving

| Item | Value | Tag | Source | Date |
|---|---|---|---|---|
| Feature name | "Bevly's Draft Purchase Orders feature replaces guesswork with real data" | [PUBLISHED] | [Automatically Build and Review POs](https://bevlypos.com/2026/07/08/automatically-build-and-review-alcohol-purchase-orders/) | 2026-07-08 |
| Pre-built, not blank | POs are built "for you to review in a matter of seconds as products are identified for replenishment" | [PUBLISHED] | Automatically Build and Review POs | 2026-07-08 |
| Line trigger sources | Minimum-stock notifications; out-of-stock alerts; inventory reviews; sales trends; manual additions by staff | [PUBLISHED] | Automatically Build and Review POs | 2026-07-08 |
| Suggestion inputs | Par levels; current inventory; low-stock alerts; sales velocity; distributor information; product costs | [PUBLISHED] | [Inventory Management Guide](https://bevlypos.com/2026/08/12/liquor-store-inventory-management-a-complete-guide/) | 2026-08-12 |
| Per-line decision fields | "Current stock levels / Inventory on incoming invoices / Estimated future inventory / Recommended reorder quantities" | [PUBLISHED] | Automatically Build and Review POs | 2026-07-08 |
| Sales windows on line | Last 15 / 30 / 60 / 90 days | [PUBLISHED] | Automatically Build and Review POs | 2026-07-08 |
| Inline graph | "the sales graph displayed alongside each product" showing "month-by-month sales performance for both the current year and the previous year" | [PUBLISHED] | Automatically Build and Review POs | 2026-07-08 |
| Double-order guard | "displaying inventory that is currently on open purchase orders and invoices" | [PUBLISHED] | Automatically Build and Review POs | 2026-07-08 |
| Transmission | POs "can be emailed to the sales representative or distributor with just a few clicks" | [PUBLISHED] | Automatically Build and Review POs | 2026-07-08 |
| Receiving flow | "1. Open the invoice. 2. Verify quantities received. 3. Review highlighted exceptions. 4. Click Complete Order." | [PUBLISHED] | [Value in Automated Invoice Receiving](https://bevlypos.com/2026/07/06/the-value-found-in-automated-invoice-receiving/) | 2026-07-06 |
| Pre-filled invoice fields | Product names & UPCs; case quantities; case costs; bottle costs; retail prices; current inventory levels; margin calculations; historical purchase information | [PUBLISHED] | Value in Automated Invoice Receiving | 2026-07-06 |
| Cost-change exception | "Bevly immediately highlights the previous cost in yellow" (worked example: bottle "$13.49" → "$14.00") | [PUBLISHED] | Value in Automated Invoice Receiving | 2026-07-06 |
| Margin exception | "If a product falls below your desired margin range, the margin field is highlighted in pink." | [PUBLISHED] | Value in Automated Invoice Receiving | 2026-07-06 |
| Margin targets | "compares them against the margin targets you've established for each category" | [PUBLISHED] | Value in Automated Invoice Receiving | 2026-07-06 |
| Line matching | "Bevly validates each product ID, UPC, and quantity to prevent duplicate or missing entries." | [PUBLISHED] | [Receive Invoices via Fintech](https://bevlypos.com/pos-solutions/receive-invoices-direct-from-distributors-with-fintech/) | 2026-02-20 |
| Mismatch detection | "flags wrong quantities, new product IDs, or unexpected fees" | [PUBLISHED] | [Digital Purchase Orders](https://bevlypos.com/pos-solutions/digital-purchase-orders/) | 2026-02-20 |
| Manual fallback | "drag-and-drop CSV/PDF from any supplier and Bevly maps it" | [PUBLISHED] | Digital Purchase Orders | 2026-02-20 |
| Landed cost | "Automatically calculates accurate landed costs, including fees, deposits, and discounts." | [PUBLISHED] | Receive Invoices via Fintech | 2026-02-20 |
| Approval controls | "Assign roles and approvals to maintain order control across your team." | [PUBLISHED] | [PO Management](https://bevlypos.com/pos-solutions/pos-purchase-order-management/) | 2026-02-20 |

### 1c. Reports

| Report | What it shows | Tag | Source |
|---|---|---|---|
| Sell-through, weeks-on-hand, top movers/laggards, margin impact of discounts | Named as a group in the app-store copy: "View sell-through, weeks-on-hand, top movers/laggards, and margin impact of discounts." No column list published. | [PUBLISHED] | [Google Play](https://play.google.com/store/apps/details?id=com.bevlyliquor.pos) |
| Dead Products Report | Zero units sold in a selected period, default lookback 12 months. Columns: product names & UPCs, current stock quantities, last sold dates, units sold over multiple years, product categories, cost and retail pricing. Actionable in place: filter by distributor/size/category, export to Excel, add to PO, edit, remove from inventory. | [PUBLISHED] | [Dead Products Report](https://bevlypos.com/2026/06/22/liquor-store-dead-products-report/) |
| Wholesale vs Retail Value vs Sales | Three monthly series — wholesale value ("what you've paid distributors for the inventory currently on your shelves"), retail value ("what that same inventory is worth at your current shelf prices"), sales ("what actually sold during a given month"). Diagnostic: wholesale rising while sales flat = inventory bloat. | [PUBLISHED] | [Wholesale and Retail Value vs Sales](https://bevlypos.com/2026/04/09/wholesale-and-retail-value-vs-sales-liquor-store-reporting/) |
| Missing-information report | Products missing Category, Distributor, Units Per Case, Product Size, Brand/Product Line, Vendor information. | [PUBLISHED] | [Organizing Your Liquor Store Inventory](https://bevlypos.com/2026/08/06/organizing-your-liquor-store-inventory/) |
| Peak Sales Time Report | "Hourly & Daily Sales Breakdown", "Predictive Trend Analysis … based on historical data and seasonal buying patterns", graphs and colour-coded dashboards. | [PUBLISHED] | [Peak Sales Time Report](https://bevlypos.com/pos-solutions/peak-sales-time-report/) |
| Run Reports rail (from screenshot) | One-click launchers: Low/Out of Stock · Dead Products · Price below Bottle Cost · Products without \<field dropdown\> · Products with Negative Margins · 30/60/90 · Label Printing Queue | [PUBLISHED] | Product screenshot on [Audits & Shrink Control](https://bevlypos.com/pos-solutions/audits-shrink-control/) |
| Dashboard tables (from screenshot) | "Top Selling Products / Top 15" (Products, Gross Sales, Units Sold); "KPI / Top 10 Categories" (Category, Gross Sales, Margin); "Product Stock Levels / Top 15" (Products, Stock, Units Sold, **Rec'd Buy**); "Top 20 Sold Products W/ Negative Margin" (Products, Stock, Retail Price, Margin) | [PUBLISHED] | Product screenshots, bevlypos.com/wp-content/uploads/2025/11/ |

### 1d. Staff, roles and logging

| Item | Value | Tag | Source |
|---|---|---|---|
| Role-scoped mobile | "Give your team mobile dashboards with limited visibility — they can do their work without accessing sensitive data." | [PUBLISHED] | [Bevly Mobile](https://bevlypos.com/pos-solutions/bevly-mobile/) |
| Role-scoped dashboards | "Limit visibility to orders, counts, or audits only." | [PUBLISHED] | Bevly Mobile |
| Override audit trail | "Manager override with PIN + reason codes and full audit trail." | [PUBLISHED] | [Clover Improvements by Bevly](https://bevlypos.com/pos-solutions/clover-improvements-from-bevly-version-1/) |
| Exception reporting | "who discounted what, when, and the margin impact avoided" | [PUBLISHED] | Clover Improvements by Bevly |
| Shrink by employee | "See exactly where losses occur — by product, vendor, or employee." | [PUBLISHED] | Audits & Shrink Control |

### 1e. POS integration and mobile

| Item | Value | Tag | Source |
|---|---|---|---|
| POS platform | Clover. "Bi-directional sync ensures your POS and Bevly share the same product data, pricing, and inventory updates instantly — whether you're using Clover Flex, Station, or Mini." | [PUBLISHED] | [Integration Suite](https://bevlypos.com/pos-solutions/bevly-integration-suite/) |
| Clover App Market | Listed as app `EX83YHBS68GPE`; listing page is a JS SPA and could not be rendered by any permitted tool — pricing/permissions there **not publicly obtained**. | [PUBLISHED] (link only) | Footer link on [bevlypos.com](https://bevlypos.com) |
| Trademark distance | "Clover® is a registered trademark of Clover Network, Inc. Bevly is not affiliated with or endorsed by Clover Network, Inc." | [PUBLISHED] | Apple App Store listing (iTunes API, id 6755444422) |
| Accounting | "export to QuickBooks/Xero with audit trails" | [PUBLISHED] | [Digital Invoicing](https://bevlypos.com/pos-solutions/digital-invoicing/) |
| Android app | BevlyPOS, Cobalt Payments Inc, category Productivity, "10+" downloads, updated Aug 7 2026, "What's new: Bug fixed", data safety "No data collected" | [PUBLISHED] | [Google Play](https://play.google.com/store/apps/details?id=com.bevlyliquor.pos) |
| iOS app | BevlyPOS id 6755444422, released 2026-03-11, version 1.13 (2026-07-24), Free, averageUserRating 0, userRatingCount 0, genres Business/Utilities | [PUBLISHED] | iTunes lookup API (public) |
| Sibling apps | "Liquor Store Near Me - LSNM" (consumer marketplace, CT-only); "Cxbolt Payment App" — both COBALT PAYMENTS INC. | [PUBLISHED] | iTunes search API |

---

## 2. Information architecture and navigation

### Web app (read directly off published product screenshots)

**Chrome:** logo "Bevly™ / CobaltConnect" top-left; a single global "Search…" field spanning the top bar; four badged icons top-right (cart 10, calendar, layers, bell 3). Left sidebar, white, active item shown as a pale-lavender pill with blue label. Footer of sidebar carries a circular user avatar. Version and "© Bevly" in the page footer.

**Primary sidebar, in order:** Dashboard · Products ▾ · Purchase Orders ▾ · Beverage Journal · eCommerce ▾ · Reporting ▾ · QuickBooks ▾ · Manage Attributes ▾ · Multi-Location ▾ · Wholesale ▾ · Community ▾ · Settings.

Three things to notice about that list. **"Manage Attributes" is a first-class top-level section** — data hygiene is treated as a daily job, not a settings sub-page. **"Beverage Journal"** is a top-level item (the beverage-trade price book), i.e. an external catalogue source sits in the main nav. **"QuickBooks" is its own section**, not buried under integrations.

**Purchase Orders sub-nav** (legible but low-resolution; the middle three labels are best-effort): PO Dashboard · Draft Orders · Purchase Order · Import PO (Old) · Import PO (New) · Detailed/Emailed POs · PO History · Accounts Payable. [PUBLISHED, low-confidence on three labels]

**Dashboard layout** — a three-band page:
1. *Sales Reporting* — four KPI tiles: Sales Volume MTD $50,862 [PUBLISHED, demo data] with prior value $63,309 and a red ↓19.66% delta; # Orders MTD 2821; # Unit Sold MTD 8420; COGS MTD $43,530. Every tile is **current value, prior value, signed delta** — three numbers, not one.
2. *Sales Month Over Month* bar chart + "Top Selling Products / Top 15" table + "KPI / Top 10 Categories" table (Liquor, Wine, Beer, Tobacco, Imported Wine, Non-alc, Uncategorized — with Beer showing a **−16.1%** margin, i.e. the dashboard is designed to show you a losing category).
3. *Purchase Order Reporting* — 26 Purchase Order Completed (MTD); 21 Incomplete Purchase Orders; $11,895.12 Total Credit/Refunds; $0.00 Total Outstanding Invoices (TBD). Below: Total Purchase Order, Upcoming EFTs / Top deliveries, Outstanding Balance (Distributor · Amount · Credits · Net).

**Right rail, two stacked cards.** "Notifications, Alerts & Updates" is a timestamped exception feed with a coloured severity dot per row and a **count in parentheses**: "Products w/o Distributor - (268)", "# of Incomplete POs – (24)", "Products w/o Tax – (22)", "Product w/ Negative Margins - (226)". Below it, "Run Reports" — a stack of one-click report launchers each ending in a → chevron, one of which carries an **inline dropdown parameter** ("Products without [Bottle Cost ▾]"). This right rail is the single strongest IA idea on the page: the dashboard does not just report, it tells you how many records are *broken* and gives you a one-tap route to the list.

### Mobile app

No published screen inventory. Copy establishes only the shape: role-scoped dashboards ("Limit visibility to orders, counts, or audits only"), barcode scanning via phone camera or handheld, section-assigned counts, quick approvals ("Review and approve invoices, orders, or pricing updates from your phone"), and offline-tolerant scanning in the BarBack variant. Twelve screenshots exist on the Play listing but are images only; their content was not transcribed. **Named mobile screens: not publicly available.**

---

## 3. The audit / count flow, step by step

Reconstructed from the Audits page, the mobile page, BarBack, and the Play listing. Every step is vendor-asserted.

1. **Start an audit at any time.** "No store shutdowns. Select an area or product category to begin." The scope is chosen up front and is either physical (aisle, shelf, back room, walk-in; front bar, back bar, storage) or logical (product category).
2. **Assign audit zones.** "Team members scan and count simultaneously using mobile or tablet access." Counting is a multi-person, multi-device activity by design — the section is the unit of assignment and the guarantee against double-counting.
3. **Count by scanning.** Phone camera or handheld scanner; "QR/UPC scanning is faster to teach and harder to misuse." In BarBack the scan target is the *empty bottle at disposal*, not the full bottle on the shelf — the count event is a depletion event.
4. **Merge.** "Bevly merges all entries, removing duplicates and highlighting inconsistencies." Merge is automatic and happens "in real time with no overlap or double-counting."
5. **Variance is computed against three sources, not one.** "Automatically compares POS sales, inventory, and received orders" — i.e. expected = last known on-hand − POS depletions + received quantities. Counted-vs-expected is then surfaced per the app copy: "compare counted vs. expected to spot shrink."
6. **Review shrinkage reports.** Sliced "by product, vendor, or employee." Separately, "Bevly flags low-margin products, disappearing SKUs, or sudden stock drops."
7. **Everything is logged.** "Every count, adjustment, and variance is logged for full transparency and compliance."

**What is conspicuously missing from the public record** — and therefore where you should design rather than copy: there is no published description of the *resolution* step. No variance threshold, no per-line accept/investigate/recount action, no reason codes on an adjustment, no "post the count" commit, no blind-count option, no partial-audit expiry, and — most importantly for a trading-hours count — **no described offset for sales that ring during the count**. Bevly's own blog contradicts the marketing here, advising stores to "Schedule after business hours" and "Use count teams" for the annual full count. Terroir should assume the trading-hours claim is a positioning statement, not a solved problem, and solve it explicitly.

---

## 4. Receiving: how an invoice becomes inventory

1. **Intake.** Three channels, in preference order: direct distributor feeds ("EDI/API/SFTP/email-to-EDI") and Fintech; then a raw-file fallback, "drag-and-drop CSV/PDF from any supplier and Bevly maps it"; then manual. Nothing describes OCR of a photograph. New invoices "appear in your queue, ready to review and post."
2. **The receiving screen is pre-filled.** "When distributors send invoices electronically, Bevly automatically imports the information directly into the receiving screen," carrying product names & UPCs, case quantities, case costs, bottle costs, retail prices, current inventory levels, margin calculations and historical purchase information. The receiver's job is verification, not data entry.
3. **Matching.** "Bevly validates each product ID, UPC, and quantity to prevent duplicate or missing entries", handling "case/bottle splits, multi-pack sizes, taxes/fees, deposits, and surcharges."
4. **Exceptions are colour-coded on the line, not on a separate report.** Changed cost → previous cost highlighted **yellow**. Margin below the category target → margin field highlighted **pink**. Mismatch detection additionally "flags wrong quantities, new product IDs, or unexpected fees."
5. **Reconcile to the PO.** "Bevly cross-checks Fintech invoices against purchase orders to flag discrepancies", and "Link each invoice to its purchase order and verify totals automatically."
6. **Commit.** "Click Complete Order." Receiving is what writes inventory: "Receiving the order can then update inventory information instead of requiring employees to re-enter everything manually." "Receiving updates on-hand instantly; credits and returns are tracked."
7. **Downstream.** Case/bottle costs, taxes and deposits update, driving margin alerts and price guidance; "One-click post: approve and push updates to inventory and purchase orders instantly"; approved invoices route to ACH/EFT payment; summarised detail exports to QuickBooks/Xero.

The claimed effect: receiving drops from "20–45" minutes to "2–3" minutes per invoice [PUBLISHED, vendor claim, 2026-07-06].

---

## 5. Design language

Read out of the live stylesheet (`bevlypos.com/wp-content/litespeed/css/733c…css`) and the published product screenshots.

**Marketing site.** WordPress 7.1 + Avada/Fusion Builder + LiteSpeed cache. Type is **DM Sans** throughout (fallback Arial, Helvetica, sans-serif) with a five-step scale: H1 3.5em / weight 500 / letter-spacing −0.045em / line-height 1.12 / capitalize; H2 2.25em / 500; H3 1.25em / 500 / −0.01em; body 1em / 400 / line-height 1.6; small 0.95em / 500. Palette: `#ffffff` white, `#f4f4f6` off-white ground, `#cecece` hairline, **`#292b77` navy (primary/brand)**, **`#f86011` orange (CTA/accent)**, `#777777` muted text, `#0064fe` link blue, `#000000`. Tight negative letter-spacing on display type plus capitalize is doing most of the "modern SaaS" work. [PUBLISHED]

**Product UI** is a different, cooler register from the marketing site: white page, near-white card ground, 1px light-grey borders, generously rounded cards, heavy whitespace, no shadows to speak of. Data type is small and dense; numbers are the loudest thing on the page. Colour is used **only for meaning**: bright blue (`#0064fe`-family) for chart bars, links and the active nav pill; **pink/magenta for negative deltas, for the sub-target margin field, and for the EFT date chip**; yellow for a changed cost; red/amber dots for alert severity. There is no decorative colour anywhere in the dashboard. The Bevly wordmark is navy with a "CobaltConnect" descender lockup.

The transferable lesson is not the palette — Terroir owns its own identity and must not borrow this one — it is the **discipline**: a neutral ground, one accent for interaction, and a reserved semantic colour that appears *only* when a number is wrong. That is why a Bevly dashboard reads as an operations tool and not a marketing page.

Marketing-site caveat worth noting: the site has visible content-management rot — a Toast contract clause pasted into Bevly's pricing block, a "Purchase Order OCR Capture" page whose body is about discounts, dozens of nav links pointing at `bevly.co/features/importing-purchase-orders/`, and `<title>` tags mismatched to their pages. Do not treat the marketing site as evidence of engineering quality in either direction.

---

## 6. Architecture, commercial and data facts

| Item | Value | Tag | Source |
|---|---|---|---|
| Vendor | Cobalt Payments Inc., "a registered ISO of Wells Fargo Bank, N.A., Concord, CA" | [PUBLISHED] | bevlypos.com footer |
| Address | 2264 Silas Deane Hwy Ste 105, Rocky Hill, CT 06067-2366 | [PUBLISHED] | Google Play developer block |
| Company page | "Bevly", Software Development, Rocky Hill CT, "Founded 2016", "11-50 employees", Privately Held, 25 followers, 3 employees listed | [PUBLISHED] | [LinkedIn](https://www.linkedin.com/company/bevlyapp) |
| Prior name | Search-result title for the Clover listing reads "Bevly Formerly CobaltConnect"; the web app logo still reads "Bevly™ / CobaltConnect" | [PUBLISHED] | Clover App Market SERP + product screenshot |
| POS platform | Clover (Flex, Station, Mini, Go); Clover App Market app `EX83YHBS68GPE` | [PUBLISHED] | Integration Suite; site footer |
| Conflicting model | "BevlyPOS License · Cloud POS · Inventory · Loyalty · Time Clock · Reporting · 24/7 Support · Unlimited stations — $259 / mo" with own hardware and "Lifetime Warranty" | [PUBLISHED] | [Build Your Own POS](https://bevlypos.com/build-your-own-pos/) |
| Software add-ons | Sell Online with StoreFronts $99 / mo [PUBLISHED]; Auto Invoicing $40 / mo [PUBLISHED]; Automatic Label Printing $19 / mo [PUBLISHED]; Multi-Location Manager $29 / mo per location [PUBLISHED]; Inventory Import Service and Standard Employee Time-Clock App included | [PUBLISHED] | Build Your Own POS |
| Conflicting tier cards | Starter $59 /mo [PUBLISHED]; Growth $79 /mo [PUBLISHED]; Premium $99 /mo [PUBLISHED] — on the same page as the $259/mo builder; **irreconcilable from public sources** | [PUBLISHED] | Build Your Own POS |
| Hardware | Complete POS Station Bundle w/ Customer Facing Display $1,999 per station [PUBLISHED]; POS Bundle without Customer Display $1,599 per station [PUBLISHED]; Mobile 4G Handheld POS $899 each [PUBLISHED]; Wireless Barcode Scanner $149 each [PUBLISHED]; Age Verification Scanner $249 each [PUBLISHED]; Brother 810W wireless label printer $129 each [PUBLISHED]; Surveillance Camera $399 each [PUBLISHED] | [PUBLISHED] | Build Your Own POS |
| Payment processing | Card-present 2.49% + 10 cents per transaction [PUBLISHED]; card-not-present 3.49% + 15 cents [PUBLISHED]; eCommerce 2.89% + 20 cents [PUBLISHED]; ACH 1% min $1 [PUBLISHED]; custom pricing above $125,000 annual volume [PUBLISHED] | [PUBLISHED] | [Cobalt pricing](https://bevlypos.com/cobalt-pricing/) |
| Commitment discounts | Dual Pricing unlocks 50% off hardware; 2-year 10% / 3-year 15% / 5-year 30% off licence; Auto Invoicing 10% rebate on the whole monthly subscription | [PUBLISHED] | Build Your Own POS |
| Sales motion | Demo-led via Calendly (`calendly.com/bevly-sales/…`); no self-serve signup; "3-month guided onboarding, weekly check-ins" | [PUBLISHED] | Digital Invoicing; blog CTAs |
| Onboarding target | "Achieve 85–90% product matching and full operations within your first quarter." | [PUBLISHED] | [Bevly Setup](https://bevlypos.com/pos-solutions/bevly-setup/) |
| Integration channels | Fintech; "EDI/API/SFTP/email-to-EDI"; QuickBooks/Xero export; eCommerce; label printers | [PUBLISHED] | Distributor Network; Integration Suite |
| Distributor scale | "6300+ Distributor Partner Integrations"; "900+ Retailers on the Platform"; "42 Active states" — from a slide watermarked "© 2023 Bevly, Inc." and "CONFIDENTIAL – LIMITED [INTERNAL ONLY]", published on bevlypos.com. **Stale and self-reported.** | [PUBLISHED] | Screenshot on [Distributor Network](https://bevlypos.com/pos-solutions/distributor-network/) |
| ROI claims | "save an average of $13,000+ per year" [PUBLISHED]; "60–90 hours of manual work per month" and "10% or more" profitability [PUBLISHED]; "~$1,200/year" processing savings [PUBLISHED]; "$23.90/hr" assumed beverage-retail wage [PUBLISHED] — all vendor-modelled, none independently verified | [PUBLISHED] | Homepage; Inventory Management Guide; Time Savings Calculator |
| Product data model (published fields) | Category, Distributor, Brand, Product Line, Size, Department, Package Type, Units Per Case, Tax status, Deposits, Pricing settings, case cost, bottle cost, quantity per case, distributor & vendor product IDs, UPC; searchable by "SKU, UPC, case/bottle, vintage, size, or category" | [PUBLISHED] | Organizing Your Liquor Store Inventory; Retail Inventory Manager; Google Play |
| Not in the data model | No published bin/aisle/shelf **location field on the product record** (sections exist on the audit, not on the item); no ABV, varietal, region, producer or appellation; no parent/child category hierarchy | — | (gap) |
| Tech stack | Not publicly obtained — no job posts, engineering blog, GitHub presence or SDK documentation found. Android package `com.bevlyliquor.pos`; iOS bundle id identical. | — | (gap) |

---

## 7. Adopt for Terroir — ranked

Mapped against Terroir's real surface (routes `cellar`, `cellar/reconcile`, `cellar/open`, `bins`, `scan`, `scan-bottle`, `insights`, `lists`, `team`, `price-comparison`, `reconcile-queue`; tables `inventory_items`, `bins`, `stock_adjustments`, `reconcile_batches`, `reconcile_actions`, `bottle_closeouts`, `open_bottles`, `pour_events`, `cellar_health`, `invoice_scans`, `pricing_recommendations`, `reason_codes`).

| # | Adopt | Maps onto | What to copy | What to do better | Size |
|---|---|---|---|---|---|
| 1 | **Section-scoped, multi-counter count session with counted-vs-expected variance** | `cellar/reconcile`, `reconcile_batches`, `reconcile_actions`, `bins` | Scope chosen *before* counting; the section as the unit of assignment and the anti-double-count guarantee; parallel counters auto-merged; every count, adjustment and variance logged. Terroir already has bins — make the bin the audit section. | Bevly stops at "highlights inconsistencies." Terroir should ship the half Bevly never documented: a variance review screen with per-line accept / recount / investigate, a **reason code on every adjustment** (`reason_codes` already exists), a named committer, and an explicit post step. And solve the trading-hours problem honestly: freeze an expected-at-timestamp snapshot per section and replay `availability_events` / POS depletions recorded *after* that timestamp back into the expected figure, so a bottle sold mid-count is not shrink. That is the feature Bevly claims and does not describe. | **L** |
| 2 | **Receiving screen with inline colour-coded exceptions** | `scan` (invoice scan), `invoice_scans`, `import` | The four-step spine — open, verify quantities, review highlighted exceptions, commit — and above all **exceptions on the line, in the field, in colour**: previous cost highlighted when the cost changed; margin field highlighted when it falls below the category target. This is the single best interaction idea Bevly has. | Terroir's invoice OCR is genuinely ahead — Bevly has no OCR path at all. So put Terroir's typed line items straight into a Bevly-style verify screen instead of a review list: cost delta vs last-paid, margin vs the list price, and an unmatched-line resolution UI (match to existing wine / create new / defer) that Bevly never publishes. Commit writes `inventory_items` + `stock_adjustments`. | **M** |
| 3 | **Exception-count alert rail on the dashboard** | `insights`, `cellar_health` | The right-rail pattern: a severity dot, a plain-language defect name, and **a count in parentheses** — "Products w/o Distributor (268)", "Product w/ Negative Margins (226)". Cellar health stops being a score and becomes a worklist. | Terroir's version: bottles without a bin (**), wines without a vintage, open bottles past their window, list items no longer in stock, invoice lines never reconciled, wines priced below cost. Each row deep-links to the filtered list. Bevly shows the count; Terroir should also show the trend on that count. | **S** |
| 4 | **"Run Reports" launcher rail with an inline parameter** | `insights` | A stack of named, one-tap exception reports rather than a report builder — Low/Out of Stock, Dead Products, Price below Bottle Cost, Products without \<field ▾\>, Negative Margins, 30/60/90. The inline dropdown inside a report row ("Products without [Bottle Cost ▾]") is a lovely, cheap piece of UI. | Restaurant-native equivalents: Wines with no bin, Bottles open >N days, Vintages sold out on the list, Wines below target GP%, Slow movers 30/60/90, Verticals with a gap. Keep the naming plain-English; Bevly's report names are its best copywriting. | **S** |
| 5 | **Draft PO / suggested order pre-built from velocity, pars and on-order** | *new* — Terroir has no PO/vendor model | The per-line decision set: current stock · on incoming invoices · **estimated future inventory** · recommended quantity, with 15/30/60/90-day sales columns and a this-year-vs-last-year graph beside each line. The on-order figure preventing double-ordering is the detail most systems miss. | For a wine programme, "recommended quantity" must not be velocity alone. Weight by list placement (is it a BTG pour or a cellar hold?), vintage availability, allocation, and the sommelier's intent — a wine can be a top mover and still be un-reorderable. Make the suggestion advisory and always explain its basis. Start with a **restock suggestion list**, not a full PO/vendor module. | **L** |
| 6 | **BarBack close-out: scan-empties-to-decrement, with waste/partials/comps logged** | `cellar/open`, `open_bottles`, `bottle_closeouts`, `pour_events` | The inversion — the count event is a *depletion* event at the point of disposal, not a shelf census; "no weighing or pour-size calculators needed"; waste, spills, partials, comps and returns each logged separately for clean variance; offline-tolerant scanning that syncs later. | Terroir already models partial bottles and pour events, which BarBack does not. Add the disposal-scan as a second, faster close-out path for BTG bottles that finish, and adopt the offline-first scanning posture — a cellar is the worst wifi in the building. Separate waste from comp from breakage in `stock_adjustments` reason codes so variance is explainable. | **M** |
| 7 | **Cost-and-margin exception model with per-category targets** | `pricing_recommendations`, `price-comparison` | Storing a **margin target per category** and checking every received line against it, so a bad buy is caught at receiving rather than at month end; plus "Price below Bottle Cost" and "Negative Margins" as standing reports. | Restaurants think in multiples and GP%, by list section, not one blanket margin. Set targets per wine-list section (BTG, by-bottle, reserve) and flag at receiving *and* at list-pricing time. Terroir's `price-comparison` gives it something Bevly lacks — an external market reference — so flag "below cost" **and** "mispriced against market." | **M** |
| 8 | **"Manage Attributes" as a first-class section + bulk edit + missing-information report** | `catalogue`, `atlas`, `import` | Elevating data hygiene to top-level navigation; a report of records missing required attributes; and bulk edit across a filtered set — their case study is a Connecticut $0.10 tax [PUBLISHED] applied to every 50ml bottle in "approximately 20 seconds". | Terroir's equivalent defects are richer and matter more: missing vintage, missing producer, unlinked to LWIN/X-Wines, no bin assigned, no bottle image. Terroir already has `wine_aliases` and the LWIN/X-Wines links — surface the unresolved ones as a worklist and allow bulk resolve. | **M** |
| 9 | Wholesale vs retail value vs sales, as three monthly series | `insights`, `cellar_health` | The diagnostic framing: cost value of stock on hand, retail value of the same stock, and what actually sold — bloat is wholesale rising while sales stay flat. | For a cellar, add a third dimension Bevly cannot: **maturity**. Value tied up in wine that is not yet drinking is not the same problem as value tied up in wine that is past it. | **S** |
| 10 | Role-scoped mobile dashboards ("orders, counts, or audits only") | `team`, `memberships` | Give a runner a phone view that is *only* the count they are assigned, with no cost or margin visible. Reduces training and protects commercially sensitive data. | Terroir already has memberships — extend to a per-session scope so an audit assignment, not a global role, decides what the counter sees. | **S** |
| 11 | Three-number KPI tiles (value, prior value, signed delta) | `insights` | Never show a single number. Every tile carries its comparison period and a coloured delta. | Trivial to adopt, disproportionately improves how the dashboard reads. | **S** |
| 12 | Manager override with PIN + reason code + audit trail | `stock_adjustments`, `reason_codes`, `team` | Any write that moves value — a variance write-off, a comp, a price override — needs an authoriser, a reason and a trail. | Terroir has `reason_codes` already; wire the authoriser identity and make the trail queryable per staff member. | **S** |

---

## 8. What NOT to copy

Bevly is retail-liquor-store-first. Most of its surface area is answering questions a restaurant wine programme does not ask.

- **State Minimum / MSRP enforcement at the register.** Real, well-built, and irrelevant: it exists because liquor retailers can lose a licence for selling below a state floor. A restaurant sets its own list prices. Copying this imports a compliance engine you do not need.
- **Automatic shelf-label printing and the Label Printing Queue.** A shop reprices a shelf edge; a restaurant reprints a wine list. Terroir's branded wine lists already occupy this slot and are a better fit.
- **eCommerce storefronts, "Liquor Store Near Me" retailer profiles, delivery/pickup, loyalty and gift cards.** Entirely consumer-retail. Terroir's audience is the floor team and the buyer.
- **The velocity/par/reorder-point model applied to everything.** This is the deepest mismatch. Bevly's whole inventory logic assumes a SKU is infinitely replenishable at a stable case cost, so the only question is *when* to reorder. A wine list is full of allocations, single vintages, closing verticals and one-off parcels where re-ordering is impossible and "dead stock" may simply be wine that is not ready. Import the *mechanics* (on-order visibility, 15/30/60/90 windows) but not the *assumption*.
- **"Dead Products" as a delete-and-move-on action.** Bevly's report lets you "Remove inactive items from inventory." In a cellar, twelve months without a sale can be correct behaviour. Reframe as "slow / at-risk / mature" with a maturity input, never as a deletion prompt.
- **Multi-store inventory cloning and UPC-based product matching across locations.** Cloning a catalogue between shops works because two liquor stores can stock the identical SKU. Two restaurants' cellars are deliberately different, and wine identity is vintage- and parcel-specific — UPC matching is exactly the wrong key. Terroir's LWIN / X-Wines / canonical-wine lineage model is the right one; do not regress to barcodes as the identity spine.
- **Distributor EDI, ACH/EFT payment rails and Accounts Payable.** Bevly's real moat is a payments business — it is an ISO, and the invoice pipeline exists partly to route payments it earns on. Terroir has no such incentive; building AP would be a large, low-value detour. Take invoice *ingestion* and *reconciliation*; leave *payment*.
- **Case/bottle deposit, bottle-return and empties-deposit handling.** Bottle-deposit accounting is a retail-compliance concern, not a restaurant one.
- **The Register Item Counter and receipt-level features.** These solve shrink at a scan-heavy checkout lane. A restaurant does not have one.
- **The marketing site's design language, wholesale.** Per the client-owned-identity rule, Terroir's palette and type come from Terroir's own `DESIGN.md`, not from Bevly's navy-and-orange Avada theme. Adopt the *product* UI's restraint — neutral ground, one interaction accent, colour reserved for wrong numbers — not the tokens.
- **The vendor's ROI arithmetic.** "$13,000+ per year", "60–90 hours per month", "10% or more profitability" are self-modelled and uncorroborated. Do not carry them into Terroir's own positioning.

---

## 9. Gaps — not publicly available

- The Clover App Market listing (`EX83YHBS68GPE`) is a client-side-rendered SPA; crawl4ai, WebFetch, raw curl and a Wayback snapshot all returned only the app shell. **Clover-side pricing, permissions, required devices and reviews were not obtained.**
- **No screenshot or video of the audit/count screen itself.** Everything in §3 is reconstructed from prose. The variance-resolution UI is entirely undocumented.
- **No mobile screen inventory.** Twelve Play Store screenshots exist as images; their contents were not transcribed.
- **No independent evidence of any kind** — no Capterra/G2/Software Advice/GetApp/TrustRadius listing, no YouTube demo, no Reddit or forum thread, no press coverage, no named customer beyond one testimonial ("Joe, Windsor Court Wine & Spirits, CT").
- **No tech-stack evidence** — no job posts, engineering blog, GitHub or public API/SDK docs.
- **Real customer count unknown.** The only figure is a © 2023 internal slide.
- Three Purchase Orders sub-nav labels are low-confidence reads from a low-resolution mockup.

## 10. How to verify the private numbers

1. **Book the demo.** `calendly.com/bevly-sales/bevly-demo-prospects` is public and demo-led; the audit screen, variance resolution and mobile flow are only visible there. This is the single highest-value step and requires no account.
2. **Install the free apps and open them.** BevlyPOS is free on both stores; the onboarding screens and empty states usually reveal the object model (audit sessions, sections, PO states) before any login gate.
3. **Read the Clover listing in a real browser.** The SPA renders fine interactively — pricing tiers, required Clover devices and permission scopes are published there and are the authoritative commercial facts.
4. **Read the EULA and privacy policy** (`/eula-terms-of-use/`, `/bevly-pos-privacy-policy/`) — sub-processors and data-flow descriptions often name the actual integration partners and infrastructure.
5. **Ask the CT trade.** Windsor Court Wine & Spirits (Windsor, CT) is the named public reference; Connecticut liquor-retail associations would corroborate the real install base.
6. **Reconcile the pricing conflict** by requesting a written quote through `/build-your-own-pos/` — the $259/mo vs $59–$99/mo contradiction resolves only in a real quote.

## 11. Sources

**Primary — Bevly / Cobalt (all fetched via local crawl4ai, 2026-09-02)**
- [Audits & Shrink Control](https://bevlypos.com/pos-solutions/audits-shrink-control/) · [Bevly Mobile](https://bevlypos.com/pos-solutions/bevly-mobile/) · [BarBack Inventory](https://bevlypos.com/pos-solutions/barback-inventory/) · [360° Stock Control](https://bevlypos.com/pos-solutions/360-stock-control/)
- [Digital Purchase Orders](https://bevlypos.com/pos-solutions/digital-purchase-orders/) · [Purchase Order Management](https://bevlypos.com/pos-solutions/pos-purchase-order-management/) · [Digital Invoicing](https://bevlypos.com/pos-solutions/digital-invoicing/) · [Receive Invoices Direct from Distributors with Fintech](https://bevlypos.com/pos-solutions/receive-invoices-direct-from-distributors-with-fintech/) · [Distributor Network](https://bevlypos.com/pos-solutions/distributor-network/) · [Vendor Management](https://bevlypos.com/pos-solutions/pos-vendor-management/)
- [The Bevly Ecosystem](https://bevlypos.com/pos-solutions/the-bevly-ecosystem/) · [Integration Suite](https://bevlypos.com/pos-solutions/bevly-integration-suite/) · [Bevly Setup](https://bevlypos.com/pos-solutions/bevly-setup/) · [Virtual Assistant](https://bevlypos.com/pos-solutions/bevlys-virtual-assistant/) · [Multi-Store Sync](https://bevlypos.com/pos-solutions/multi-store-sync/) · [Clover Improvements by Bevly](https://bevlypos.com/pos-solutions/clover-improvements-from-bevly-version-1/) · [Retail Inventory Manager](https://bevlypos.com/clover-pos-app/retail-inventory-manager/) · [Register Item Counter](https://bevlypos.com/clover-pos-app/clover-register-item-counter/)
- [Sales Tracking & Business Analytics](https://bevlypos.com/pos-solutions/pos-retail-analytics/) · [Peak Sales Time Report](https://bevlypos.com/pos-solutions/peak-sales-time-report/) · [Smarter Inventory Management](https://bevlypos.com/pos-solutions/smarter-inventory-management-pos/) · [Time Savings Calculator](https://bevlypos.com/pos-solutions/time-savings-calculator/) · [Build Your Own POS](https://bevlypos.com/build-your-own-pos/) · [Cobalt pricing](https://bevlypos.com/cobalt-pricing/) · [Homepage](https://bevlypos.com) · [bevly.co](https://bevly.co)

**Primary — Bevly blog**
- [Automatically Build and Review Alcohol Purchase Orders](https://bevlypos.com/2026/07/08/automatically-build-and-review-alcohol-purchase-orders/) (2026-07-08) · [The Value Found In Automated Invoice Receiving](https://bevlypos.com/2026/07/06/the-value-found-in-automated-invoice-receiving/) (2026-07-06) · [Liquor Store Dead Products Report](https://bevlypos.com/2026/06/22/liquor-store-dead-products-report/) (2026-06-22) · [Liquor Store Inventory Management: A Complete Guide](https://bevlypos.com/2026/08/12/liquor-store-inventory-management-a-complete-guide/) (2026-08-12) · [Organizing Your Liquor Store Inventory](https://bevlypos.com/2026/08/06/organizing-your-liquor-store-inventory/) (2026-08-06) · [Adding Liquor Store Attributes In Bulk](https://bevlypos.com/2026/07/30/adding-liquor-store-attributes/) (2026-07-30) · [Wholesale and Retail Value vs Sales](https://bevlypos.com/2026/04/09/wholesale-and-retail-value-vs-sales-liquor-store-reporting/) (2026-04-09) · [Liquor Store Stock Audits: How Often and What Items](https://bevlypos.com/2026/06/19/liquor-store-stock-audits-how-often-and-what-items-should-you-audit/) (2026-06-19) · [Benefits of Liquor Store Stock Audits](https://bevlypos.com/2026/05/14/why-liquor-store-stock-audits-should-be-done-monthly-quarterly-and-annually/) (2026-05-14)

**App stores and company records**
- [Google Play — com.bevlyliquor.pos](https://play.google.com/store/apps/details?id=com.bevlyliquor.pos) · Apple iTunes lookup API, trackId 6755444422 ([App Store](https://apps.apple.com/us/app/bevlypos/id6755444422)) · [LinkedIn — Bevly](https://www.linkedin.com/company/bevlyapp) · [Clover App Market — EX83YHBS68GPE](https://www.clover.com/appmarket/apps/EX83YHBS68GPE) (not renderable)

**Design tokens** — `https://bevlypos.com/wp-content/litespeed/css/733c81851ada623c0ce2e0a5cf74fa55.css`
**Product screenshots** — `https://bevlypos.com/wp-content/uploads/2025/11/` (dashboard, purchase-orders, sales-reporting, inventory, distributor-stats)

**Searched, nothing found:** Capterra · G2 · Software Advice · GetApp · TrustRadius · YouTube · Reddit · Crunchbase · BBB · press releases.

---

_Run stats: 44 pages harvested (38 bevlypos.com/bevly.co + 6 third-party), 55 crawl4ai scrape calls (local, free), **0 Firecrawl calls** (standard-depth cap of 20 entirely unused), 0 WebFetch fallbacks; plus 7 product screenshots and 1 stylesheet fetched by curl. Gemini discovery ERRed (rc=0) → WebSearch fallback. 3 subagents. Stage 4 cite-check: 30 quotes checked, 28 OK, 2 MISS (both LinkedIn boilerplate strings split across lines in the scrape — the underlying facts were re-verified by direct grep and are cited from the same file). Stage 6: GPT-5.6 Sol verifier timed out (rc=124, circuit breaker tripped after 2 consecutive batch failures) → Claude adversarial fallback; 18 claims judged, 12 supported and 6 overstated; all 6 corrections applied by substituting the narrower cite-checked quote or narrowing the wording. All 18 flagged `vendor_claim: yes`. Stage 5 triangulation not run — no gated fact met the >=3-independent-dated-reports bar, so gaps are reported as "not publicly available" rather than estimated._
