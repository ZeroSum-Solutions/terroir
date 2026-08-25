# Visual Wine Platform — Phase 2 Synthesis (architecture recommendation)

Date: 2026-08-24 · **v2 — post-audit.** v1 was adversarially audited by GPT-5.6 (Codex lane;
verdict UNSOUND, 4 blocking) and Grok 4.6 (OpenRouter; verdict SOUND-WITH-REVISIONS, 2
blocking). All blocking and major findings are dispositioned in §Audit at the end; this v2
incorporates every accepted change. Status: awaiting owner review + decisions.

Inputs: the 2026-08-23 Codex research corpus (4 docs, `~/Documents/Codex/2026-08-23/hey-x20/outputs/`)
and the 2026-08-24 Phase 1 deep-dive brief
(`~/Inbox/notes/research-terroir-visual-platform-phase1-2026-08-24.md`). Facts were byte-verified
in their source runs; audit raw outputs:
`/private/tmp/claude-501/-Users-zero-projects-terroir-vw/9bac7700-dab2-4dd7-af28-a9418ed0fdec/scratchpad/audit/`
(copy in this doc's git history via §Audit).

**Posture (owner-stated):** prototype is for demos and fundraising only; licensing is NOT a
blocker this phase; proper licensing precedes production. Prove the identification system works,
works well, works fast — on the wines that will actually be in the room.

---

## D1. Identity spine — landed core + one NEW global entity

P2 (`canonical_wines` global / `wine_variants` tenant-scoped / `wine_aliases`, LWIN as alias)
and P3 chunked import are landed (0097–0111) and unchanged.

**NEW (audit-driven, both auditors blocking):** `wine_variants.restaurant_id` is NOT NULL —
tenant-scoped — so nothing global (community ratings, vintage-scoped imagery, LWIN11) may
reference `wine_variant_id`. Introduce a global **`wine_editions`** table:
`id, canonical_wine_id, vintage (nullable = NV), size_ml (nullable = any), lwin11 alias` with a
unique key on (canonical_wine_id, vintage, size_ml). `wine_variants` becomes the tenant
*inventory projection* of an edition (nullable `edition_id` FK, backfilled by the same
normalization P2 uses). Global attachments (images, imported ratings, critic scores) key to
`canonical_wine_id` or `wine_edition_id`; tenant state (inventory, purchase, position, user
ratings/notes) keys to variant/inventory rows. This replaces P4's plain vintage/size columns on
`wine_images` with a nullable `wine_edition_id` (P4 amendment #1).

## D2. Corpus strategy — partner-cellar-first, bulk corpus second (INVERTED per audit)

The demo index is built from the **partner CSV's own wines**, not the biggest pile:

1. **Gate 0 — 500-variant stratified pilot:** dedupe → editions → enrichment cascade → verified
   reference images → scan index for exactly those editions. Coverage/precision report.
2. Then the full partner cellar (~20k rows → unique editions).
3. Only after the scan proof is frozen: bulk layers for breadth —
   Wine Images 126K (packshots), X-Wines (metadata + ratings rollups), Open Food Facts
   (barcode), DDGS→Brave (gap fill).
4. **WineSensed (897k phone photos): evaluation benchmark + hard-negative set ONLY.** Never in
   the reference index; no fine-tuning in this phase (an unscoped research project and a
   licensing-story poison). Its job is to be the query distribution we test against.

Standing caveats: dataset rows ≠ clean identities; X-Wines Full image archive needs a manifest
count; WineSensed joins via vintage_id, names are sparse.

## D3. Image enrichment — land P4 WITH two amendments

P4 (0112–0119 reserved) builds as designed EXCEPT:

1. **`wine_edition_id`** (nullable FK) replaces reliance on plain vintage/size_ml columns for
   vintage-scoped attachment (D1).
2. **Cylinder unwarp is a best-effort derivative in the P4 contract now** (raw crop always
   retained; unwarp can fail open on angle/partial shots), because D4 (OCR pre-step) and D7
   (3D label texture) both consume it — bolting it on later means a second image schema.

Cascade order unchanged: local dataset joins → barcode → DDGS → Brave; multi-channel candidate
verifier; explicit vintage/size conflict = hard reject; cache-don't-hotlink.

## D4. Fast identification — parallel multimodal retrieval, measured before promised

**Revised shape (audit: OCR must not gate the visual path):**

```
photo → preprocess (orient/resize; unwarp best-effort)
      ├─ ZXing barcode ─────────────┐
      ├─ PaddleOCR → trigram/BM25 ──┼─ UNION candidates
      └─ DINOv2 → FAISS (exact) ────┘
      → LightGlue geometric rerank (top 5–10)
      → fused, calibrated confidence → top-3 or ABSTAIN
```

- The three retrieval arms run in **parallel** and their candidates are unioned before rerank —
  glare/curvature/stylized type can kill OCR without killing the match.
- **Demo/investor build: abstain > misidentify.** A wrong wine in front of a wine-native
  audience is the worst outcome. VLM fallback is default-OFF in the investor path (abstain +
  correction search instead); VLM remains available in the normal product path as
  parser/tie-breaker, never identity authority.
- `wineberto-ner` is OUT of the hot path (candidate for offline enrichment only).
- **Execution topology is a Phase-3 spike, not an assumption:** this stack is a Python/GPU
  service that doesn't exist in the TS app. Stand up one inference box (models warm), run the
  full stack over the 500-variant set with real phone photos, measure cold/warm/concurrent
  p50/p95 — BEFORE tickets freeze and before any latency number is spoken aloud. Sub-2s
  perceived is the target, not a claim.
- Exact FAISS `IndexFlatIP` holds because the DEMO index is partner-cellar-sized (D2
  inversion); revisit ANN only when an index actually exceeds what exact search sustains.
- Eval design: identity-disjoint tuning / calibration / frozen evaluation sets, including
  out-of-corpus wines, non-wine images, and near-duplicate vintages, so calibration isn't
  scored on the set that selected the architecture.

## D5. Ratings — three stores + one read model; honest critic attribution

**Schema (revised per audit — one table conflated too many things):**

- `user_wine_reviews` — tenant-scoped: user stars (1–5 half-step) + notes, RLS like all tenant
  rows.
- `external_rating_events` — imported raw rows (X-Wines etc.), source + provenance, keyed to
  `wine_edition_id`/`canonical_wine_id`, batch-loaded, never written interactively.
- `rating_aggregates` — computed rollups per edition (community avg/count; critic score +
  source), with lineage to the events/API call that produced them.
- One read model / API view unifies them for display. **Critic and community display
  separately** (also the cleaner licensing story).

**Critic layer honesty (audit):** Wine-Searcher Wine Check returns an **unattributed
multi-critic aggregate** — the UI may not present it as "Vinous" coverage. Vinous (partner's
pick) becomes nameable only via a direct licensing deal — which stays the production/
fundraising play (200k+ notes; they own Delectable). GlobalWineScore = second aggregate.
**Fix the Wine-Searcher average-vs-median bug (`src/lib/wine-intelligence/wine-searcher.ts:178`)
before any score is displayed**, not "when touched."

**Demo tactic:** prefetch + cache critic/community fields for the demo cellar only; "critic
score pending" state beats a wrong number; **no unofficial Vivino calls in a fundraising
room**. X-Wines pre-aggregated to edition rollups offline (21M raw rows are never queried
live).

## D6. Voice — FULL first cut: intake AND retrieval (owner decision 2026-08-24)

*The audit recommended intake-only; the owner chose both. The risk is managed, not ignored:*

- **Intake**: push-to-talk batch STT → LLM slot-filling → the same
  `resolve_wine_variants_bulk` identity path as CSV → confirmation UI. Keyterm prompting from
  the tenant's own producer/cuvée vocabulary. Needs nothing from ratings or 3D.
- **Retrieval**: constrained function-calling tool over tenant Postgres; names resolved to IDs
  via trigram BEFORE filters (text filters are the benchmark's known weak spot); no free-form
  SQL. Hard dependency: `containers`/`slots` must land before location queries work — D8
  sequences the 3D data model ahead of/alongside the voice slice.
- **Failure envelope (demo-critical):** an unresolvable wine/location gets an explicit
  "couldn't find that" response — never a guess; the Phase 3 voice eval includes unscripted
  out-of-domain questions so the envelope is measured before an investor probes it.
- Vendor: AssemblyAI first (free tier 185h/333h covers the demo; keyterms built into realtime),
  Deepgram priced alternate; decision AFTER the 50-utterance wine-vocab eval.

## D7. 3D substrate — manual grids ship; every "auto" is a spike

- **Bottles:** template geometry library (Bordeaux/Burgundy/Champagne/flute/Rhône/fortified/
  half/magnum), GLB/glTF, react-three-fiber; textures = P4 `label_front`/`label_back`
  derivatives. **Renderer texture contract includes aspect ratio, UV placement hints, and a
  no-unwarp fallback** (raw crop) so a failed unwarp degrades instead of breaking.
- **Spaces Track 1 (ships): ASSISTED setup, not auto-vision.** User photographs the rack →
  photo is the visual backdrop → user confirms/adjusts rows×cols×zones through a manual
  template flow (tap-to-correct). Auto grid inference from a photo is an unspiked vision
  problem (occlusion, reflections, empty slots) — it is a SPIKE, and a wrong slot map in front
  of an investor is worse than a 30-second manual setup.
- **Spaces Track 2 (spike-gated overlay):** Polycam gaussian splat (20–200 photos / mp4) via
  GaussianSplats3D; mobile FPS spike decides whether it appears in the demo at all.
  luma-web deprecated; Splatfacto = self-host fallback.
- **Data model — single source of truth:** `containers` (typed geometry) + `slots`, where slot
  IS the inventory location (bins migrate to slots, or slots are a strict 1:1 projection of
  bins with a defined sync rule — no parallel location trees).
- **Bottle-detail API: keyed to the inventory unit/lot, not the variant** (a variant can sit in
  many slots). Response: inventory unit (position, purchase cost, acquisition date) + embedded
  shared identity/edition data (producer/cuvée/vintage/size, texture URLs + bottle-shape
  class, market rate, critic/community scores, producer story).

## D8. Build sequence (REVISED — vertical slice first)

1. **Gate 0 — thin vertical slice:** editions table + 500-variant pilot enrichment → verified
   reference images → parallel-retrieval scan service on one inference box → frozen phone-photo
   benchmark + latency report. *This is the fundable proof and everything else waits on it.*
2. **P4 image enrichment at scale** (0112+ with the two amendments), full partner cellar.
3. **Ratings + notes** (three stores + read model; demo-cellar critic prefetch; WS bug fix).
4. **3D substrate data model + APIs** (containers/slots, inventory-keyed bottle-detail
   endpoint, texture exports) — pulled ahead of voice because voice retrieval depends on
   slots (owner chose full voice); renderer work by Codex proceeds in parallel; splat overlay
   only if the spike passes (desktop demo only, per owner decision).
5. **Voice slice — intake AND retrieval** (full first cut per owner decision; retrieval demo
   lines exercised against the landed containers/slots).

Plus a cross-cutting deliverable before any investor demo: **demo mode** — prewarmed models,
preflight health checks, cached golden-path assets and external responses (critic scores,
market rates), explicit timeouts, graceful degraded states for every external dependency.

## D9. Validation spikes (Phase 3, before tickets freeze)

Original five: STT 50-utterance wine-vocab eval · mobile splat FPS · Wine-Searcher trial + GWS
coverage on ~50 LWIN'd wines (+ written quotes) · X-Wines/WineSensed join rates + X-Wines image
manifest count · DDGS 500-query soak.

**Added by audit (the actual demo-killers):**
6. End-to-end scan latency on demo hardware (full stack, one inference box, cold/warm/concurrent
   p50/p95).
7. Phone-photo-vs-packshot verification quality (does LightGlue rerank survive the domain gap?).
8. Assisted-grid UX flow (and separately, whether auto-grid is worth pursuing at all).

## Rejected alternatives (unchanged from v1)

Single-vendor recognition (InVintory/WineEngine — bake-off comparators only) · LLM/VLM as
primary identifier · text-to-SQL voice retrieval · ANN now · luma-web · Vivino/CellarTracker as
bulk ratings backbone.

## Top risks (re-prioritized)

1. **Scan latency/topology unproven** — the headline claim has no measured deployment yet;
   Gate 0 + spike 6 exist to close this first.
2. **Phone-photo domain gap** — packshot references vs handheld queries; WineSensed benchmark +
   spike 7 measure it; abstain-calibration bounds the demo damage.
3. **Corpus join rate on the partner's wines** — pilot measures before anything scales.
4. **Demo-day external dependencies** — mitigated by demo mode (cached, prewarmed, degraded
   states); no live third-party call is load-bearing on stage.
5. **STT on wine proper nouns** — unmeasured anywhere; eval decides vendor and feasibility.
6. **Licensing cliff at production** — NOT "just ETL": derived artifacts (embeddings, indexes,
   calibration, aggregates) inherit source dependencies. Mitigation: per-source isolation of
   raw + derived artifacts, rebuildable indexes, deletion lineage; production replacement is
   planned as a *revalidation project*.

## Owner decisions (Devin, 2026-08-24) — questions CLOSED

1. **3D demo target: desktop-first.** Splat overlay allowed in the desktop demo; phone version
   follows only after the mobile FPS spike passes.
2. **Voice first cut: FULL voice — intake AND retrieval.** *Owner override of the audit
   recommendation (intake-only).* Consequences absorbed into the plan: `containers`/`slots`
   must land BEFORE the voice retrieval demo (3D substrate data model moves ahead of/alongside
   the voice slice in D8); the text-filter weakness is hardened, not dodged — every name in an
   utterance resolves to IDs via trigram identity search before filtering, unresolvable
   references get an explicit "couldn't find that wine/location" response (never a guess), and
   the voice-retrieval eval in Phase 3 must include unscripted out-of-domain questions so we
   know the failure envelope before an investor finds it.
3. **Budget approved:** Brave (~$100 worst-case), AssemblyAI free tier, one rented GPU
   inference box for the scan service (price it in Phase 3).
4. **`wine_editions` now.** Global editions entity migrates before P4 0112 lands; P4 carries
   both amendments.
5. **Ratings display: separate + honest label.** "Aggregated critic score" + community stars;
   "Vinous" appears only after a direct deal.

---

## Audit — verdicts and disposition (2026-08-24)

**GPT-5.6 (Codex): UNSOUND** (as v1) — 4 blocking, 9 major.
**Grok 4.6 (OpenRouter): SOUND-WITH-REVISIONS** — 2 blocking, 7 major.
Raw outputs: `codex-audit.out` / `grok-audit.out` in the session audit dir. Every blocking and
major finding accepted or modified below; v2 is the result. No finding was rejected outright.

| # | Finding (auditor) | Disposition | v2 change |
|---|---|---|---|
| 1 | Global ratings/images can't hang on tenant-scoped variants (GPT-1/6, Grok-1) | **Accepted** | New global `wine_editions`; P4 amendment #1 (D1, D3) |
| 2 | OCR gates the visual path → recall bottleneck (GPT-2) | **Accepted** | Parallel 3-arm retrieval, union before rerank (D4) |
| 3 | No execution topology behind the latency claim (GPT-3, Grok-5) | **Accepted** | Gate-0 inference-box spike; latency measured before promised; wineberto out of hot path (D4, D9) |
| 4 | Bottle-detail API mis-keyed to variant (GPT-4) | **Accepted** | Keyed to inventory unit/lot (D7) |
| 5 | "WineSensed training" undefined / poisonous (GPT-5, Grok-3) | **Accepted** | Benchmark + hard negatives only; no fine-tune, never in reference index (D2) |
| 6 | Single ratings table conflates concerns (GPT-8, Grok-7) | **Accepted** | Three stores + read model; edition rollups offline; demo prefetch; WS bug fixed pre-display (D5) |
| 7 | Vinous can't be the visible flagship via an unattributed aggregate (GPT-9) | **Accepted** | Display as aggregate; Vinous named only post-deal (D5) |
| 8 | Auto grid inference unspiked; "not at risk" false (GPT-10, Grok-6) | **Accepted** | Assisted manual setup ships; auto-grid is a spike; slots = single location truth (D7) |
| 9 | P4-first sequencing vs. scan-proof goal; biggest-first contradiction (GPT-11, Grok-2) | **Accepted** | Partner-cellar-first inversion; Gate-0 vertical slice (D2, D8) |
| 10 | No demo-resilience architecture (GPT-12, Grok-9) | **Accepted** | Demo mode deliverable; no live third-party call load-bearing (D8) |
| 11 | "Licensing swap = ETL" overclaims (GPT-13) | **Accepted** | Reframed as revalidation project with artifact isolation (Top risks) |
| 12 | Calibration/eval set hygiene (GPT-7) | **Accepted** | Disjoint tuning/calibration/frozen-eval sets (D4) |
| 13 | Unwarp + texture contract missing from P4 (Grok-4) | **Accepted** | P4 amendment #2; renderer texture contract with fallback (D3, D7) |
| 14 | Voice retrieval before slots; unscripted Q&A risk (Grok-8) | **Accepted** | Intake-only first cut; retrieval slips (D6) |
| 15 | VLM fallback fires on stage; abstain > misidentify (Grok-5/9) | **Accepted** | Investor build abstains; VLM default-off there (D4) |
| 16 | HNSW-rejection premise vs corpus sizes (Grok-2, part) | **Modified** | Premise repaired by partner-first indexing: demo index is small, exact FAISS stands; ANN revisited on measurement (D4) |
