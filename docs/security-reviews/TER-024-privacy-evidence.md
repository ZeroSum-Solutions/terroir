# TER-024 security-review evidence

Reviewed commit: `3fda4873b1c87f2e75f96756d53a03106324c385`
Base: `f9a19fdcbd3613f19ce63307c8c029b7981bd063`

## CMD-001: changed-path capture

Command: `git diff --name-only f9a19fdcbd3613f19ce63307c8c029b7981bd063...3fda4873b1c87f2e75f96756d53a03106324c385`
Result: PASS (exit 0).

Captured paths:

- docs/completion-records/TER-024-privacy-lifecycle.yaml
- docs/runbooks/data-lifecycle-privacy.md
- src/adapters/storage/supabase-storage.test.ts
- src/adapters/storage/supabase-storage.ts
- src/app/(app)/cellar/page.tsx
- src/app/api/cellar/[id]/route.test.ts
- src/app/api/cellar/[id]/route.ts
- src/app/api/cellar/cellar-lifecycle-idempotency.test.ts
- src/app/api/inventory/save-scan/route.ts
- src/app/api/restaurant/[id]/route.test.ts
- src/app/api/restaurant/[id]/route.ts
- src/app/api/scans/[id]/image/route.test.ts
- src/app/api/wines/[id]/image/route.test.ts
- src/domains/cellar/wine-image-service.ts
- src/domains/privacy/storage-cleanup-service.ts
- src/domains/scanning/invoice-scan-service.ts
- src/domains/scanning/scan-image-service.ts
- src/test/contracts/privacy-lifecycle.test.ts
- supabase/migrations/0075_privacy_storage_lifecycle.sql
- supabase/migrations/down/0075_privacy_storage_lifecycle.down.sql
- supabase/schema.snapshot.sql
- supabase/tests/0075_privacy_storage_lifecycle.sql

## CMD-002: range secrets scan

Command: `gitleaks detect --source . --no-banner --redact --log-opts f9a19fdcbd3613f19ce63307c8c029b7981bd063..3fda4873b1c87f2e75f96756d53a03106324c385`
Result: PASS (exit 0); 1 commit scanned; no leaks found.

## CMD-003: local gates

Commands: Node 24.16.0 / pnpm 10.33.2 `pnpm test`, `tsc --noEmit`, `pnpm lint`, `pnpm downs:check`, and `pnpm snapshot:check`.
Result: PASS. Full Vitest run: 147 files and 1,492 tests passed. The schema snapshot and paired down-migration checks passed.

## Static review notes

- No changed prompt, model, retrieval, or tool-control path exists.
- Authentication remains server-side before restaurant deletion; Storage cleanup only starts for the active restaurant owner.
- Storage authorization is enforced by private buckets, RLS tenant prefix checks, exact write-path validation, and signed URLs.
- Upload MIME/signature/size checks remain in the wine image service; invalid legacy image paths fail closed when signing.
- Storage is the only changed egress: authenticated tenant media is private, signed for five minutes, and cleanup failures return fixed errors.
- Sentry receives no interpolated provider error through the changed image paths; its existing scrubber removes sensitive request and exception data.
- Current provider account-retention settings were intentionally not queried. The runbook records the approved staging evidence needed before production use.
