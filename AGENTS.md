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
   running 14 gates. There is no path around it, by design. Do not try to find one.

## Gates that must pass before anything lands

CI runs these in one job; any failure fails the merge. Run the fast ones locally
first:

```bash
pnpm exec tsc --noEmit          # type-check
pnpm lint                       # ESLint + jsx-a11y
pnpm test                       # Vitest (live-DB suites self-skip locally, run in CI)
pnpm check:design               # palette, contrast, token-sync, typography ratchet
pnpm verify:feature-ledger
pnpm verify:api-contract
pnpm verify:product-conformance
pnpm run snapshot:check         # after any migration
pnpm run types:check:local      # after any migration
pnpm run downs:check
pnpm run manifest:check
```

If `pnpm test` passes locally but you touched anything tenant-scoped, **that is not
proof** — the cross-tenant containment suites only run against a live loopback
Postgres. Start one (`docs/runbooks/local-stack.md`) or rely on CI.

## Where things live

| Concern | Home |
|---|---|
| Architecture and DB boundaries | `docs/ARCHITECTURE.md` — canonical |
| Code conventions, verified | `docs/CONVENTIONS.md` |
| Design contract | `DESIGN.md` (root). `docs/design/*` are archived predecessors — do not build from them |
| Completion status | `docs/feature-ledger.json` — the only authority |
| Operational procedures | `docs/runbooks/` (see its README index) |
| Active plans and specs | `docs/plans/` — `_archive/` is history, not backlog |

**Do not trust for current status:** `docs/_archive/app_spec.txt` and
`docs/_archive/claude-progress.txt`. Both are frozen historical records, both contain
drifted claims (including a dead env var name), and both are retained as evidence
only.

## Known state you should not re-discover

- **No React Query, no SWR, no CVA, no shadcn/ui, no Radix.** Absent deliberately or
  by omission — check `docs/CONVENTIONS.md` before assuming a library exists.
- **Zod at the API boundary is the target, not the reality** — 44 of 93 routes today.
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
  **The CSV import path (`apply_import_batch_chunk`) is still unresolved by
  design** — the P2 plan (§9/§12) puts that call in P3's TypeScript caller, once
  per batch of unique variants, before the per-row loop. The import dedup key is
  also still the fallback four-tuple in `src/domains/import/dedup-key.ts`.
  Both are open work; see `docs/plans/2026-08-29-modular-architecture-refactor.md`.
- **A known RLS gap exists** on `stock_adjustments` and `bottle_closeouts` INSERT
  policies (`wine_id` ownership is unverified; FK cascades bypass RLS). Mitigated in
  application code with a documented TOCTOU race. See
  `docs/runbooks/csv-import.md`. Do not build on top of the mitigation without
  reading it.

## Commits

Conventional commits (`type: description`). One feature = one branch = one squashed
commit on `main`. Never commit to `main` directly.

## Next.js 16

This version has breaking changes from earlier App Router releases — APIs,
conventions, and file structure may differ from what you have seen elsewhere. Check
`node_modules/next/dist/docs/` before writing framework-level code, and heed
deprecation notices.
