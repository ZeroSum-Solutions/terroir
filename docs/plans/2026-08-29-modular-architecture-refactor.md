# Modular Architecture Refactor — Plan

**Status:** Draft for review
**Date:** 2026-08-29
**Baseline commit:** `8c777d5` (main, clean)
**Goal:** Make Terroir a codebase where several senior engineers can work in parallel without colliding, and where no single file or module can grow back into a monolith.

---

## 1. What this plan is, and is not

This is **not** a rescue refactor. The investigation that produced this plan found a
codebase with unusually strong governance already in place. The refactor's first
obligation is to **not break that**, and its second is to close the one structural
gap that governance does not cover: nothing in this repo says where a given piece of
logic belongs.

### 1.1 What we are explicitly preserving

These are load-bearing and must survive every phase intact. Any phase that reds one
of these is rolled back, not "fixed forward":

| Asset | Where | Why it matters to the refactor |
|---|---|---|
| Single required merge gate, `enforce_admins: true` | `.github/workflows/ci.yml`, branch protection on `main` | 14 sequential gates in one job. Any step failing fails the merge. This is the refactor's safety net. |
| Live Postgres in CI | `ci.yml` — `supabase start`, all 108 migrations, seeded fixtures, env exported | The live-DB suites (~69 tests, all cross-tenant containment) run for real on every PR. |
| Loopback-only live-DB guard | `src/test/live-db-target.ts`, `src/test/contracts/live-db-target.test.ts` | `.env.local` holds **production** credentials. This guard is the only thing standing between `pnpm test` and a destructive run against prod. The contract test prevents the guard being bypassed by a rename. |
| Generated-types drift check | `pnpm types:check:local`, `scripts/check-types-drift.mjs` | `src/types/database.ts` (2,571 lines) is generated and CI-verified. **Never hand-edit; never "refactor".** |
| Schema snapshot + down-migration pairing | `snapshot:check`, `downs:check`, `manifest:check` | 98 of 108 migrations have paired downs; the 10 exempt are documented in `supabase/migrations/down/README.md`. |
| Design-system enforcement | `pnpm check:design` — 4 scripts, gated in CI | Palette, contrast, token-sync, typography ratchet. Currently passing. |
| Mutation-proven coverage thresholds | `vitest.config.ts` — `reconcile-ledger`, `domains/cellar`, `domains/pours` at 94–100% | The only quantified confidence in the repo. Thresholds may only go up. |

### 1.2 Success criteria

The refactor is done when all of the following are true and verified:

1. Every bounded context has exactly **one** home. Answering "where does cellar logic
   live?" has one correct answer, not four.
2. A structural lint gate exists and is CI-enforced, so the next 2,390-line file
   cannot land.
3. `apps/worker` cannot import `next/*` — enforced by the compiler, not by
   convention.
4. Data access has a chokepoint per context; a route cannot invent its own query
   against a table another context owns.
5. Every doc in the repo is either current-and-true or archived. No file claims
   something the code contradicts.
6. All preserved gates from §1.1 still pass, and CI covers strictly more than it did
   at `8c777d5`.

---

## 2. Findings that drive the design

Evidence-cited. Figures re-verified directly against the working tree at `8c777d5`.

### 2.1 The core problem: no single owner

One bounded context may currently live in up to four places — `src/domains/X`,
`src/lib/X`, a differently-named `src/lib/X-adjacent`, and `src/app/(app)/X/*.tsx`.

**Cellar** is the clearest case:

| Location | Lines (excl. tests) |
|---|---|
| `src/domains/cellar/**` | 382 |
| `src/app/(app)/cellar/**` | 9,689 |

25× more cellar business logic lives in the UI tree than in the domain module.
Related cellar logic is additionally scattered across `src/lib/cellar-facets`,
`src/lib/cellar-health`, `src/lib/bins`, and `src/lib/partial-bottles`.

**Scanning** is split across five top-level trees for one feature:
`src/domains/scanning` (orchestration) · `src/lib/scanner` (14 files, 1,240 lines —
the actual extraction/scoring mechanics) · `src/adapters/{llm,ocr}` ·
`src/app/(app)/scan` · `src/app/api/scan*`. The `scanning` vs `scanner` name split is
a coin-flip for anyone who did not write it.

`src/domains/` is not a designed layer — it is an in-flight, opportunistic
extraction. `docs/ARCHITECTURE.md` admits as much in its "Remaining Handoffs"
section. `src/domains/import` alone is over 90% of all domain code;
`src/domains/identity` has **zero** app-tree importers and is really a private helper
of import/scanning wearing a top-level label.

### 2.2 No data-access chokepoint

Verified directly:

- **93** API route files. **72 (77%)** construct their own Supabase queries inline
  (`.from(` or `.rpc(`). Only **21** delegate outward.
- **44 of 93 (47%)** use zod. The rest hand-roll validation — not absent, but a real
  convention split.
- `src/app/(app)/insights/page.tsx` shows the same pattern one layer up: a server
  component running raw `await supabase.from(...)` in page-local functions
  (`fetchPastDrinkWindow:192`, `fetchSnoozedAlerts:1146`).

Consequence: two engineers touching the same table from two different surfaces have
no shared chokepoint to review. Query-shape drift — a dropped `.eq()` filter, a wrong
join — is invisible until production.

### 2.3 No structural gate

`eslint.config.mjs` has no `max-lines`, no `boundaries`, no `no-restricted-imports`.
Nothing prevents regrowth. The design-system typography ratchet
(`check-design-typography.mjs`, fingerprinted baseline that can only shrink) is the
pattern to copy here — it already works, and it is already in this repo.

### 2.4 Dependency-direction violations

- `src/lib/jobs/invoice-extract-handler.ts:2` imports `@/domains/scanning/invoice-scan-service` — infrastructure reaching up into a business workflow.
- `src/adapters/llm/anthropic-invoice-extraction.ts:1` imports `@/lib/ai/anthropic-client`; `src/adapters/ocr/azure-document-intelligence.ts:8` imports `@/lib/scanner/ocr-service`. The ports depend on the layer that should depend on them — **inverted ports-and-adapters**. Two of the four adapter barrels are unused; call sites import the concrete file directly.

### 2.5 The monoliths

Ten files. Most are **already function-boundary-clean** — the subcomponents exist as
named functions in the same file — which makes the majority of this work mechanical
rather than risky.

| File | Lines | Character |
|---|---|---|
| `src/domains/import/batch-service.ts` | 3,149 | 9 distinct responsibilities. Highest risk. |
| `src/app/(app)/import/import-client.tsx` | 2,390 | ~380 lines of pure non-React logic + 4 step components inline |
| `src/app/(app)/import/session-step.tsx` | 1,650 | 73% pure non-component code above the single export |
| `src/app/(app)/lists/[id]/wine-list-editor.tsx` | 1,250 | 2 already-standalone functions; 2 inline `DndContext` blocks |
| `src/app/(app)/cellar/wine-detail-drawer.tsx` | 1,220 | 6–7 provably independent action clusters. **Best ROI.** |
| `src/app/(app)/insights/page.tsx` | 1,201 | Server component, zero hooks. Best-architected of the ten. |
| `src/app/(app)/cellar/cellar-list.tsx` | 1,110 | 5 subcomponents already isolated. Purely mechanical. |
| `src/app/(app)/scan/scanner.tsx` | 913 | 17 `useCallback`; explicit `Status` enum never made a reducer |
| `src/app/(app)/scan-bottle/page.tsx` | 813 | 9-phase enum, no `views/` dir despite sibling `scan/views/` precedent |
| `src/app/(app)/team/team-actions.tsx` | 745 | 0 `useCallback` despite 500+ lines of handlers |

`src/types/database.ts` (2,571) is **generated and excluded** from all monolith work.

`batch-service.ts` carries an inline comment trail — `"Round-10 audit, HONESTY-CORRECTED round-11"`, `"Sol round-2/3 audit (2026-08-27) findings 2/3/4/6"` — showing it has been repeatedly patched in place by adversarial audits and never split. It is the textbook accretion monolith and the single biggest collision magnet in the repo.

### 2.6 Missing UI primitive layer

No shadcn/ui, no Radix, no CVA, **no `<Button>` primitive anywhere**. 180–247 raw
`<button className="...">` call sites hand-specify variant and size classes
independently. Six to seven modals hand-roll the identical dialog shell
(`fixed inset-0 z-[var(--z-dialog)] ... role="dialog" aria-modal="true"`) instead of
using the existing `src/components/action-dialog.tsx` — each independently wiring the
*shared* `useFocusTrap` hook. ~1,500 lines of duplicated dialog chrome.

`src/components/` holds only ~11 shared files against ~130 feature-colocated files
(~30,372 lines).

---

## 3. Blockers — resolve before or during, not after

These outrank the refactor. Two are correctness issues; one is a design decision the
boundary work depends on.

### 3.1 [HIGH] Cross-tenant cascade-delete via unconstrained `wine_id`

INSERT policies on `stock_adjustments` and `bottle_closeouts` check
`is_member(restaurant_id) and acting_user_id = auth.uid()` but **do not verify
`wine_id` belongs to that same tenant**. `wine_id` is `ON DELETE CASCADE`, and
Postgres FK cascades bypass RLS — so a tenant-B member can insert a row naming tenant
A's `wine_id`, and tenant A deleting that wine silently cascade-deletes tenant B's
row.

Current mitigation is an app-layer service-role reference sweep before every wine
delete, with a documented, narrowed-but-open TOCTOU race
(`src/domains/import/batch-service.ts:1860-1990`,
`docs/runbooks/csv-import.md:523-620`). Both real fixes are already named in that
runbook and neither has been done:

- add an ownership `WITH CHECK` to the write policies, **or**
- move the re-check and delete into one `SECURITY INVOKER` RPC transaction.

**Action:** fix at the schema level in Phase 0. Do not carry this through a refactor
that touches wine deletion.

### 3.2 [HIGH] Worker tenant isolation has no database backstop

The worker runs entirely on the service-role key, which bypasses RLS. Tenant scoping
is application-code convention — every query manually filtered by the job's
`restaurant_id` — verified only by `src/lib/jobs/tenant-isolation.test.ts`, whose own
header says so plainly. Any new worker code path that forgets a filter has no
database-level safety net.

**Action:** the boundary work in Phase 3 makes this enforceable — the worker's data
access goes through `packages/db`, where the filter can be structurally required
rather than remembered.

### 3.3 [DECIDED 2026-08-29 — finish it. Partly done] The identity spine

**Original finding.** `canonical_wines` / `wine_variants` / `wine_aliases` were added
in migrations 0097–0101. The RPC `resolve_wine_variants_bulk` had **zero production
callers** — only tests. Measured on a freshly seeded local stack: **250 wines, 0 with
`wine_variant_id`, 0 with `canonical_wine_id`, and all three spine tables empty.** Not
partly wired — it held no rows at all. `src/lib/wine-intelligence/xwines-profile.ts`
prefers the `canonical_wine_id` link (0132) and silently degrades without it, so the
X-Wines join that 0131–0134 exist to serve never ran in its intended mode.

**Owner decision: finish the migration.**

**Landed — migration `0135_identity_resolution_on_write.sql`:**

- `find_or_create_wines_batch` (the manual / create-from-LWIN path) now resolves
  identity in **one bulk call after its loop**, honouring §9's "once per batch of
  unique variants" contract. `canonical_wine_id` follows from 0098's trigger.
- Resolution failure raises a `WARNING` and leaves `wine_variant_id` null rather than
  failing the wine write. A lost write is unrecoverable; an unresolved row is
  repairable, and the null is itself the queryable signal.
- `backfill_wine_identity(uuid)` — idempotent, pages by id, `SECURITY INVOKER`,
  granted to `service_role` only.
- `resolve_wine_variants_bulk` gains a `service_role` grant. 0099 granted it to
  `authenticated` only, so no service-role caller could execute it at all — found by
  running the real reset-and-seed path, not by reading. Deliberately **not** fixed by
  making the backfill `SECURITY DEFINER`: 0099's tenant boundary *is* invoker-mode
  RLS, and definer rights would erase it.
- `scripts/seed-local-supabase.mjs` calls the backfill. It upserts `wines` directly,
  so without this every CI run and every local reset reproduced the original
  null-identity state.
- Coverage: `src/domains/identity/identity-on-write.test.ts`, a live-DB suite whose
  central case is the point of the whole spine — two tenants holding the same wine get
  **separate `wine_variant_id`s under one shared `canonical_wine_id`**.

Verified from a clean `supabase db reset` + seed: **250/250 wines resolved**, 250
canonical rows, 250 variants. Full suite 2779 passing with the live DB attached.

**Still open — deliberately, with reasons:**

1. **`apply_import_batch_chunk` does not resolve.** CSV import is the majority of wine
   creation by volume. The P2 plan (§9, §12) places that call in P3's *TypeScript*
   caller, once per batch of unique variants, before the per-row loop — hooking it
   into the per-row loop would break the C10 performance contract on a path handling
   4,000–8,000 rows per session.
2. **The import dedup key is still the fallback four-tuple** in
   `src/domains/import/dedup-key.ts`. Switching it to `wine_variant_id` changes *which
   rows collapse into one wine* — a behavioural change needing its own evidence, not a
   side effect of populating identity.
3. **`canonical_wines.xwines_wine_id` is 0/250 populated.** The spine now feeds
   `match_xwines`, but nothing persists the match. Separate gap, newly visible.

**Sequencing conflict to note:** item 1 lands in `src/domains/import/batch-service.ts`
— the 3,150-line file Phase 2 decomposes. These two must not run concurrently on the
same file. See §7.4.

### 3.4 [HIGH for refactor safety] `src/adapters/*` has zero tests

Four adapters — Azure Document Intelligence OCR, Anthropic invoice extraction,
html-to-pdf, Supabase storage — have **no test files**, and every call site mocks the
adapter module wholesale. Response parsing, error mapping, and retry/timeout behavior
of the real calls are never exercised. A refactor here is invisible to the entire
suite, and §2.4 says this layer needs to change.

**Action:** Phase 0 adds fixture-based adapter contract tests before Phase 3 touches
them.

---

## 4. Target architecture

Five packages, each with a stated reason to exist. Not thirteen — contexts that still
share the `wines` / `inventory_items` tables and the `restaurantId` auth kernel are
not ready to be separately versioned, and packaging them early would force premature
interface design or produce a `@terroir/core` that everything depends on anyway.

```
apps/
  web/                    Next.js 16 App Router. Route shells only.
    app/(app)/<feature>/
      page.tsx            server component: auth + fetch via domain service + render
      <feature>-shell.tsx thin client orchestrator, target < 300 lines
      views/              one file per step/phase/mode
      components/         feature-local composites, built on @terroir/ui
      hooks/              feature-local state hooks
    app/api/<route>/route.ts   thin: auth → validate (zod) → call domain → map response

  worker/                 tsx long-poll runner. MUST NOT resolve next/*.
                          Compile-enforced via its own tsconfig, not convention.

packages/
  ui/                     Nocturne primitives + tokens. Zero business logic,
                          zero data access. Button, Dialog, Field, IconButton,
                          StatusChip, Skeleton, RouteDataState.

  db/                     The data chokepoint. Generated types, Supabase clients,
                          service-role guard, tenant-scoping helpers. 66+ importers
                          today — making it a package makes the RLS/service-role
                          discipline reviewable in one place.

  domain/                 All bounded contexts, one directory each, with
                          eslint-plugin-boundaries enforcing context-to-context rules.
    cellar/               absorbs lib/{cellar-facets,cellar-health,bins,partial-bottles}
                          + the business logic currently inlined in app/(app)/cellar/*.tsx
    import/               batch-service split per §5.2
    scanning/             absorbs lib/scanner — kills the scanning/scanner name split
    identity/             internal shared kernel (pending §3.3 decision)
    reconciliation/       merges lib/{reconcile-queue,reconcile-ledger,reconciliation}
                          into {queue,ledger,variance}
    pricing/              merges lib/{pricing,pricing-recommendations} into {core,recommendations}
    wine-lists/
    pours/
    jobs/                 async queue. NOTE: distinct from reconcile-queue despite
                          the name echo — do not merge.
    team/                 the one cross-cutting seam. Every other context depends on
                          it for restaurantId resolution. Do not let contexts
                          re-implement membership checks.
```

**Not moving to packages:** `scripts/` and its tests. `src/lib/api-route-inventory`,
`src/lib/feature-ledger`, and `src/lib/product-contract-conformance` contain **zero
source files** — only tests that import implementations from `scripts/*.mjs`. They
are governance-test scaffolding mislabeled as lib modules and relocate to
`scripts/__tests__/`.

### 4.1 Enforcement — the boundaries must be mechanical

Boundaries that live only in a document are boundaries that decay. Each rule below
gets a CI gate:

| Rule | Mechanism |
|---|---|
| `apps/worker` never resolves `next/*` | separate tsconfig project reference; `tsc --noEmit` per project |
| `packages/ui` imports no domain or db | `eslint-plugin-boundaries` |
| `packages/domain/<ctx>` imports no other context except `team` and `core` types | `eslint-plugin-boundaries` |
| Only `packages/db` constructs Supabase queries | `no-restricted-imports` + a ratcheted `.from(`/`.rpc(` call-site baseline |
| No file regrows past its budget | `max-lines` with a fingerprinted baseline that can only shrink — same pattern as `check-design-typography.mjs` |
| Every context has an owner | `CODEOWNERS` per package/context |

---

## 5. Phases

Each phase ends with a verification gate. **A phase is not done until its gate is
green in CI**, not locally.

### Phase 0 — Close the blockers and widen the net (no code moves)

Nothing structural moves until the safety net covers what the refactor will touch.

| # | Work | Verify |
|---|---|---|
| 0.1 | Fix the `stock_adjustments` / `bottle_closeouts` RLS gap (§3.1) at the schema level | new migration + paired down; a live-DB test proving a forged cross-tenant `wine_id` insert is rejected |
| 0.2 | Adapter contract tests for all four adapters (§3.4) — fixture-based, mocking only the network transport, not the adapter's own parsing/error logic | `src/adapters/*` coverage > 0; the four suites red when a parse path is mutated |
| 0.3 | Run the **full** `e2e/` suite in CI, not 2 of 19 files. Keep today's 2 as the PR-blocking subset if runtime matters; add the rest as a `main`/nightly job feeding the existing `ci-main-alert.yml` pattern | 19 specs execute somewhere in CI; the 9 that self-skip under CI either run or carry a dated, justified skip |
| 0.4 | Wire `assertNoSeriousA11yViolations` into the already-existing but unwired specs — `import-journey`, `insights-drilldown`, `team-mobile`, `scan-intake-mobile` | axe covers the routes owning 8 of the 10 monoliths, which today it does not |
| 0.5 | Add `eslint-plugin-boundaries` + `max-lines` with today's sizes as the starting baseline; ratchet only | `pnpm lint` green; baseline file committed |
| 0.6 | Delete `src/lib/supabase/client.ts` (zero importers, verified) | `tsc --noEmit` green |
| 0.7 | Relocate the three fake lib modules to `scripts/__tests__/` | governance gates still green |
| 0.8 | Resolve §3.3 — decide the identity spine's fate and record it in `docs/decisions/` | decision recorded |

**Gate:** full CI green, plus adapter coverage non-zero, plus the a11y and e2e
expansion visibly running.

### Phase 1 — Documentation truth pass

Nothing in the tree may claim something the code contradicts. Per-file verdicts and
their evidence live with the files themselves — `docs/_archive/README.md`,
`docs/plans/_archive/README.md`, and `docs/design/README.md` each record why their
contents were retired. Most of this phase is **already done**; see §5.1.

Headline items:

- `AGENTS.md` is 327 bytes of generic Next.js boilerplate, last touched **2026-04-17**, containing nothing project-specific. `CLAUDE.md` is one line: `@AGENTS.md`. The agent-instruction layer is effectively empty — rewrite both.
- `claude-progress.txt` (83KB) self-describes as superseded by `docs/feature-ledger.json` — archive out of the repo root.
- `app_spec.txt` (34KB) is duplicated at `.zeroforge/prompts/app_spec.txt` — deduplicate.
- `docs/design/DESIGN-cantina-2026-08-26.md` is the **superseded** predecessor palette; its `gold: #786218` and cream `#E3D9CB` are exactly what `check-design-palette.mjs` now rejects. `docs/design/DESIGN-nocturne-typography-2026-08-29.md` is a same-day intermediate draft whose own frontmatter still describes the direction its body argues against. Neither is marked historical → `docs/design/_archive/`.
- Plans for shipped work → `docs/plans/_archive/` per the plan-hygiene convention. Move, don't delete.
- **25MB of committed PNGs** under `docs/screenshots/` — two-thirds of the repo's 37MB. Decide: keep as verification evidence, or move to a release artifact. New screenshots stop being committed either way.

**Residual, not yet done:** `DESIGN.md`'s unterminated frontmatter is fixed (see
§5.1), but the document is still **off-schema** for `@google/design.md` — 19 sections
against the canonical 8, "Colors" renamed to "Colours", and Layout / Shapes /
Components absent. The linter passes because those are structural conventions it does
not enforce, not because the document conforms. Reconciling the section order is a
design-review task, not a mechanical one, and is deliberately left out of this phase.

**Audit limits — treat as unverified, not confirmed:** `docs/AUTH-SETUP.md`,
`docs/LOCAL-SUPABASE.md`, `docs/PERF-BUDGET.md`, and `docs/DEMO-DATA.md` were **not**
command-level verified during the 2026-08-29 pass. An earlier draft of the audit
reported them as verified; that claim did not hold up. Verify them before relying on
them.

**Gate:** every retained doc's commands, env vars, and paths verified to exist; no
doc contradicts another; `README.md` gets a new engineer to a running local stack.

### 5.1 Already done (2026-08-29, branch `chore/refactor-prep-docs`)

Landed ahead of the phase plan because each was mechanical and independently
verifiable:

- `DESIGN.md` frontmatter terminated. **Before:** `design.md lint` returned *"No YAML content found"* with 0 errors and exit 0 — a false pass validating none of the tokens. **After:** it parses and validates 60 colors, 16 typography scales, 5 rounding levels, 9 spacing tokens. All four `pnpm check:design` gates still pass.
- `AGENTS.md` rewritten from 327 bytes of generic Next.js boilerplate (untouched since 2026-04-17) into a real working contract. `CLAUDE.md` stays a thin `@AGENTS.md` import, which is correct — it just now points at something.
- `docs/CONVENTIONS.md` created, every claim verified against the tree. Replaces `.planning/codebase/CONVENTIONS.md`, which asserted CVA as the variant convention (CVA is not in this repo) and "no destructive down migrations" (`downs:check` in fact *requires* paired downs).
- `.planning/` (5 files, generated 2026-05-01, never updated, referenced nowhere) archived to `docs/_archive/planning-codebase-2026-05-01/`.
- 22 shipped or superseded plans and the 10 UX implementation audits archived, each with a stated verdict. `docs/plans/` drops from 35 files to 14 active.
- `PROJECT.md` (orphaned tool output) archived; `scratchpad/` untracked and gitignored.
- Index pages added: `docs/runbooks/README.md`, `docs/design/README.md`, `docs/_archive/README.md`, `docs/plans/_archive/README.md`.
- **File-size ratchet** added — `scripts/check-file-size.mjs` + `pnpm check:file-size`, wired into CI. 62 files over 400 lines and 49,156 lines of monolith debt are now frozen in a baseline that can only shrink. Verified to fail on both growth of a baselined file and a new oversized file.
- **`.github/workflows/e2e-full.yml`** added — runs all 19 e2e specs nightly and on push to `main`, opening an issue on failure. The required PR check keeps its fast 2-spec subset.

**A trap worth knowing about:** `app_spec.txt`, `claude-progress.txt`,
`docs/plans/2026-07-20-terroir-completion-spec.md`, and
`docs/plans/2026-08-23-p2-identity-spine.md` all *read* like stale documents and are
all **machine-read** — `scripts/verify-feature-ledger.mjs` and its tests load them by
path. Archiving them reds the merge gate. This was discovered by doing it. Before
moving anything out of `docs/plans/`, run
`grep -rn "docs/plans/<file>" scripts .github src e2e`.

### Phase 2 — Mechanical decomposition (no logic changes)

Lowest risk, highest immediate parallel-work payoff. Every move here is
extract-to-file of an already-isolated function, or a path rewrite the compiler
verifies.

Ordered by ROI:

1. `wine-detail-drawer.tsx` — 6–7 provably independent action clusters + 5 already-isolated presentational sections. Introduce `useAsyncAction` (`{busy, error, run()}`) to replace the repeated `setBusy/try/catch/finally` shape.
2. `cellar-list.tsx` — 5 subcomponents already defined; pure extract-to-file.
3. `import-client.tsx` + `session-step.tsx` — move ~380 + ~1,195 lines of pure non-React logic into the domain; split `UploadStep`/`PreviewStep`/`BatchStep` to files, matching the pattern `session-step.tsx` already half-follows.
4. `wine-list-editor.tsx` — extract `ListActions`, `SortableSectionButton`; wrap the two `DndContext` blocks in hooks.
5. `team-actions.tsx`, `wine-list-landing.tsx` — one flow hook each; per-row action state becomes a keyed reducer, not 5 flat booleans.
6. `insights/page.tsx` — move `Sparkline`/`ThroughputBarChart` to a shared chart module; relocate the page-local fetch functions to the domain.
7. `scanner.tsx` + `scan-bottle/page.tsx` — both explicit enums become reducers; give `scan-bottle` a `views/` dir mirroring `scan/views/`; unify the two independently-reimplemented `loadScan`/`saveScan` localStorage helpers.

Fold the typography baseline burn-down into each file's PR — the ~1,248 baselined
`text-[Npx]` violations cluster almost 1:1 on these files. Include
`price-comparison/page.tsx` (66 violations, the worst single offender, not in the
original ten).

**Gate:** `max-lines` baseline strictly shrinks each PR; typography baseline strictly
shrinks; full CI green; no behavior change (existing suites pass unmodified).

### Phase 3 — Boundary consolidation (behavior-preserving, needs tests first)

Now the risky work, on a net that Phase 0 widened.

1. Build `packages/ui`: real `<Button>` and generalized `<Dialog>`; `ActionDialog` becomes a specialization. Migrate the 6–7 hand-rolled modal shells. This closes ~1,500 lines of duplicated chrome and removes the class of bug where a future modal gets `role`/`aria-modal`/focus-trap subtly wrong.
2. Fix the adapter inversion (§2.4) — adapters import only node builtins, vendor SDKs, and domain types. Never `@/lib`. Fix `lib/jobs` → `domains/scanning` the same way.
3. Merge `lib/scanner` → `domains/scanning`. Path rewrite; compiler + existing suites catch misses.
4. Merge the three reconcile-* folders into `reconciliation/{queue,ledger,variance}`. **`reconcile-ledger` does non-transactional ordered writes with explicit compensation** (`docs/ARCHITECTURE.md:39-42`) — write a partial-failure/undo test before touching it.
5. Merge `pricing` + `pricing-recommendations` into `pricing/{core,recommendations}`.
6. Split `batch-service.ts` along its 9 existing seams → `batch-create`, `batch-apply`, `batch-revert`, `batch-status`, `orphan-cleanup` (~900 lines, its own concern), and move the generic Supabase pagination helpers (`fetchAllRows`, `fetchAllRowsForIds`, `chunkIds`) to `packages/db`. Its 4,856-line test file must stay green line-for-line; add revert/duplicate-detection interaction tests **first**.
7. Introduce per-context data-access services and route the 72 inline-query routes through them. Highest effort, highest long-term payoff. Needs request/response tests per route against the seeded local Supabase before and after — this is exactly the change that silently alters query shape without a type error.
8. Standardize the 49 non-zod routes onto zod, in the same PRs that touch them.
9. Centralize env access — 34 raw `process.env` reads across 17 files — into one zod-validated config module, matching the house convention.

**Gate:** full CI green including the widened e2e and a11y; the `.from(`/`.rpc(`
call-site baseline outside `packages/db` strictly shrinks each PR.

### Phase 4 — Package extraction

Only now, and only because the boundaries already exist and are lint-enforced. This
phase is mechanical: move directories, add `package.json` files, wire
`transpilePackages`, split tsconfig project references, add `CODEOWNERS`.

Extract in dependency order: `ui` → `db` → `domain` → `apps/web`, `apps/worker`.

**Gate:** `apps/worker` fails to compile if it imports `next/*` — proven by a
deliberate red test. Full CI green. `pnpm build`, `pnpm test`, `pnpm worker` all work
from a clean clone.

---

## 6. Sequencing rationale

The module reorganization is identical work whether or not it ends in packages, and
packages cannot be drawn before the boundaries exist. Putting extraction last means:

- every earlier phase delivers standalone value and is independently revertable;
- Phase 4 is cheap and low-risk when reached, because it moves already-separated things;
- if the team decides mid-way that lint-enforced boundaries inside one package are
  sufficient, Phases 0–3 are not wasted — they were the point.

---

## 7. Decisions — all four resolved 2026-08-29

### 7.1 Identity spine — **FINISH IT.** Partly landed.

Migration `0135` is in. See §3.3 for what shipped, what is still open, and why.

### 7.2 `docs/screenshots/` (25MB) — **KEEP COMMITTED.**

They stay in the tree as verification evidence. No history rewrite, which also means
no force-push against a public repo and no broken clones for anyone who has already
forked. The cost is accepted knowingly: ~two-thirds of a 37MB repo, paid once per
clone.

Consequence to hold, not a re-litigation of the decision: this makes the git object
store monotonic. If the directory keeps growing at its current rate the clone cost
grows with it and cannot later be undone without the history rewrite that was just
declined. Worth a periodic size check; not worth acting on now.

### 7.3 Full e2e — **STAYS NIGHTLY + ON-MAIN-PUSH, WITH ALERTING.** Resolved.

Consulted GPT-5.6 (Codex) as instructed, framed on feedback latency at PR time versus
post-merge detection latency. Its recommendation and the measured state of the repo
agree, so no change ships:

The required check already runs the critical journeys (G1–8) against a real disposable
Supabase in ~9 minutes. Promoting the full nineteen-spec suite to merge-blocking would
multiply that across every push and every rebase of ten concurrent branches, and the
slower signal would routinely arrive after the author had already context-switched —
paying PR-cycle time for coverage whose failures are, in this repo, overwhelmingly
post-merge-detectable and cheap to fix forward.

So the existing split is correct and is now a deliberate decision rather than an
accident of how the workflows grew:

| Suite | Trigger | Role |
|---|---|---|
| Critical journeys G1–8 (`ci.yml`) | every PR, required | merge gate — blocks |
| Full nineteen specs (`e2e-full.yml`) | nightly 07:00 UTC, push to `main`, manual | regression net — alerts |

Both failure paths are wired and verified present: `e2e-full.yml` and `ci-main-alert.yml`
each open a labelled issue on failure and comment on the existing one rather than
spamming duplicates. A scheduled job that fails silently is worse than no job, and
neither of these does.

**One addition adopted from the consult:** dispatch `e2e-full.yml` manually
(`workflow_dispatch`) before merging any branch that touches e2e infrastructure or
crosses unusually many surfaces. That buys full coverage exactly where the cheap
subset is least representative, without taxing the other ninety-odd percent of PRs.

### 7.4 Phase 2 parallelism — **PARALLEL DEVELOPMENT, SERIALIZED LANDING.** Resolved.

The question "are the ten decompositions independent?" has two different answers
depending on which activity is being asked about, and conflating them is what makes
parallel refactors go wrong.

**Development: fully parallel, 10-wide.** Verified by file inventory — each
decomposition's primary targets sit in a distinct directory, and no two touch the same
source file:

| # | Target(s) | Lines | Directory |
|---|---|---|---|
| 1 | `cellar/wine-detail-drawer.tsx` | 1,220 | `cellar/` |
| 2 | `cellar/cellar-list.tsx` | 1,110 | `cellar/` |
| 3 | `import/import-client.tsx` + `session-step.tsx` | 2,390 + 1,650 | `import/` |
| 4 | `lists/[id]/wine-list-editor.tsx` | 1,250 | `lists/[id]/` |
| 5 | `team/team-actions.tsx` + `lists/wine-list-landing.tsx` | 745 + 624 | `team/`, `lists/` |
| 6 | `insights/page.tsx` | 1,201 | `insights/` |
| 7 | `scan/scanner.tsx` + `scan-bottle/page.tsx` | 913 + 813 | `scan/`, `scan-bottle/` |
| 8 | `price-comparison/page.tsx` | 875 | `price-comparison/` |

**Landing: strictly serialized merge train.** Independence during development does not
survive contact with the shared ratchets. Three known contention classes, all of which
the train handles:

- **`scripts/file-size-baseline.json` and `scripts/design-typography-baseline.json`** —
  every branch rewrites both. Mechanical, never semantic. Both accept `--update`, so the
  resolution is always *discard both sides and regenerate against the combined tree* —
  never `--ours`, never `--theirs`, never hand-merged. Picking a side silently re-admits
  the other branch's already-eliminated violations back into the baseline, which is how a
  ratchet quietly stops ratcheting.
- **`src/domains/import/batch-service.ts` (3,149 lines)** — contended by Phase 2 item 3
  and by §3.3's open import-path identity work. Serialized against each other regardless.
- **Generated artifacts** — `schema.snapshot.sql`, `src/types/database.ts`, the
  API-contract and product-conformance outputs. Any branch touching a migration
  invalidates them for every branch in flight. Phase 2 touches no migrations, so this
  class is dormant for this wave, but it reactivates the moment Phase 3 starts.

**The train, per branch, one at a time:** rebase onto current `main` → discard both
baselines and regenerate → run the full required CI against that exact rebased SHA →
merge only if green. This also catches the case the whole design is for: two branches
that each pass CI alone and fail together. Ten branches each green against a stale `main`
proves nothing about the tree that results from merging them.

Development parallelism is where the wall-clock is won; landing serially costs one CI
run each and is the only thing that makes the parallelism safe.

---

## 8. Estimate

Phase 2 is roughly 3–4 engineer-weeks and is mostly mechanical extraction of
structure that already exists inside the files. Phase 0 and Phase 1 are days, not
weeks, but they gate everything. Phase 3 is the real work and should be estimated per
item after Phase 0 reveals how much the widened net actually catches. Phase 4 is days.

Do not compress Phase 0. Every hour skipped there is paid back with interest in
Phase 3, on a codebase where the riskiest file already has a comment trail recording
the production invariants it has broken before.
