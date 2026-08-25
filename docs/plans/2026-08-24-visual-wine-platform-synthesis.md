# Visual Wine Platform — Phase 2 Synthesis (architecture recommendation)

Date: 2026-08-24 · **v4 — post round-3 verdict pass.** Status: owner questions closed
(decisions recorded below); awaiting owner approval.

Audit history:
- **Round 1** (on v1): GPT-5.6 UNSOUND (4 blocking) · Grok 4.6 SOUND-WITH-REVISIONS (2
  blocking). All 16 findings dispositioned into v2 (§Audit round 1).
- **Round 2** (on v2, plus repo-grounding + cross-document consistency agents): GPT-5.6 still
  UNSOUND (2 blocking) · Grok 4.6 SOUND-WITH-REVISIONS (1 blocking) · repo sweep: 18/18 claims
  true, 4 surprises · consistency agent: 3 blocking, 8 major. All dispositioned into v3
  (§Audit round 2).
- **Round 3** (final verdict pass on v3): Grok 4.6 **SOUND-WITH-REVISIONS — all six round-2
  blockers confirmed closed**; 6 majors on v3's new surface. GPT-5.6 UNSOUND — credits the
  grain/re-key/disposition fixes, 3 blockers on authorization/integrity/eval contracts. The
  two sets converge; all 15 distinct findings applied in this v4 (§Audit round 3).

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

**`wine_editions` (v3/v4 design — round-2 and round-3 findings resolved):**

- **Grain: one row = one vintage-level release.** Columns: `id`, `canonical_wine_id` (FK,
  NOT NULL), `vintage smallint NOT NULL` with **`0` = NV** as an explicit sentinel (the
  repo's `coalesce(vintage, 0)` index plumbing is mechanically compatible but is NOT the
  semantic basis — see the backfill spec below), `lwin11 text` nullable with a UNIQUE partial
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
  the server-side identity-resolution path. `lwin11` gets a partial unique index
  (`WHERE lwin11 IS NOT NULL`) and is set only via a corroboration gate that validates BOTH
  the canonical identity (as `lwin7` does today) AND that the LWIN11's vintage digits agree
  with the edition's vintage — never from a client-supplied value. A `CHECK` bounds vintage to
  valid years or 0.
- **`edition_id` linking is server-only too (round 3):** the editions table being protected is
  not enough — a tenant client that can update its own variant row could attach it to an
  arbitrary edition and poison identification, ratings, and placement resolution. Client
  writes to `wine_variants.edition_id` are revoked (column guard/trigger); linking happens
  only through a server-side resolution function that records match method + provenance on
  the variant's alias row.
- **Backfill spec (NV is never inferred from NULL):** `vintage IS NOT NULL AND vintage <> 0`
  → dated edition. `vintage = 0` is written only where an explicit NV flag/source attests it.
  Legacy `NULL` vintages are an unknown mix of true-NV and unresolved — they go to a
  quarantine queue with a named NV-classification pass (rule + human review), NOT an
  automatic conversion. (The repo's `coalesce(vintage, 0)` convention is mechanical index
  plumbing, not NV semantics — it is not precedent for the backfill.) The backfill report
  counts known-NV / dated / quarantined separately, and Gate 0 cannot start until the pilot's
  500 variants are 100% resolved or explicitly quarantined.
- **Migration manifest (one numbering scheme, executable):** `wine_editions` = **0112**, and
  P4's files are RENAMED to **0113–0120 in the same commit that lands 0112** — no standing
  "read +1" rule; the P4 doc's inline references are updated when its tickets are cut from
  the manifest, and a CI uniqueness/order check guards the range. Containers/slots/placements
  (D7) are assigned **0121+** now so the 0112 collision cannot repeat. The manifest
  (0112–0121+, with dependencies) is published in the Phase 3 spec list before any migration
  file is created.

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
a **deterministic scope resolver** (round-3 fix — the naive `(canonical, vintage)` join would
have dropped any-vintage packshots from dated editions, emptying the LightGlue admission set
and leaving 3D bottles textureless):

- Dated edition (vintage = Y): `canonical_wine_id` match AND (`images.vintage = Y` OR
  `images.vintage IS NULL`) — NULL keeps P4's "any vintage" meaning and DOES attach to dated
  editions as base-wine fallback.
- NV edition (vintage = 0): `images.vintage IS NULL OR images.vintage = 0`.
- An explicit-NV image (`vintage = 0`) never attaches to a dated edition.
- Size precedence for a requesting variant: exact vintage + exact size → exact vintage + any
  size → any vintage + exact size → base fallback. The identification index may admit all
  sizes; bottle-detail textures prefer the variant's `size_ml` via that fallback chain.
  On both axes: `0` = explicit NV, `NULL` = wildcard.

**P4 amendment #2 (kept): cylinder unwarp** as a best-effort derivative (raw crop always
retained). **Sequencing fix (round 2):** the unwarp implementation lands as a shared library
inside the Gate-0 scan service (which needs it first, before P4-at-scale); P4's pipeline
reuses it to store derivatives at scale. **Round-3 addition:** unwarp derivatives are produced
for Gate-0 REFERENCE images too, not just query preprocessing — otherwise spike 7 measures a
self-inflicted domain gap.

P4's §12 `render_3d`/`terroir_render` reserved extension point is **kept reserved but unused
by D7** (template geometry + 2D textures needs no per-wine model rows); it remains available
for optionally caching exported textured-template GLBs later.

Cascade order unchanged: local dataset joins → barcode → DDGS → Brave; multi-channel
verifier; explicit vintage/size conflict = hard reject; cache-don't-hotlink.

## D4. Fast identification — parallel arms with a defined fusion contract

```
photo → preprocess (orient/resize; unwarp best-effort)
      ├─ ZXing barcode ── verified 1:1 GTIN map? ──→ SHORT-CIRCUIT (see contract)
      ├─ PaddleOCR → trigram/BM25 (top-k text candidates, calibrated text score)
      └─ DINOv2 → FAISS exact (top-k visual candidates)
      → UNION → LightGlue rerank (ONLY candidates that have reference images)
      → fusion: geometric + text + visual scores, calibrated → top-3 or ABSTAIN
```

Fusion contract (round-2 + round-3 fixes; all constants are tunable hypotheses, not evidence):
- **Barcode contract (round-3 rewrite — GTINs are size-grain and vintage-reusable):** a GTIN
  resolves to `(canonical_wine_id, size_ml, vintage?)` via a small pilot barcode-map table
  (or `wine_edition_formats` when it lands) — barcode is identity authority ONLY for a
  verified one-to-one GTIN→edition mapping. Vintage-ambiguous GTIN + a disagreeing
  high-confidence OCR vintage → **ABSTAIN** (never a pick, never a demotion fight);
  low/no OCR vintage → accept the GTIN's wine without inventing a vintage. Barcode arm stays
  OPTIONAL for Gate 0 (the CSV may carry no GTINs; Open Food Facts arrives post-demo); spike
  10 reports GTIN vintage-uniqueness, not just coverage.
- **Per-arm retention before union** (proposed: OCR top-20, visual top-20, barcode as above),
  cross-arm score normalization defined in the eval harness, rerank admission = has a
  reference image; OCR-only candidates (no image) survive on calibrated text score and can
  reach the top-3 as "text match" candidates rather than being silently dropped.
- **Output contract binds to tenant inventory — and the edition→bottle map is 1:N, never a
  silent pick (round 3):** the service returns ranked `wine_edition_id`s PLUS the resolved
  set of the requesting tenant's `bottle_placement_id`s per edition. Zero placements → an
  "in catalog, not placed" variant card; exactly one → direct-open; more than one → highlight
  all / picker (format disambiguation order: GTIN size > OCR size > all same-edition
  placements). Label recognition identifies the edition, not a physical unit — the UI never
  pretends otherwise. Variants with NULL `edition_id` are not indexed (D1).
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
- `rating_aggregates` — computed rollups **only from `external_rating_events`**, with
  lineage, kept at BOTH grains separately (round-3 fix): edition-grain aggregates are built
  only from edition-grain events; canonical-grain aggregates only from canonical-grain events.
  **Canonical events are never materialized/fanned out into edition rollups** — a non-vintage
  score must not masquerade as vintage-specific. The read model shows the edition aggregate
  when one exists, else the canonical aggregate explicitly labeled as a base-wine score.
  Dedupe rule within a grain: one source counts once per subject.
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
- `containers` (typed geometry: rack_grid | fridge_shelves | case | wall | **zone** — the
  generic type added round-3 so all 40 live bins can migrate even where no geometry is known)
  + `slots` (coordinates) + **`bottle_placements`** — one row per physical bottle placed:
  (`slot_id`, `inventory_item_id`). Placement is the single location truth.
- **Integrity + tenancy contract (round-3 blocking fix — these are schema invariants, not
  ticket details):** `restaurant_id` on the whole hierarchy with standard RLS; composite
  same-tenant FKs so a placement can never join a slot and an inventory item from different
  tenants; `UNIQUE (slot_id)` over ACTIVE placements (one bottle per slot); one active
  placement per physical bottle; a transactional guard enforcing
  `count(active placements of item) ≤ inventory_items.quantity`; a place-from-lot operation
  that creates one placement row per bottle (no qty-on-slot shortcut). These invariants ship
  IN the migration + regression suite, not as follow-ups.
- **`bins` migrates ONCE into containers/slots** — implemented as a location FK move off
  `inventory_items`/`bins` onto placements (single location truth), not a table rename; the
  40 live production rows and the bins e2e suite migrate with it. Migration numbers **0121+**
  (assigned now; P4 consumes through 0120). The v2 "1:1 projection with sync rule" option is
  DELETED — no parallel location trees, no dual-write.
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
   **Eval contract (round-3 rewrite — the gate must be ungameable):** metrics use query-level
   denominators; **an abstention on an in-corpus query counts as a top-1/top-3 failure**
   (accuracy cannot be bought by abstaining); a minimum acceptance-coverage floor accompanies
   the false-accept ceiling; in-corpus and out-of-corpus false-accepts are reported
   separately; a minimum reference-image-coverage floor is reported. Two evaluation sets:
   a working frozen set that the failure tree may inspect, and a **sealed holdout that never
   informs remediation** — a failed run that triggers fixes requires a NEWLY SAMPLED holdout
   for the retest.
   **Proposed pass thresholds (tunable hypotheses, set finally with the owner before the
   run):** top-1 ≥ 70% and top-3 ≥ 90% (abstentions counted as misses) · false-accept ≤ 5%
   with acceptance coverage ≥ 80% · verified-image precision ≥ 98% with reference coverage
   reported · warm server-side p95 ≤ 2.5s · 100% of pilot variants edition-resolved or
   quarantined.
   **Failure tree:** miss accuracy → improve references/arms, re-run on a fresh holdout (do
   NOT proceed to scale); miss latency → topology fix before feature work; miss coverage →
   widen enrichment sources for the pilot only. "Frozen scan proof" = these numbers,
   published.
2. **Import scale-up + P4 at scale** (0113+ with the unwarp amendment): durable staging or
   MAX_ROWS raise for the 20k CSV; full partner cellar enrichment.
   **Gate 0-R (round-3 addition):** growing the index 500 → full partner cellar is itself a
   neighborhood change that invalidates Gate-0 calibration. Before any investor rehearsal,
   rebuild the frozen eval on the FINAL partner-edition index (with the room's bottles in the
   eval set), same metric family and thresholds. No silent 500→full cutover.
3. **Ratings + notes** (three stores + read model; 0025 legacy migration; WS median fix;
   demo-cellar prefetch).
4. **3D substrate data model + APIs** (containers/slots/placements, bins one-time migration,
   placement-keyed bottle-detail endpoint, texture exports) — strictly before the voice
   retrieval demo; renderer work by Codex in parallel; splat overlay only if the spike passes.
5. **Voice slice — intake AND retrieval** (owner decision), demo lines exercised against
   landed placements; retrieval eval passed first.

Cross-cutting before any investor demo: **demo mode** — prewarmed models, preflight health
checks (incl. STT AND the inference box), cached golden-path assets/responses, explicit
timeouts, degraded states. STT is the sole live **third-party API** on stage (D6); the GPU
inference box is a live first-party dependency and gets the same preflight + degrade
treatment (cached golden-path scan results as last resort).

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

## Audit round 3 (2026-08-24, final verdict pass on v3) — disposition

Verdicts: **Grok 4.6: SOUND-WITH-REVISIONS — all six round-2 blockers confirmed closed**
("one-spec-pass repairs, not a third redesign of the spine") · GPT-5.6: UNSOUND — credits the
grain/re-key/disposition fixes, holds 3 blockers on authorization/integrity/eval contracts.
The two finding sets converge; 15 distinct findings, all accepted into this v4.

| # | Finding (lane) | v4 change |
|---|---|---|
| 1 | Gate-0 eval gameable: abstentions uncounted, no acceptance floor, frozen set doubles as tuning set (GPT-B1) | Eval contract rewritten: abstain = miss in-corpus, acceptance-coverage floor, split false-accept reporting, sealed holdout + fresh holdout on retest (D8.1) |
| 2 | `wine_variants.edition_id` client-writable → edition poisoning; LWIN11 vintage unvalidated (GPT-B2) | Server-only linking function with provenance; client writes revoked; LWIN11 gate validates canonical + vintage agreement (D1) |
| 3 | Containers/slots/placements lack tenancy + integrity invariants (GPT-B3, Grok-6) | RLS + composite same-tenant FKs, unique active slot, placement-count ≤ lot qty, place-from-lot op — shipped in the migration + regression suite (D7) |
| 4 | Edition→bottle map is 1:N; silent pick = live demo failure (GPT-4, Grok-2) | Scan returns editions + resolved placement sets; 0/1/N placement UX defined; recognition claims edition, not physical unit (D4) |
| 5 | Image join drops any-vintage packshots from dated editions (Grok-1, GPT-5) | Deterministic scope resolver: NULL wildcard attaches to dated editions; vintage=0 never does; size precedence chain (D3) |
| 6 | Barcode authority contradicts deferred formats; GTINs size-grain/vintage-reused (GPT-6, Grok-5) | Barcode contract rewritten: pilot GTIN map, authority only for verified 1:1, ambiguity → ABSTAIN; spike 10 reports vintage-uniqueness (D4) |
| 7 | NV backfill cannot be derived from NULL vintages; coalesce is not NV semantics (GPT-7, Grok-4) | Backfill spec: explicit-NV evidence required for 0; NULLs quarantined with named classification pass; counts reported (D1) |
| 8 | "Read +1" P4 numbering is not executable (GPT-8, Grok-7b) | P4 files renamed 0113–0120 in the same commit as 0112; published manifest 0112–0121+ with CI order check (D1); P4 doc note updated |
| 9 | Canonical-grain scores must not fan out into edition rollups (GPT-9) | Two-grain aggregates, no materialized fan-out, labeled base-wine fallback in read model (D5) |
| 10 | 500→full-cellar index growth silently invalidates calibration (Grok-3) | Gate 0-R: pre-demo re-eval on the final partner index, room bottles in eval set (D8.2) |
| 11 | GPU box is also a live demo dependency (Grok-7a) | STT = sole live third-party API; box gets same preflight/degrade + cached golden path (D8) |
| 12 | Four container types can't hold all 40 live bins (Grok-7d) | Generic `zone` type added (D7) |
| 13 | Unwarp only on queries = self-inflicted domain gap in spike 7 (Grok-7e) | Unwarp derivatives produced for Gate-0 references too (D3) |
| 14 | `lwin11` partial-index predicate unstated (Grok-7c) | `WHERE lwin11 IS NOT NULL` stated (D1) |
| 15 | Bins migration is an FK move, not a rename (Grok-6) | Stated explicitly; migration numbers 0121+ assigned (D7) |

Residual: GPT-5.6's round-3 verdict conditions SOUND-WITH-REVISIONS/SOUND on exactly these
fixes plus re-review; findings below the synthesis's altitude (constraint DDL, eval harness
mechanics) are Phase-3 spec/ticket content by design.
