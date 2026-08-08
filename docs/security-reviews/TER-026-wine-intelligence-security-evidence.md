# TER-026 wine-intelligence security evidence

Review environment: local isolated worktree, Node 24.16.0 and pnpm 10.33.2.
Base: `5638b63`.
Reviewed ref: `8a246df`.

CMD-001: `git diff --name-only 5638b63...8a246df`
Exit 0; the captured paths were:
- `.github/workflows/staging-smoke.yml`
- `docs/ARCHITECTURE.md`
- `docs/STAGING-SETUP.md`
- `docs/completion-records/TER-026-wine-intelligence.yaml`
- `e2e/wine-intelligence-staging.test.ts`
- `src/app/(app)/cellar/cellar-list.tsx`
- `src/app/(app)/cellar/wine-detail-drawer.tsx`
- `src/app/api/wines/[id]/route.ts`
- `src/app/api/wines/enrich/route.test.ts`
- `src/app/api/wines/wine-mutation-behavior.test.ts`
- `src/lib/drink-window/status.test.ts`
- `src/lib/drink-window/status.ts`
- `src/lib/wine-intelligence/enrich.test.ts`
- `src/types/database.ts`
- `supabase/migrations/0081_atomic_wine_metadata_overrides.sql`
- `supabase/migrations/down/0081_atomic_wine_metadata_overrides.down.sql`
- `supabase/schema.snapshot.sql`
- `supabase/tests/0081_atomic_wine_metadata_overrides.sql`

CMD-002: `gitleaks detect --source . --no-banner --redact --log-opts 5638b63..8a246df`
Exit 0; six commits and about 74.46 KB were scanned. No leaks were found.

CMD-003: `pnpm exec vitest run src/app/api/wines/wine-provider-mutation-behavior.test.ts src/app/api/wines/wine-provider-mutation-boundaries.test.ts src/app/api/wines/wine-mutation-behavior.test.ts src/app/api/wines/enrich/route.test.ts src/lib/wine-intelligence/enrich.test.ts src/lib/drink-window/status.test.ts`
Exit 0; six files and 101 tests passed.

The first independent exact-ref review found a P1 database bypass: the API and
UI denied staff, but the old batch-enrichment RPC and broad wine UPDATE policy
allowed a staff JWT to mutate wine intelligence directly. A red PostgreSQL
acceptance run reproduced the RPC bypass before the fix.

Migration 0081 now aligns wine UPDATE RLS with the shared `wine:manage`
owner/manager capability. It reinstalls `enrich_wines_batch` with an empty
search path, authentication and manager checks, a bounded object-array input,
tenant-bound updates, explicit `public` and `anon` revocation, and authenticated
execute. The separate atomic metadata RPC retains the same independent checks,
row lock, final-window validation, and all-or-nothing manual-lock write.

Transactional PostgreSQL acceptance passed after the fix and its down migration
also applied cleanly. It covers anonymous execute denial, manager enrichment,
manual preservation after enrichment, staff RPC denial, staff direct-update
denial, cross-tenant metadata and enrichment denial, malformed fields, and the
unchanged non-manual enrichment path. Manual review found no remaining security
defect in the reviewed diff.

Integrated follow-up qualified the initial direct-update proof: that source
harness inherited authenticated wine-table CRUD from an earlier ad hoc grant.
On the fresh Supabase CLI privilege matrix, authenticated lacked SELECT and
UPDATE, so the statement failed before reaching RLS. The integrated fix
reproduced that failure, granted only SELECT and UPDATE on `public.wines` to
authenticated, and added privilege assertions. Staff then reached manager-only
RLS and affected zero rows; anonymous UPDATE remained absent. Authenticated
CRUD stayed absent on `api_idempotency`, `open_bottles`, and `pour_events`, with
only the existing SELECT exception on `background_jobs`.

The workflow addition references only the existing encrypted isolated-test
secrets and adds no credential value or destination. Its pilot is manual,
opt-in, single-slot, and gated behind the existing exact-SHA staging smoke. The
browser fixture uses synthetic tenant data and the existing teardown and
encrypted-artifact steps.

No prompt, retrieval, model invocation, download, telemetry destination,
credential source, or third-party export was added or changed. TER-026's
existing provider adapter is unchanged; new tests exercise deterministic
fallback objects only. Prompt-injection and export review are not applicable.

Fable 5 medium advisory was attempted through the approved Nous subscription
lane. The provider returned a length-exhausted completion with no visible
verdict and later attempts returned no usable response body. No Fable verdict
is claimed; the independent repository verifier is the authoritative gate.
