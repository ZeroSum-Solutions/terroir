# Visual Wine Platform — Spec List & Migration Manifest

Date: 2026-08-24 · Status: **ACTIVE — §1's migration manifest is normative and CI-enforced**
by `scripts/check-migration-manifest.mjs` (and `src/test/contracts/check-migration-manifest.test.ts`).
A new migration must be added to §1 or the merge gate fails. §2–§4 remain planning material. · Parent:
`2026-08-24-visual-wine-platform-prd.md` (VWP-FR IDs cited below) · Architecture:
`2026-08-24-visual-wine-platform-synthesis.md` (v4, audit converged).

Tickets are NOT cut from this list until: (a) the owner approves the PRD, (b) the gating
spikes for each spec have run (§Spike register), and (c) the owner confirms Gate 0
threshold values (VWP-D-01). Evals follow the repo protocol
(`docs/evals/top10-evals.yaml`): each eval becomes ≥1 failing test first; a slice lands
only when its evals AND the global gates are green.

---

## 1. Migration manifest (normative — satisfies VWP-FR-005)

Migration numbers define deterministic replay order, not commit landing chronology. Numbers
`0112`–`0126` remain preallocated to the Visual Wine Platform sequence; approved,
order-independent migrations may use the reserved band and land earlier. The CI
uniqueness/manifest check governs every migration numbered `0112` or higher. No migration in
that governed range may be created except from this manifest; changes to the manifest land in
THIS document first.

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
| 0127 | `match_lwin_deterministic_tiebreak.sql` | `create or replace public.match_lwin(text, text, float)`: retain 0078 matching semantics and add `ORDER BY score DESC, lc.lwin_id ASC`; `match_lwin_batch` and `match_lwin_bulk` inherit the total ordering through their existing calls | 0078 | — |
| 0128 | `apply_import_batch_chunk_sibling_lock.sql` | `create or replace public.apply_import_batch_chunk(uuid, integer)`: transaction-scoped advisory lock plus under-lock sibling-applied recheck; raise `P0004` on conflict | 0108 | — |
| 0129 | `import_batches_digest_boundary.sql` | `not valid` CHECK requiring new `content_sha256` values to match a shape 0128 can normalise, plus a `before update` trigger freezing the column (`P0005`); closes the manufactured-malformed-digest bypass of 0128's barrier | 0128 | — |
| 0130 | `wine_image_storage.sql` | Creates the `wine-images` storage bucket (public, 10 MB, JPEG/PNG/WebP) plus restaurant-scoped insert/update/delete policies. Declares the bucket `src/domains/cellar/wine-image-service.ts` has written to since BND-057 but that no migration ever created — a fresh environment had a hero-image upload that could only fail. Distinct from 0116, which provisions storage for P4's `wine_images` table; this one serves the shipped `wines.hero_image_url` feature and does not wait on P4. | 0072 | — |
| 0131 | `xwines_catalog.sql` | `xwines_catalog` (100,646 rows of the CC0-1.0 X-Wines Full corpus: type, elaborate, grapes, food pairings, ABV, body, acidity, country/region, winery + website, the vintage list, and the per-wine rating average/count aggregated from the corpus's 21,013,536 ratings) plus `xwines_vintage_ratings` (per `(wine_id, vintage)` average/count, 1,008,593 rows) — the grain "Compare Vintages" needs. Global reference tables in the shape of `lwin_catalog`: authenticated-select-only RLS, trigram indexes on winery and wine name. Carries the attributes the cellar has no column for anywhere today — body, acidity, ABV, food pairing, community rating. | 0003 | — |
| 0132 | `canonical_wines_xwines_link.sql` | `canonical_wines.xwines_wine_id` (FK → `xwines_catalog`, `on delete set null`) + `xwines_match_score real`, and `match_xwines(text, text, float)` — a producer-weighted trigram matcher mirroring 0127's `match_lwin`, including its deterministic `order by score desc, wine_id asc` tie-break. Attaches the corpus at the SHARED catalog grain (`canonical_wines`), not per-tenant `wines`, because body/acidity/ABV/pairing are producer+cuvée facts and must not be duplicated per restaurant. | 0097; 0131 | — |
| 0133 | `xwines_catalog_lower_trgm_indexes.sql` | GIN trigram indexes on `lower(winery_name)` and `lower(name)` for `xwines_catalog`. 0131 indexed the RAW columns, but `match_xwines` (0132) prefilters on `lower(xc.winery_name) % lower(p_producer)`, and Postgres cannot serve a functional expression from a bare-column index — every call parallel-seq-scanned all 100,646 rows. Same defect and same remedy as 0078 for `lwin_catalog.lower(producer)`. Index-only addition: no function, grant or matching semantics changes. | 0131; 0132 | — |
| 0134 | `match_xwines_top_n.sql` | `create or replace public.match_xwines(text, text, float, integer)`: adds `p_limit integer default 5` and returns the top N by the existing `score desc, wine_id asc` order instead of `limit 1`. The caller's acceptance floors (`xwines-profile.ts`) are stricter than the RPC's prefilter, so a `limit 1` that the client then rejects discarded valid runner-up candidates unseen. Matching predicates, weighting, `security definer`, `search_path` and grants are unchanged; the single-argument-arity function is dropped so the overload does not shadow. | 0132; 0133 | — |
| 0135 | `identity_resolution_on_write.sql` | `create or replace public.find_or_create_wines_batch(uuid, jsonb)`: one bulk `resolve_wine_variants_bulk` call after the existing loop, writing `wines.wine_variant_id` (`canonical_wine_id` follows from 0098's trigger), plus a re-runnable backfill for every `wines` row still unresolved. Closes the gap where 0099's resolver had zero production callers, so every wine created after 0101's one-shot backfill carried a null identity forever and `xwines-profile.ts`'s `canonical_wine_id` link (0132) never fired. Deliberately does NOT touch `apply_import_batch_chunk` or the import dedup key — §9/§12 of the P2 plan place that call in P3's TypeScript caller, before the per-row loop. | 0097–0101; 0079 | — |
| 0136 | `wine_ownership_on_write_policies.sql` | `alter policy` on both write policies for `stock_adjustments` and `bottle_closeouts`, adding an `exists` check that the row's `wine_id` (and `bottle_closeouts.open_bottle_id`, when non-null) belongs to the row's own `restaurant_id`. Closes the [HIGH] cross-tenant cascade-delete hole: both columns are `on delete cascade`, Postgres cascades bypass RLS, and the prior policies gated only on membership of the row's own restaurant — so a tenant could file a policy-compliant row naming another tenant's wine, and that tenant's later delete of their own wine silently destroyed it. Proven live before the fix (tenant B's row count went 2 → 1 on tenant A's delete) and re-proven closed after. Amends rather than recreates, per 0084's precedent, so the `roles={public}` list is untouched. | 0060; 0063; 0084 | — |
| 0137 | `backfill_blank_producers_from_lwin.sql` | Recovers `wines.producer` for wines imported with an empty producer, by longest-word-prefix match of `name` against the 211,498-row `lwin_catalog` producer set. A CSV import created 1277 such wines (`producer=''`, producer run together with the cuvee in `name`); their source rows carry `"producer": ""`, so nothing is recoverable from the import itself. Identity resolution is producer-first, so these could neither resolve to the spine nor match LWIN — 108/1385 wines resolved before this. Prefix beats trigram on precision (trigram scored `Agrapart Experience` against `ABK6, L'Experience, Cognac` and would have written ABK6); a stoplist excludes the generic catalog entries `Chateau`/`Maison`/`Clos`/`Tenuta` that otherwise swallow `Château Sainte Anne`. Measured on production before writing: **956 of 1277 repaired, 956 newly resolved, total 108 → 1064 of 1385.** Every write recorded in `producer_backfill_audit` so the down is an exact reversal. | 0099; 0105; 0135 | — |
| 0138 | `xwines_catalog_imagery.sql` | Four nullable columns on `xwines_catalog` — `image_url`, `image_kind`, `image_source`, `image_credit` — plus a closed-vocabulary CHECK on `image_kind` (`label`/`producer`/`representative`), an all-or-nothing CHECK binding url+kind+source, and a partial index on `image_kind` where `image_url is not null`. 1,007 of the corpus's 100,646 wines had a photograph (1.0%); there is no open collection of 100,646 wine labels, so the column set records WHICH of three strengths of claim each picture is rather than flattening them into one `label_image_url` that would be false for most rows. `image_source`/`image_credit` carry per-source licensing (X-Wines CC0-1.0; Open Food Facts contributor photos CC-BY-SA-3.0; Wikimedia Commons per-file) for NFR-5 containment — they record what the source stated and are not a clearance. Populated by `scripts/local/harvest-wine-imagery.mjs` + `scripts/local/seed-catalog-imagery.mjs`. | 0130; 0131; 0133 | — |
| 0141 | `canonical_wines_xwines_grant.sql` | `grant select (xwines_wine_id, xwines_match_score) on public.canonical_wines to authenticated`. 0097 made this table's SELECT grant COLUMN-level on purpose, enumerating twelve columns so the two `created_by_*` audit columns stay unreadable across tenants — and a column-level grant is a closed list, so every column added later defaults to unreadable. 0132 added `xwines_wine_id`/`xwines_match_score`, granted execute on `match_xwines()`, and stopped. The result was not a degraded feature but a dead code path: `resolveXWinesProfile` opens by reading the trusted link (`xwines-profile.ts:307`), which returned 42501 for every authenticated caller, and its error branch correctly returns `unavailable` rather than falling through to the matcher — so the wine detail page showed no taste profile, no pairings, no community rating and no vintage comparison for every wine with a canonical row, in every environment, since 0132. Service-role seeding never saw it because it bypasses grants. Read-only and no wider than 0132 already intended (`match_xwines` has been authenticated-executable since then and returns `wine_id` for the whole corpus); both `created_by_*` columns remain unreadable. `0097_identity_spine_grants.sql` asserted this grant only through `producer_norm` and so passed straight over the gap; it now asserts the columns the application actually selects. | 0097; 0132 | — |
| 0139, 0140 | unused | Reserved during the imagery/operational-seed work and never taken; left as a gap rather than renumbered, since 0141 was already applied and recorded in `schema_migrations`. | — | — |
| 0142 | `anon_wine_hero_image_grant.sql` | `grant select (hero_image_url) on public.wines to anon`. 0081 replaced anon's table-level SELECT on `wines` with a column-level grant, and a column-level grant is a CLOSED list — every column added afterwards defaults to unreadable for anon. `hero_image_url` was never in it, so the published guest menu (`/list/[slug]`), whose entire purpose is showing wines to guests, could render each wine's name, producer, vintage and serving temperature but not its photograph. One column, deliberately: 0081's model (no table-level grant, an explicit column list instead) is untouched, and this column is a URL into the already world-readable `wine-images` bucket carrying no pricing, cost, supplier or operational signal. `0074_public_api_grants.sql` pins the anon column list in BOTH directions, so both halves of that assertion are updated in the same change rather than loosened. | 0081 | — |
| 0143 | `invoice_scan_deletion.sql` | SCAN-04 / decision D6: `invoice_scans.status_reason` (the stated reason a zero-item or failed scan is in the ledger — the ledger already keeps those rows, it just could not say why), the table's first-ever DELETE policy (manager-scoped via `member_restaurant_ids_with_role`; SELECT/INSERT/UPDATE were all it had, which is also why the two error-path rollback DELETEs in `POST /api/inventory/save-scan` were silent no-ops), the `invoice_scan_deletions` append-only audit table, and `delete_invoice_scan(uuid)` — one transaction that reverses exactly the `inventory_items` rows the scan created (`invoice_scan_id = p_scan_id`) BEFORE deleting the scan, because that FK is `ON DELETE SET NULL` and the reverse order orphans the stock. Not `revert_import_batch` (0109): that function walks `import_batch_rows.applied_inventory_item_id` and an invoice scan has no batch, no rows table and no applied-id column — there is no argument shape that makes it accept a scan id. Mirrors its rules (only this scan's rows, never `wines`, `auth.uid()` never client-supplied) rather than inventing new ones. | 0002; 0066; 0084; 0090 | — |
| 0144 | `wines_fuzzy_search.sql` | SCAN-06 / decision D3 (fuzzy half only; the corpus-coverage half stays blocked on a commercial data licence): `immutable_unaccent(text)`, a `gin (immutable_unaccent(lower(producer || ' ' || name)) gin_trgm_ops)` index on `public.wines` — the table had no trigram index at all — and `search_wines_fuzzy(uuid, text, float, integer)`, which scores a row as the MAX per-token `word_similarity` over the accent-folded `producer || ' ' || name`. The reported failure was a search for "Fredric savart" returning nothing: the route built ONE ILIKE pattern out of the WHOLE query, so it could neither span producer + name nor tolerate a typo or a dropped accent. Whole-string `similarity()` is not the fix either (0 rows at the 0.3 default — a long wine name dilutes a short query). The 0.5 threshold is load-bearing and is therefore explicit: 'fredric' -> 'Frédéric' scores 0.545455, which clears 0.5 and FAILS pg_trgm's 0.6 default, so inheriting the default would ship the bug. Matches `producer || ' ' || name` rather than `producer` because 1,277 of 1,527 local wines carry an empty producer with the name embedded (0137's unrepaired remainder). SECURITY INVOKER, not the SECURITY DEFINER of `match_lwin`/`match_xwines`: those read global catalogues, this reads tenant data, so 0079's rule applies and `wines` RLS is the enforcing layer with the explicit `restaurant_id = p_restaurant_id` predicate behind it. | 0079; 0127; 0133; 0137 | — |
| 0145 | `lwin_xwines_links.sql` | WS-IDENT P0 (`2026-08-31-ws-ident-identity-policy.md` §5): `xwines_link_runs` (run provenance: rule version, params), `lwin_xwines_links` (one current decision per `lwin_catalog` row — accepted links carry corpus id + score vector, review rows a closed-vocabulary reason, abstentions stored as first-class rows; shape-enforcing CHECKs), `lwin_xwines_link_tombstones` (pairs a human split; never auto-accepted again). Links are authenticated-select-only global reference data (P1 dedupe reads them); runs and tombstones follow 0137's two-layer deny (revoke + RLS-no-policy, service_role only). Written only by `scripts/link-lwin-xwines.ts`. | 0003; 0131; 0137 (pattern) | — |
| 0146 | `xwines_search.sql` | P1 slice 1 (unified palette, `2026-08-31-unified-search-companion-and-canonical-facts.md` §7): `xwines_search(text, int)` — free-text trigram search over `xwines_catalog` in `lwin_search`'s shape (one query string vs winery + wine name, best similarity wins), on the 0133 lower-expression indexes, with 0127's deterministic `wine_id asc` tie-break. Explicit column list (identity, geography, image url+kind, score). Granted to authenticated and service_role. | 0007 (shape); 0131; 0133 | — |
| 0147 | `xwines_catalog_name_lower_trgm_index.sql` | `gin (lower(name) gin_trgm_ops)` on `xwines_catalog` — the second half of the pair 0146's header assumed 0133 had built. 0133 indexed only `lower(winery_name)`, so `xwines_search`'s `lower(name)` predicate seq-scanned all 100,646 rows on every palette keystroke: measured 2026-09-01 at 1,459 ms on production and 681 ms locally for `esporao reserva`, 245 ms locally with the index (94 ms for `pol roger`). Index-only, 0133's exact shape; same rows, faster. The raw-column `xwines_catalog_name_trgm_idx` (0131) stays for `match_xwines`. | 0131; 0133; 0146 | — |
| 0148 | `wine_notes.sql` | Phase 1 of `docs/superpowers/specs/2026-09-03-wine-page-design.md`: `wine_notes` (the house tasting-note corpus — body, optional 100-point score, tasted_on, self-attributed author), `descriptors` (global controlled vocabulary; `family` groups chips and carries NO colour, because DESIGN.md forbids a fifth hue and bans exactly the warm mid-tones an aroma palette needs), `wine_note_descriptors` (composite PK is load-bearing — promotion of a model suggestion from `inferred` to `confirmed` is an UPDATE, and without the key an insert-based promotion would double-count that descriptor in every tally), `wine_reference_notes` (GLOBAL like `lwin_catalog`/`xwines_catalog`, no `restaurant_id`, deliberately NO tenant INSERT policy — service-role written only, since an authenticated user must never author a row every other tenant reads as sourced fact; `vintage` is NOT NULL because a vintage-less row would attach one vintage's score to another with a source URL beside it), and `wines.drink_window_basis` + `drink_window_set_by`/`set_at`. `wine_notes` RLS follows 0136 rather than membership alone: `wine_id` is `on delete cascade` and cascades bypass RLS, so the INSERT policy carries an `exists` check that the row's wine belongs to the row's own restaurant. `drink_window_basis` exists for two reasons — `manual_overrides text[]` cannot say WHO set a window, so the house's own window would otherwise be the only one unable to name its author; and `batch.ts` selects wines on `drink_window_start is null`, so without it the phase-2 retirement would make every retired wine the primary target of the next enrichment run and regenerate exactly what it removed. Additive only: four new tables and three new columns, and the one backfill writes only the new column. Override is written before inference so a wine satisfying both conditions resolves to `override`. | 0060; 0084; 0097; 0136 | — |
| 0148+ | reserved | Durable import staging IF VWP-D-04 chooses it; `wine_edition_formats` when barcode authority needs it; splat asset metadata if the spike passes | per decision | — |

**Sequencing note (documented deviation from PRD phase lettering):** rows 0112–0126
preserve the VWP DDL replay sequence. The order-independent function replacements at
0127–0129 are allocated from the reserved band and may land before that sequence; on a
clean rebuild they replay after it. Within the VWP sequence, substrate DDL (0121–0123)
precedes ratings DDL (0124–0126) to honor the synthesis's audited
"containers/slots/placements = 0121+" assignment. PRD Phases C and D describe feature
delivery and may overlap; ratings feature work starts as soon as 0124–0125 land. Nothing
in ratings blocks on the bins move (0123).

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
  raise decided by VWP-D-04 (staging → takes an 0130+ number). Acceptance: full partner
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
  *Spike-4 correction (2026-08-25): WineSensed cannot supply the labeled accuracy
  denominator — its rows carry opaque Vivino IDs with no wine/winery names, so its photos
  cannot be mapped to our editions. It is hard-negative / out-of-corpus abstention material
  and a domain-gap reference only. The labeled top-1/top-3 denominator comes from
  partner-cellar photos labeled by resolved edition (as Gate 0 already specifies). Drop
  "benchmark" framing for WineSensed wherever it appears.*
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
  Polycam→GaussianSplats3D; asset metadata migration only if approved (0130+).

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
| 1 | STT 50-utterance wine-vocab eval (FR/IT/ES producers) — **CLOSED 2026-08-25, audited (GPT-5.6 Sol) + remediated** (`2026-08-25-spike-01-stt-vendor-eval.md`) | SPEC-19/22 | **VWP-D-02 = AssemblyAI (demo-committed, production-provisional)** |
| 2 | Splat FPS (desktop + mobile) | SPEC-14 | VWP-D-06 |
| 3 | Wine-Searcher trial + ~~GWS~~ coverage on ~50 LWIN'd wines + written quotes — *GWS dropped 2026-08-25: domain parked/for-sale, no live API surface (evidence in `2026-08-25-spike-resources-status.md`); critic layer = WS aggregate + X-Wines community* | SPEC-16 | paid-tier viability |
| 4 | X-Wines/WineSensed join rates + X-Wines image manifest count — *datasets downloaded + MD5-verified 2026-08-25 (`~/projects/terroir-data/`); manifest half ANSWERED: X-Wines Full publishes NO label images (author on-demand only; Slim = 1,007); WineSensed 996,808 image refs in a 35 GB undownloaded archive. Join-rate half runnable now* | SPEC-04/16 | corpus expectations |
| 5 | DDGS 500-query soak — **CLOSED 2026-08-25** (`2026-08-25-spike-05-ddgs-soak.md`) | SPEC-04 | **viable cascade tier: 94.0 % ok / 0 empty over 500; transient timeout runs ≤ 3 force mandatory per-query retry (~30 s backoff) into SPEC-04** |
| 6 | e2e scan latency on demo hardware (cold/warm/concurrent p50/p95) — **CLOSED 2026-08-25** (`2026-08-25-spike-06-scan-latency.md`) | SPEC-05 | **RTX 4090-class box sufficient: warm e2e p50 0.18 s, ~5 req/s saturated; cold start ≈ 35 s makes SPEC-23 prewarm a quantified hard requirement; cached reference SuperPoint features become an index artifact** |
| 7 | Phone-photo vs. packshot LightGlue survival — **7a (synthetic) CLOSED 2026-08-25** (`2026-08-25-spike-07a-lightglue-survival.md`); **7b (real phone photos) OPEN — needs Devin's captures** | SPEC-03/05 | **rerank viable: LightGlue separates true/wrong perfectly across all degradations (worst true 37 vs wrong median ≤22 inliers); failure mode is candidate nomination (combo: 73 % top-1) → arms-union topology confirmed by measurement** |
| 8 | Assisted-grid UX flow (+ separate auto-grid feasibility) | SPEC-12 | v1 contract fit |
| 9 | Voice-retrieval eval construction — **CLOSED 2026-08-25, eval constructed + baselined** (`2026-08-25-spike-09-voice-retrieval-eval.md`) | SPEC-21 | **viable; forces producer-corroboration/margin rule into the resolver** |
| 10 | Partner-CSV GTIN coverage + vintage-uniqueness | SPEC-05 | VWP-D-07 barcode arm |
| 11 | `wine_lineages` status (deprecated vs. still-read; note eval F-2) | SPEC-01/24 | VWP-D-05 |

**Spike 1 — CLOSED 2026-08-25 (700 live transcriptions + 192 full-catalog resolutions;
adversarially audited by GPT-5.6 Sol, all corrections applied).** **VWP-D-02 =
AssemblyAI (Universal-3.5 Pro) — committed for the demo phase, provisional for
production** pending a small human/noisy/streaming validation. The decision rests on
the audit-prescribed metric: resolution correctness against the full 211k catalog,
utterance-clustered — AssemblyAI +18.8 pp naive / +17.2 pp producer-gated over corrected Deepgram (p = 0.009 naive,
p = 0.042 producer-gated). Findings that bind the specs: (a) **hot-list selection** —
Deepgram measured ceiling 75 phrases / 124 words (500-token cap); AssemblyAI accepted
93/156, documented to 1,000 words; nobody primes a 20k list. (b) **The dangerous
failure is the plausible-but-wrong transcript, now measured**: naive threshold
resolution misidentifies across producers at 31–50 %; a producer-corroboration gate
cuts that to 6–8 % (at 34–50 % abstention) — that gate is now a SPEC-21 requirement.
Empty transcripts (Deepgram `language=en`: 42 % of native clips; `multi` fixes it) are
the cheap detectable guard, mapped to abstention. (c) **Accent folding is a hard
requirement**: live pg_trgm shows accented-query-vs-ASCII-catalog at 0.294, below
match_lwin's 0.3 threshold, and match_lwin does not fold. All numbers are clean-TTS
oracle-primed upper bounds; scorer validated byte-exact against live pg_trgm (203
pairs, max delta 0.000000).

**Spike 9 — CLOSED 2026-08-25 (constructed + baselined).** 206 cases / 250-item fixture
from the production LWIN catalog; queries are spike 1's REAL AssemblyAI transcripts, so
degradation is measured, not synthetic. Naive trigram baseline separates STT configs
(92 % vs 81 % resolution) — the eval measures the pipeline end-to-end. Binding finding:
with a *perfect* transcript of an out-of-inventory wine ("Brunello di Montalcino from
Biondi-Santi"), the resolver false-accepts another producer's Brunello at 0.53 —
appellation vocabulary swamps producer signal, the same shared-vocabulary failure the
P2 round-5 critic proved at the identity gate (Pichon Baron/Lalande, 0.55). SPEC-21's
resolver therefore requires producer-token corroboration or a top-1/top-2 margin rule,
never a bare similarity threshold; out-of-inventory false-accept rate and
empty-transcript rate become gated metrics in the eval YAML.

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
