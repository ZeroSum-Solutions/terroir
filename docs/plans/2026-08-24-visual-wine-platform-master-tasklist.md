# Visual Wine Platform — Master Task List

Created 2026-08-24. Owner: Devin. This is the persistent checklist for the fast-label-scan +
rich-corpus + 3D-cellar + voice initiative. Check items off as they complete; add discoveries
as new unchecked items rather than losing them.

**Prototype posture (owner-stated, 2026-08-24):** licensing is NOT a blocker for this phase.
The prototype exists to demonstrate and raise money; it will not ship to production as-is.
Bias toward the biggest, richest corpus we can get. Proper licensing happens before real
production.

## Phase 0 — Digest & alignment

- [x] Digest the full feature vision (label scan, corpus, ratings, 3D cellar, storage-scan, voice)
- [x] Audit what already exists in the repo (P2 identity spine and P3 chunked import LANDED
      through migration 0111; P4 image enrichment designed at
      `docs/plans/2026-08-23-p4-image-enrichment.md`, NOT built; LWIN 211k catalog + trigram
      matching live; camera-first personal cellar PRD exists but was scoped with 3D renderer
      and multi-bottle vision OUT — this initiative reopens some of that scope)
- [x] Receive and ingest Devin's Codex research — 4 docs at
      `~/Documents/Codex/2026-08-23/hey-x20/outputs/`: the prototype blueprint (composite
      enrichment + recognition system, live-tested sources, Grok-audited), the free-sources
      report (Open Food Facts / RF100 / recognition-engine survey), the commercial-database
      report (InVintory / Wine Labs / grapeminds / WineEngine / pricing vendors), and the 64K
      current-state assessment (search options, pricing model, phased roadmap). Deep-dive run
      artifacts (claims, verification) at `~/.local/share/deep-dive/run/terroir-csv-visual-cellar/`.
- [ ] Note: the Codex research predates P2/P3 landing and the "licensing is not a blocker"
      posture — its rights-conservative verdicts (e.g. "do not ship Wine Images 126K photos")
      are production guidance, not prototype constraints. Re-weight during synthesis.

## Phase 1 — Research (Claude + GPT-5.6 in parallel, then cross-audit)

### 1a. Fast label identification (the core bet: fast, ideally no LLM in the hot path)
- [ ] Evaluate candidate pipelines: on-device/server OCR (+ fuzzy match vs. corpus),
      image-embedding similarity (CLIP-class model + vector index), barcode/GTIN,
      perceptual hash — and hybrids. LLM (existing Claude scan path) stays as fallback tier.
- [ ] Benchmark plan: latency budget, accuracy target, and how we measure top-1/top-3 hit rate
      against a real label photo set
- [ ] GitHub sweep: existing wine-label-recognition repos, wine datasets, vector-search infra
      (pgvector vs. FAISS vs. hosted), OCR engines (PaddleOCR, Tesseract, Apple Vision, cloud)

### 1b. Corpus & data sourcing (licensing deliberately ignored this phase)
- [ ] Inventory candidate sources: LWIN/Liv-ex (have 211k), Wine-Searcher, Vivino, CellarTracker,
      Wine.com, GWS/global wine score, Open datasets (Kaggle, X-Wines, etc.), producer sites
- [ ] Compare at least two databases by coverage, label imagery availability, ratings, market price
- [ ] Extraction/scrape strategy per source (crawl4ai first, Firecrawl fallback) and storage plan
      that fits P4's `wine_images` design (canonical_wine_id-scoped, provenance recorded)

### 1c. Ratings & market data
- [x] Where external ratings come from (critic vs. community) — RESEARCHED 2026-08-24
      (brief: `~/Inbox/notes/research-terroir-visual-platform-phase1-2026-08-24.md`):
      X-Wines 21M community ratings (1-5 half-step scale, downloadable) as seed;
      Wine-Searcher Wine Check API (critic aggregate, LWIN-keyed, 100 free calls/day) +
      GlobalWineScore API as critic layer; CellarTracker export is per-user only;
      Vivino unofficial-only.
- [x] Partner recommendation received 2026-08-24: **Vinous** (Galloni; 200k+ tasting notes;
      owns Delectable). Compared: no public API — consumer subscription + trade program
      (~$2k/mo reported); Vinous scores already flow through the Wine-Searcher critic
      aggregate (LWIN-keyed), so prototype gets Vinous-inclusive scores via Wine Check API;
      direct Vinous licensing deal is the production/fundraising play (Delectable synergy).
      Critic-only — X-Wines community layer still needed. Ratings source question CLOSED
      for synthesis purposes.
- [ ] User ratings (stars) + personal notes schema — per user, per wine/variant, tenant-safe
      (design in PRD phase; one schema can hold both user and imported community ratings)
- [ ] Market price / purchase price / value-over-time data source options (existing
      Wine-Searcher adapter + known average-vs-median bug; quote needed for paid tier)

### 1d. 3D support (Codex builds the renderer; we build the substrate)
- [ ] Define asset requirements the DB must serve: high-res label crops, bottle-shape class,
      capsule/foil color, eventually GLB/glTF renders — confirm P4 schema holds these (its §11
      claims yes) and extend the design if not
- [x] Storage-space capture → 3D — RESEARCHED 2026-08-24 (see brief): two-track
      recommendation — Track 1 (ships): parametric rack/fridge reconstruction from photos
      (vision infers grid → template geometry → slots map to bins); Track 2 (wow overlay):
      gaussian splat of the real space via Polycam (20-200 photos or mp4) rendered with
      GaussianSplats3D (.ply/.splat/.ksplat) — mobile perf is a flagged risk to spike;
      @lumaai/luma-web is DEPRECATED (not a path); nerfstudio Splatfacto = self-host option
- [ ] Data model for containers/positions (containers with typed geometry + slot coordinates)
      — design in PRD phase; must serve parametric track now, splat annotations later
- [ ] Define the API contract Codex's 3D feature will consume (bottle detail: market rate,
      purchase price, producer story, position in rack)

### 1e. Voice (log + retrieve)
- [x] STT options — RESEARCHED 2026-08-24 (see brief): accuracy plateaued at top; keyterm
      prompting is the wine-vocabulary lever (Deepgram $0.0013/min add-on; AssemblyAI
      built into $0.45/hr realtime, 1,500-word keyterms). Deepgram or AssemblyAI both
      viable; AssemblyAI free tier (185h batch/333h streaming) covers the whole demo phase.
- [x] Retrieval pattern — RESEARCHED: constrained function-calling tool over tenant Postgres
      (arXiv 2502.00032: 74.3% best exact-match; text filters are the weak spot → resolve
      names via trigram/identity search first, pass IDs not free text). No free-form SQL.
- [ ] Voice-driven rapid intake parsing pipeline + confirmation UX (design in PRD phase;
      route utterances through the same resolve_wine_variants_bulk identity path as CSV)
- [ ] Build 50-utterance wine-vocab STT eval (producer names, FR/IT/ES) before vendor commit

## Phase 2 — Synthesis & audit

- [x] Synthesize research into one architecture recommendation — 2026-08-24:
      `docs/plans/2026-08-24-visual-wine-platform-synthesis.md`
- [x] Cross-audit — 2026-08-24: GPT-5.6 (Codex; v1 verdict UNSOUND, 4 blocking) + Grok 4.6
      (OpenRouter; SOUND-WITH-REVISIONS, 2 blocking); all 16 distinct findings accepted or
      modified and folded into synthesis v2 (disposition table in the doc). Biggest changes:
      global `wine_editions` entity, partner-cellar-first sequencing (Gate-0 vertical slice),
      parallel 3-arm retrieval, inventory-keyed bottle-detail API, assisted (not auto) grid
      setup, 3-store ratings schema, demo mode, abstain-over-misidentify investor build.
- [ ] Owner review + decisions on 5 open questions (listed at end of synthesis doc)

## Phase 3 — PRD & specs

- [ ] Write the PRD (supersedes/extends camera-first PRD where scope reopened)
- [ ] Spec list per feature slice
- [ ] Tickets (small, judgeable, with acceptance criteria)
- [ ] Evals per slice (identification accuracy, latency, voice-retrieval correctness) so "done"
      is measurable

## Phase 4 — Testing suite

- [ ] Audit current coverage (vitest + Playwright e2e exist) and identify gaps as the app grows
- [ ] Stand up regression suite for critical paths (scan → identify → save; search; ratings;
      voice retrieval once built) wired into CI

## Phase 5 — Build (sequenced after Phase 3 approval)

- [ ] Land P4 image enrichment (0112+) as the reference-image substrate
- [ ] Fast-identification pipeline (Milestone-3 style: photo → candidates, LLM fallback)
- [ ] Ratings + notes
- [ ] Voice slice
- [ ] 3D substrate/APIs (parallel with Codex's renderer work)
