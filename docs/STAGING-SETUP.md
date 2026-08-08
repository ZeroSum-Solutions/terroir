# Staging and controlled promotion

TER-003 requires a separately deployed candidate before production. Staging is
the fixed Railway origin:

```text
https://terroir-web-staging.up.railway.app
```

`pnpm run test:staging` is deliberately read-only. It allows only that exact
HTTPS origin, then performs `GET /`, `GET /login`, and `GET /api/health`.
It fails unless the application reports a connected database, the Railway
environment is `staging`, and (when `STAGING_EXPECTED_SHA` is set) the deployed
commit equals that SHA. The command has no credentials and never sends a
mutating request.

## Required resource configuration

Create and operate only the following staging resources. Do not copy
production rows, object storage, sessions, or secrets.

| Surface | Required staging state | Evidence that is safe to record |
| --- | --- | --- |
| Railway | A dedicated staging environment and web service instance; upload or source only an immutable staging candidate | environment ID, service ID, URL, deployment SHA |
| Railway worker | After explicit resource approval, a distinct worker service using `railway.worker.toml` and the same staging candidate SHA | service ID, environment name, deployment SHA, health state |
| Supabase | The isolated branch/project ref `wwhxcgtcecsftcivosop` | ref only; never URL, keys, or service-role secret |
| Data | Synthetic fixtures in a disposable namespace | fixture run ID and cleanup result |
| Auth/email | Site URL and redirect allow-list include the staging origin; SMTP/test inbox is staging-only | configuration checklist and redacted inbox transcript |
| Storage | Staging bucket/prefix has staging-only policies | bucket/prefix names and policy check result |

The Railway service must set staging-owned values for
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, and `ACTIVE_RESTAURANT_COOKIE_SECRET`. The three
Supabase values must be issued for `wwhxcgtcecsftcivosop`; the cookie secret
must be unique to staging. Keep all values in Railway/Supabase, never in this
repository or a smoke-test log.

The worker service receives the same staging Supabase URL and its own
service-role secret through Railway variables, plus the bounded `WORKER_*`
settings documented in
[`runbooks/background-worker.md`](runbooks/background-worker.md). It must never
receive production credentials. The worker's `GET /health` is a separate
readiness gate and does not change the public web health endpoint.

Railway-connected deploys expose `RAILWAY_GIT_COMMIT_SHA` automatically. For a
manual staging-only deploy, set `TERROIR_RELEASE_SHA` to the exact local Git
commit before upload; the health route prefers Railway's immutable Git value
when both exist. `GET /api/health` exposes only the selected public release SHA
plus the Railway environment name; it exposes no credential or Supabase URL.

## Candidate flow

The staging workflow has one guarded, manual-only database lane for migrations
0084 through 0086. Leave `staging_migration_confirmation` blank for ordinary
staging pushes. For the exact integrated candidate, the configured release
owner may enter `MIGRATE-wwhxcgtcecsftcivosop-0084-0086`. The runner hard-codes
that isolated ref, requires the `staging` Git ref, configured staging Supabase
origin, and exact checked-out candidate SHA, verifies the existing 0080 through
0082 history,
applies all three migrations in one transaction, and reconciles their fixed
source hashes before smoke begins. Drift, partial history, an ambiguous write,
or a simultaneous wine-enrichment worker pilot fails closed. The Management
API token is supplied only to that guarded step; `SUPABASE_PROJECT_ID` and the
E2E service-role key are never used for schema administration.

This schema rehearsal does not activate TER-021G. Keep
`WINE_ENRICHMENT_HANDLER_ENABLED=0` and
`WINE_ENRICHMENT_WORKER_ENABLED=0`, and do not dispatch the enrichment-worker
pilot until the canonical TER-021F soak dependency is recorded.

1. Merge the candidate into `staging`, or upload the exact immutable candidate
   to the staging environment during an integration rehearsal. Record the
   candidate SHA and deployment ID; never upload it to the production
   environment during this step.
2. The `Staging smoke / Required staging smoke` GitHub check waits for the
   deployed SHA and requires `pnpm run test:staging` to pass.
3. Run synthetic authenticated workflows on staging only: magic-link/reset,
   image upload, database write, public list, and PDF. TER-004/TER-010 own the
   disposable fixture and real-email coverage; retain their report with the
   candidate SHA.
4. After the first handler-owning TER-021 slice is present, run the worker
   kill/restart and dead-letter drill against synthetic staging data and retain
   its exact candidate SHA and effect-count evidence.
5. Require the staging smoke check, workflow report, and any applicable worker
   drill before a
   release owner dispatches `Promote to production` with the exact SHA.
6. The promotion workflow rejects any SHA other than the current `staging`
   tip, requires the configured `PRODUCTION_RELEASE_OWNER` actor to enter the
   exact `PROMOTE-STAGING-SHA` confirmation, runs a fresh staging smoke, then
   only fast-forwards `main`.

The manual staging workflow also exposes an opt-in
`run_wine_intelligence_pilot` input. It runs only in isolated browser slot 1
against synthetic wine data and verifies deterministic guidance, owner/manual
override preservation, staff denial, and cross-tenant denial. A skipped local
test or an undispatched workflow is collection evidence only, not runtime
proof. TER-021G separately owns migration of enrichment to the worker after the
invoice-OCR soak; the pilot does not close that dependency or prove a live
provider response.

The same workflow exposes a separate opt-in
`run_wine_enrichment_worker_pilot` input. Do not dispatch it until the
canonical TER-021F completion record proves the invoice-OCR soak and the exact
candidate has the wine-enrichment handler deployed before its web enqueue flag
is enabled. A collected or skipped browser test is not staging evidence. The
pilot must retain exact-SHA enqueue, replay, completion, effect-count,
manual-field, and cross-tenant-denial evidence; retry, restart, dead-letter,
duplicate-delivery, drain, and rollback evidence remain mandatory under the
worker runbook. Production activation is prohibited in this task.

The opt-in `run_analytics_pilot` input also runs only in isolated browser slot
1. It seeds tenant-owned scans, invoice-linked spend, and consecutive market
observations; applies a validated custom range; checks auto-accepted versus
corrected line-item metrics; verifies the range-bound CSV; and confirms foreign
tenant data stays absent. The pilot is required runtime evidence for TER-027,
but collection alone is not a pass and it does not close TER-020 or TER-026.

GitHub environment required reviewers are unavailable on the repository's
current plan. The repository variable and exact-confirmation check are the
enforced fallback: set `PRODUCTION_RELEASE_OWNER` to the named release owner's
GitHub login, restrict the `production` environment to the `staging` branch,
and never dispatch promotion from an untrusted account. If environment
reviewers become available, enable the named reviewer as an additional gate;
do not remove the workflow-level owner check.

Configure GitHub branch protection so `staging` requires the staging-smoke
check and `main` permits changes only from the promotion workflow. Configure
Railway production to track `main` and staging to track `staging`; never point
both environments at one service/source trigger.

## Rollback

Production rollback is an approved release operation, not an automatic retry:

1. Identify the prior known-good production SHA and record the failed SHA,
   Railway deployment IDs, migration state, and incident link.
2. Confirm the rollback SHA is already a successful staging candidate with a
   smoke report. If it is not, deploy it to staging and run the gate first.
3. With release-owner approval, fast-forward or revert `main` to the rollback
   commit according to branch-protection policy; wait for Railway production
   health and record the deployment ID.
4. Do not restore or copy database data as part of an application rollback.
   Schema/data rollback requires its own approved backup-and-restore drill.

To decommission staging, first export the redacted configuration inventory and
logs. Only then delete the newly created staging service/branch/project; do not
delete production resources or existing backup artifacts.

## Environment-drift check

Before every promotion, compare redacted configuration metadata:

- Railway project, environment ID, service instance, source branch or manual
  upload record, deployment SHA, and variable **names** (not values).
- Supabase staging ref, auth Site URL/redirect allow-list, storage policy names,
  and migration version.
- Staging and production must differ in Railway environment ID and deployment,
  Supabase project/branch ref, service-role-key fingerprint, and cookie-secret
  fingerprint. Railway can represent both environments with one logical
  service ID; isolation is established by their distinct environment-scoped
  instances and variables. Store only yes/no comparisons or one-way
  fingerprints.

The staging smoke command is an infrastructure gate, not a substitute for the
synthetic stateful workflow report. If it fails, promotion is blocked.

## Current verification status (2026-08-08)

Staging is operational and isolated at the infrastructure, data, and browser
fixture boundaries:

- Railway environment `cc3e7aff-417e-4d8d-9d25-690617aba8ab` serves
  `https://terroir-web-staging.up.railway.app`. Web deployment
  `45034ec8-faf4-43a9-acc4-0e8fb5c39451` and worker deployment
  `c9e0b052-2f72-4d53-a00e-6e251936140e` both serve exact candidate
  `8d895fb5f7b73fbbbc063a9e196b3275b980dba2`.
- `/api/health` reports `environment: "staging"`, `db: "connected"`, and that
  exact release. The worker reports the same environment and release, with
  queue depth zero and zero dead letters after the load pilot.
- GitHub Actions run `31232010892` passed the exact-SHA smoke, both parallel
  isolated authenticated workflows, the single-slot browser PDF download, the
  10-request worker load pilot, cleanup, evidence encryption, and artifact
  retention.
- Controlled-failure run `31235962292` failed both browser jobs by design only
  after the exact-SHA smoke passed. Both jobs then encrypted and retained their
  diagnostic artifacts, proving failure evidence survives a red test result.
- The `staging` branch requires `Staging smoke / Required staging smoke`, the
  production GitHub environment permits only the `staging` branch, and the
  workflow-level release owner is configured. TER-005 still owns the final
  aggregate `main` release-check policy.
- The isolated Supabase ref remains `wwhxcgtcecsftcivosop`; fixture workflows
  verify key fingerprints, use synthetic namespaces, and clean up their Auth,
  database, and Storage state.

Real magic-link, password-reset email, and provider-inbox evidence remain owned
by TER-010. Production promotion remains blocked until the final integrated
candidate satisfies TER-005 and TER-046.
