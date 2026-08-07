# TER-022 scanner security evidence

Reviewed base: `f7d015131cdb96f5c6614766dd6f98fd24c09ce2`

Reviewed implementation ref: `db7c29ebf21f2d4bfe7c8163cf3be7bc1ae10621`

## Commands

`CMD-001 git diff --name-only f7d015131cdb96f5c6614766dd6f98fd24c09ce2...db7c29ebf21f2d4bfe7c8163cf3be7bc1ae10621`

Result: PASS, 40 paths captured and classified in the review JSON.

`CMD-002 gitleaks detect --source . --no-banner --redact --log-opts f7d015131cdb96f5c6614766dd6f98fd24c09ce2..db7c29ebf21f2d4bfe7c8163cf3be7bc1ae10621`

Result: PASS, one commit and approximately 79.99 KB scanned; no leaks found.

`CMD-003 pnpm exec vitest run` with the 11 named scanner, API, domain, and contract test files recorded in the review JSON.

Result: PASS, 11 files and 102 tests.

`CMD-004 pnpm run test`

Result: PASS, 157 files and 1,546 tests.

`CMD-005 pnpm run lint && pnpm exec tsc --noEmit && pnpm run build`

Result: PASS. ESLint and TypeScript exited zero; Next.js compiled, typechecked,
generated 50 static pages, and completed the production build.

`CMD-006 pnpm run scanner:score && pnpm run snapshot:check && pnpm run downs:check`

Result: PASS after staging the generated snapshot. The scorer made zero billed
provider calls, reported no violations, and the migration/down version check was
unique and complete.

## Surface review

Prompt injection is not applicable: the changed AI and OCR paths only classify
failures; prompt construction, roles, message content, tools, and retrieved content
are unchanged.

Authentication and authorization are reviewed. The new database wrapper derives
identity from `auth.uid()`, requires a staff membership at the tenant decision
point, row-locks the tenant scan, revokes authenticated access to the bypassing RPC,
and records reviewer identity in the same transaction as the inventory commit.

Untrusted input is reviewed. Fixture JSON is Zod-validated, provider exceptions are
reduced without reading messages or response bodies, review confirmation accepts
only literal `true` or `false`, and both inventory paths re-check persisted scan
confidence before writing.

Secrets are reviewed. The changed range is clean. A supplementary full-history scan
reported ten pre-existing generic-key signatures, all in historical test-fixture
paths and none introduced or modified by this range; that reduced-scope observation
does not replace or weaken the passing exact-range scan.

Exports are reviewed. Existing Azure OCR and Anthropic extraction destinations are
documented in the privacy runbook, and this change minimizes their failure egress to
fixed codes and retryability. The only new export is a GitHub Actions artifact that
contains synthetic aggregate scoring output, explicitly excludes provider secrets,
and is retained for 30 days.
