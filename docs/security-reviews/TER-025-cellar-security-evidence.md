# TER-025 cellar security evidence

Review environment: local isolated worktree, Node 24.16.0 and pnpm 10.33.2.
Base: `e293981`.
Reviewed ref: `6d497ea`.

CMD-001: `git diff --name-only e293981...6d497ea`
Exit 0; the captured paths were:
- `docs/ARCHITECTURE.md`
- `docs/LOCAL-SUPABASE.md`
- `docs/api-route-inventory.json`
- `docs/api-route-reconciliation.json`
- `docs/completion-records/TER-025-cellar-inventory.yaml`
- `docs/ui-control-inventory.json`
- `e2e/cellar-local.test.ts`
- `src/app/(app)/cellar/cellar-list.tsx`
- `src/app/(app)/cellar/cellar-shell.tsx`
- `src/app/(app)/cellar/config/layout.test.tsx`
- `src/app/(app)/cellar/config/layout.tsx`
- `src/app/(app)/cellar/page.tsx`
- `src/app/(app)/cellar/quantity-adjustment-modal.test.tsx`
- `src/app/(app)/cellar/quantity-adjustment-modal.tsx`
- `src/app/(app)/cellar/types.ts`
- `src/app/(app)/cellar/wine-detail-drawer.tsx`
- `src/app/api/cellar/[id]/quantity/route.test.ts`
- `src/app/api/cellar/[id]/quantity/route.ts`
- `src/app/api/cellar/[id]/route.test.ts`
- `src/app/api/cellar/[id]/route.ts`
- `src/lib/api-route-inventory/verify-api-contract.test.ts`
- `src/lib/auth/api-authorization.test.ts`
- `src/lib/auth/api-authorization.ts`
- `src/lib/auth/api-idempotency-policy.test.ts`
- `src/lib/auth/api-idempotency-policy.ts`
- `src/lib/cellar/inventory-aggregation.test.ts`
- `src/lib/cellar/inventory-aggregation.ts`
- `src/lib/cellar/inventory-view.test.ts`
- `src/lib/cellar/inventory-view.ts`
- `src/test/contracts/cellar-quantity-adjustment.test.ts`
- `src/types/database.ts`
- `supabase/migrations/0080_audited_cellar_quantity_adjustments.sql`
- `supabase/migrations/down/0080_audited_cellar_quantity_adjustments.down.sql`
- `supabase/schema.snapshot.sql`
- `supabase/tests/0080_audited_cellar_quantity_adjustments.sql`

CMD-002: `gitleaks detect --source . --no-banner --redact --log-opts e293981..6d497ea`
Exit 0; three commits and about 90.27 KB were scanned. No leaks were found.

CMD-003: `pnpm exec vitest run src/app/api/cellar/[id]/quantity/route.test.ts src/test/contracts/cellar-quantity-adjustment.test.ts src/lib/auth/api-authorization.test.ts src/lib/auth/api-idempotency-policy.test.ts`
Exit 0; four files and 23 tests passed.

Manual review found no open security defects. The protected route requires an
authenticated owner or manager, validates a UUID, bounded integer quantity,
trimmed 1-to-500-character reason, and optional idempotency key before calling
the dedicated RPC. The RPC independently requires `auth.uid()`, checks the
current-tenant manager role, binds wine and inventory rows to both tenant and
wine identifiers, locks those rows, and applies the count plus audit event in
one transaction. Execute is revoked from `public` and `anon` and granted to
`authenticated` only. Replays return the stored response and do not repeat the
write. Tests cover unauthenticated, staff, malformed, wrong-tenant, exact replay,
key reuse, no-op, and successful audit paths.

No prompt, retrieval, model, tool, credential source, third-party destination,
download, telemetry, or other external export was added or changed. The
existing cellar CSV requirement is documented in the completion record, but
its export implementation and authorization path are unchanged by this diff.

Fable 5 medium advisory: the approved Nous Portal returned HTTP 200 from
`anthropic/claude-fable-5` with verdict `PASS`, no blocking finding, and browser
runtime proof still pending. Its low/info observations were dispositioned
against the repository: the composite inventory-to-wine foreign key makes new
lots participate in the parent-row lock while existing lots are locked directly;
manual count increases intentionally adjust the newest lot and retain the
reasoned audit delta rather than invent purchase provenance; the existing schema
already installs `pgcrypto` in `extensions` and uses `extensions.digest`; and
`is_member_with_role(..., 'manager')` explicitly includes owners. The shared
request-hash contract remains covered by the focused idempotency tests.
