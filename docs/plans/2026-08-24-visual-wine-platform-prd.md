# Visual Wine Platform PRD

Date: 2026-08-24 · Status: **approved as the VWP requirement source** (the eval contract it
feeds, `docs/evals/vwp-evals.yaml`, is CI-gated via `pnpm eval:vwp`; its VWP-FR-* IDs and
13 acceptance criteria are enforced there) · Derives from synthesis v4
(`docs/plans/2026-08-24-visual-wine-platform-synthesis.md`, audit CONVERGED: Grok 4.6 and
GPT-5.6 both at sound-with-revisions-applied after four rounds).

Companion documents: master task list
(`2026-08-24-visual-wine-platform-master-tasklist.md`) · P2 identity spine
(`2026-08-23-p2-identity-spine.md`, LANDED 0097–0111) · P4 image enrichment design
(`2026-08-23-p4-image-enrichment.md`, NOT built) · camera-first personal cellar PRD
(`2026-08-21-camera-first-personal-cellar-prd.md`, partially superseded — see
§Supersession).

## Product contract

**Objective:** Extend Terroir so that, in an investor room, a partner restaurant's cellar can
be demonstrated as a visual wine platform: photograph any bottle from the room and open its
placed bottle in under ~2 seconds perceived, walk the cellar in 3D, ask for wine by voice,
and see honest critic/community scores — without an LLM in the identification hot path.

**Posture (owner-stated):** this is a demo/fundraising prototype. Licensing is NOT a blocker
this phase; proper licensing precedes production (risk R6). BUT the prototype rides on the
production repo and touches landed, production-tested surfaces — so all schema-touching work
(migrations 0112–0121+, the bins move, the 0025 ratings migration) carries full production
rigor (paired downs, snapshots, generated types, RLS tests, regression suites), while
demo-only surfaces (scan service internals, renderer, demo mode) may be prototype-grade.

**Output contract:** Implementation requirement IDs become real only through the
repository's `app_spec.txt` source-ledger process; the VWP-FR IDs below are provisional
planning IDs. Every shipped slice needs an eval-first acceptance contract, focused tests,
current global gates, and review per repo convention.

**Decision boundary:** The five owner decisions of 2026-08-24 are CLOSED (§Decision log).
Do not reopen them. Do not infer answers to the decisions listed as OPEN. Gate 0 pass
thresholds are tunable hypotheses until the owner confirms values before the run.

## Problem and intended outcome

Terroir identifies wine today via an LLM scan path (accurate, slow, per-call cost) and
represents location as flat bins. Neither survives a fundraising demo: identification must
feel instant and never confidently wrong, and "where is it" must be a visual, spatial answer.
The corpus behind identification (references, ratings, market data) must look rich for the
wines actually in the room.

Intended outcome: a partner-cellar demo where scan → placed bottle, 3D walkthrough, voice
intake/retrieval, and honest ratings all run against real inventory, with measured accuracy
and latency published before any investor sees it (Gate 0 / Gate 0-R), and every
identification failure mode degrading to abstain-plus-correction-search, never to a wrong
bottle presented confidently.

## Target users

- **Primary (this phase):** the investor room — the demo operator (Devin/partner) and the
  audience judging speed, accuracy, and polish.
- **The partner restaurant** — its real cellar (~20k CSV rows) is the corpus, index, and 3D
  space. Existing restaurant workflows must not regress.
- **Deferred:** personal collectors. The camera-first PRD remains the governing document for
  personal tenancy (its D-001, D-007, D-008 stay open and are NOT decided here).

## Primary workflows

1. **Fast label scan:** photograph a bottle → parallel identification (barcode / OCR-text /
   visual) → top-3 editions or ABSTAIN → the tenant's placed bottle(s) for the chosen
   edition open directly (one placement), as a picker (several), or as an "in catalog, not
   placed" card (none). Correction search on abstain.
2. **3D cellar walkthrough:** navigate template-geometry containers (racks, fridges, cases,
   walls, zones) with one rendered bottle per placement; click a bottle → bottle detail
   (identity, label texture, market rate, purchase cost, scores, producer story, position).
   Desktop-first; splat overlay only where the spike passes.
3. **Voice intake:** push-to-talk, batch STT → slot filling → the same
   `resolve_wine_variants_bulk` identity path as CSV import → confirmation UI → inventory.
4. **Voice retrieval:** "where's the 2016 Barolo?" → one constrained tool call with
   server-side name→ID resolution → placements lit in the 3D view or a disambiguation list;
   out-of-domain and unresolvable queries answer honestly.
5. **Ratings display:** edition-grain aggregated critic score + community stars where they
   exist, labeled base-wine (canonical) score where only that exists, tenant's own
   stars/notes separate. Never a fabricated or misattributed number.

## Scope

### In scope

- Global `wine_editions` entity + server-only variant linking (synthesis D1), migration 0112.
- P4 image enrichment landed as designed with the unwarp amendment (D3), files 0113–0120.
- The Gate 0 identification vertical slice, eval harness, and inference-box topology (D4, D8).
- Containers/slots/bottle_placements + one-time bins migration, 0121+ (D7).
- Three-store ratings schema + read model + 0025 legacy migration (D5).
- Full voice: intake AND retrieval (owner decision; D6 controls are hard requirements).
- Assisted (manual-calibration) 3D space setup; template bottle geometry; desktop splat
  overlay behind its FPS spike.
- Demo mode: preflight, caching, degraded states.
- The 11 validation spikes (synthesis D9) before tickets freeze.

### Explicitly out of scope

- Multi-bottle / whole-shelf vision that establishes or reconciles counts (camera-first
  D-003 posture unchanged — the assisted grid's photo is a calibration backdrop, and NO
  count or identity authority derives from it).
- Automatic grid inference on the critical path (spike only).
- Personal tenancy, granular sharing, external custody (camera-first D-001/D-007/D-008
  remain open and untouched).
- Bulk corpus layers (Wine Images 126K, X-Wines images, Open Food Facts, DDGS→Brave) inside
  the investor-demo index — post-demo only, behind a new frozen eval.
- Fine-tuning on WineSensed or any dataset this phase.
- ANN indexing (partner-sized exact index; revisit with the bulk index).
- "Vinous" attribution anywhere in the UI before a direct deal.
- Production licensing work (planned as a revalidation project post-raise, but per-source
  artifact isolation is required NOW — see NFR-5).
- A native mobile application.

## Functional requirements

Provisional planning IDs; grouped by domain. Each cites its synthesis section — the
synthesis text is normative where this table compresses it.

### Identity (D1)

| ID | Requirement |
|---|---|
| VWP-FR-001 | A global `wine_editions` table must exist at vintage grain: `canonical_wine_id` NOT NULL, `vintage smallint NOT NULL` with `0` = explicit NV, `UNIQUE (canonical_wine_id, vintage)`, no size column (formats deferred to a future `wine_edition_formats`). A CHECK bounds vintage to valid years or 0. |
| VWP-FR-002 | Editions writes follow P2 §8's apparatus: global read, client roles cannot insert/update, rows created only by the server-side identity-resolution path. `lwin11` carries a partial unique index (`WHERE lwin11 IS NOT NULL`) and is set only via a corroboration gate validating BOTH canonical identity AND vintage-digit agreement. |
| VWP-FR-003 | `wine_variants.edition_id` must be client-unwritable (column guard/trigger); linking happens only through a server-side resolution function recording match method + provenance. |
| VWP-FR-004 | Edition backfill must never infer NV from NULL: explicit-NV evidence → `vintage = 0`; dated vintages → dated editions; remaining NULLs → a quarantine queue with a named classification pass. The report counts known-NV / dated / quarantined. Gate 0 cannot start until the pilot's 500 variants are 100% edition-resolved or explicitly quarantined. |
| VWP-FR-005 | One migration manifest governs 0112 (editions), 0113–0120 (P4, renamed in the same commit that lands 0112), and 0121+ (containers/slots/placements), published in the spec list before any migration file is created, with a CI uniqueness/order check. |
| VWP-FR-006 | `wine_lineages` (0054–0056) status must be confirmed (deprecated vs. still-read) before editions tickets are cut (spike 11). |

### Corpus & images (D2, D3)

| ID | Requirement |
|---|---|
| VWP-FR-007 | The investor-demo identification index is FROZEN to the partner cellar's edition set. Appending any bulk layer requires a NEW frozen eval; no silent appends. |
| VWP-FR-008 | The 20k-row partner CSV must have an explicit ingestion path (durable staging or a `MAX_ROWS` raise from the current 5,000) as a scheduled work item, not an assumption. |
| VWP-FR-009 | P4 lands as designed — `wine_images` keeps its `canonical_wine_id` + `(vintage, size_ml)` tuple (NO edition re-key) — plus the cylinder-unwarp amendment: unwarp ships first as a shared library in the Gate-0 scan service and produces derivatives for REFERENCE images as well as queries. |
| VWP-FR-010 | Editions join images only through the deterministic scope resolver: dated edition (vintage=Y) admits `images.vintage = Y OR IS NULL`; NV edition admits `IS NULL OR = 0`; explicit-NV images never attach to dated editions; size precedence exact-vintage+exact-size → exact-vintage+any → any-vintage+exact-size → base. `0`=NV applies to the vintage axis only; `size_ml` is positive-or-NULL, zero rejected. |
| VWP-FR-011 | WineSensed is used ONLY as a hard-negative / out-of-corpus abstention source and domain-gap reference — never in the reference index. *[Corrected 2026-08-25 per spike 4: its rows carry opaque Vivino IDs with no wine/winery names, so it cannot supply a labeled accuracy denominator; the original "evaluation benchmark" framing is retracted. Labeled top-1/top-3 denominators come from partner-cellar photos per Gate 0.]* |

### Identification (D4, D8)

| ID | Requirement |
|---|---|
| VWP-FR-012 | Identification runs parallel arms (ZXing barcode; PaddleOCR → trigram/BM25; DINOv2 → exact FAISS) → union → LightGlue rerank (only candidates WITH reference images; OCR-only candidates survive on calibrated text score) → calibrated fusion → top-3 or ABSTAIN. No LLM in the hot path; VLM fallback default-OFF on the investor path. |
| VWP-FR-013 | The service's result type is edition-only. Barcode is identity authority ONLY for a verified 1:1 GTIN→edition mapping. Vintage-ambiguous GTIN + disagreeing high-confidence OCR vintage → ABSTAIN. Vintage-ambiguous GTIN with low/no OCR vintage contributes a `(canonical_wine_id, size_ml)` candidate constraint into fusion; if no edition resolves, the scan ABSTAINS with the canonical wine surfaced in correction search. |
| VWP-FR-014 | The scan response must return ranked `wine_edition_id`s PLUS the requesting tenant's resolved `bottle_placement_id` set per edition, with defined 0/1/N behavior (catalog card / direct-open / highlight-all-or-picker; format disambiguation GTIN size > OCR size > all). The UI never presents an edition match as identification of a physical unit. |
| VWP-FR-015 | Variants with NULL `edition_id` are excluded from the index and counted in the pilot report. |
| VWP-FR-016 | Gate 0 uses the ungameable eval contract: query-level denominators; in-corpus abstention counts as a top-1/top-3 miss; acceptance-coverage floor beside the false-accept ceiling; in-corpus vs. out-of-corpus false-accepts reported separately; reference-image-coverage floor reported; sealed holdout never informs remediation; failed-run fixes require a newly sampled holdout. Proposed thresholds (owner confirms before the run): top-1 ≥ 70%, top-3 ≥ 90%, false-accept ≤ 5% at acceptance ≥ 80%, image precision ≥ 98%, warm server-side p95 ≤ 2.5s. |
| VWP-FR-017 | Gate 0-R: before any investor rehearsal, the frozen eval is rebuilt on the FINAL partner-edition index (room bottles in the eval set), same metric family and thresholds. No silent 500→full cutover. |
| VWP-FR-018 | Execution topology (one GPU box, models resident, direct upload, bounded queue, per-stage timeouts) is measured — cold/warm/concurrent p50/p95 on real phone photos — before tickets freeze (spike 6). Latency claims are spoken only after measurement. |

### Ratings (D5)

| ID | Requirement |
|---|---|
| VWP-FR-019 | Three stores: `user_wine_reviews` (tenant-scoped, never feeds global aggregates), `external_rating_events` (one subject grain per event: edition preferred, canonical only when the source has no vintage), `rating_aggregates` (computed only from external events, kept at both grains separately; canonical events never fan into edition rollups; one source counts once per subject within a grain). |
| VWP-FR-020 | The read model shows the edition aggregate when one exists, else the canonical aggregate explicitly labeled as a base-wine score; tenant-local rollups live in the read model only. |
| VWP-FR-021 | Legacy `wines.rating`/`rating_source`/`review_excerpt` (0025) data migrates into `external_rating_events` and its readers repoint to the read model. |
| VWP-FR-022 | Display honesty: critic numbers are labeled "aggregated critic score" (Wine-Searcher/GWS), never "Vinous", until a direct deal exists. The Wine-Searcher median-from-average approximation (`src/lib/wine-intelligence/wine-searcher.ts:196–201`) is replaced with a true median or labeled "avg-based" BEFORE any price/score display. Demo cellar values are prefetched and cached; "critic score pending" beats a wrong number; no unofficial Vivino calls in the demo. |

### Voice (D6)

| ID | Requirement |
|---|---|
| VWP-FR-023 | Intake: push-to-talk batch STT → LLM slot-filling → `resolve_wine_variants_bulk` → confirmation UI, with keyterm prompting from the tenant's producer/cuvée vocabulary. |
| VWP-FR-024 | Retrieval: exactly ONE constrained function-calling tool over tenant Postgres; name→ID resolution happens server-side inside the tool; the LLM never passes raw text filters or invented IDs; ambiguity returns a disambiguation list; unresolvable references return an explicit "couldn't find that". No free-form SQL (consistent with camera-first PCI-FR-012). |
| VWP-FR-025 | Hard gate: `containers`/`slots`/`bottle_placements` are populated for the demo cellar BEFORE any retrieval demo line is rehearsed, and the voice-retrieval eval (VWP-FR-026) has passed. |
| VWP-FR-026 | A scored voice-retrieval eval exists before tickets freeze: utterances → expected tool calls + expected result sets, covering wine + location resolution, ambiguity, out-of-domain questions, and abstention, with pass thresholds. Distinct from the 50-utterance STT vocab eval (which decides AssemblyAI vs. Deepgram). |
| VWP-FR-027 | STT is the sole live third-party API on stage: preflight health check, rehearsed retry, and a typed-query fallback UI reachable mid-demo. |

### 3D substrate (D7)

| ID | Requirement |
|---|---|
| VWP-FR-028 | Location model: `containers` (typed geometry: rack_grid, fridge_shelves, case, wall, zone) + `slots` (coordinates) + `bottle_placements` (one row per placed physical bottle: slot_id, inventory_item_id). Placement is the single location truth. |
| VWP-FR-029 | Integrity + tenancy invariants ship IN the migration + regression suite, not as follow-ups: `restaurant_id` across the hierarchy with RLS; composite same-tenant FKs; `UNIQUE (slot_id)` over active placements; one active placement per bottle; transactional `count(active placements) ≤ inventory_items.quantity`; a place-from-lot operation creating one row per bottle. |
| VWP-FR-030 | `bins` migrates ONCE into containers/slots as a location-FK move onto placements (no parallel trees, no dual-write), carrying the ~40 live production rows and the bins e2e suite. Migration numbers 0121+. |
| VWP-FR-031 | The bottle-detail API is keyed to `bottle_placement_id` (unplaced stock → variant-level card) and embeds: identity, label texture URLs + bottle-shape class + aspect ratio + UV hints + no-unwarp fallback, market rate, purchase cost/acquired_at, scores per VWP-FR-020, producer story, container/slot coordinates. |
| VWP-FR-032 | Assisted space setup is a bounded contract: v1 supports uniform grid racks and shelf fridges via photo backdrop → 4-corner manual calibration → rows×cols confirm → per-slot edit → assignment; empty slots first-class; irregular layouts get a non-photographic template. The photo confers no count or identity authority. Auto-grid is a spike off the critical path. |
| VWP-FR-033 | Rendering: template GLB/glTF bottle geometry (Bordeaux/Burgundy/Champagne/flute/Rhône/fortified/half/magnum) in react-three-fiber, textured from P4 derivatives. Gaussian-splat overlay (Polycam → GaussianSplats3D) is desktop-only and ships only if the FPS spike passes; luma-web is not a path. |

### Demo mode (D8)

| ID | Requirement |
|---|---|
| VWP-FR-034 | A demo mode exists before any investor demo: prewarmed models, preflight health checks covering STT AND the GPU inference box, cached golden-path assets/responses (including cached scan results as last-resort degrade), explicit timeouts, designed degraded states. The demo-day plan states whether the box is local at the venue (preferred) or on a verified wired uplink. |

## Non-functional requirements

1. **Abstain over misidentify.** Every identification surface degrades to
   abstain-plus-correction-search. No confidence theater: calibrated scores or nothing.
2. **Honest data states.** No fabricated ratings, no misattributed critics, no invented
   vintages (NV ≠ unknown), no edition claims presented as physical-bottle claims, no
   latency claims before measurement. (Continues the repo's honest-data-states UX doctrine.)
3. **Tenancy.** Every new tenant-scoped table carries standard RLS; composite same-tenant
   FKs wherever rows join across the hierarchy; global tables are server-write-only.
4. **Migration safety.** Paired down migrations, snapshot updates, generated types, RLS
   tests, drift checks — per repo convention — for 0112–0121+; each schema-touching ticket
   carries a regression suite for the landed surface it touches (risk R7).
5. **Licensing containment (prototype ≠ laundering).** Raw AND derived artifacts
   (embeddings, index shards, calibration sets, aggregates) are isolated per source with
   deletion lineage, so any source can be removed and its indexes rebuilt at production
   licensing time. This is the one licensing requirement that cannot be deferred.
6. **Cost control.** Paid calls (Brave, Wine-Searcher, STT) are budgeted, rate-limited, and
   cached; the 21M-row X-Wines set is pre-aggregated offline, never queried live.
7. **Stack compliance.** Next.js 16 App Router conventions per the installed
   `node_modules/next/dist/docs/` (repo AGENTS.md rule); existing Server Component / Zod /
   Supabase / Tailwind-CVA / adapter conventions preserved.

## Supersession & reconciliation of the camera-first PRD (2026-08-21)

| Camera-first item | Status under this PRD |
|---|---|
| D-005 (location/container hierarchy) | **CLOSED** by VWP-FR-028..030 (containers/slots/placements), per the owner's 2026-08-24 sequencing decision. The camera-first spec's "existing bins + unplaced queue" first-slice rule is superseded once the bins migration (VWP-FR-030) lands. |
| "3D cellar renderer" exclusion | **REOPENED** (owner-approved): D7/VWP-FR-028..033. |
| Multi-bottle vision exclusion; photo count authority (D-003 posture) | **UNCHANGED — still out.** VWP-FR-032 explicitly denies the calibration photo any count/identity authority. |
| PCI-FR-012 (constrained NL retrieval, whitelisted, row-grounded) | **Compatible and now concrete**: VWP-FR-024 is its implementation shape. |
| PCI-FR-016 (lineage compatibility) | Subsumed by VWP-FR-006: `wine_lineages` status is confirmed before editions tickets. |
| D-001 (personal tenancy), D-007 (sharing), D-008 (custody), D-010 (evidence privacy for personal photos) | **OPEN and untouched.** This PRD operates entirely in the existing restaurant tenancy. |
| Its output contract (app_spec.txt source-ledger, eval-first slices) | **Inherited** by this PRD's Output contract. |
| Its production decision boundary ("no implementation until audits + owner approval") | Carried forward in prototype-adjusted form (§Product contract posture paragraph). |

## Decision log

**Closed (owner, 2026-08-24):** desktop-first 3D (splat on desktop; phone after FPS spike) ·
FULL voice, intake + retrieval (override of audit recommendation; D6 controls are hard
requirements) · budget approved (Brave ~$100 worst-case, AssemblyAI free tier, one rented
GPU box) · `wine_editions` now, migration 0112 · ratings displayed separate with honest
"aggregated critic" label.

**Open (decide during Phase 3, none blocks PRD approval):**

| ID | Decision | Decides when |
|---|---|---|
| VWP-D-01 | Gate 0 threshold values (final confirmation of the tunable proposals) | Before the Gate 0 run |
| VWP-D-02 | STT vendor: AssemblyAI vs. Deepgram | After the 50-utterance eval (spike 1) |
| VWP-D-03 | GPU inference box: vendor/spec/price | Priced during spec phase (budget approved in principle) |
| VWP-D-04 | 20k CSV path: durable staging vs. MAX_ROWS raise | Spec for D8 step 2 |
| VWP-D-05 | `wine_lineages` disposition (deprecate vs. keep-read) | Spike 11, before editions tickets |
| VWP-D-06 | Splat overlay ships in demo? | Mobile/desktop FPS spike (spike 2) |
| VWP-D-07 | Barcode arm enabled for Gate 0? | Spike 10 (partner-CSV GTIN coverage + vintage-uniqueness) |

## Phased delivery (maps to synthesis D8; spikes from D9 run first)

- **Phase A — Gate 0 vertical slice:** manifest published → 0112 editions + backfill/
  quarantine → 500-variant pilot enrichment → verified references (unwarp lib) → scan
  service on the box → frozen benchmark + latency report → **GO/NO-GO against VWP-FR-016.**
  Failure tree: accuracy miss → improve references/arms, fresh holdout, do NOT scale;
  latency miss → topology fix before features; coverage miss → widen pilot enrichment only.
- **Phase B — scale + P4:** 20k ingestion (VWP-D-04) → P4 at scale (0113–0120) → full
  partner enrichment → **Gate 0-R** (VWP-FR-017).
- **Phase C — ratings:** three stores + read model → 0025 migration → WS median fix →
  demo-cellar prefetch.
- **Phase D — 3D substrate:** 0121+ containers/slots/placements with invariants → bins
  migration → placement-keyed bottle-detail API → texture exports → assisted setup UI.
  Renderer work (Codex) in parallel against the API contract.
- **Phase E — voice:** intake slice → retrieval tool → voice-retrieval eval → demo lines
  rehearsed against landed placements (strictly after Phase D).
- **Cross-cutting:** demo mode (VWP-FR-034) before any investor demo; Gate 0-R before any
  rehearsal.

## Independently verifiable acceptance criteria

1. Migration manifest 0112–0121+ published and CI-checked; P4 files renamed in the 0112
   commit; no numbering collisions.
2. Editions invariants hold under test: duplicate `(canonical_wine_id, vintage)` rejected;
   client insert/update on editions and on `wine_variants.edition_id` rejected under RLS
   test; lwin11 with mismatched vintage digits rejected by the corroboration gate.
3. Backfill report shows known-NV / dated / quarantined counts; pilot at 100%
   resolved-or-quarantined before Gate 0 starts.
4. Gate 0 numbers published from the eval harness with abstentions counted as in-corpus
   misses and the sealed holdout untouched by remediation; thresholds met at
   owner-confirmed values; Gate 0-R repeated on the final index before rehearsal.
5. An out-of-corpus bottle and a non-wine image both produce ABSTAIN + correction search,
   never a confident match, in the demo build.
6. Scan of a placed demo bottle opens its placement directly; a two-placement edition shows
   a picker; an unplaced catalog edition shows the catalog card (VWP-FR-014's three states
   each demonstrated).
7. Placement integrity tests pass in the migration's regression suite: same-tenant composite
   FK violation rejected; second active placement in one slot rejected; over-placement
   beyond lot quantity rejected; bins e2e suite green after the one-time migration with all
   ~40 production rows carried over.
8. Bottle-detail responses for a placed bottle embed every VWP-FR-031 field; a
   different tenant receives no data.
9. Ratings display shows an edition-grain "aggregated critic score" where events exist, a
   labeled base-wine score where only canonical events exist, and no critic display anywhere
   the WS median fix/label is missing; the string "Vinous" appears nowhere in the UI.
10. Voice-retrieval eval passes its thresholds (resolution, ambiguity, out-of-domain,
    abstention) before any retrieval demo line is rehearsed; a live retrieval demo cannot be
    started while `bottle_placements` for the demo cellar is empty.
11. Demo-mode preflight fails loudly when STT or the inference box is unreachable, and the
    typed-query fallback + cached golden path are reachable mid-demo.
12. Every external data source used by the prototype has per-source raw + derived artifact
    isolation with deletion lineage (NFR-5), verified by removing one source in a rehearsal
    and rebuilding its indexes.
13. Existing restaurant critical journeys pass before and after each phase (repo e2e gates).

## Risks (carried from synthesis, PRD-level view)

- **R1 Gate 0 fails** → explicit gate + failure tree; no investor exposure until numbers.
- **R2 Phone-photo domain gap** → spike 7 + WineSensed hard-negative/domain-gap material *(spike-4 correction — not a labeled benchmark)*; abstain calibration.
- **R3 Corpus join rate on partner wines** → pilot measures first; 5k cap is a work item.
- **R4 Demo-day dependencies** → demo mode; STT sole live third-party with typed fallback;
  box gets preflight/degrade.
- **R5 STT on wine proper nouns** → 50-utterance eval decides vendor and feasibility.
- **R6 Licensing cliff at production** → NFR-5 containment now; revalidation project later.
- **R7 Schema blast radius** (editions + P4 renumber + bins move touch landed surfaces) →
  per-ticket regression suites; invariants live in migrations.
- **R8 Full-voice scope risk** (owner override) → D6 hard controls; retrieval eval gate;
  slots-before-voice sequencing.

## Approval

This PRD is approved when the owner signs off on: (a) the requirement set above, (b) the
open-decision list (nothing here pre-empts VWP-D-01..07), and (c) proceeding to the Phase 3
spec list + migration manifest + ticket breakdown + eval definitions.
