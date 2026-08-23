# Camera-First Personal Cellar PRD

Status: Grok 4.6 audit passed; implementation remains gated by owner decisions

Discovery record: `docs/plans/2026-08-21-camera-first-personal-cellar-discovery-reconstruction.md`

Implementation specification: `docs/plans/2026-08-21-camera-first-personal-cellar-implementation-spec.md`

Audit record: `docs/plans/2026-08-21-camera-first-personal-cellar-audit-and-verification.md`

## Fable 5 product contract

**Objective:** Extend Terroir so a serious personal collector can build and use a truthful, camera-first inventory across home and external storage while preserving restaurant behavior.

**Essential context:** Terroir already supports restaurant tenants, invoice OCR, single-bottle photo extraction, bins, cellar grids, LWIN trigram matching, purchase cost, drink windows, team roles, and RLS. It does not support personal tenancy, hierarchical containers, persisted visual evidence, external custody connectors, semantic retrieval, or granular private sharing.

**Output contract:** Implement only owner-approved requirements that enter `app_spec.txt` through the repository's source-ledger process. Every shipped slice must have an eval-first acceptance contract, focused tests, current global gates, independent review, a Grok 4.6 scoped-diff audit, and a squash landing.

**Decision boundary:** Do not infer answers to the open decisions in this PRD. Do not start production implementation until this planning package has a clean Grok 4.6 audit, the final verification record is complete, and the owner approves the required product decisions and source-contract amendment.

## Problem and intended outcome

Personal collectors may hold wine for decades across racks, refrigerators, unopened cases, and professional storage. Terroir's current restaurant model can record inventory, purchases, bins, and drink windows, but it cannot truthfully represent expected case contents, visual evidence, personal custody, or natural-language recall.

The intended outcome is a responsive web workflow in which a collector can capture and confirm bottles quickly, understand where and why each wine is held, retrieve it despite imperfect memory or spelling, and prioritize bottles approaching the end of their drink window. The system must show what it knows, how it knows it, and what still needs confirmation.

## Target users

- **Primary:** A serious personal collector with a large, long-lived collection across home and professional storage.
- **Existing adjacent user:** Restaurant owners, managers, and staff. Their workflows must not regress.
- **Unresolved:** Household member, assistant, advisor, guest, or other delegate. The access recipient and permissions need owner approval.
- **Integration actor:** A professional storage provider or merchant that supplies custody and purchase records through an approved interface.

## Primary workflows

1. **Rapid bottle intake:** Photograph a label, review ranked identity and vintage, correct if needed, select an existing bin or the unplaced queue before or at confirmation, confirm quantity, log, and return to capture. A later approved flow may preselect a new location/container.
2. **Sealed-case intake:** Create or confirm a six-pack, twelve-pack, or original wooden case from purchase evidence, record its location, and preserve expected versus verified contents.
3. **Purchase recall:** Open a wine or search result and view acquisition date, unit cost, currency, source invoice, and current custody.
4. **Imperfect-memory search:** Find wine by typo, punctuation variant, producer/cuvee relationship, purchase period, color, location, or constrained natural language. Refine when the query remains ambiguous.
5. **Drink decision:** See a sourced, uncertainty-aware shortlist that prioritizes drink-window urgency and excludes unavailable stock.
6. **External custody:** See that wine is held by a named provider and open or inspect the synchronized source record without replacing that provider's portal.
7. **Delegated access:** Share an approved scope with an approved role, duration, and audit trail. Exact policy is open.

## Scope

### In scope

- Product and architecture decisions needed to add a personal collection context without breaking restaurants.
- One-bottle/one-label camera intake as the first shippable vertical slice.
- Evidence provenance for expected, visually identified, user-confirmed, and physically verified states.
- Physical location and container concepts needed for rooms, racks, refrigerators, bins, six-packs, twelve-packs, and sealed cases.
- Purchase history and signed invoice access from a wine or lot view.
- Typo-tolerant and constrained natural-language search, subject to an approved privacy/provider/index design.
- In-app drink-window recommendations with source and uncertainty.
- External custody integration discovery and one approved provider adapter after its contract is known.
- Granular sharing design after recipient and permission decisions are approved.
- Exact-revision legal and technical review of candidate open-source repositories and datasets.

### Explicitly out of scope

- Marketplace listing, brokerage, sale execution, profit projection, or tax treatment.
- Whole-cellar or shelf photography that establishes or reconciles counts unless the owner reopens rejected inventory-counting scope.
- A guaranteed multi-bottle vision feature before a real-photo feasibility gate passes.
- A native mobile application.
- A 3D cellar renderer.
- Push or email notifications until the owner selects a channel and infrastructure.
- Scraping provider portals with user credentials or bypassing provider controls.
- Replacing a provider's operational portal.
- Replatforming Terroir onto InvenTree, Kellerlog, CellarBoss, or Glou.
- Silent AI confirmation, free-form SQL generation, or prose answers unsupported by tenant rows.

## Functional requirements

IDs are provisional planning IDs. They become implementation IDs only through the approved `app_spec.txt` source process.

| ID | Requirement |
|---|---|
| PCI-FR-001 | The system must support an owner-approved personal collection context while preserving existing restaurant behavior and tenant isolation. |
| PCI-FR-002 | In the first slice, a collector must be able to select an existing bin or the unplaced queue before or during confirmation. Creating locations/containers and using hierarchy are gated by D-005. |
| PCI-FR-003 | The first production slice must accept one bottle/label image, validate type and size, extract identity fields, and return ranked candidate information plus calibrated confidence. |
| PCI-FR-004 | The user must be able to accept or correct producer, cuvee, vintage, format, quantity, and location before inventory becomes user-confirmed. |
| PCI-FR-005 | After confirmation, the flow must return to capture without losing the session's ordered results or creating duplicate inventory on retry. |
| PCI-FR-006 | The system must persist evidence source, capture time, actor, provider/model version where applicable, confidence, corrections, and the inventory fact supported by that evidence. |
| PCI-FR-007 | The system must keep expected, visually identified, user-confirmed, and physically verified facts distinguishable. Lower-confidence evidence must never silently become a stronger state. |
| PCI-FR-008 | A sealed case must remain a first-class container with expected contents, expected quantity, physical location, and sealed/opened/partial/damaged facts selected through the approved model. |
| PCI-FR-009 | Purchase evidence may propose case contents but must not mark them visually or physically verified. |
| PCI-FR-010 | A wine or purchase-lot view must expose acquisition date, unit cost, currency, source invoice, and current custody when those facts exist. Invoice images must use membership-scoped signed access in the core slice. Grant-scoped access is gated by D-007. |
| PCI-FR-011 | Search must tolerate representative misspellings, apostrophe/diacritic variants, producer/cuvee ambiguity, and filters over vintage, purchase period, wine color/type, and location. |
| PCI-FR-012 | If natural-language retrieval is approved, it must compile into a whitelisted tenant-scoped query contract, return row-grounded results, and ask for refinement when ambiguity exceeds the approved rule. |
| PCI-FR-013 | Drink recommendations must use available inventory and stored drink-window source/review state, expose uncertainty, and never present estimated windows as spoilage guarantees. |
| PCI-FR-014 | **D-008 gated.** If the owner approves an external custody provider, its data must identify provider, source record, last synchronization time, and conflict state. It must degrade without corrupting confirmed local facts when the provider fails. |
| PCI-FR-015 | **D-007 gated.** If the owner approves granular sharing, it must enforce the approved subject, scope, role, expiry, revocation, and audit policy. Public wine-list access is not an acceptable substitute. |
| PCI-FR-016 | Wine/vintage lineage must remain compatible with Terroir's immutable-vintage and separate-cost-basis decisions. |

## Non-functional requirements and constraints

- **Truth and provenance:** Every expected, extracted, corrected, synchronized, and confirmed fact must retain its source and strength.
- **Privacy:** Photos, invoices, queries, collection contents, custody records, and purchase costs are private. RLS and signed object access must enforce the approved scope.
- **Security:** Harden caller-controlled security-definer RPCs before exposing broader search or batch operations. Never place provider credentials in client code or logs.
- **Mobile usability:** Design for 390 by 844 first, 44px minimum targets, thumb-reachable confirmation, interruption, and safe retry. The first slice keeps session results while the scan view remains mounted; refresh/offline resume is not implied.
- **Idempotency:** Image uploads, scan jobs, confirmations, provider syncs, and invoice commits must be safe to retry.
- **Cost control:** Paid vision and embedding paths need tenant-aware rate limits, quotas, telemetry, and graceful refusal. The current in-process limiter is not a distributed cost control.
- **Observability:** Do not send raw images, invoice contents, purchase details, provider credentials, or unredacted natural-language queries to general logs or Sentry replay.
- **Migration safety:** Each schema migration requires a paired down migration, snapshot update, generated types, RLS tests, and drift checks.
- **Compatibility:** Use the installed Next.js 16 documentation before code changes. Preserve Server Component, Zod, Supabase, Tailwind/CVA, and adapter conventions.
- **Release safety:** Health checks alone do not prove providers, RLS, storage, or release behavior. Use isolated staging and exact-SHA verification before production.
- **Legal compliance:** Code license, data license, image rights, API terms, attribution, and transitive dependencies require separate exact-revision checks.

## Dependencies

- Owner decisions D-001 through D-011 in the implementation specification.
- An approved amendment to `app_spec.txt` and generated feature-ledger process.
- Canonicalization of the existing invoice scan/commit lifecycle before purchase evidence drives expected cases.
- A private evidence-image storage policy with retention and deletion behavior.
- A selected search architecture and, if applicable, embedding provider/data policy.
- A named external custody provider with a lawful API/export/auth path.
- A real worker or bounded synchronous strategy for any operation that exceeds request limits.
- Current staging repair before it serves as a promotion gate.

## Candidate repository and dataset audit

This table records the exact revisions reviewed on 2026-08-21. Public visibility is not reuse permission. No code or data has been copied.

| Candidate and revision | License evidence | Potential value | Planning disposition |
|---|---|---|---|
| [CellarBoss `aa3cd37`](https://github.com/CellarBoss/cellarboss/tree/aa3cd37a618ab1616d703bae55ebecf91db73621) | [GPL-3.0](https://github.com/CellarBoss/cellarboss/blob/aa3cd37a618ab1616d703bae55ebecf91db73621/LICENSE) | Bottle/location separation, mobile flows, drink windows, natural-language MCP concepts | Study behavior only. Do not copy code into Terroir without an explicit GPL compatibility and product-license decision. |
| [Kellerlog `5e2e789`](https://github.com/KrapfalAT/kellerlog/tree/5e2e7894740d0643f977e9f2ffa2c76b1de6d11f) | README says MIT, but no license file or grant text exists | Image-centered details, self-hosted kiosk, simple cellar UX | Ideas only. Require author clarification or a complete license grant before code reuse. |
| [Glou `6fdca4f`](https://github.com/jackthomasanderson/glou-server/tree/6fdca4f32387630fb37c11aec5d7e9c1ad24ec75) | [MIT](https://github.com/jackthomasanderson/glou-server/blob/6fdca4f32387630fb37c11aec5d7e9c1ad24ec75/LICENSE) | Closest technical concepts: chained scan review, `fieldSources`, grid plan, maturity, reconciliation, and guest shares | Highest-priority code-reading candidate. Reuse only selected patterns after source tests, security review, dependency check, attribution, and adaptation to Supabase/RLS. Do not transplant its Express/Prisma auth or schema wholesale. |
| [WineDB `b6cb8e2`](https://github.com/WhiskyyDB/wine-database/tree/b6cb8e2f275c20b99d9014307d33a42e10c56056) | Repository sample/docs claim [CC BY 4.0](https://github.com/WhiskyyDB/wine-database/blob/b6cb8e2f275c20b99d9014307d33a42e10c56056/LICENSE); full snapshot has a separate commercial license | Provenance schema, producer/cuvee/vintage sample data | Do not seed production yet. Audit row-level source rights, attribution, internal sample-count inconsistency, geographic coverage, and full-dataset terms. Evaluate only the open sample. |
| [API4AI examples `1427661`](https://github.com/api4ai/wine-rec-examples/tree/1427661d9a51a730c597288f6a9ce637eda582d8) | [MIT](https://github.com/api4ai/wine-rec-examples/blob/1427661d9a51a730c597288f6a9ce637eda582d8/LICENSE) | Multipart request/response example for wine-label recognition | The sample code is reusable with notice, but the hosted API is a separate vendor, billing, privacy, data-retention, and quality decision. Run a provider bake-off; do not select from examples alone. |
| [OpenWines OCR `50a25a9`](https://github.com/OpenWines/OpenWinesOCR/tree/50a25a9256261f791b0a51d6d29008d47e433dd3) and [Ontology `0dda4a7`](https://github.com/OpenWines/Ontology/tree/0dda4a718a9b255f3cf688ceef58a16b7f08bd07) | MIT in each repository | OCR preprocessing ideas and vocabulary references | Code is old and tied to legacy Tesseract tooling. Use only as historical input after a maintenance/security review. Other OpenWines image/data repositories lack clear licenses and are not approved. |
| [InvenTree `9d19b32`](https://github.com/inventree/InvenTree/tree/9d19b32b16d7424d349644b4fb8d9c3377d40365) | [MIT](https://github.com/inventree/InvenTree/blob/9d19b32b16d7424d349644b4fb8d9c3377d40365/LICENSE) | Hierarchical locations, stock history, attachments, external locations, lots/serial concepts | Borrow domain concepts selectively. Do not adopt its Django subsystem or general inventory scope. Any copied algorithm requires attribution and transitive-license review. |
| [WGISD `6910edc`](https://github.com/thsant/wgisd/tree/6910edc5ae3aae8c20062941b1641821f0c30127) | [CC BY-NC 4.0](https://github.com/thsant/wgisd/blob/6910edc5ae3aae8c20062941b1641821f0c30127/LICENSE) | Vineyard grape-cluster segmentation research | Exclude. It is noncommercial and not a bottle-label, rack, or cellar dataset. |

### Repository reuse gate

Before borrowing any implementation or dataset, the assigned owner must record: exact commit and files, license and required notices, copied versus adapted material, transitive dependencies, security findings, test evidence, data/image provenance, redistribution rights, and a retain/reject decision. Legal counsel remains the escalation path for ambiguous compatibility.

## Assumptions

- The owner wants a personal collector experience inside Terroir, but the tenant shape is not decided.
- One-bottle capture is the safest first production slice because the existing system already supports it.
- Purchase and custody facts can be modeled without committing to a selling product.
- Search requirements can be evaluated against a redacted representative corpus before selecting embeddings.
- The current restaurant schema and APIs remain authoritative until an approved migration says otherwise.

## Unresolved decisions and risks

| Decision or risk | Effect if unresolved |
|---|---|
| Personal tenancy and restaurant coexistence | Blocks schema, RLS, navigation, invitations, and migration design. |
| Count authority of photos | Blocks rack/case vision and prevents accidental reintroduction of rejected counting scope. |
| Evidence-state semantics | Blocks persistence and acceptance tests. |
| Container/location hierarchy | Blocks case, rack, and spatial UI contracts. |
| Sharing subject and role | Blocks access schema and private-link behavior. |
| Search/index/provider policy | Blocks embeddings and conversational retrieval. |
| Notification channel | Keeps drink guidance in-app only. |
| External provider and lawful interface | Blocks connector implementation. |
| Duplicate invoice lifecycle | Risks duplicate scans, inventory, and expected case facts. |
| Worker and distributed rate-limit strategy | Risks request timeouts, duplicated work, and uncontrolled provider spend. |
| Private image storage and Sentry policy | Risks exposure of labels, invoices, prices, and queries. |
| Dataset provenance | Risks infringement, bad metadata, and unsupported valuation claims. |
| Purchase rationale meaning | The phrase "why did I buy this?" may mean invoice context or a user-authored rationale; no rationale feature may be inferred until the owner decides. |

## Independently verifiable acceptance criteria

1. The approved source requirement inventory contains each shipped PCI requirement and the generated ledger passes without hand edits.
2. Existing restaurant critical journeys pass before and after the personal slice.
3. A 390 by 844 user can capture one supported single-label image, review identity/vintage/format, enter a user-confirmed quantity, select an existing bin or the unplaced queue, correct one field, confirm once, and return to capture. A photograph does not establish or reconcile counts.
4. Retrying the same confirmation does not create duplicate inventory or evidence.
5. Stored evidence uses the approved D-004 states shipped in the slice. Model extraction, user correction, and user confirmation remain distinguishable. An uncertain match never becomes confirmed without an actor action. Physically verified is tested only after that state is approved.
6. After the approved case model and canonical invoice lifecycle land, a sealed-case fixture can show expected contents from purchase evidence without claiming visual or physical verification. Purchase evidence creates a proposal only and does not create a case row unless the owner approves that rule.
7. A wine with linked purchase data shows date, unit cost, currency, custody, and a signed invoice action; a different tenant receives no data and no usable object URL.
8. Search evals cover representative French apostrophe/diacritic variants, misspellings, producer versus cuvee ambiguity, and structured filters for color/type and purchase period when those fields exist, including a November 2019 red purchase. Results remain tenant-scoped. Conversational compilation is not part of this criterion.
9. Any approved natural-language path emits only a whitelisted structured query and row-grounded response. Prompt injection and arbitrary SQL evals fail closed.
10. Drink recommendations exclude zero stock, show window source/review state, rank an ending window ahead of a later one under the approved rule, and avoid guarantee language.
11. **Conditional on D-008.** If a provider adapter is approved, an outage leaves confirmed local inventory unchanged and shows last synchronization and conflict/error state. Otherwise this is not a core release gate.
12. **Conditional on D-007.** If granular sharing is approved, every share enforces the approved scope, role, expiry, revocation, and audit behavior at API and RLS layers. Otherwise this is not a core release gate.
13. Schema work includes a tested down migration, current snapshot, generated types, RLS isolation tests, and current CI gates.
14. Each retained external artifact has an exact-revision reuse record and required attribution; rejected sources contribute no code or data.
15. Existing restaurant critical journeys and tenant behavior remain unchanged unless the owner explicitly approves a shared-domain migration.

## Phased delivery for safe fan-out

### Phase 0: Decisions and evidence

Run independent non-production spikes for tenancy, later multi-object vision, semantic search, external provider contract, and repository reuse. Resolve the first-slice decisions among D-001 through D-011. Approve a narrow source-contract amendment and define new eval IDs.

### Phase 1: Security and domain foundation

Land RLS/RPC hardening, private evidence storage policy, the approved evidence schema, paired downs, snapshots, and generated types. One schema owner controls every migration edit.

### Phase 2: One-bottle camera vertical slice

Extend the existing Anthropic-backed responsive scan flow to one label, user-confirmed quantity, existing bins or unplaced state, private evidence, idempotent confirmation, and repeat. Location may be preselected or chosen at confirmation, and the session preserves the last selected location. Keep multi-object counting out.

### Phase 3: Cases and purchase provenance

First canonicalize invoice-only commit behavior. Then add the approved sealed-case/container behavior, expected-content proposals, lot-level purchase history, and signed invoice access.

### Phase 4: Search and drink decisions

Land a measured typo-tolerant and structured-filter baseline first. Add constrained natural-language retrieval only after D-006b and only if it beats that baseline within privacy, cost, and latency budgets. Add the in-app drink shortlist.

### Phase 5: External custody and sharing

Implement one selected provider adapter only after D-008, and granular access only after D-007. Neither optional slice blocks completion of the core camera, purchase, search-baseline, and drink phases.

### Phase 6: Release verification

Run full gates, focused E2E, provider-gated tests, accessibility/mobile checks, migration restore rehearsal, independent review, Grok 4.6 scoped-diff audit, exact-SHA staging verification, and release-owner approval.
