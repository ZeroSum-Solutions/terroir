# Camera-First Personal Cellar Discovery Reconstruction

Status: reconstructed discovery input, not approved implementation scope

Repository baseline: `main` at `f0e542a848390b76407490c84f14bfad1ed29a29` on 2026-08-21

Source note: `docs/product-notes/2026-08-21-camera-first-personal-cellar-inventory.md`

## Reconstruction method

The supplied transcript is incomplete and out of order. The sequence below is a logical reconstruction, not a claim about the original chronology. It preserves uncertainty and does not convert exploratory phrases such as "it would be cool" into approved implementation decisions.

The phrases "strike this from the record" and "stricken from the record" are jokes. They do not remove adjacent content. The nearby age question has no product requirement attached to it.

## Faithful logical reconstruction

1. A serious personal collector wants Terroir to become the single place to understand a collection spread across a home cellar and professional storage providers.
2. External storage portals should continue doing what they do. Terroir should aggregate enough information to show that a wine is held by a named provider and make the provider's records accessible in the collection context.
3. Purchase provenance matters. From a wine or purchase result, the collector wants to see the original invoice, purchase date, amount paid, and storage location without searching old records manually.
4. A future selling capability might need acquisition cost and expected proceeds. The transcript treats selling as conditional future context, not current approved scope.
5. Current exact-text discovery is inadequate for producers and cuvees with French punctuation, misspellings, or overlapping names. The collector wants typo-tolerant, semantic, natural-language search. Example intents include "what was that red wine I bought in November 2019?" and a follow-up refinement such as red versus white.
6. Daily value should include drink-window guidance. On opening the app, the collector wants to see bottles that should be consumed soon and be able to ask what to drink tonight. A wine near the end of its window should rank ahead of one that can wait.
7. Initial personal inventory should be camera-first. The desired bottle loop is photograph, identify, confirm producer/wine and vintage, log to a physical location, then return immediately to the camera.
8. Physical storage must represent real collector behavior: rooms, cellars, racks, refrigerators, bins, six-packs, twelve-packs, and unopened original wooden cases held for 10 to 20 years.
9. Sealed cases should remain first-class objects. Purchase history may establish expected contents without pretending the case has been opened or visually verified.
10. Terroir must distinguish inventory that is expected from records, visually identified from a photograph, confirmed by a user, and later physically verified.
11. Personal collectors and restaurants have different workflows. The transcript does not decide whether Terroir needs a personal mode, a generalized collection tenant, or a shared foundation with tailored experiences.
12. The source ends with an unfinished point about granting someone access. The intended recipient, scope, duration, and permissions are unknown.

## Confirmed discovery directions

These points are confirmed as product needs or principles in the supplied material. They are not yet approved additions to Terroir's source requirement inventory.

- Make personal collection intake camera-first and minimize typing.
- Preserve a rapid photograph, identify, confirm, log, repeat loop.
- Model physical locations and containers, not only a flat bottle count.
- Treat unopened cases and expected contents honestly.
- Preserve evidence provenance and never silently promote an uncertain match to confirmed inventory.
- Surface purchase date, acquisition cost, invoice access, and custody location in the collection context.
- Support misspellings, punctuation variants, cuvees, and natural-language retrieval.
- Use drink-window urgency to help answer what to drink.
- Aggregate external custody rather than replacing a storage provider's own operational portal.
- Keep personal collector needs distinct from existing restaurant workflows.

## Repository-confirmed decisions that constrain the work

- `app_spec.txt` and its generated feature ledger are the active product contract. New implementation needs a source-contract amendment; `docs/feature-ledger.json` must not be edited by hand. Evidence: `README.md:44-50`, `app_spec.txt:8-17`, `docs/evals/README.md:15-17`.
- Terroir is a restaurant-scoped Next.js 16 modular monolith with Supabase/Postgres and route, domain, adapter boundaries. Evidence: `docs/ARCHITECTURE.md:3-27`.
- Software proposes and humans confirm. Prefill requires evidence, confidence, source freshness, and a manual path. Evidence: `/Users/zero/Desktop/Terroir Planning/13-product-north-star.md:20-60`.
- Wine vintages remain distinct immutable children with separate cost basis. Evidence: `/Users/zero/Desktop/Terroir Planning/18-terroir-top10-product-spec.md:34-54`.
- Physical placement is bin-first; unplaced stock is a queue state rather than a fake bin. Evidence: `/Users/zero/Desktop/Terroir Planning/18-terroir-top10-product-spec.md:123-137`.
- Broad inventory-counting workflows were rejected. A camera-assisted intake flow can proceed, but a photograph that establishes or reconciles counts reopens that decision. Evidence: `/Users/zero/Desktop/Terroir Planning/12-owner-decision-log.md:33-45`.
- Multi-bottle shelf vision remains research, not a promised feature, until a real-photo spike demonstrates acceptable accuracy. Evidence: `/Users/zero/Desktop/Terroir Planning/13-product-north-star.md:184-193`.
- Natural-language cellar retrieval, if approved, must translate to constrained queries over a whitelisted schema. It must not expose free SQL or invent facts. Evidence: `/Users/zero/Desktop/Terroir Planning/13-product-north-star.md:120-137`.
- The existing Terroir gauntlet protocol is reusable: one opportunity per branch, eval first, honor dependencies, run opportunity and global gates, pair schema changes with downs, update the ledger through its source process, and squash each landing. Evidence: `docs/evals/README.md:1-17`.

## Open questions

1. Does a personal collection reuse a restaurant tenant, add a tenant type, or introduce a generalized collection boundary?
2. Is Phase 1 limited to one label/bottle per capture, or does it include rack, bin, refrigerator, or case photographs?
3. Does any photograph establish quantity, or does quantity always require user confirmation?
4. What match confidence and candidate rules govern one-tap acceptance?
5. Does purchase history create expected cases automatically, or only after user approval?
6. How are mixed, partial, opened, damaged, moved, or missing cases represented?
7. Is the first spatial view the existing grid, a photo overlay, a rack map, or another representation? A 3D view is only a candidate.
8. Which external custody provider is first, and does it offer an API, export, email attachment, or only a human portal?
9. Which source wins when provider data, invoices, photos, and user corrections disagree?
10. Does "why did I buy this?" require a user-authored rationale or only invoice and purchase context?
11. Is natural-language search a single query interface, a conversational refinement flow, or both?
12. Which indexed fields may leave the database for embedding, and what provider, retention, cost, and latency limits apply?
13. Is "alert me" an in-app briefing, push notification, email, or some combination?
14. Who receives access, to which collections or locations, with what role, expiry, and audit trail?
15. Is resale valuation or a selling workflow in a later product initiative? It is not approved here.

## Assumptions used only for planning

- The responsive web application remains the delivery surface. Native mobile is not assumed.
- Existing restaurant behavior must continue to work unless the owner explicitly approves a shared-domain migration.
- Label photos, invoices, natural-language queries, and collection details are private tenant data.
- Existing bottle scan, invoice, LWIN, bin, drink-window, and membership capabilities are substrate to extend, not systems to replace.
- External repository code is not reusable until exact-revision license, file-level license, attribution, dependency, provenance, security, and technical-fit checks pass.

## Rejected, deferred, or unsupported ideas

- Do not rebuild or alter professional storage providers' operational portals.
- Do not include a marketplace, selling flow, or profit projection in this initiative.
- Do not reintroduce full inventory counting, blind counts, count cycles, or a quantity ledger without explicit owner approval.
- Do not promise multi-bottle, rack, or case counting before a real-photo feasibility spike passes.
- Do not assume push/email notification infrastructure exists.
- Do not assume a native mobile application, 3D cellar, background worker, embedding service, or provider connector exists.
- Do not use WGISD for commercial bottle-label recognition. It is noncommercial and depicts grape clusters in vineyards.
- Do not copy GPL-3.0 code into Terroir without a deliberate license-compatibility decision.

## Current implementation-relevant gaps

- The primary photo flow identifies one bottle with Anthropic vision, permits edits, warns below `0.75`, and saves inventory, but it does not persist the label photo, confidence, candidate list, or physical location as evidence. Evidence: `src/app/api/scan-bottle/route.ts:84-176`, `src/app/(app)/scan/views/bottle-results-view.tsx:29-188`, `src/app/api/inventory/save-bottle-scan/route.ts:60-136`.
- Current locations are flat restaurant-scoped bins plus a row/column cellar grid, not hierarchical rooms, racks, refrigerators, containers, or camera-derived geometry. Evidence: `supabase/schema.snapshot.sql:4552-4617`, `src/app/(app)/cellar/cellar-grid.tsx:31-337`.
- Invoice and unit-cost provenance exists, but the cellar projection hides invoice linkage and overlapping scan/commit paths create duplicate-record risk. Evidence: `src/types/database.ts:403-590`, `src/app/(app)/cellar/page.tsx:64-112`, `src/domains/scanning/invoice-scan-service.ts:68-163`, `src/app/api/inventory/save-scan/route.ts:139-209`, `src/app/api/scans/[id]/commit/route.ts:21-109`.
- Search is substring `ILIKE` plus LWIN `pg_trgm`; no vector, embedding, or conversational retrieval exists. Evidence: `src/app/api/wines/search/route.ts:15-182`, `supabase/schema.snapshot.sql:750-825`.
- Drink-window classification and urgency sorting exist, but no personal occasion or preference recommender exists. Evidence: `src/lib/drink-window/status.ts:11-108`, `src/lib/drink-window/alerts.ts:49-121`.
- Access is restaurant-wide membership or public wine-list sharing. There is no granular private collection, location, case, or item share. Evidence: `src/lib/api/auth.ts:20-94`, `src/app/api/team/invite/route.ts:9-64`, `supabase/migrations/0008_public_wine_read.sql:1-15`.
