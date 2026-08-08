# TER-003 guarded staging-migration security evidence

## Scope

The focused review covers source candidate `ae816c2` against integrated base
`f78ef0a`. `git diff --name-only f78ef0a...HEAD` is the authoritative path
capture. The final structured report and this evidence document are included
in that same range before validation and exact-range secret scanning.

The change adds a manual-only GitHub Actions lane for isolated staging
migrations 0084 through 0086. It does not change production, does not activate
the TER-021G worker, and does not accept an arbitrary project, migration, file,
version, SQL string, or branch from workflow input.

## Findings and rechecks

Manual source review first found that a proposed baseline check depended on a
database comment absent from the actual pre-0086 schema. The committed runner
instead inspects `pg_get_functiondef`, and its exact generated state query
classified the live local pre-migration function as `staff_all_jobs`.

The first independent review of exact commit `6ffd308` returned one P2. Mutable
GitHub Action tags executed before the broad Supabase Management API token was
exposed. Commit `ae816c2` pins every action in the staging workflow to the
repository-approved immutable commit, disables dependency lifecycle scripts,
and moves the E2E service-role credential from job scope to only the browser
steps that require it. The workflow contract and actionlint recheck passed.

The mutation client also treats transport failures and HTTP 5xx responses as
an unknown database state. It never retries a mutation automatically and tells
the operator to reconcile through the read-only endpoint before retrying.
Regression tests cover timeout, 401, 403, 429, 500, 503, invalid JSON, token
redaction, and one-call mutation behavior.

## Command evidence

`CMD-001` ran `git diff --name-only f78ef0a...HEAD`; the output exactly matched
the structured report's changed, captured, and classified paths.

`CMD-002` ran `gitleaks detect --source . --no-banner --redact --log-opts
f78ef0a..HEAD`. The final rerun covers all staging-runner, workflow, test,
documentation, and security-evidence commits and reports no leaks.

`CMD-003` ran the focused staging runner and workflow contract suite on Node
24.16.0 and pnpm 10.33.2. Thirty-six tests passed. TypeScript no-emit, focused
ESLint, actionlint, and `git diff --check` also passed.

`CMD-004` ran the complete repository gates. Vitest passed 193 files and 1,745
tests; TypeScript, ESLint, and the Next production build passed with 50 pages.
The snapshot remained exact at 85 migrations and 452319 generator bytes; all
75 forward migrations from 0011 have unique down pairs. API inventory remained
92 implemented operations with zero planned operations, the feature ledger
remained 269, and UI inventory remained 23 routes and 345 controls.

`CMD-005` generated the exact mutation SQL from the fixed manifest and executed
it against isolated local PostgreSQL after restoring the pre-0084 baseline.
The advisory lock, migrations 0084 through 0086, all three acceptance suites,
postconditions, and migration-history inserts passed inside one transaction.
The proof replaced only the final commit with rollback; a read-only state query
then confirmed the original baseline and zero net schema/history change.

## Six surfaces and exports

No prompt, retrieval, model, or tool-control path changed, so prompt injection
is not applicable. The workflow supplies the Management API token to only the
guarded mutation step. The runner discards provider bodies and caught transport
errors, emits fixed status text, and never includes the token in URL, SQL, body,
or logs. The browser service-role key is scoped only to browser execution steps.

Authentication and authorization require the staging Git ref, exact lowercase
candidate SHA, matching checked-out SHA, configured release-owner actor, exact
confirmation string, exact staging Supabase origin, and nonblank token before
network access. Ordinary pushes are credential-free no-ops. The dependency-
gated wine-enrichment pilot is rejected when migration apply is requested.

All SQL input is repository-owned and SHA-256-bound. Read-only preflight checks
exact prerequisite name/version pairs, target name/version collisions, schema
state, and prior enqueue authorization. The mutation repeats those checks under
an advisory transaction lock, runs each acceptance suite under a savepoint,
checks final privileges/schema/function semantics, and records exact source
hash markers. Partial, duplicated, drifted, or inconsistent state fails closed.

The only new external export is fixed migration and acceptance SQL plus schema
state to the established isolated staging Supabase project. Migration source
and hash markers are intentionally retained in migration history; acceptance
fixtures roll back. GitHub receives fixed workflow status and existing encrypted
browser evidence only. No customer or production data is introduced.
