# TER-026 wine-intelligence security evidence

Review environment: local isolated worktree, Node 24.16.0 and pnpm 10.33.2.
Base: `5638b63`.
Reviewed ref: `a406a07`.

CMD-001: `git diff --name-only 5638b63...a406a07`
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

CMD-002: `gitleaks detect --source . --no-banner --redact --log-opts 5638b63..a406a07`
Exit 0; two commits and about 44.66 KB were scanned. No leaks were found.

CMD-003: `pnpm exec vitest run src/app/api/wines/wine-mutation-behavior.test.ts src/app/api/wines/enrich/route.test.ts src/app/api/wines/[id]/enrich/route.test.ts src/lib/wine-intelligence/enrich.test.ts src/lib/drink-window/status.test.ts`
Exit 0; four discovered files and 70 tests passed.

Manual review found no open security defect. The PATCH route authenticates an
owner or manager before parsing tenant-bound metadata and dispatches a single
idempotent RPC. The security-definer RPC independently requires an authenticated
manager-or-owner membership, rejects unsupported or malformed fields, locks the
wine only when both restaurant and wine identifiers match, validates the final
drink-window tuple, and records manual values and their enrichment locks in one
transaction. Execute remains revoked from `public` and `anon` and granted only
to `authenticated`. Focused HTTP tests and transactional PostgreSQL acceptance
cover staff denial, cross-tenant non-disclosure, malformed input, field
collision, atomic failure, and subsequent enrichment preserving locked fields.

The workflow addition references the existing encrypted isolated-test secrets;
it adds no credential value or new destination. Its pilot is manual, opt-in,
single-slot, and gated behind the existing exact-SHA staging smoke. The new
browser fixture uses only synthetic tenant data, confirms staff and cross-tenant
denials, and relies on the existing teardown and encrypted-artifact steps.

No prompt, retrieval, model invocation, download, telemetry destination,
credential source, or third-party export was added or changed. TER-026's
existing provider adapter and synchronous provider call are unchanged; new
tests exercise deterministic fallback objects only. Prompt-injection and export
review are therefore not applicable to this diff.

Fable 5 medium advisory was attempted through the approved Nous subscription
lane. The provider returned a length-exhausted completion with no visible
verdict on the bounded SQL review, and subsequent larger advisory attempts
returned no usable response body. No Fable verdict is claimed; independent
repository verification remains the authoritative review gate.
