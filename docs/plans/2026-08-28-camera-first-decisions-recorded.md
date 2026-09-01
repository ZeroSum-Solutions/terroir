# Camera-First Personal Cellar — Recorded Decisions (D-001 … D-011)

Date: 2026-08-28
Supersedes the proposal table in `2026-08-27-camera-first-owner-decisions-brief.md`.

## Provenance — read this before relying on anything below

**These decisions were not made by the repo owner personally.** On 2026-08-28 the
owner explicitly delegated all twelve gates (D-001..D-011, with D-006 split
into D-006a and D-006b), instructing that the adjudicating
model's answer be recorded "instead of my decision." The adjudicator was
**GPT-5.6 Sol at high reasoning effort**, run read-only against this repository at
`origin/main` `0e9351c`, with the brief, the PRD, the implementation spec, the
discovery reconstruction, and the relevant source files in scope.

Six rows were ratified as proposed; six were amended. The adjudication also found
**twelve factual errors in the brief's own premises** — these are listed in full
below and matter more than the verdicts, because several defaults were resting on
claims the code contradicts.

Standing per the source contract: recording a decision does **not** authorise
implementation. Each answer still enters the normal `app_spec.txt` amendment and
feature-ledger process before production code lands. Nothing in this document has
been built.

---

## D-001 — Where personal-collector data lives · **AMENDED**

Add an immutable `tenant_kind` discriminator with values `restaurant` and
`personal` to the existing `public.restaurants` tenant envelope. Backfill every
existing row as `restaurant`. Keep `restaurants.id`, all existing `restaurant_id`
foreign keys, memberships, and the active-restaurant cookie as the physical tenant
key in v1; do not create a second personal-tenant root and do not generalise the
schema into collections. Personal provisioning must explicitly create a `personal`
row with one owner membership. Until D-007 reopens, personal tenants cannot add
members or use invitations. Auth context must return `tenant_kind` and a fixed
capability set. Shared cellar tables may serve both kinds; restaurant-only tables,
APIs, RPCs, navigation, and direct database access must reject personal tenants
through matching RLS/capability checks. Tenant kind cannot be changed through
ordinary application APIs.

**Changed from the default:** "new tenant type" is defined as a discriminator on the
existing envelope, not a separate tenant table — avoiding a migration of the
repository-wide `restaurant_id` spine while still separating product behaviour.

**Implementation notes:** add the enum/column via a paired migration and backfill.
Existing restaurant signup and journeys stay unchanged. Personal provisioning must
not blindly run restaurant-specific initialisation. Freeze a capability matrix
before WS-02: cellar inventory, wines, bins, invoice provenance, evidence, search,
and drink windows may be shared; team invitations, public wine lists, and
menu/pricing/pour/branding workflows stay restaurant-only unless separately
approved. Extend active-membership resolution beyond its current
`{restaurantId, restaurantName, role}` result
(`src/lib/api/resolve-active-membership.ts:17-21`, `:61-65`). RLS must enforce type
restrictions wherever authenticated clients address tables directly — hiding UI is
insufficient.

## D-002 — Multi-bottle detection in one photo · **RATIFIED**

The production camera flow remains one image containing one intended bottle label.
It may return one to three alternative identity candidates for that label, but it
must not detect, crop, enumerate, or identify multiple bottles, labels, shelves,
racks, or cases from one image.

**Implementation notes:** keep the current one-label request contract and manual
fallback. No bounding boxes, no multi-object quantity semantics. Extra visible
bottles are background, not additional inventory.

**Reopen trigger:** a versioned, independently labelled real-photo spike covering
representative shelves, racks, cases, devices, lighting, occlusion, and label
orientation, reporting per-object false positives, false negatives, duplicate
detections, latency, cost, and subgroup results.

## D-003 — Can a photo establish quantity · **RATIFIED**

A photograph never establishes, increments, decrements, or reconciles bottle
quantity. Quantity is always entered or explicitly confirmed by the user. Purchase
evidence may propose an expected case quantity under D-004, but that does not make
the quantity visually or physically verified.

**Implementation notes:** do not derive quantity from detected objects, case
dimensions, label count, or model prose. Persist quantity confirmation as a separate
user assertion. Retrying confirmation must reuse the same idempotency key and create
neither additional quantity nor duplicate evidence.

## D-004 — Evidence state table · **AMENDED**

Evidence is append-only and applies **per fact**, not to an entire inventory row.
Each current fact references its winning observation; superseded and conflicting
observations are retained.

States, weakest to strongest: `expected`, `visually_identified`, `user_confirmed`,
`physically_verified`.

**Source mapping (fixed):**

- Invoice/purchase evidence and any future provider-sync observation enter as `expected`.
- A model result from a label photo enters as `visually_identified`.
- Explicit acceptance, manual entry, or correction by the personal tenant owner enters as `user_confirmed`.
- An explicit owner action stating the physical item was checked enters as `physically_verified`.
- No confidence score and no deterministic system rule may create `user_confirmed` or `physically_verified`.

**Observation time is source-specific.** Invoice and vision observations use the
server-accepted capture/invocation time; user confirmations, corrections, and
physical checks use the server transaction time; provider observations use the
provider's immutable source timestamp. Invoice date remains a separate purchase
fact. Every record also stores `received_at`.

**Source identity.** Each observation has a unique source identity containing
tenant, fact key, source kind, source system, immutable source record ID, source
version, and attempt ID. Concretely: canonical invoice scan/line/revision; camera
capture UUID / model invocation / candidate rank; client mutation UUID for user and
physical actions; and provider/account/remote-record/version if D-008 later opens. A
transport retry reuses the same attempt ID. A new provider or model invocation
receives a new attempt ID even when processing the same file.

**Conflict and idempotency rules:**

1. Same source identity, same canonical value → idempotent delivery; return the existing observation.
2. Same source identity, different canonical value → integrity error: reject with `409 inconsistent_source_delivery`, retain the original, record an operational event.
3. A distinct observation with the same canonical value is **corroboration, not conflict**. It may strengthen the current state only when its source is stronger and its observation time is not older.
4. A different value supersedes the current value only when it is newer **and** its source strength is equal or stronger.
5. At the exact same observation time, a stronger source wins; different values at equal strength become a surfaced conflict. An older observation never overwrites a newer current fact.
6. A weaker, older, or equal-time/equal-strength differing observation is retained as a conflict and does not change the current fact.
7. An explicit newer user correction is the sole exception to strength precedence: it replaces the value and sets `user_confirmed`. If the prior state was `physically_verified`, the UI must warn that the edit removes physical verification.
8. States never silently downgrade. Editing a physically verified fact is the only approved downgrade, `physically_verified` → `user_confirmed`.

Until D-007 reopens, only the personal tenant owner may confirm, correct, or
physically verify.

**Changed from the default:** defined source identity concretely; distinguished
transport retries from new observations; made identical corroboration
non-conflicting; limited exact-time conflict to equal-strength differing values;
prevented stale stronger evidence from overwriting newer facts; and resolved the
contradiction between "stronger always supersedes" and the explicit
post-verification correction downgrade.

**Implementation notes:** use an append-only observation table plus a current-fact
projection/reference. Add unique constraints for source identity, and tests for
same-key/same-value, same-key/different-value, distinct same-value, stale stronger,
newer weaker, equal-time equal-strength, equal-time stronger, explicit correction,
and retry races. Canonical value comparison must be field-specific. `added_via`
remains an input channel, not evidence strength. D-011 confidence affects review
presentation only.

## D-005 — Location and container model · **AMENDED**

**First slice:** placement is exactly one active existing bin belonging to the active
tenant, or the unplaced queue. Unplaced means both `bin_id` and legacy
`bin_location` are null; it is never represented by a pseudo-bin. Creating
locations, racks, refrigerators, or cases is unavailable in that slice.

**Approved later hierarchy (bounded):**

- A root `location` represents a room, cellar, or offsite facility.
- The existing bins domain becomes the compatible storage-position layer, with kinds `bin`, `rack`, or `refrigerator`; each position belongs to at most one root location.
- A first-class case may sit directly in a root location or in one storage position.
- An inventory lot is either loose in one storage position, contained in one case, or unplaced.
- Maximum chain: location → storage position → case → inventory lot. Positions cannot contain positions; cases cannot contain cases.
- Quantities remain lot-based. Moving part of an aggregate quantity requires splitting the lot or adding a placement allocation; the system must not pretend an aggregate row is one physical bottle.

**First representation:** a grouped list — location → storage position → cases and
loose lots, plus separate "location not assigned" and "unplaced inventory" groups.
No new 3D, photo-overlay, or graphical rack renderer is approved. The existing
restaurant SVG grid remains intact.

**Changed from the default:** replaced the insufficient one-level model with a
bounded two-container-level hierarchy so a sealed case can truthfully sit in a rack
or refrigerator; replaced per-bottle language with the repository's actual
aggregate-lot semantics; explicitly preserved the existing restaurant grid.

**Implementation notes:** add a composite same-tenant FK
`(bin_id, restaurant_id) → bins(id, restaurant_id)`. First-slice writes must validate
active/non-retired bins and mirror the selected bin code into `bin_location` until
legacy consumers migrate. Unknown or foreign bin IDs fail closed — they do not become
unplaced. Preserve existing bin IDs when later adding kind/location fields. Existing
bins whose root location is unknown appear under "location not assigned"; do not
fabricate a physical location during migration.

## D-006a — Typo-tolerant search baseline · **AMENDED**

Approve a tenant-scoped, relevance-ranked typo-tolerant baseline as the first search
deliverable. It must:

- Normalise case, Unicode accents/diacritics, straight/curly apostrophes, punctuation, and spacing.
- Search producer, cuvée/name, canonical aliases, and linked normalised identity, retaining which field matched.
- Use trigram similarity for representative misspellings and return an explicit ambiguity state when producer-versus-cuvée candidates are not decisively ordered.
- Support vintage range, purchase-date range, colour, wine type, bin/location, and unplaced filters.
- Define purchase date as `invoice_scans.invoice_date` or another explicit stored acquisition date. `inventory_items.added_at` must **not** be silently treated as purchase date.
- Use stored `wines.colour`; use authoritative linked LWIN `type` where available. Unknown values remain unknown and are not inferred solely to satisfy a filter.
- Scope every query and join to the active D-001 tenant key, returning row-grounded results from that tenant only.
- Measure top-k retrieval, ranking, ambiguity, and zero-result behaviour against a versioned approved corpus.

The new search query/RPC must run as `SECURITY INVOKER` under RLS, or perform an
internal membership check before reading tenant data.

**Changed from the default:** preserved the full PCI-FR-011 baseline but defined
truthful purchase/type semantics, and replaced the stale requirement to repair
already-fixed wine RPCs with a security requirement on the new search contract and
anything it invokes.

**Implementation notes:** reuse the existing `unaccent`/normalised canonical identity
and trigram substrate rather than adding an external provider. Search must join
purchase and placement data without duplicating wines; ranking operates per unique
wine/lot result. A location filter uses relational bins plus an explicit null-bin
predicate for unplaced. Preserve unknown purchase dates. The existing
`/api/wines?q=` legacy caller must be corrected to the actual search contract rather
than treated as a second search API.

## D-006b — Semantic / conversational retrieval · **AMENDED**

> **Amended 2026-08-31 by `2026-08-31-d006b-amendment-unified-search.md`**
> (ratified by Devin). That amendment lifts the deferral for three
> capabilities *together* — tier-2 LLM struct compile, tier-3 conversation
> mode, and embeddings — each under binding terms recorded there. **The
> reopen trigger below is SPENT: it was met by the amendment, not by a
> bake-off.** What the text below still states correctly is what remains
> FORBIDDEN, which the amendment did not touch: generated SQL, ungrounded
> prose presented as data, and a parallel semantic result model.
> Ratifying the amendment does not authorise implementation — the
> operational terms for tier 2 are in
> `2026-09-01-tier-2-struct-compile-ops-spec.md`, and the feature-ledger
> assertions ride the branch that builds each tier.

Defer embeddings, vector indexes, open-ended chat, and multi-turn conversational
search from v1. Ship D-006a typed search and preserve the existing single-turn
deterministic voice resolver. Extending that resolver with additional whitelisted
filters is allowed only when it emits the same structured D-006a query contract; it
must not generate SQL or ungrounded prose. **Embeddings are not required merely to
accept natural-language input.**

**Changed from the default:** separated three capabilities the default conflated —
deterministic constrained natural-language compilation, multi-turn conversation
state, and embedding-based semantic retrieval. Only the latter two are deferred; the
existing deterministic voice path remains supported.

**Implementation notes:** D-006a remains the shared query and security contract for
typed and voice entry. Do not create a parallel semantic result model.
Natural-language telemetry follows D-010 redaction. Existing STT provider behaviour
is not authorisation to send cellar rows or queries to an embedding provider.

**Reopen trigger:** after the versioned D-006a corpus is measured and a read-only
bake-off demonstrates material improvement on meaning-dependent queries with row
grounding intact, plus a complete indexed-field, provider, retention, deletion,
freshness, latency, and cost policy.

## D-007 — Sharing and delegated access · **RATIFIED**

Granular sharing does not ship in v1. A personal tenant is owner-only: no household
member, assistant, advisor, guest, private link, team invitation, delegated edit, or
view-only grant is created. Existing restaurant team membership and public wine-list
behaviour remain restaurant-only and unchanged.

**Implementation notes:** D-001 capability and RLS rules must *reject* personal-tenant
invitation, public-list, and membership-management operations, not merely hide them.
Do not reuse public wine-list policies as private-cellar sharing.

**Reopen trigger:** a named recipient class, exact resource scope, role/capability
matrix, maximum expiry, revocation behaviour, audit events, abuse cases, and
API/direct-RLS test matrix supplied together. Time-boxed view-only access is the
first candidate but is **not** pre-approved.

## D-008 — External storage/custody provider · **RATIFIED**

No external custody provider integration ships in v1. The system may store
user-entered offsite location/custody labels under the approved location model, but
must not authenticate to, scrape, synchronise with, or claim freshness from a
provider. Provider facts cannot enter D-004 until a specific adapter is approved.

**Implementation notes:** no provider credentials, sync jobs, remote IDs, portal
scraping, or provider-specific schema. Manual offsite location data is labelled
user-confirmed, not synchronised.

**Reopen trigger:** one named provider with reviewed API/export/auth terms, lawful
access, stable remote identifiers and timestamps, rate limits, deletion/retention
requirements, credential handling, conflict behaviour, outage behaviour, and
representative fixtures.

## D-009 — Drink-window notification channel · **RATIFIED**

Ship an in-app drink-window shortlist only. Include only available inventory with a
known window end that is not actively snoozed. Rank ascending by
`drink_window_end`; ties sort by producer, wine name, vintage, then stable ID. Show
stored source/review state and uncertainty, and never phrase an estimated window as a
spoilage guarantee. No push, email, SMS, or background notification infrastructure is
approved.

**Implementation notes:** reuse the canonical alert pipeline, which already excludes
unavailable stock and sorts by end year (`src/lib/drink-window/alerts.ts:49-79`,
`:92-120`). Preserve snooze behaviour. Add the final stable tie-breakers in tests.

## D-010 — Photo storage, retention, and redaction · **AMENDED**

Invoice and label-evidence images are private tenant data. Retain the existing
private `invoice-images` bucket and add a **separate private label-evidence bucket**;
do not reuse public wine hero images. New paths are tenant-prefixed and owner-bound:

- Invoice: `<tenant-id>/invoice/<invoice-scan-id>/<page-id>.<ext>`
- Label: `<tenant-id>/label/<evidence-id>/<object-id>.<ext>`

Before upload, create a database object-metadata row with a unique `(bucket, path)`
and exactly one owning FK. Invoice pages belong to one `invoice_scans` row; label
photos belong to one D-004 evidence record, which in turn belongs to the supported
inventory fact. Caller-preuploaded arbitrary paths are not a supported production
contract.

**Signed URLs expire after 3,600 seconds** and are issued only after row
authorisation and path-prefix verification — for every invoice page and label photo.

**Retention** lasts until the owning record or tenant is deleted; no shorter
automatic expiry applies. Deleting derived inventory never deletes its source
invoice. Deleting an inventory fact deletes its label evidence and associated photos.
An invoice scan with derived inventory may not be hard-deleted without first
deleting/reassigning those rows, or explicitly retaining a metadata-only provenance
record with its images removed. All user-visible hard deletion goes through a server
cleanup service that deletes every owned object before deleting metadata/owner rows.
Direct owner-table deletion remains denied where it would bypass object cleanup.

**Export** is a private archive containing inventory/provenance manifests plus every
owned invoice page and label-evidence photo, generated after authorisation, exposing
no permanent public URLs.

**Redaction.** General logs and Sentry may contain opaque tenant/scan/evidence IDs,
error codes, timing, byte size, and MIME type only. They may **not** contain image
bytes/base64, OCR text, invoice line contents, purchase values, natural-language
queries, provider payloads, signed URLs, or credentials. Disable server
local-variable capture for these surfaces, add explicit `beforeSend` scrubbing tests,
and disable or comprehensively block/mask Replay on scan, invoice-review, and
private-query surfaces.

**Changed from the default:** made label photos owned by evidence records rather than
directly by aggregate inventory rows; covered multi-page invoices; required unique
object ownership before upload; prohibited arbitrary preuploaded paths; constrained
invoice deletion so provenance is not silently nulled; made logging/Sentry
enforcement concrete.

**Implementation notes:** support legacy invoice paths for read/export during
migration, but all new writes use the owner-bound scheme. Add member/owner storage
policies appropriate to read and controlled deletion. Check every Supabase
update/delete result — a surrounding `try/catch` does not catch returned PostgREST
errors. Remove the duplicate active invoice lifecycle in which `/api/scan` persists a
scan/photo and the client later resubmits the same file to
`/api/inventory/save-scan` (`src/app/(app)/scan/scanner.tsx:571-589`). Add orphan,
duplicate-path, multi-page, cross-tenant signed URL, deletion failure, tenant
deletion, export, Sentry, and Replay tests.

## D-011 — Confidence threshold for one-tap acceptance · **RATIFIED**

No confidence-dependent bypass or automatic acceptance ships in v1. Every result
requires the user to review a displayed candidate or correct its fields and then
explicitly activate "Confirm & save." That action, not the model score, creates
`user_confirmed` evidence. Provider candidate order may be displayed as "possible
identifications" but is not described as a calibrated database ranking. The model's
confidence remains visible only as explicitly labelled self-assessment. The current
strict `< 0.75` boundary may remain as a warning/colour heuristic; exactly `0.75` is
not low-confidence. The warning never blocks or authorises confirmation.

**Implementation notes:** amend PCI-FR-003 for this slice from "calibrated
confidence" to "model-reported, explicitly uncalibrated confidence"; do not claim
calibration before the reopen trigger passes. Persist provider rank, score,
model/version, candidate list, and selected/corrected outcome as D-004 evidence. Do
not sort candidates solely by the uncalibrated score.

**Reopen trigger:** a versioned corpus of at least 500 representative real label
photos showing top-1 precision ≥ 99%, false-accept rate ≤ 1%, expected calibration
error ≤ 0.05, and no material device/lighting/label subgroup below 97% precision at
the proposed threshold.

---

## Factual errors found in the 2026-08-27 brief

These are the reason six rows were amended. Each was checked against the code.

1. **D-001** — "new tenant type" is not automatically a narrow middle path. A separate tenant root conflicts with the repository-wide `restaurant_id → restaurants(id)` spine (`supabase/schema.snapshot.sql:23-30`, `:39-90`, `:254-292`, `:4552-4569`); the narrow implementation is a discriminator on the existing envelope.
2. **D-004** — did not define "source reference", conflated duplicate delivery with distinct invocation, treated same-value corroboration as a possible tie conflict, and let stale stronger evidence contradict its own correction-downgrade rule. Current request idempotency is only a 24-hour cache keyed by client UUID and `restaurant_id` (`supabase/migrations/0011_scan_idempotency.sql:3-18`, `:24-31`) — not an evidence-source identity system. Inventory stores `added_via` but no evidence state, source reference, confidence, or transition history (`supabase/schema.snapshot.sql:254-264`).
3. **D-005** — the first-slice target is coherent, but **no current scan flow implements the required existing-bin/unplaced picker** (`src/app/api/inventory/save-bottle-scan/route.ts:98-109`, `src/app/api/scan-bottle/confirm/route.ts:49-62`). The current bin FK also lacks a same-tenant composite invariant (`supabase/schema.snapshot.sql:4593-4594`).
4. **D-005** — "one bottle" language conflicts with aggregate `inventory_items.quantity`, and the proposed one-level hierarchy cannot represent a case stored inside a rack.
5. **D-005** — "no graphical grid" cannot apply to existing restaurants: a restaurant SVG grid already ships (`src/app/api/cellar/grid/route.ts:13-18`, `:29-68`).
6. **D-006a** — the premise was too generous. Tenant search is escaped substring `ILIKE` over name and producer only, alphabetically ordered, with no typo ranking and no purchase-period, colour/type, or location filters (`src/app/api/wines/search/route.ts:15-25`, `:49-83`).
7. **D-006a** — the RPC-hardening prerequisite is **stale**. Migration 0079 already converted the three vulnerable caller-controlled wine RPCs to `SECURITY INVOKER` (`supabase/migrations/0079_wine_rpc_invoker_boundary.sql:3-41`, `:48-61`, `:104-111`, `:173-175`).
8. **D-006b** — incorrectly implied constrained natural-language retrieval requires embeddings. A deterministic single-turn AssemblyAI + trigram/facet voice path already exists (`src/app/api/cellar/voice-resolve/handler.ts:121-177`).
9. **D-010** — the 3,600 s TTL claim is correct only for the primary invoice page (`src/domains/scanning/scan-image-service.ts:9-10`, `:38-61`). Extra pages have no equivalent signed-access path.
10. **D-010** — "deletion follows the owning record" is **not** current behaviour. There is no invoice-image delete policy (`supabase/migrations/0009_invoice_image_storage.sql:14-28`) and no canonical scan delete flow; multiple upload/error paths can retain unowned or duplicate objects (`src/app/api/scan/route.ts:303-351`, `src/app/api/inventory/save-scan/route.ts:193-230`, `:256-292`). Bottle-label photos are not persisted at all (`src/app/api/scan-bottle/route.ts:91-108`).
11. **D-010** — the current Sentry configuration does not demonstrate redaction. Production server config sets `includeLocalVariables` on (`sentry.server.config.ts:25-31`) and browser Replay samples 10% of sessions and 100% of error sessions (`instrumentation-client.ts:21-35`). **This is a live production exposure on the OCR/invoice path, not merely a future-decision gap** — see the note below.
12. **D-011** — `0.75` is a warning/colour boundary, not an acceptance or ranking cutoff (`src/app/(app)/scan/views/bottle-results-view.tsx:35-41`, `:111`, `:188-199`). Confirmation eligibility checks only non-empty producer/name and is available at every confidence (`:154-157`, `:362-375`). Candidates are model-generated guesses preserved in prompt order, not catalogue-ranked matches (`src/lib/scanner/bottle-system-prompt.ts:14-16`, `src/app/api/scan-bottle/route.ts:142-160`).

### Note on finding 11 — verified independently, not fixed here

`includeLocalVariables: process.env.NODE_ENV !== "development"` is confirmed live in
`sentry.server.config.ts`, and `Sentry.replayIntegration()` is active client-side.
Server-side local-variable capture on the scan/OCR path can place image buffers, OCR
text, and invoice line contents into error events. Sentry's Replay defaults do mask
text and block media, which narrows — but does not eliminate — the client-side half.

This was **not changed** as part of recording these decisions: D-010's redaction
clause is a decision awaiting the normal amendment/implementation process, and
altering production observability configuration is outside the scope of a decision
record. It is called out here because it is the only finding describing a defect in
what is running today rather than a gap in a plan.

---

## Cross-row consistency

- D-001 provides one physical tenant key for D-005 bins/locations and D-010 storage prefixes, while tenant kind and RLS capabilities keep personal and restaurant behaviour distinct.
- D-005 preserves existing bin IDs and `restaurant_id`, so it requires no second tenancy shape. Its later hierarchy is personal-specific and does not remove the restaurant grid.
- D-010 label objects belong to D-004 evidence records, not directly to an ambiguous aggregate "bottle". Invoice objects remain owned by invoice scans.
- D-004 and D-011 agree that confidence never promotes evidence. Vision creates `visually_identified`; only explicit confirmation creates `user_confirmed`.
- D-006a scopes typed and deterministic voice search to the active D-001 tenant. D-006b cannot create a second search or authorisation boundary.
- D-007's deferral means a personal tenant has one owner actor, matching D-004's transition authority and D-001's provisioning rule.
- D-008's deferral means no provider-sync observations exist yet, but D-004 already defines their future maximum strength as `expected`.

## Sequencing

1. Record all decisions and amend `app_spec.txt` / eval contracts through WS-00. D-001, D-004, D-005(a), D-006a, D-009, D-010, and D-011 define the blocking contract; D-002 and D-003 supply the first-slice constraints.
2. WS-01 freezes the D-001 tenant-kind/capability/RLS contract and the D-010 privacy/storage contract.
3. WS-02 lands one migration train: tenant discriminator, type-aware RLS, same-tenant bin FK, D-004 evidence schema, object-ownership metadata, and any D-006a search RPC/index requirements.
4. After those contracts freeze: WS-03 canonicalises invoice persistence and ownership; WS-04 implements one-label evidence capture; WS-05 implements D-006a search; WS-06 implements the D-009 shortlist. WS-03's canonical invoice lifecycle must land before invoice-derived expected-case behaviour and before D-010 deletion/export is declared complete.
5. D-005's later location/position/case hierarchy lands as a separate WS-02 increment after the first camera slice; its first-slice bin/unplaced contract is already on the critical path.
6. D-002 multi-object vision, D-006b embeddings/conversation, D-007 sharing, and D-008 provider integration remain off the core critical path until their stated reopen triggers pass.
7. WS-09 then performs migration restore rehearsal, restaurant regression, cross-tenant/RLS/storage tests, focused mobile flows, independent review, exact-SHA staging verification, and release authorisation.
