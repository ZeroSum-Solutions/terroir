# Camera-First Personal Cellar Implementation Specification

Status: Grok 4.6 audit passed; no implementation authorized

PRD: `docs/plans/2026-08-21-camera-first-personal-cellar-prd.md`

Discovery record: `docs/plans/2026-08-21-camera-first-personal-cellar-discovery-reconstruction.md`

Audit record: `docs/plans/2026-08-21-camera-first-personal-cellar-audit-and-verification.md`

## Fable 5 execution brief

**Objective:** Deliver the approved personal-cellar slices as small, independently verifiable extensions of Terroir's existing Next.js 16, Supabase, and modular-monolith boundaries.

**Essential context:** Existing single-bottle vision, invoice OCR, inventory, bins, LWIN search, drink windows, and memberships are useful but incomplete. The current tenant is a restaurant. The bottle photo is not persisted as evidence. Invoice persistence has overlapping commit paths. Search is substring/trigram only. External custody, granular sharing, workers, and semantic retrieval do not exist.

**Output contract:** Each workstream owns a bounded file set, writes its eval and failing test first, implements the smallest approved behavior, runs focused and global verification, receives independent review plus Grok 4.6 audit, and lands as one squashed opportunity in dependency order.

**Decision boundaries:** Do not rename or generalize tenancy, add tables, select providers, assign sharing roles, allow photos to establish counts, add notifications, or copy external code/data unless the corresponding decision below is approved and recorded in the source contract.

## Required read order for implementers

1. This specification and the linked PRD/discovery record.
2. `AGENTS.md` and the relevant installed Next.js 16 guide under `node_modules/next/dist/docs/`.
3. `README.md:44-50`, `app_spec.txt:8-17`, and `docs/evals/README.md:1-17`.
4. `docs/ARCHITECTURE.md:3-68`.
5. The exact existing files owned by the assigned workstream.
6. The approved decision record and new eval contract for that workstream.

## Blocking decisions

| ID | Owner decision | Evidence required | Blocks |
|---|---|---|---|
| D-001 | Personal tenancy: reuse restaurant, add tenant type, or generalize collection | Schema/RLS impact map, migration path, restaurant regression plan | All production work |
| D-002 | Expansion beyond the first-slice single-label capture | Real representative-photo spike with false-positive/false-negative analysis | Guided-area or multi-object vision only |
| D-003 | Count authority beyond the first slice. First-slice photos never establish quantity | Explicit owner approval because broad counting was rejected | Cases, rack vision, reconciliation |
| D-004 | Evidence-state transitions and who can promote them | State table with sources, actors, corrections, and downgrade/conflict rules | Schema and acceptance tests |
| D-005 | Location/container hierarchy beyond first-slice existing bins plus unplaced queue, and its first visual representation | Domain examples for room, rack, refrigerator, bin, case, partial case | Later schema and cellar UI |
| D-006a | First-slice typo-tolerant and structured-filter baseline | Approved eval corpus and fields available from current tenant rows | WS-05 baseline |
| D-006b | Semantic/conversational architecture and data policy | Comparison against D-006a, indexed fields, provider, retention, cost/latency budgets | Embeddings and conversational UI |
| D-007 | Access recipient, scope, role, expiry, and revocation | Abuse cases and RLS policy matrix | Sharing |
| D-008 | First external custody provider and lawful interface | API/export/auth docs, source-of-truth rules, sync/conflict model | Provider adapter |
| D-009 | Drink delivery and ranking | In-app versus notification decision; deterministic ranking examples | Recommendation UI and notifications |
| D-010 | Evidence-photo privacy and lifecycle | Bucket privacy/path policy, signed-URL TTL, retention, deletion/export, log and Sentry redaction | Persisted capture evidence |
| D-011 | Candidate ranking and match acceptance | Representative fixture set, ranking rule, warning/accept thresholds, correction behavior | One-tap confirmation and calibrated-confidence claims |

If a decision remains open, the assigned agent may produce a read-only spike, eval corpus, or design comparison. It may not change production code. The proposed first-slice constraints are one label, user-confirmed quantity, existing bins or unplaced state, the current Anthropic vision adapter, and in-memory session continuity while the scan view remains mounted. WS-00 must record owner approval before those constraints become source requirements.

## Architecture rules

- Keep HTTP lifecycle in `src/app/api`, domain workflows in `src/domains`, and provider code in `src/adapters`.
- Use Server Components by default and client components only for camera, interactive review, and other browser state.
- Validate external and client input with Zod.
- Enforce tenant and grant isolation in RLS as well as route guards.
- Treat `added_via` as input channel, not evidence strength.
- Preserve immutable vintage lineage and separate purchase cost basis.
- Keep storage object paths tenant-scoped and private; issue short signed URLs after access checks.
- Do not assume `background_jobs` has a working consumer.
- Do not expose broader search until caller-controlled security-definer RPCs have internal tenant checks.
- Do not hand-edit `docs/feature-ledger.json`, `supabase/schema.snapshot.sql`, or `src/types/database.ts`.

## Logical data requirements

The first-slice minimum depends on D-001, D-004, and D-010 only. It consists of the approved tenant key, evidence records, a private evidence object key, and placement against an existing bin or the unplaced queue. D-005 does not block that minimum. Names below describe contracts, not pre-approved table names.

### Collection context

- Collection/tenant identity and type selected by D-001.
- Existing restaurant memberships and active-tenant cookie behavior remain valid.
- Every new row carries the approved tenant/collection foreign key needed for RLS.

### First-slice placement

- Existing `bins` remain the only selectable physical location.
- Unplaced stock remains a queue state, not a fake bin.
- New location/container creation and hierarchy are unavailable until D-005.

### Later physical place and container, gated by D-005

- Parent-child physical hierarchy for approved location kinds.
- Stable human label/code, optional capacity, ordering, retired state, and approved spatial coordinates.
- Container facts for case size/type, sealed/opened/partial/damaged state, expected quantity, confirmed quantity where authorized, and current parent location/container.
- No fake bin for unplaced stock.

### Inventory observation and evidence

- Evidence source: purchase/invoice, provider sync, photo/model, user assertion, or physical verification.
- Source reference, capture/observation time, actor, provider/model/version, confidence, raw candidate/result reference, corrections, and supported fact.
- Explicit strength/state from D-004. Promotion requires an authorized actor or approved deterministic rule.
- Private image object key plus the D-010 retention/deletion policy. Do not store a public evidence URL.

### Purchase and later custody

- Preserve purchase lot, inventory item, wine/vintage, invoice scan/line, date, unit cost, currency, quantity, and custody links.
- External custody is gated by D-008. If approved, it includes provider, remote record ID, source timestamp, sync timestamp, raw-source reference, normalized facts, and conflict/status.
- If custody is approved, source precedence is explicit; sync never overwrites stronger confirmed local evidence silently.

### Search projection

- Tenant-scoped fields approved for exact, trigram, filtered, and semantic retrieval.
- A versioned index/projection so source updates can be rebuilt and stale results identified.
- Natural-language compilation output is a whitelisted structured query, never SQL from the model.

### Later sharing, gated by D-007

- Grant subject, resource scope, role/capabilities, inviter, recipient binding, creation/expiry/revocation, and audit facts selected by D-007.
- RLS evaluates grants directly. Public wine-list policies are not reused for private collections.

## Existing codebase boundaries

| Concern | Existing areas to extend or verify |
|---|---|
| Tenancy/auth | `supabase/migrations/0001_auth_boundary.sql`; `src/lib/api/auth.ts`; `src/lib/api/active-restaurant.ts`; `src/lib/api/resolve-active-membership.ts`; team invite routes |
| Schema/types | `supabase/migrations/`; `supabase/migrations/down/`; `supabase/schema.snapshot.sql`; `src/types/database.ts` |
| Bottle capture | `src/app/(app)/scan/`; `src/app/api/scan-bottle/route.ts`; `src/lib/scanner/bottle-schema.ts`; `src/app/api/inventory/save-bottle-scan/route.ts` |
| Legacy scan correction | `src/app/(app)/scan-bottle/page.tsx`; `src/app/api/scan-bottle/confirm/route.ts`; verify the apparent `/api/wines?q=` mismatch before reuse |
| Invoice lifecycle | `src/domains/scanning/invoice-scan-service.ts`; `src/app/api/scan/route.ts`; `src/app/api/inventory/save-scan/route.ts`; `src/app/api/scans/[id]/commit/route.ts` |
| Cellar/locations | `src/app/(app)/cellar/`; `src/domains/cellar/`; `src/app/api/cellar/`; `src/app/api/bins/`; `src/app/(app)/cellar/cellar-grid.tsx` |
| Search | `src/app/api/wines/search/route.ts`; `src/app/api/wines/lwin-search/route.ts`; `supabase/migrations/0003_wine_intelligence.sql`; `0007_lwin_matching.sql` |
| Drink guidance | `src/lib/drink-window/alerts.ts`; `src/lib/drink-window/status.ts`; `src/app/api/insights/drink-window-alerts/route.ts`; `src/app/(app)/insights/` |
| Storage | `src/adapters/storage/supabase-storage.ts`; `src/domains/scanning/scan-image-service.ts`; storage migrations/policies |
| External providers | New adapters under `src/adapters/`; new domain orchestration under `src/domains/`; no portal connector exists |
| Contracts/evals | `app_spec.txt`; generated feature ledger process; `docs/evals/`; contract tests; API inventory/conformance files |

## Workstreams and ownership

### WS-00: Product contract and eval map

**Owner:** Contract integrator. Exclusive ownership of `app_spec.txt` source edits, new eval manifest, API inventory/conformance regeneration, and completion records.

**May proceed:** Only after D-001, D-004, D-006a, D-009, D-010, and D-011 are recorded, plus owner approval of the first-slice constraints for D-002 (single label), D-003 (photo never establishes quantity), and D-005 (existing bins or unplaced only).

**Requirements:** Add only the owner-approved first-slice subset through the source process. The initial candidate subset is PCI-FR-001 through PCI-FR-007, PCI-FR-010 with membership-scoped access only, PCI-FR-011 without conversational retrieval, PCI-FR-013, and PCI-FR-016. Add case, semantic, provider, and sharing requirements only after their D-IDs are recorded. Define new opportunity/eval IDs and `depends_on`. Do not reuse completed Top-10 acceptance criteria.

**Verification:** `pnpm verify:feature-ledger`, `pnpm verify:api-contract`, `pnpm verify:product-conformance`.

**Done:** Approved requirements map one-to-one to evals and no generated ledger file was hand-edited.

### WS-01: Security and tenancy contract

**Owner:** Security/tenancy agent. Owns the tenant-key and authorization contract, active-tenant/auth TypeScript, security-definer review, privacy policy, and RLS/security tests. It does not edit migrations, snapshots, or generated types.

**Dependencies:** D-001 and D-010 for the first slice. D-007 applies only to a later sharing increment.

**Requirements:** Preserve restaurant access; freeze the tenant-key/RLS contract; define D-010 storage, retention, signed-URL, deletion/export, logging, and Sentry rules; specify internal tenant checks for caller-controlled security-definer RPCs. WS-02 is the only agent that translates approved SQL/RLS changes into migrations. If D-007 later lands, WS-01 supplies the grant policy and tests for a separate WS-02 migration increment.

**Verification:** Focused RLS/route tests, contract tests, `pnpm exec tsc --noEmit`, `pnpm lint`, migration gates.

**Done:** The frozen contract and tests cover route and direct database access; WS-02 has the exact migration requirements; existing restaurant/team/public-list tests pass.

### WS-02: Provenance, container, and spatial schema

**Owner:** Sole schema agent for the entire initiative. No other agent edits migrations, downs, snapshot, generated database types, SQL/RLS definitions, SQL indexes, or RPC definitions at any time.

**Dependencies:** D-001, D-004, D-010, and WS-01's tenant/security contract for the first increment. D-003 and D-005 gate later case/hierarchy increments.

**Requirements:** First implement the minimum approved evidence contract against existing bins and unplaced state. Later increments may add container/case, custody, or grant records only after their D-IDs. Preserve bins and immutable wine/vintage lineage. Backfill only facts supported by existing data; unknown remains unknown.

**Verification:** Failing migration/RLS tests first; paired down rehearsal; `pnpm snapshot:check`, `pnpm types:check`, `pnpm downs:check`, `pnpm supabase:seed:local`.

**Done:** Up/down paths pass, types and snapshot are current, restaurant rows remain valid, and evidence transitions reject unauthorized promotion.

### WS-03: Canonical invoice commit and purchase provenance

**Owner:** Purchase-provenance agent. Exclusively owns invoice paths in `invoice-scan-service`, `/api/scan`, `/api/inventory/save-scan`, `/api/scans/[id]/commit`, and purchase-history reads. It does not edit bottle-scan save paths, vision, or tenancy policy.

**Dependencies:** WS-01/02 contracts.

**Requirements:** Select one canonical invoice-scan-to-commit lifecycle; make repeat invoice commit idempotent; prevent duplicate `invoice_scans` and invoice-derived inventory; expose lot-level date/cost/currency/provider and membership-scoped signed invoice access; supply expected-case proposals without stronger verification. Purchase evidence proposes a case; it does not create one without owner approval.

**Verification:** Duplicate-submit tests, rollback/cleanup tests, signed-URL isolation tests, existing invoice E2E, and contract gates.

**Done:** One scan has one canonical record and repeatable commit behavior; wine/lot history retains all purchase facts instead of a representative latest cost only.

### WS-04: Camera capture and evidence persistence

**Owner:** Bottle-capture agent. Owns only the bottle vision adapter, `/api/scan-bottle`, `/api/inventory/save-bottle-scan`, `src/lib/scanner/bottle-*`, the bottle branch of `src/app/(app)/scan/`, and focused bottle-scan tests. It never edits invoice paths, migrations, SQL/RLS, snapshots, or generated types.

**Dependencies:** D-004, D-010, D-011; WS-02 first-slice evidence and existing-bin contracts. D-002/D-003 apply only to later expansion because the first slice is single-label and quantity is user-confirmed.

**Requirements:** Extend the current Anthropic-backed one-label flow. Return ranked candidates under D-011; persist private evidence under D-010; allow correction; let location be preselected or chosen at confirmation; preserve the last selected location; confirm idempotently; return to capture with ordered in-memory session results. Preserve manual fallback. Do not establish counts from photos. Do not add API4AI or another vision vendor in this slice.

**Integration:** Provider-specific code belongs in `src/adapters`; route handlers must not embed a second provider contract. Retain the current Zod boundary. The first slice stays within the existing 60-second request budget and adds a documented tenant-aware in-process quota with graceful refusal. It must not claim distributed cost control.

**Verification:** Route/schema tests, scanner component tests, duplicate retry, D-011 low-confidence/candidate fixtures, camera cancel/safe retry, unsupported file, provider timeout, quota refusal, 390 by 844 Playwright journey, and accessibility targets.

**Done:** PCI acceptance criteria 3 through 5 pass with private evidence and no restaurant regression.

### WS-05: Search and constrained retrieval

**Owner:** Search application agent. Owns `/api/wines/search`, approved TypeScript query compilation, search UI, and the search eval corpus. It specifies SQL/index/RPC requirements to WS-02 and never edits SQL, indexes, RPC definitions, migrations, snapshots, or generated types.

**Dependencies:** D-006a and WS-01 security-definer contract for the baseline; WS-02 searchable contracts. D-006b gates embeddings and conversational retrieval only.

**Requirements:** Implement the approved D-006a `ILIKE`/`pg_trgm` and structured-filter baseline first. Test accents, apostrophes, misspellings, producer/cuvee ambiguity, purchase period, type, and location. A D-006b bake-off remains read-only until approved. Add embeddings only if it improves the target corpus within privacy, cost, latency, and freshness budgets. Whitelist structured query fields/operators and reject arbitrary SQL/prompt injection.

**Security prerequisite:** WS-01 specifies and WS-02 lands internal tenant checks for caller-controlled security-definer functions before WS-05 starts. WS-05 consumes the frozen RPC contract and does not widen it independently.

**Verification:** Quality corpus with expected result sets, cross-tenant tests, injection/adversarial tests, index rebuild/freshness tests, and provider failure fallback if embeddings are retained.

**Done:** Search acceptance criterion 8 passes; criterion 9 passes only if natural-language retrieval is approved.

### WS-06: Drink decision support

**Owner:** Recommendation agent. Exclusively owns `src/lib/drink-window/alerts.ts`, approved drink ranking, the drink-window alert API extension, insights UI, and focused tests. Does not add notification infrastructure without D-009.

**Dependencies:** D-009; inventory availability contract.

**Requirements:** Reuse canonical drink-window status, source, review, and snooze fields. Define deterministic ranking examples. Exclude unavailable stock. Show source and uncertainty. Treat occasion/preferences as a later requirement unless approved.

**Verification:** Boundary-year tests, zero-stock exclusion, snooze behavior, ranking fixtures, unknown-window behavior, and UI copy review.

**Done:** The approved in-app shortlist passes criterion 10 without guarantee language.

### WS-07: External custody adapter

**Owner:** Integration agent. Owns one new provider adapter, its domain sync contract, provider-specific tests, and operational runbook. It does not edit generic inventory truth rules.

**Dependencies:** D-008; WS-01/02; WS-10 if the selected integration needs a worker or distributed rate limiting.

**Requirements:** Use lawful provider auth/export. Normalize remote facts with source timestamps. Record conflict and last sync. Never overwrite stronger local evidence silently. Provide retry/idempotency, rate limits, credential rotation, deletion, and degraded-state behavior.

**Verification:** Contract fixtures, expired auth, pagination, duplicate remote IDs, stale update, conflict, provider outage, retry, and credential/log redaction.

**Done:** Criterion 11 passes and the provider runbook identifies ownership, quotas, replay, and disconnect behavior.

### WS-08: External artifact reuse

**Owner:** License/technical-review agent. Owns reuse records and attribution/NOTICE changes only. It does not import code into feature branches.

**May proceed:** Independently during Phase 0.

**Requirements:** Pin exact commit/files; verify repository and file-level license; separate code, data, images, and hosted API terms; inspect dependencies/security/tests; record copied versus adapted material and attribution. Grok 4.6 must audit each retain/reject decision.

**Done:** Every candidate in the PRD table has a signed-off retain/reject record. Only approved snippets or concepts enter later workstream prompts.

### WS-09: Integration and release evidence

**Owner:** Integration/release agent. Owns final merge sequencing, current global gates, focused E2E, exact-SHA staging evidence, audit resolution, and completion record. It does not rewrite workstream code without returning findings to the owner.

**Dependencies:** All landing workstreams.

**Requirements:** Own and repair staging readiness before treating staging as a promotion gate, subject to required provider/account authorization. Verify current staging isolation before using it. Run migration restore rehearsal for schema releases. Distinguish provider-gated checks from local passes. Obtain release-owner approval.

**Done:** Current global gates, required E2E, independent review, Grok scoped-diff audit, resolution/re-audit, exact-SHA staging, health, auth, and primary mobile journey all have recorded evidence.

### WS-10: Optional worker and distributed cost controls

**Owner:** Delivery-foundation agent. Exclusively owns any new worker runtime, distributed limiter/quota store, related configuration, and operational tests.

**Dependencies:** A specific approved need from D-006b or D-008. This workstream does not run for the bounded synchronous first camera slice.

**Requirements:** Define producer/consumer ownership, idempotency, retries, leases, dead-letter/replay behavior, quotas, deployment process, observability, and rollback. Do not treat the existing `background_jobs` table as a worker.

**Done:** The selected workload has tested enqueue/claim/retry/idempotency and distributed quota behavior, plus a deployment and failure-recovery runbook.

## API requirements

- Reuse or version existing routes where semantics remain compatible. Do not create parallel save/confirm paths for the same fact.
- Every mutation has Zod validation, tenant/grant authorization, idempotency behavior, stable error codes, and audit/evidence effects.
- Scan responses separate extraction candidates from confirmed IDs.
- Search responses identify applied structured filters, result grounding, ambiguity/refinement state, and index version when semantic retrieval is retained.
- Invoice and evidence image endpoints return short signed URLs only after row and object-path authorization.
- Provider sync endpoints or jobs carry provider/source IDs and idempotency keys; raw provider payload access is restricted.
- Update `docs/api-route-inventory.json` and product conformance through generators when routes change.

## UI requirements

- Preserve the current responsive web shell and restaurant context.
- The first-slice capture state machine covers ready, permission/file selection, upload, processing, low-confidence review, correction, location, confirming, success/next, cancellation, interruption, provider error, and duplicate retry. Session results persist only while the scan view remains mounted; offline or refresh resume requires a later approved draft record.
- Location may be preselected or chosen at confirmation. Returning to capture preserves the last selected location.
- Evidence state and source use plain labels; never imply a photograph verified unopened contents.
- Case and location UI follow the approved D-005 representation. Do not implement 3D by default.
- Purchase history exposes each lot and source invoice instead of collapsing to a representative cost.
- Search refinement stays bounded to approved filters and does not mimic an unrestricted chatbot.
- Drink recommendations show why an item ranked, source/review state, and no-guarantee language.
- Empty, loading, stale, conflict, permission-denied, and provider-degraded states require designed coverage.

## Migration and data rules

1. Write failing DB/RLS tests.
2. Add the forward migration and paired down under `supabase/migrations/down/`.
3. Backfill only derivable facts and preserve unknown states.
4. Run snapshot and generated-type commands in a controlled schema-owner branch.
5. Verify direct authenticated RPC abuse as well as route behavior.
6. Rehearse down migration against representative seeded data.
7. Record irreversible steps explicitly and obtain owner approval before landing.

## Test and verification matrix

### Focused tests

- Unit and route tests beside each owned module.
- Contract tests for request/response and provider fixtures.
- RLS tests for tenant, role, grant, expiry, and direct RPC cases.
- Migration up/down and backfill tests.
- Component tests for every capture/search/case/recommendation state.
- Focused Playwright at 390 by 844 plus desktop for primary workflows.
- Provider-live tests remain manual/gated and report spend separately.

### Current global gate superset

Run from the repository root after focused tests:

```bash
pnpm verify:feature-ledger
pnpm verify:api-contract
pnpm verify:product-conformance
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm test:contracts
pnpm snapshot:check
pnpm types:check
pnpm downs:check
pnpm supabase:seed:local
pnpm build
```

Run the focused Playwright project or files required by the changed journey. Do not present Playwright as CI-covered; current CI does not run it. Record skipped live/provider checks separately from passes.

## Sequencing and merge dependencies

1. Resolve first-slice decisions and run later-scope read-only spikes in parallel.
2. Land WS-00's approved first-slice source contract and eval map.
3. Freeze WS-01's tenant, RPC, and privacy contract.
4. WS-02 lands SQL/RLS hardening plus the first-slice evidence schema as the single migration train.
5. Run WS-03 invoice-only work, WS-04 one-label capture, WS-05 D-006a search baseline, and WS-06 in-app drink shortlist in parallel against frozen contracts. Each uses a separate worktree and exclusive file ownership.
6. Land WS-03 before expected-case behavior consumes invoice provenance.
7. Later WS-02 increments add hierarchy, grants, or custody only after their D-IDs.
8. Land WS-07 only after provider and worker/auth decisions; invoke WS-10 only if the selected workload needs it.
9. Land sharing only after D-007 and its RLS matrix.
10. WS-09 repairs/verifies staging, merges in dependency order, and rejects cross-workstream contract drift.

No two agents may edit the same migration, generated types, feature ledger source, API inventory, or shared contract concurrently. Contract changes return to the owning workstream and may require dependent branches to rebase and rerun focused gates.

## Terroir gauntlet alignment

For each approved opportunity:

1. Create one feature branch/worktree and one opportunity ID.
2. Map each eval ID to a failing test before implementation.
3. Honor `depends_on`; do not fan out across an unfrozen contract.
4. Implement the smallest change that passes the opportunity evals.
5. Run focused tests and the current global gate superset.
6. For schema changes, include paired downs, snapshot, generated types, and restore evidence.
7. Run independent code/security review appropriate to the diff.
8. Send the scoped diff, requirements, and verification evidence to Grok 4.6.
9. Resolve every blocking or important supported finding and re-audit.
10. Record completion evidence and squash-land one isolated conventional commit.

The old `docs/evals/top10-evals.yaml` protocol is precedent, not the acceptance contract for this initiative.

## Definition of done

A workstream is done only when:

- Its approved source requirements and eval IDs exist.
- Each acceptance criterion has independent test or inspection evidence.
- Focused tests and applicable global gates pass on the final diff.
- Migration, RLS, privacy, provider, and license evidence is complete where applicable.
- Independent review and Grok 4.6 audit have no unresolved blocking or important findings.
- Documentation describes actual behavior and operational ownership.
- The workstream lands as one isolated squash without unrelated changes.

The core initiative is done when the owner-approved camera, purchase, search-baseline, and drink phases meet their applicable PRD criteria, exact-SHA staging and primary mobile flows pass, and release authorization is recorded. External custody, granular sharing, embeddings, hierarchy beyond existing bins, and notifications become release gates only after their D-IDs are approved. Planning approval alone never authorizes implementation or deployment.
