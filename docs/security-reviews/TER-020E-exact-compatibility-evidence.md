# TER-020E exact compatibility security evidence

Review environment: durable isolated worktree, Node 24.16.0, and pnpm 10.33.2.
Base: `235a88dead961453b886928a9e68e8a358084d8e`. Reviewed ref: `HEAD`.

CMD-001 is the final `git diff --name-only
235a88dead961453b886928a9e68e8a358084d8e...HEAD` capture. It exits 0 and
accounts for every path in the structured security report.

CMD-002 is `gitleaks detect --source . --no-banner --redact --log-opts
235a88dead961453b886928a9e68e8a358084d8e..HEAD`. It exits 0 across the
committed range with no detected secret.

CMD-003 runs the four exact-handler suites. It exits 0 with four files and 24
tests passing. The tests cover authentication-before-input ordering, malformed
input rejection, active-tenant filters, opaque missing-resource responses,
provider-error redaction, normalized idempotency hashes, and replay without a
second update, insert, or membership-removal RPC.

CMD-004 runs `pnpm run test:contracts`. It exits 0 with 16 files and 139 tests.
The API contract reports 92 discovered operations, zero planned operations,
and 92 classifications; the feature ledger reports 269 requirements; UI
control evidence covers 23 routes and 345 controls.

CMD-005 runs the full local static and regression gates: TypeScript no-emit,
lint, the 176-file/1665-test Vitest suite, and the Next.js production build.
Every command exits 0 using the pinned toolchain. Migration snapshot and down
pair checks also pass; TER-020E adds no migration.

Manual review confirms that every handler authenticates and authorizes before
reading route parameters or bodies. Wine and scan reads require the declared
capability and filter both resource ID and active restaurant ID. Restaurant
updates derive the only mutable restaurant ID from authenticated membership.
Team invitation inserts derive restaurant and inviter IDs from authentication.
Membership removal passes both active restaurant ID and validated membership
ID to the existing tenant-bound, owner-only RPC.

The two dynamic resource IDs are UUID-validated and normalized. Restaurant and
invitation bodies use strict shared Zod schemas. Invalid input reaches no
database dependency. Provider failures pass through the shared redacted error
boundary. The three writes use distinct operation IDs, canonical validated
payload hashes, and fail-closed idempotency claims.

The invitation success response preserves the existing alternate route's
invite-token behavior and is available only to authorized invitation managers.
Team-list responses continue to omit invitation tokens. No credential source,
prompt, retrieval, model call, download, telemetry, or other external export
was added or changed.

No security defect remains open in reviewed source. Live staging exercises are
not claimed: deployment and remote mutation were excluded from this lane.
