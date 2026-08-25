# Visual Wine Platform — Spec List & Migration Manifest

Date: 2026-08-24 · Status: **draft, pending PRD approval** · Parent:
`2026-08-24-visual-wine-platform-prd.md` (VWP-FR IDs cited below) · Architecture:
`2026-08-24-visual-wine-platform-synthesis.md` (v4, audit converged).

Tickets are NOT cut from this list until: (a) the owner approves the PRD, (b) the gating
spikes for each spec have run (§Spike register), and (c) the owner confirms Gate 0
threshold values (VWP-D-01). Evals follow the repo protocol
(`docs/evals/top10-evals.yaml`): each eval becomes ≥1 failing test first; a slice lands
only when its evals AND the global gates are green.

---

## 1. Migration manifest (normative — satisfies VWP-FR-005)

Numbering = landing order. Current tip is `0111`. The CI uniqueness/order check ships with
0112. No migration file in this range may be created except from this manifest; changes to
the manifest are commits to THIS document first.

| # | File | Contents | Depends on | Spec |
|---|---|---|---|---|
| 0112 | `wine_editions.sql` | `wine_editions` (vintage-grain, `0`=NV, `UNIQUE (canonical_wine_id, vintage)`, vintage CHECK, `lwin11` partial unique `WHERE lwin11 IS NOT NULL`), P2 §8 write posture, `wine_variants.edition_id` + client-write guard, server-side linking fn (provenance-recording) + LWIN11 corroboration gate (canonical + vintage agreement), backfill + quarantine queue | P2 (0097–0101); spike 11 verdict | SPEC-01 |
| 0113 | `image_licenses.sql` | P4 as designed (was P4-0112) | — | SPEC-02 |
| 0114 | `image_sources.sql` | P4 (was 0113) | 0113 | SPEC-02 |
| 0115 | `wine_images.sql` | P4 core table — keyed `canonical_wine_id` + `(vintage, size_ml)` tuple, NO edition FK (was 0114) | 0113–0114 | SPEC-02 |
| 0116 | `wine_images_storage.sql` | P4 (was 0115) | 0115 | SPEC-02 |
| 0117 | `enrichment_source_attempts.sql` | P4 (was 0116) | 0114 | SPEC-02 |
| 0118 | `wine_image_enrichment_jobs.sql` | P4 (was 0117) | 0115–0117 | SPEC-02 |
| 0119 | `merge_canonical_wines_images.sql` | P4 (was 0118; down restores 0100's exact prior body) | 0115 | SPEC-02 |
| 0120 | `resolve_wine_images_bulk.sql` | P4 (was 0119) | 0115 | SPEC-02 |
| 0121 | `containers_slots.sql` | `containers` (types: rack_grid, fridge_shelves, case, wall, zone) + `slots`, `restaurant_id` + RLS across both, composite same-tenant FKs | — | SPEC-09 |
| 0122 | `bottle_placements.sql` | `bottle_placements` (slot_id, inventory_item_id, active/removed lifecycle), `UNIQUE (slot_id)` over active rows, transactional `count(active) ≤ inventory_items.quantity` guard, place-from-lot operation (one row per bottle) | 0121 | SPEC-09 |
| 0123 | `bins_to_containers.sql` | ONE-TIME move: each live bin → a `zone` container (code/zone/capacity carried; `zone` containers auto-generate unordered slots, capacity-bounded when set); each lot's binned quantity → N placements; `inventory_items.bin_id`/`bin_location` become read-legacy (writes revoked); `wine_lists.show_bin_codes` surface repointed at container codes | 0121–0122; bins e2e suite migrated in the same PR | SPEC-10 |
| 0124 | `ratings_stores.sql` | `user_wine_reviews`, `external_rating_events` (one grain per event), `rating_aggregates` (two grains, lineage, no fan-out) | 0112 | SPEC-15 |
| 0125 | `ratings_read_model.sql` | Read model (edition-first, labeled canonical fallback, tenant-local rollups) | 0124 | SPEC-15 |
| 0126 | `legacy_ratings_migration.sql` | 0025 `wines.rating`/`rating_source`/`review_excerpt` → `external_rating_events`; readers repointed in the same PR | 0124–0125 | SPEC-24 |
| 0127+ | reserved | Durable import staging IF VWP-D-04 chooses it; `wine_edition_formats` when barcode authority needs it; splat asset metadata if the spike passes | per decision | — |

**Sequencing note (documented deviation from PRD phase lettering):** the manifest is DDL
landing order — substrate DDL (0121–0123) lands before ratings DDL (0124–0126) to honor
the synthesis's audited "containers/slots/placements = 0121+" assignment. PRD Phases C
and D describe feature delivery and may overlap; ratings feature work starts as soon as
0124–0125 land. Nothing in ratings blocks on the bins move (0123).

Every migration: paired down, snapshot update, generated types, RLS tests, drift check,
plus the regression suite for whatever landed surface it touches (NFR-4 / risk R7).

---

## 2. Spec slices

Format: scope → key contracts → gated by → acceptance evidence. Full per-spec documents
are written only for slices whose contracts aren't already normative in the synthesis/P4
doc (marked ★); the rest cite their source and go straight to tickets once gates clear.

### Identity & corpus

- **SPEC-01 ★ Editions + backfill (0112)** — VWP-FR-001..004. DDL per manifest; server
  linking fn; backfill classifier (dated / explicit-NV / quarantine) + report; Gate-0
  blocker: pilot 100% resolved-or-quarantined. Gated by: spike 11 (`wine_lineages`
  disposition — note repo eval F-2 says `wines.lineage_id` exists with LWIN7 grouping, so
  "deprecated" is not assumable). Acceptance: PRD criteria 2–3.
- **SPEC-02 P4 land + renumber (0113–0120)** — VWP-FR-009. Spec = the P4 doc itself
  (`2026-08-23-p4-image-enrichment.md`) with its header amendment; files renamed in the
  0112 commit; P4's inline numbering updated when its tickets are cut. Unwarp amendment
  folded in (SPEC-03). Acceptance: P4's own migration/test plan + PRD criterion 1.
- **SPEC-03 ★ Unwarp shared library** — VWP-FR-009. Cylinder unwarp as a lib consumed by
  the Gate-0 scan service (queries AND reference derivatives) and by P4's pipeline at
  scale; raw crop always retained; no-unwarp fallback texture guaranteed. Gated by:
  spike 7 (phone-vs-packshot LightGlue survival informs how much unwarp matters).
- **SPEC-04 ★ Pilot enrichment run (Gate 0 corpus)** — VWP-FR-007, D2. 500-variant
  stratified pilot: dedupe → editions → enrichment cascade (local joins → barcode → DDGS →
  Brave) → verified reference images → frozen index build for exactly those editions.
  Gated by: SPEC-01/02 landed; spikes 3–5 (WS/GWS coverage, X-Wines joins, DDGS soak).
  Acceptance: reference-image coverage + precision reported per VWP-FR-016.
- **SPEC-07 Import scale-up (20k CSV)** — VWP-FR-008. Durable staging vs. `MAX_ROWS`
  raise decided by VWP-D-04 (staging → takes an 0127+ number). Acceptance: full partner
  CSV ingested with P3 chunked-apply semantics intact; import e2e green.

### Identification

- **SPEC-05 ★ Scan service** — VWP-FR-012..015, D4. Parallel arms (ZXing / PaddleOCR→
  trigram+BM25 / DINOv2→exact FAISS) → union → LightGlue rerank (reference-image
  admission; OCR-only candidates survive) → calibrated fusion → top-3 or ABSTAIN; barcode
  contract incl. the candidate-constraint path; edition-only result type; response embeds
  ranked editions + tenant placement sets (0/1/N). Topology per VWP-FR-018. Gated by:
  spikes 6 (latency topology), 7 (LightGlue), 10 (GTIN coverage/vintage-uniqueness →
  VWP-D-07). Acceptance: PRD criteria 5–6 + Gate 0.
- **SPEC-06 ★ Gate 0 eval harness + benchmark** — VWP-FR-016..017. Frozen working set +
  sealed holdout (identity-disjoint from tuning/calibration; out-of-corpus + non-wine +
  near-duplicate-vintage cases); query-level metrics with abstention-as-miss; report
  format; Gate 0-R re-run (SPEC-08) on the final index. Gated by: VWP-D-01 (owner
  thresholds). Acceptance: PRD criterion 4; published numbers = the "frozen scan proof".
- **SPEC-08 Gate 0-R** — re-execution of SPEC-06 on the full partner index before any
  investor rehearsal; same metric family/thresholds; room bottles in the eval set.

### 3D substrate

- **SPEC-09 ★ Containers/slots/placements DDL (0121–0122)** — VWP-FR-028..029. All
  integrity + tenancy invariants IN the migration + regression suite. Acceptance: PRD
  criterion 7 (first half).
- **SPEC-10 ★ Bins one-time move (0123)** — VWP-FR-030. FK move off
  `inventory_items.bin_id` onto placements; ~40 production rows carried; bins e2e suite
  migrated; `show_bin_codes` surface preserved. Acceptance: PRD criterion 7 (second half).
- **SPEC-11 ★ Bottle-detail API** — VWP-FR-031. Keyed to `bottle_placement_id`; response
  contract per PRD; variant-level fallback card for unplaced stock; tenant isolation.
  This is the Codex renderer's consumption contract — freeze it early (SPEC-13).
  Acceptance: PRD criterion 8.
- **SPEC-12 Assisted space setup UI** — VWP-FR-032. Bounded v1 contract (grid racks +
  shelf fridges, corner calibration, per-slot edit, non-photo fallback). Gated by:
  spike 8 (UX flow). No count/identity authority from photos.
- **SPEC-13 Renderer contract + texture exports** — VWP-FR-033. Template GLB library,
  texture export endpoints from P4 derivatives (scope resolver per VWP-FR-010), UV
  hints/aspect/shape-class in bottle-detail; written FOR Codex's parallel renderer work.
- **SPEC-14 Splat overlay** — desktop-only, ships only on spike 2 pass (VWP-D-06);
  Polycam→GaussianSplats3D; asset metadata migration only if approved (0127+).

### Ratings

- **SPEC-15 ★ Ratings stores + read model (0124–0125)** — VWP-FR-019..020. DDL + read
  model; grain discipline; labeled canonical fallback. Acceptance: PRD criterion 9.
- **SPEC-16 External ratings ingestion** — X-Wines offline pre-aggregation (21M rows
  never live), Wine-Searcher/GWS fetchers, demo-cellar prefetch cache. Gated by: spike 3
  (WS trial + GWS coverage + written quotes).
- **SPEC-17 WS median fix** — VWP-FR-022. True median or "avg-based" label at
  `src/lib/wine-intelligence/wine-searcher.ts:196–201` before ANY display ships.
- **SPEC-18 Ratings display UI** — VWP-FR-020/022. "Aggregated critic score" labeling;
  no "Vinous" string; community stars; tenant stars/notes separate.
- **SPEC-24 Legacy reconciliation (0126)** — VWP-FR-021 + VWP-FR-006. 0025 data
  migration + reader repoint; `wine_lineages` disposition executed per spike 11 verdict.

### Voice

- **SPEC-19 Voice intake** — VWP-FR-023. Push-to-talk → batch STT → slot-filling →
  `resolve_wine_variants_bulk` → confirmation UI; tenant keyterm vocabulary. Gated by:
  spike 1 (STT eval → VWP-D-02).
- **SPEC-20 ★ Voice retrieval tool** — VWP-FR-024..025. ONE constrained tool; in-tool
  server-side name→ID resolution; disambiguation lists; explicit not-found; hard-gated on
  populated placements. Acceptance: PRD criterion 10.
- **SPEC-21 ★ Voice-retrieval eval** — VWP-FR-026. Scored utterance set → expected tool
  calls + result sets (resolution, ambiguity, out-of-domain, abstention); thresholds set
  before tickets freeze; runs before any demo line is rehearsed.
- **SPEC-22 STT integration** — VWP-FR-027. Vendor per VWP-D-02; preflight; typed
  fallback UI; keyterms wired both vendors' way until decided.

### Cross-cutting

- **SPEC-23 ★ Demo mode** — VWP-FR-034. Preflight (STT + inference box), prewarm, cached
  golden path incl. last-resort cached scan results, timeouts, degraded states, demo-day
  venue/topology checklist. Acceptance: PRD criterion 11.
- **NFR-5 licensing containment** applies to SPEC-04/05/16 artifacts: per-source raw +
  derived isolation with deletion lineage; PRD criterion 12 rehearses one source removal.

---

## 3. Spike register (all run before tickets freeze — synthesis D9)

| # | Spike | Feeds | Decides |
|---|---|---|---|
| 1 | STT 50-utterance wine-vocab eval (FR/IT/ES producers) | SPEC-19/22 | VWP-D-02 vendor |
| 2 | Splat FPS (desktop + mobile) | SPEC-14 | VWP-D-06 |
| 3 | Wine-Searcher trial + ~~GWS~~ coverage on ~50 LWIN'd wines + written quotes — *GWS dropped 2026-08-25: domain parked/for-sale, no live API surface (evidence in `2026-08-25-spike-resources-status.md`); critic layer = WS aggregate + X-Wines community* | SPEC-16 | paid-tier viability |
| 4 | X-Wines/WineSensed join rates + X-Wines image manifest count — *datasets downloaded + MD5-verified 2026-08-25 (`~/projects/terroir-data/`); manifest half ANSWERED: X-Wines Full publishes NO label images (author on-demand only; Slim = 1,007); WineSensed 996,808 image refs in a 35 GB undownloaded archive. Join-rate half runnable now* | SPEC-04/16 | corpus expectations |
| 5 | DDGS 500-query soak | SPEC-04 | cascade reliability |
| 6 | e2e scan latency on demo hardware (cold/warm/concurrent p50/p95) | SPEC-05 | topology; VWP-D-03 box spec |
| 7 | Phone-photo vs. packshot LightGlue survival | SPEC-03/05 | rerank viability |
| 8 | Assisted-grid UX flow (+ separate auto-grid feasibility) | SPEC-12 | v1 contract fit |
| 9 | Voice-retrieval eval construction | SPEC-21 | eval viability |
| 10 | Partner-CSV GTIN coverage + vintage-uniqueness | SPEC-05 | VWP-D-07 barcode arm |
| 11 | `wine_lineages` status (deprecated vs. still-read; note eval F-2) | SPEC-01/24 | VWP-D-05 |

**Spike 11 — CLOSED 2026-08-24 (repo evidence).** `wine_lineages` is LIVE, not
deprecated: tenant-scoped (`restaurant_id NOT NULL`, per-restaurant LWIN7/name-norm
unique keys — it is NOT a cross-tenant identity layer), created by a security-definer
BEFORE trigger on every wine-creation path, and read by real product surface
(cellar grouping, reconcile-queue, `merge_wines` — which rejects cross-vintage merges,
consistent with edition-grain doctrine). Meanwhile `canonical_wines`/`wine_variants` are
read only by the import path, `src/domains/identity/*`, and tests — the live UI still
runs on `wines` + `wine_lineages`. **Verdict (VWP-D-05, evidence-forced): KEEP-READ.**
Lineages are a tenant-side display grouping at canonical grain over the legacy `wines`
table; they do not collide with `wine_editions` (which attaches to the P2 spine), so
0112 is NOT blocked. Constraints recorded into SPEC-01: the editions backfill must not
treat lineage rows as canonical truth (their LWIN7 derivation is trigger-heuristic, with
ambiguous rows deliberately left unlinked — that pattern is precedent for the quarantine
queue, not a resolution source). Follow-up (backlog, not this phase): derive UI grouping
from variant→canonical linkage and retire the parallel lineage trigger. Exposed by this
spike: the `wines` ↔ `wine_variants` bridge (which table the demo UI's inventory rows
live on) must be stated in SPEC-05/11's ticket specs, since scan output and bottle detail
bind to the P2 spine while today's UI reads `wines`.

---

## 4. What tickets wait on

1. Owner approves the PRD (and with it this spec list + manifest).
2. Spikes 1–11 run; their verdicts recorded against VWP-D-02/05/06/07 and folded into the
   affected specs.
3. Owner confirms Gate 0 thresholds (VWP-D-01) and the 20k ingestion path (VWP-D-04).
4. The eval YAML (`docs/evals/` addition, EV-VWP-* IDs per slice, repo given/then format)
   is authored from the ★ specs' acceptance criteria — the PRD's 13 criteria decompose
   into per-slice evals at that point, each becoming a failing test first.

Ticket grain then follows repo convention: one branch per opportunity-sized slice,
e2e-tagged, landing only when its evals and global gates are green.
