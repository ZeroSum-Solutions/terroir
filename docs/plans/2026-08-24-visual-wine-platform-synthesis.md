# Visual Wine Platform — Phase 2 Synthesis (architecture recommendation)

Date: 2026-08-24 · **v3 — post round-2 audit.** Status: owner questions closed (decisions
recorded below); awaiting owner approval of the v3 revisions.

Audit history:
- **Round 1** (on v1): GPT-5.6 UNSOUND (4 blocking) · Grok 4.6 SOUND-WITH-REVISIONS (2
  blocking). All 16 findings dispositioned into v2 (§Audit round 1).
- **Round 2** (on v2, plus repo-grounding + cross-document consistency agents): GPT-5.6 still
  UNSOUND (2 blocking) · Grok 4.6 SOUND-WITH-REVISIONS (1 blocking) · repo sweep: 18/18 claims
  true, 4 surprises · consistency agent: 3 blocking, 8 major. All dispositioned into this v3
  (§Audit round 2).

Inputs: 2026-08-23 Codex research corpus · 2026-08-24 Phase 1 deep-dive brief
(`~/Inbox/notes/research-terroir-visual-platform-phase1-2026-08-24.md`). Raw audit outputs in
the session scratchpad `audit/` dir; agent findings summarized in §Audit round 2.

**Posture (owner-stated):** prototype is for demos and fundraising only; licensing is NOT a
blocker this phase; proper licensing precedes production. Prove the identification system
works, works well, works fast — on the wines that will actually be in the room. ("Biggest
corpus" bias applies to post-Gate-0 breadth, not to the demo index — see D2.)

**Scope note (reopens prior PRD exclusions):** the camera-first personal-cellar PRD
(2026-08-21) explicitly scoped OUT a 3D cellar renderer and pre-gate multi-bottle vision. This
initiative deliberately reopens the 3D renderer (D7, owner-approved); multi-bottle vision
remains OUT until its own feasibility gate. The PRD's unresolved D-005 (container/location
hierarchy) is closed by D7's containers/slots model per the owner's 2026-08-24 sequencing
decision, to be reconciled formally when the Phase 3 PRD supersedes the camera-first PRD.

---

## D1. Identity spine — P2 amended with a global `wine_editions` entity

P2 (`canonical_wines` global / `wine_variants` tenant-scoped / `wine_aliases`, LWIN as alias)
and P3 chunked import are landed (0097–0111). P2 is **amended** (not unchanged): variants gain
a nullable `edition_id`, and one new global table is added.

**`wine_editions` (v3 design — round-2 blocking findings resolved):**

- **Grain: one row = one vintage-level release.** Columns: `id`, `canonical_wine_id` (FK,
  NOT NULL), `vintage smallint NOT NULL` with **`0` = NV** (matching the repo's existing
  `coalesce(vintage, 0)` convention in 0098), `lwin11 text` nullable with a UNIQUE partial
  index. Unique key: `(canonical_wine_id, vintage)` — no nullable key columns, so Postgres
  NULLs-are-distinct cannot admit duplicates.
- **No size in the entity.** Critic scores, community rollups, and LWIN11 are vintage-grain;
  bottle size is not. Format-grain needs (LWIN16/18, per-format market price, global barcode
  maps) are deferred to a future `wine_edition_formats` table — not smuggled in as a nullable
  wildcard column.
- **Unknown ≠ NV.** A variant whose vintage is unresolved gets `edition_id = NULL` — there is
  no "unknown" edition row. Gate 0 refuses to index or demo any variant with a NULL
  `edition_id`; the pilot report counts them.
- **Write posture inherits P2 §8's apparatus** (the six-round-audited pattern from
  `canonical_wines`): global read; client roles cannot insert/update; rows are created only by
  the server-side identity-resolution path; `lwin11` is set only via the same corroboration
  gate that governs `lwin7` on canonical wines — never from a client-supplied value.
- **Backfill with a completion gate:** editions are derived from existing variants
  (canonical_wine_id + vintage); the backfill report lists variants that could not resolve
  (missing canonical, ambiguous vintage) and Gate 0 cannot start until the pilot's 500
  variants are 100% resolved or explicitly quarantined.
- **Migration numbering:** `wine_editions` takes **0112**; P4's files shift +1 to
  **0113–0120** (absorbed by P4's unclaimed 0120–0125 reserve). P4's doc header carries an
  amendment note; its internal `0112`–`0119` file references read +1 until its tickets are cut.

Global attachments (imported ratings, critic scores, LWIN11) key to `wine_edition_id` or
`canonical_wine_id`. Tenant state (inventory, purchases, placements, user ratings/notes) keys
to variant/inventory rows. **`wine_images` is NOT re-keyed** — see D3.

**Legacy reconciliation (repo sweep):** `wine_lineages` (0054–0056) is a pre-P2 cross-tenant
identity attempt that overlaps the P2 spine; Phase 3 must confirm its status (deprecated vs.
still-read) before editions tickets are cut, so we don't ship three competing identity layers.

## D2. Corpus strategy — partner-cellar-first; the demo index is FROZEN

1. **Gate 0 — 500-variant stratified pilot** (see D8 for pass thresholds): dedupe → editions →
   enrichment cascade → verified reference images → scan index for exactly those editions.
2. Full partner cellar (~20k rows → unique editions). **Repo fact:** the import `MAX_ROWS`
   cap is still 5,000 (P3's 100-row apply-chunking is a separate mechanism) — durable staging
   or a cap raise is an explicit work item here; the 20k CSV cannot enter unchanged today.
3. **The investor-demo index is frozen as the partner-edition set.** Bulk layers —
   Wine Images 126K, X-Wines, Open Food Facts, DDGS→Brave — are post-demo breadth work, and
   appending them to the identification index requires a NEW frozen eval (an index append
   changes the candidate neighborhood and invalidates the calibration measured on the small
   set). No silent appends.
4. **WineSensed (897k phone photos): evaluation benchmark + hard negatives ONLY.** Never in
   the reference index; no fine-tuning this phase.

Standing caveats: dataset rows ≠ clean identities; X-Wines Full image archive needs a manifest
count; WineSensed joins via vintage_id, names sparse.

## D3. Image enrichment — land P4 as designed, ONE amendment (not two)

**P4 amendment #1 (edition FK on `wine_images`) is WITHDRAWN** — round-2 consistency finding:
P4 already keys images to `canonical_wine_id` + the `(vintage, size_ml)` value tuple,
honoring P2 §10's explicit "zero schema change" forward-compatibility commitment, and its
scope CHECK/unique indexes and merge/serving tests are built on that shape. Images never had
the tenant-scoping defect (that was ratings/LWIN11). Editions join to images at READ time via
the tuple (`canonical_wine_id` + `vintage`); `wine_images.vintage = NULL` keeps P4's meaning
("applies to any vintage" / base_wine scope), which is distinct from an edition's `vintage = 0`
(NV) — the read-time join maps NV editions to tuple `vintage IS NULL OR vintage = 0` per P4's
`identity_scope`.

**P4 amendment #2 (kept): cylinder unwarp** as a best-effort derivative (raw crop always
retained). **Sequencing fix (round 2):** the unwarp implementation lands as a shared library
inside the Gate-0 scan service (which needs it first, before P4-at-scale); P4's pipeline
reuses it to store derivatives at scale.

P4's §12 `render_3d`/`terroir_render` reserved extension point is **kept reserved but unused
by D7** (template geometry + 2D textures needs no per-wine model rows); it remains available
for optionally caching exported textured-template GLBs later.

Cascade order unchanged: local dataset joins → barcode → DDGS → Brave; multi-channel
verifier; explicit vintage/size conflict = hard reject; cache-don't-hotlink.

## D4. Fast identification — parallel arms with a defined fusion contract

```
photo → preprocess (orient/resize; unwarp best-effort)
      ├─ ZXing barcode ── exact GTIN→edition hit? ──→ SHORT-CIRCUIT (identity authority)
      ├─ PaddleOCR → trigram/BM25 (top-k text candidates, calibrated text score)
      └─ DINOv2 → FAISS exact (top-k visual candidates)
      → UNION → LightGlue rerank (ONLY candidates that have reference images)
      → fusion: geometric + text + visual scores, calibrated → top-3 or ABSTAIN
```

Fusion contract (round-2 fixes; all constants are tunable hypotheses, not evidence):
- **Barcode short-circuits.** An exact GTIN→edition match is accepted directly (with a
  wrong-vintage guard when the GTIN maps to a different vintage than OCR sees); it is never
  demoted by image reranking. **Gate-0 caveat:** the barcode arm is OPTIONAL until barcode
  data exists for the partner's wines (the CSV may carry none; Open Food Facts arrives
  post-demo) — declare its coverage in the pilot report rather than assuming it.
- **Per-arm retention before union** (proposed: OCR top-20, visual top-20, barcode exact
  only), cross-arm score normalization defined in the eval harness, rerank admission = has a
  reference image; OCR-only candidates (no image) survive on calibrated text score and can
  reach the top-3 as "text match" candidates rather than being silently dropped.
- **Output contract binds to tenant inventory:** the service returns ranked
  `wine_edition_id`s; a mandatory tenant-resolution step maps edition → the requesting
  tenant's variants → placements (D7), so a correct match always opens the partner's actual
  bottle. Variants with NULL `edition_id` are not indexed (D1).
- **Demo build: abstain > misidentify.** VLM fallback default-OFF on the investor path
  (abstain + correction search); VLM remains a parser/tie-breaker in the normal product path,
  never identity authority. `wineberto-ner` stays out of the hot path.
- **Eval hygiene:** identity-disjoint tuning / calibration / frozen evaluation sets, including
  out-of-corpus wines, non-wine images, near-duplicate vintages.

**Execution topology (Phase-3 spike, specified not assumed):** one GPU inference box, models
resident (warm), direct image upload from the app to the box, bounded queue with a concurrency
limit and per-stage timeouts; measure cold/warm/concurrent p50/p95 over the 500-variant set
with real phone photos BEFORE tickets freeze. Venue connectivity is load-bearing if the box is
remote — the demo-day plan states which (local box at the venue preferred; else a wired/
verified uplink in preflight). Sub-2s perceived remains the target, spoken only after
measurement.

## D5. Ratings — three stores, one read model, defined aggregation scope

- `user_wine_reviews` — tenant-scoped: user stars (1–5 half-step) + notes, standard RLS.
  **Never feeds global aggregates.** Tenant-local rollups (this restaurant's own average)
  live in the read model, not in the global table.
- `external_rating_events` — imported raw rows (X-Wines etc.) + API-fetched critic values;
  source + provenance; **each event has exactly one subject grain** (`wine_edition_id`
  preferred; `canonical_wine_id` only when the source truly has no vintage). Batch-loaded,
  never written interactively.
- `rating_aggregates` — computed rollups **only from `external_rating_events`**, per edition
  (community avg/count; critic score + source), with lineage. Dedupe rule: when a source has
  both edition-grain and canonical-grain events for the same wine, edition-grain wins and the
  canonical-grain event is excluded from that edition's rollup (no double counting).
- **Repo reconciliation (round 2):** `wines.rating`/`rating_source`/`review_excerpt`
  (migration 0025 — sources incl. `vinous`, `parker`, `aggregate`) is a live legacy critic
  path. The new stores use distinct names (no column collision); Phase 3 includes a ticket to
  migrate 0025 data into `external_rating_events` and repoint its readers at the read model.

**Critic honesty:** Wine-Searcher Wine Check returns an unattributed multi-critic aggregate —
displayed as "aggregated critic score," never "Vinous," until a direct Vinous deal exists
(that deal remains the production/fundraising play; they own Delectable). GWS = second
aggregate. **The Wine-Searcher median field is populated from `average_price`
(`src/lib/wine-intelligence/wine-searcher.ts:196–201` — a documented approximation, not a
silent bug): replace with true median or label the band "avg-based" BEFORE any price/score
display in the demo.** Demo tactic: prefetch + cache critic/community fields for the demo
cellar; "critic score pending" beats a wrong number; no unofficial Vivino calls in a
fundraising room; X-Wines pre-aggregated offline (21M rows never queried live).

## D6. Voice — FULL first cut: intake AND retrieval (owner decision 2026-08-24)

*The round-1 audits recommended intake-only; the owner overrode (recorded as OVERRIDDEN in the
disposition, not "accepted"). The override's risk controls are now hard requirements:*

- **Intake**: push-to-talk batch STT → LLM slot-filling → the same
  `resolve_wine_variants_bulk` identity path as CSV → confirmation UI. Keyterm prompting from
  the tenant's own producer/cuvée vocabulary.
- **Retrieval**: ONE constrained function-calling tool over tenant Postgres.
  **Name→ID resolution happens server-side INSIDE the tool** (trigram identity search for
  wines, exact/fuzzy match for containers/locations) — the LLM never passes raw text filters
  or invented IDs. Ambiguity (multiple matches) returns a disambiguation list, not a guess;
  unresolvable references return an explicit "couldn't find that."
- **Hard gate:** `containers`/`slots` are populated for the demo cellar BEFORE any retrieval
  demo line is rehearsed — D8 sequences this strictly before (not "alongside") the voice
  slice.
- **Phase-3 voice-retrieval eval (new, distinct from the STT vocab eval):** a scored set of
  utterances with expected tool calls and expected result sets — covering wine + location
  resolution, ambiguity, unanswerable/out-of-domain questions, and abstention — with pass
  thresholds set before tickets freeze.
- **STT is the named exception to "no live third-party call on stage"** (query content is
  unknowable in advance, so it cannot be cached): mitigations are a preflight STT health
  check, a rehearsed retry, and a typed-query fallback UI mid-demo. Everything else
  (critic scores, market rates, images) is cached in demo mode.
- Vendor: AssemblyAI first (free tier covers the demo; keyterms in realtime), Deepgram priced
  alternate; decision after the 50-utterance wine-vocab eval.

## D7. 3D substrate — explicit inventory grain; assisted grids; splat gated

**Inventory grain (round-2 blocking fix) — three distinct entities, no slash-objects:**

- `wine_variants` — the tenant SKU (edition projection; D1).
- `inventory_items` (EXISTS today) — stock/acquisition rows: quantity, unit cost,
  acquired_at, currency (0111 constraints). A lot of 12 bottles is one row with qty 12.
- `containers` (typed geometry: rack_grid | fridge_shelves | case | wall) + `slots`
  (coordinates) + **`bottle_placements`** — one row per physical bottle placed:
  (`slot_id`, `inventory_item_id`). Placement is the single location truth.
- **`bins` migrates ONCE into containers/slots** (a bin becomes a container or zone; its
  40 live production rows and the bins e2e suite migrate with it). The v2 "1:1 projection
  with sync rule" option is DELETED — no parallel location trees, no dual-write.
- **Bottle-detail API is keyed to `bottle_placement_id`** (one physical bottle → one
  position, one cost lineage via its inventory item, one identity via variant → edition).
  Unplaced stock falls back to a variant-level card without a position. Response embeds:
  identity (producer/cuvée/vintage/size), label texture URLs + bottle-shape class + aspect
  ratio + UV hints + no-unwarp fallback texture, market rate, purchase cost/acquired_at,
  critic + community scores (D5), producer story, container/slot coordinates.

**Bottles:** template geometry library (Bordeaux/Burgundy/Champagne/flute/Rhône/fortified/
half/magnum), GLB/glTF, react-three-fiber; textures from P4 label derivatives.

**Spaces Track 1 (ships): ASSISTED setup with a bounded contract.** Supported layouts v1:
uniform grid racks and shelf fridges. Flow: photo as backdrop → manual corner calibration
(tap 4 corners to fit the template to the photo's perspective) → confirm rows×cols/shelves →
per-slot edit (add/remove/mark-unusable) → assign bottles. Empty slots are first-class.
Unsupported layouts (irregular racks) get a non-photographic template fallback. Auto grid
inference is a separate SPIKE, not on the critical path.

**Spaces Track 2 (spike-gated overlay, desktop demo only per owner decision):** Polycam splat
→ GaussianSplats3D; mobile FPS spike decides phone availability. luma-web deprecated;
Splatfacto self-host fallback.

## D8. Build sequence

1. **Gate 0 — thin vertical slice with GO/NO-GO thresholds:** editions (0112) + 500-variant
   pilot enrichment → verified reference images → parallel-retrieval scan service on the
   inference box → frozen partner phone-photo benchmark + latency report.
   **Proposed pass thresholds (tunable hypotheses, set finally with the owner before the
   run):** top-1 ≥ 70% and top-3 ≥ 90% on the frozen set · false-accept ≤ 5% at the
   calibrated abstain point · verified-image precision ≥ 98% · warm server-side p95 ≤ 2.5s ·
   100% of pilot variants edition-resolved or quarantined.
   **Failure tree:** miss accuracy → improve references/arms and re-run (do NOT proceed to
   scale); miss latency → topology fix before feature work; miss coverage → widen enrichment
   sources for the pilot only. "Frozen scan proof" = these numbers, published.
2. **Import scale-up + P4 at scale** (0113+ with the unwarp amendment): durable staging or
   MAX_ROWS raise for the 20k CSV; full partner cellar enrichment.
3. **Ratings + notes** (three stores + read model; 0025 legacy migration; WS median fix;
   demo-cellar prefetch).
4. **3D substrate data model + APIs** (containers/slots/placements, bins one-time migration,
   placement-keyed bottle-detail endpoint, texture exports) — strictly before the voice
   retrieval demo; renderer work by Codex in parallel; splat overlay only if the spike passes.
5. **Voice slice — intake AND retrieval** (owner decision), demo lines exercised against
   landed placements; retrieval eval passed first.

Cross-cutting before any investor demo: **demo mode** — prewarmed models, preflight health
checks (incl. STT), cached golden-path assets/responses, explicit timeouts, degraded states;
STT is the sole named live dependency (D6).

## D9. Validation spikes (Phase 3, before tickets freeze)

Original five: STT 50-utterance wine-vocab eval · mobile splat FPS · Wine-Searcher trial + GWS
coverage on ~50 LWIN'd wines (+ written quotes) · X-Wines/WineSensed join rates + X-Wines
image manifest count · DDGS 500-query soak.

Round-1 additions: 6. e2e scan latency on demo hardware (cold/warm/concurrent p50/p95) ·
7. phone-photo-vs-packshot LightGlue survival · 8. assisted-grid UX flow (+ separate
auto-grid feasibility).

**Round-2 additions:** 9. voice-retrieval eval (utterances → expected tool calls/results/
abstentions, D6) · 10. partner-CSV barcode coverage check (does the barcode arm have any data
for Gate 0?) · 11. `wine_lineages` status confirmation (deprecated or live) before editions
tickets.

## Rejected alternatives (unchanged)

Single-vendor recognition (bake-off comparators only) · LLM/VLM as primary identifier ·
text-to-SQL voice retrieval · ANN now (demo index is partner-sized and frozen; ANN revisited
only with the post-demo bulk index and its new eval) · luma-web · Vivino/CellarTracker as
bulk ratings backbone · bins/slots dual-write projection (deleted in v3).

## Top risks (v3)

1. **Gate 0 thresholds unmet** — now an explicit gate with a failure tree, not a surprise.
2. **Phone-photo domain gap** — spike 7 + WineSensed benchmark; abstain calibration bounds
   demo damage.
3. **Corpus join rate on the partner's wines** — pilot measures first; 5,000-row cap is a
   known work item, not a discovery.
4. **Demo-day dependencies** — demo mode; STT is the sole named live dependency with a typed
   fallback.
5. **STT on wine proper nouns** — unmeasured anywhere; eval decides vendor and feasibility.
6. **Licensing cliff at production** — NOT "just ETL": per-source isolation of raw + derived
   artifacts (embeddings, indexes, calibration, aggregates), deletion lineage, rebuildable
   indexes; production replacement planned as a revalidation project.
7. **Schema-change blast radius** — editions (0112) + P4 renumbering + bins migration touch
   landed, production-tested surfaces; Phase 3 tickets carry regression suites for each.

## Owner decisions (Devin, 2026-08-24) — CLOSED

1. **3D demo target: desktop-first.** Splat overlay allowed on desktop; phone follows the FPS
   spike.
2. **Voice first cut: FULL voice — intake AND retrieval.** Owner override of the round-1
   audit recommendation; risk controls in D6 are hard requirements.
3. **Budget approved:** Brave (~$100 worst-case), AssemblyAI free tier, one rented GPU
   inference box (priced in Phase 3).
4. **`wine_editions` now** — v3 assigns it migration 0112 (P4 shifts to 0113–0120). *v3 scope
   note: the images re-key originally bundled with this decision is withdrawn (D3); editions
   still lands first and carries ratings/LWIN11 as approved.*
5. **Ratings display: separate + honest label.** "Aggregated critic score" + community stars;
   "Vinous" appears only after a direct deal.

---

## Audit round 1 (2026-08-24, on v1) — summary

GPT-5.6 (Codex): UNSOUND, 4 blocking / 9 major · Grok 4.6 (OpenRouter): SOUND-WITH-REVISIONS,
2 blocking / 7 major. 16 distinct findings; 15 accepted, 1 modified — resolved in v2:
global editions entity (superseded by v3's redesign), parallel 3-arm retrieval,
measured-before-promised latency, inventory-keyed bottle-detail (superseded by v3's placement
grain), WineSensed eval-only, three-store ratings, aggregate-not-Vinous display, assisted
grid, partner-cellar-first sequencing, demo mode, licensing-revalidation framing, eval-set
hygiene, unwarp amendment, VLM-off/abstain investor build. Row 14 (voice intake-only) was
recorded "Accepted" in v2 — **corrected in v3 to OVERRIDDEN** by the owner's full-voice
decision (mitigations in D6).

## Audit round 2 (2026-08-24, on v2 + repo + docs) — disposition

Lanes: GPT-5.6 re-audit (UNSOUND: 2 blocking, 6 major, 2 minor) · Grok 4.6 re-audit
(SOUND-WITH-REVISIONS: 1 blocking, 7 major, 1 minor) · repo-grounding agent (18/18 claims
verified; 4 surprises) · cross-document consistency agent (3 blocking, 8 major, 2 minor).

| # | Finding (lane) | Disposition | v3 change |
|---|---|---|---|
| 1 | Editions unique key broken by nullable columns; grain conflates vintage & format (GPT-B1, Grok-B1) | **Accepted** | Vintage-grain redesign: vintage NOT NULL 0=NV, unique (canonical, vintage), no size column; formats deferred (D1) |
| 2 | Editions lacks P2-grade RLS/write authorization (Consistency-B3) | **Accepted** | P2 §8 apparatus inherited: server-only writes, corroboration-gated lwin11 (D1) |
| 3 | No migration number; collides with P4's hard-coded 0112–0119 (Consistency-B2) | **Accepted** | Editions = 0112; P4 shifts to 0113–0120; P4 header annotated (D1) |
| 4 | Images amendment mis-justified; breaks P2 §10 zero-schema-change commitment (Consistency-B/M4,5) | **Accepted** | P4 amendment #1 WITHDRAWN; read-time tuple join; NV vs any-vintage semantics defined (D3) |
| 5 | Bottle-detail unit-vs-lot grain undefined; variant/lot/slot slash-objects (GPT-B4, Grok-3) | **Accepted** | Explicit grain: variants / inventory_items / containers+slots+bottle_placements; API keyed to placement (D7) |
| 6 | Photo→edition→tenant-inventory binding unspecified; NULL edition_id unhandled (Grok-2) | **Accepted** | Output contract: ranked editions + mandatory tenant resolution; NULL-edition variants not indexed; backfill gate (D1, D4) |
| 7 | Barcode fused through image reranker; OCR-only candidates dropped; union contract undefined (GPT-2, Grok-5) | **Accepted** | Barcode short-circuit; rerank admission = has reference image; per-arm top-k + normalization; text-only candidates survive (D4) |
| 8 | Gate 0 has no pass thresholds — a measurement, not a gate (GPT-7) | **Accepted** | Go/no-go thresholds + failure tree published in D8 (owner confirms values pre-run) |
| 9 | Bulk-layer append silently invalidates demo calibration (Grok-7) | **Accepted** | Demo index frozen to partner editions; bulk append requires new frozen eval (D2) |
| 10 | Disposition row 14 stale ("intake-only") vs owner's full-voice override; retrieval eval missing (GPT-6, Grok-6, Consistency-B1) | **Accepted** | Row corrected to OVERRIDDEN; server-side in-tool ID resolution; slots hard gate; new voice-retrieval eval = spike 9 (D6, D9) |
| 11 | Bins "migrate OR project" is two architectures (Grok-8) | **Accepted** | Projection option deleted; one-time bins→containers/slots migration incl. 40 prod rows + e2e (D7) |
| 12 | Topology still underspecified; STT/remote-box make "no live call load-bearing" false (GPT-3, Consistency-12) | **Accepted** | Topology specified (resident models, queue, timeouts, local-box preference); STT named sole live exception with typed fallback (D4, D6, D8) |
| 13 | Ratings aggregation scope undefined; tenant reviews could leak into global aggregates (GPT-5, Grok-4) | **Accepted** | Aggregates from external events only; one grain per event; dedupe rule; tenant rollups stay in read model (D5) |
| 14 | Assisted grid lacks a bounded contract (GPT-8) | **Accepted** | Supported-layouts v1, corner calibration, per-slot edit, empty states, non-photo fallback (D7) |
| 15 | Gate-0 barcode arm has no data source pre-bulk (GPT-9) | **Accepted** | Barcode arm optional for Gate 0; partner-CSV barcode coverage = spike 10 (D4, D9) |
| 16 | Unwarp waits on P4-at-scale but Gate 0 needs it (Grok-9) | **Accepted** | Unwarp ships as shared lib inside Gate-0 scan service; P4 reuses (D3) |
| 17 | Import MAX_ROWS still 5,000 — 20k CSV blocked (Repo-9) | **Accepted** | Explicit staging/cap work item in D8 step 2 |
| 18 | `wines.rating`/`rating_source` legacy critic column collides with new ratings work (Repo-17) | **Accepted** | Distinct names + Phase-3 migration ticket for 0025 data (D5) |
| 19 | `wine_lineages` pre-P2 identity layer unaddressed (Repo-surprise) | **Accepted** | Spike 11: confirm status before editions tickets (D1, D9) |
| 20 | WS bug is at :196–201 and is a documented approximation, not hidden (Repo-6) | **Accepted** | Citation + framing corrected; fix-before-display requirement stands (D5) |
| 21 | Synthesis never names the PRD exclusions it reopens; PRD D-005 gate unaddressed (Consistency-10,11) | **Accepted** | Scope note added; D-005 closed via D7 pending Phase-3 PRD reconciliation (preamble) |
| 22 | P4 §12 render_3d extension point orphaned by template approach (Consistency-7) | **Accepted** | Explicit disposition: reserved, unused by D7, available for cached template exports (D3) |
| 23 | Stale v1 sentences: header status, "P2 unchanged", posture banner, task-list §11 ref & superseded 1d entry (Grok-9m, GPT-10, Consistency-6,8,9,13) | **Accepted** | Header/status fixed; "P2 amended"; posture scoped to post-Gate-0; task list annotated + §12 ref fixed + re-weight item closed |
