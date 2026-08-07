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
| Railway | A dedicated `terroir-web-staging` service which tracks only `staging` | service ID, URL, environment name, deployment SHA |
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

Set `RAILWAY_GIT_COMMIT_SHA` from Railway's commit variable if it is not
automatically provided. `GET /api/health` exposes only its presence as the
public release SHA plus the Railway environment name; it exposes no credential
or Supabase URL.

## Candidate flow

1. Merge the candidate into `staging`; Railway deploys that branch to the
   dedicated staging service.
2. The `Staging smoke / Required staging smoke` GitHub check waits for the
   deployed SHA and requires `pnpm run test:staging` to pass.
3. Run synthetic authenticated workflows on staging only: magic-link/reset,
   image upload, database write, public list, and PDF. TER-004/TER-010 own the
   disposable fixture and real-email coverage; retain their report with the
   candidate SHA.
4. Require both the staging smoke check and the workflow report before a
   release owner dispatches `Promote to production` with the exact SHA.
5. The promotion workflow rejects any SHA other than the current `staging`
   tip, requires the configured `PRODUCTION_RELEASE_OWNER` actor to enter the
   exact `PROMOTE-STAGING-SHA` confirmation, runs a fresh staging smoke, then
   only fast-forwards `main`.

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

- Railway project, environment, service ID, source branch, deployment SHA, and
  variable **names** (not values).
- Supabase staging ref, auth Site URL/redirect allow-list, storage policy names,
  and migration version.
- Staging and production must differ in Railway service ID, Supabase
  project/branch ref, service-role-key fingerprint, and cookie-secret
  fingerprint. Store only yes/no comparisons or one-way fingerprints.

The staging smoke command is an infrastructure gate, not a substitute for the
synthetic stateful workflow report. If it fails, promotion is blocked.

## Current verification status (2026-08-07)

Read-only inspection found a live Railway staging environment and URL, but not
a completed TER-003 configuration:

- Railway staging environment `cc3e7aff-417e-4d8d-9d25-690617aba8ab` serves
  `https://terroir-web-staging.up.railway.app` from service
  `15194296-9cfb-4bc4-a1f6-d333fadb8a3a`.
- Its latest deployment was sourced from `main` at
  `224808678643cd12fcfabefbe53094c2a364febc`, not a `staging` candidate.
- `/api/health` returned HTTP 200 but `db: "unconfigured"`; this is a failed
  staging smoke result, not deployment evidence.
- The staging environment has the required Supabase variable names, but this
  check intentionally did not read their values. It therefore cannot prove
  their branch/project identity or distinct secret values.

Until those findings are corrected and the stateful synthetic workflow report
exists, TER-003 remains in progress and production promotion must stay blocked.
