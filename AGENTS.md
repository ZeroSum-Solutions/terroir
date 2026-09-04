# AGENTS.md — working contract for this repo

For any engineer or coding agent making changes to Terroir. Read this before your
first edit. `README.md` tells you what the app is and how to run it; this file tells
you how to change it without breaking something load-bearing.

## What Terroir is

Restaurant and personal wine-cellar management. Photograph an invoice → Azure
Document Intelligence extracts text → Claude structures it into typed line items →
save to cellar. Also: bin placement, cellar health, reconciliation, partial-bottle
close-out, pricing and staff analytics, branded wine lists, bottle-label scan, team
management.

One Next.js 16 App Router deployable plus one background worker, both backed by
Supabase (Postgres + Auth). No microservices.

## Non-negotiables

Break any of these and you will cause damage that tests will not catch.

1. **`.env.local` holds production credentials.** Never point a test, script, or
   migration at it. `src/test/live-db-target.ts` refuses non-loopback hosts and
   `src/test/contracts/live-db-target.test.ts` enforces that every live-DB test uses
   that guard. Do not weaken, rename around, or skip either.

   **Start the dev server with `scripts/local/dev-local.sh`, never bare `pnpm dev`.**
   Plain `pnpm dev` loads `.env.local`, so it serves the hosted project while looking
   exactly like a local server — the terminal output is identical either way, and
   `/api/dev-login` is disabled only when `NODE_ENV === "production"`, which is false
   here. `dev-local.sh` pins the local stack in the *process* environment, which Next
   resolves ahead of any dotenv file. Add `DEV_BYPASS_EMAIL=owner+local@terroir.test`
   so the bypass identity matches the seed instead of inheriting the production address.

   **Playwright is guarded.** `playwright.config.ts` starts
   `scripts/local/dev-local.sh`, never reuses an unknown server on port 3000, and
   runs with zero retries. The required CI journey subset also sets
   `FAIL_ON_SKIPPED_TESTS=1`, so a loopback safety skip fails the gate instead of
   producing a false green. Keep all three safeguards when changing E2E startup.
2. **`src/types/database.ts` is generated.** Never hand-edit. `pnpm types:gen` after
   any migration; CI diffs it.
3. **Service-role usage bypasses RLS entirely.** Every service-role call site must
   gate on membership first and pass only the session's own `restaurantId` into
   subsequent `.eq("restaurant_id", …)` filters. There is no database backstop for
   this — it is application-code discipline, verified only by
   `src/lib/jobs/tenant-isolation.test.ts`. A new service-role call site is a
   review-worthy event, not a convenience.
4. **Migrations are forward-numbered with paired downs** from 0011 onward. Read
   `docs/runbooks/migration-numbering.md` before picking a number on a branch —
   collisions have happened. After a schema change: `pnpm snapshot` **and**
   `pnpm types:gen`, both before commit.
5. **Never hand-edit `docs/feature-ledger.json`.** It is the authoritative completion
   ledger and is CI-verified. Change it through its generator and run
   `pnpm verify:feature-ledger`.
6. **`main` is protected** with `enforce_admins: true` and a single required check
   running 18 gates. There is no path around it, by design. Do not try to find one.
7. **Merging to `main` deploys. Migrations do not ride along.** Railway is connected to
   `main` and ships the same SHA to *both* the `production` and `staging` environments;
   `railway.toml` runs `pnpm start` and nothing else. There is one Supabase project, so
   there is no database-level staging either. A migration reaches production only when
   someone applies it by hand —
   `docs/runbooks/production-migrations.md` is how. Write every migration so it is safe
   against a database the *old* code is still talking to, because that is the window it
   lands in.

## Gates that must pass before anything lands

CI runs these in one job; any failure fails the merge. Run the fast ones locally
first:

```bash
pnpm exec tsc --noEmit          # type-check
pnpm lint                       # ESLint + jsx-a11y
pnpm test                       # Vitest (live-DB suites self-skip locally, run in CI)
pnpm test:e2e                   # Playwright; starts the guarded local server itself
pnpm check:design               # palette, contrast, token-sync, typography ratchet
pnpm check:file-size            # file-size ratchet — 400 source / 1000 test; baselined files may shrink, never grow
pnpm check:control-rows         # GLOBAL-01 control-row ratchet
pnpm eval:vwp                   # VWP eval traceability (docs/evals/vwp-evals.yaml)
pnpm verify:feature-ledger
pnpm verify:api-contract
pnpm verify:product-conformance
pnpm run snapshot:check         # after any migration
pnpm run types:check:local      # after any migration
pnpm run downs:check
pnpm run manifest:check
```

`check:file-size` and `check:control-rows` are ratchets: they fail on *growth*, so a
change that is fine in isolation can red the merge because of where it landed. Pay the
debt down with `pnpm check:file-size:update` after splitting a file — do not raise the
baseline to make a gate pass.

If `pnpm test` passes locally but you touched anything tenant-scoped, **that is not
proof** — the cross-tenant containment suites only run against a live loopback
Postgres. Start one (`docs/runbooks/local-stack.md`) or rely on CI.

The full Playwright suite reports its remaining explicit skips. Do not describe a
run as complete coverage unless the active-test count and skipped count are both
recorded. The required critical subset fails on any skip.

## Where things live

| Concern | Home |
|---|---|
| Architecture and DB boundaries | `docs/ARCHITECTURE.md` — canonical |
| Code conventions, verified | `docs/CONVENTIONS.md` |
| Design contract | `DESIGN.md` (root). `docs/design/*` are archived predecessors — do not build from them |
| Completion status | `docs/feature-ledger.json` — the only authority |
| Operational procedures | `docs/runbooks/` (see its README index) |
| Active plans and specs | `docs/plans/` — `_archive/` is history, not backlog |

**Do not trust for current status:** `app_spec.txt` and `claude-progress.txt` — both
at the **repo root**, not in `docs/_archive/`. Both are frozen historical records, both
contain drifted claims (including a dead env var name), and both are retained as
evidence only.

**Do not move them into `docs/_archive/`.** They read like stale documents because they
are, but they are *machine-read*, not prose: `scripts/verify-feature-ledger.mjs` sets
`SOURCE_FILE = "app_spec.txt"`, and `src/lib/feature-ledger/verify-feature-ledger.test.ts`
resolves both repo-root-relative. Moving either reds `pnpm verify:feature-ledger`, which
is part of the one required merge check. This has already happened: they were moved to
`docs/_archive/` on 2026-08-29 and moved straight back the same day when the gate went
red. Correct their drift in place if you correct it at all; do not relocate them.
`docs/_archive/README.md` records the same rule.

## Known state you should not re-discover

- **No React Query, no SWR, no CVA, no shadcn/ui, no Radix.** Absent deliberately or
  by omission — check `docs/CONVENTIONS.md` before assuming a library exists.
- **Zod at the API boundary is the target, not the reality** — 46 of 94 routes today.
  New routes use zod; routes you touch get migrated.
- **`src/adapters/*` has no tests** and is mocked at every call site. A change there
  is invisible to the suite. Add a test with your change.
- **There are two identity systems.** `wines` (per-tenant) and the
  `canonical_wines`/`wine_variants`/`wine_aliases` spine. As of migration `0135`
  the spine is live on the manual/LWIN creation path:
  `find_or_create_wines_batch` resolves identity in one bulk
  `resolve_wine_variants_bulk` call, `wines.wine_variant_id` is written, and
  `canonical_wine_id` follows from 0098's trigger. `backfill_wine_identity(uuid)`
  is the idempotent repair function; the local seeder calls it because it writes
  `wines` directly.
  **In production the spine resolves 1064 of 1385 wines (2026-08-29, after
  `0137`).** It was 108 before. A CSV import had created 1277 wines with an
  *empty* `producer` and the producer name embedded in `name` ("Benjamin Leroux
  Vosne-Romanée"); identity resolution is producer-first, so none of them could
  resolve. `0137` recovered 956 producers by longest-word-prefix match against
  `lwin_catalog`, and every write is reversible from
  `public.producer_backfill_audit`. The remaining **321 keep an empty
  producer** — their producer is not in LWIN or is spelled differently
  ("Bérêche & Fils" vs the catalog's "Bereche et Fils") — and an unrepaired row
  is the correct outcome there, because a wrong producer is worse than a
  missing one.
  **The import path now GATES a blank producer instead of silently accepting
  one (SD-41).** It still accepts it — a real Binwise/BevSpot/CellarTracker
  export legitimately has no producer column, and rejecting those rows would
  reject the file — but confirm refuses unless the request carries an explicit
  `acknowledgedMissingProducerRows` count that is at least the count confirm
  re-derives for itself. The preview's old `role="status"` warning is now a
  checkbox that disables Confirm until ticked. The enforcement lives in
  `src/domains/import/producer-acknowledgement.ts` (which also records why
  rejecting the row, and why write-time recovery via
  `src/lib/wine-intelligence/producer-from-name.ts`, were both rejected), is
  called from `confirmImportBatch` before a single row is persisted, and is
  deliberately NOT part of `content_sha256`. **This changed the import UX: an
  operator importing a producer-less file must now tick a box.** What a
  successful import *produces* is unchanged — same rows, same `producer: ""`.
  **Do not expect a local checkout to match those production numbers, and do not
  read this as a closed incident.** `0137` is a *repair*, not a guard: it fixes
  rows that already exist and does nothing to the code path that creates them. Any
  re-import of the same CSV after `0137` has run reproduces the defect exactly.
  That has already happened on this checkout — measured 2026-08-30, full migration
  set applied: the `My Restaurant` tenant holds **1,277 wines with a blank
  `producer`, a null `colour`, and a null `hero_image_url`**, alongside the
  250-wine `LOCAL SEED - Osteria Scala` demo set. If your local numbers look like
  the pre-`0137` production ones, that is the expected outcome, not a broken
  checkout — it is the data the import-time guard above was built for, and it
  is still there: the guard stops the NEXT one, it repairs nothing.
  **The CSV import path (`apply_import_batch_chunk`) is still unresolved by
  design** — the P2 plan (§9/§12) puts that call in P3's TypeScript caller, once
  per batch of unique variants, before the per-row loop. The import dedup key is
  also still the fallback four-tuple in `src/domains/import/dedup-key.ts`.
  Both are open work; see `docs/plans/2026-08-29-modular-architecture-refactor.md`.
- **The `stock_adjustments` / `bottle_closeouts` RLS gap is CLOSED as of `0136`.**
  Both INSERT policies now require the row's `wine_id` (and
  `bottle_closeouts.open_bottle_id`, when non-null) to belong to the row's own
  `restaurant_id`. Before that they gated only on membership, and because both
  columns are `on delete cascade` and cascades bypass RLS, one tenant could file a
  policy-compliant row naming another tenant's wine and have it silently destroyed
  when that tenant deleted their own wine.
  `src/domains/cellar/wine-ownership-write-policies.test.ts` is the containment
  suite; it is live-DB-only, because the boundary being tested *is* RLS.
  The application-layer reference sweep in `src/domains/import/batch-service.ts`
  and its documented TOCTOU race (`docs/runbooks/csv-import.md`) still exist and
  are now belt-and-braces rather than the only guard. That runbook's claim that
  neither real fix has been done is stale — the policy fix is the one that landed.

## Commits

Conventional commits (`type: description`). One feature = one branch = one squashed
commit on `main`. Never commit to `main` directly.

## Next.js 16

This version has breaking changes from earlier App Router releases — APIs,
conventions, and file structure may differ from what you have seen elsewhere. Check
`node_modules/next/dist/docs/` before writing framework-level code, and heed
deprecation notices.
