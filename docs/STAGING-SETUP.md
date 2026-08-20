# Staging and preview safety

This guide records the current GitHub, Railway, and Supabase gate state. It does
not authorize a deployment, migration, promotion, rollback, or production data
operation.

## Current GitHub state

Verified through the GitHub API on 2026-08-20:

- `origin/staging` exists and is protected. It requires the strict
  `Staging smoke / Required staging smoke` check, enforces administrators and
  linear history, and blocks force pushes and branch deletion.
- The staging branch contains the `Staging smoke` and `Promote to production`
  workflow files. Those files do not exist on `main`.
- The staging smoke workflow is operational. It binds the deployed Railway
  candidate to the expected SHA before its isolated browser jobs can run.
- The latest staging-tip run, GitHub Actions run `31283879947`, failed the
  exact-candidate smoke for staging SHA
  `a94b196ad7b5947afec76c6174644cd520bfc932`. Its authenticated E2E jobs were
  skipped. That tip is not a promotable candidate.
- GitHub Actions run `31232010892` succeeded for the earlier candidate
  `8d895fb5f7b73fbbbc063a9e196b3275b980dba2`. That evidence proves only its
  recorded candidate and does not override the red check on the current tip.
- `main` branch protection currently requires
  `Typecheck / Lint / Test / Schema`. It does not require the PR-preview health
  check or the staging-smoke check.

The promotion workflow on `origin/staging` is not a usable production gate in
its current location. It requires a `main` ref, but `main` does not contain the
workflow file. Do not dispatch it or reproduce its push step manually. Promotion
remains blocked until the reviewed workflow exists on `main`, its environment
and release-owner restrictions are verified, and the exact current staging SHA
has fresh smoke and database-recovery evidence.

## Fixed staging environment

The separately deployed staging origin is
`https://terroir-web-staging.up.railway.app`.

Staging must keep all of these boundaries:

- a Railway staging environment and staging-scoped service variables;
- an isolated Supabase branch or project with its own URL and credentials;
- synthetic data in disposable namespaces, with cleanup evidence;
- staging-only Auth redirects, Storage policies, email/test inboxes, and
  provider credentials; and
- a cookie secret that is not shared with production.

The current `origin/staging` workflow and its retained evidence remain the
source for the detailed fixed-staging procedure. Because those files are not on
`main`, this document does not copy their mutation commands or claim that the
main branch can run them.

## PR preview environments

The repository's PR-preview workflow can prove that Railway reported a
deployment for the PR HEAD and that the trusted Railway service domain returned
HTTP 200 from `/api/health`. Its success does not prove database, provider,
tenant, Auth, or Storage isolation.

Standard Railway PR environments are blocked for Terroir when they inherit
production variables. Do not enable or use one until every preview has:

- a preview-specific Supabase branch or project with separate publishable and
  service-role credentials;
- no production service-role key, database URL, rows, Auth users, sessions, or
  Storage objects;
- synthetic or disposable data only;
- preview-scoped provider credentials, quotas, and callback URLs; and
- a preview-specific cookie secret and explicit cleanup lifecycle.

If Railway cannot supply those boundaries per preview, use the fixed isolated
staging environment instead. A preview that points at production Supabase or
uses production provider credentials is unsafe even when `/api/health` returns
200.

The strict workflow in this change fails closed when PR metadata is missing,
Railway reports failure or error, or polling ends without a valid preview. The
success log phrase is exactly `Preview ready — curling <preview>/api/health`,
followed by `Preview /api/health returned 200`. The workflow is operational,
but it is advisory until GitHub branch protection requires
`Preview health / Railway preview /api/health` on `main`.

## Supabase staging choices

Supabase documents two branch lifecycles: ephemeral preview branches and
long-lived persistent branches. Each branch is a separate environment with its
own database, API endpoint, credentials, Auth, and Storage. New branches are
data-less by default; production data is not copied. Supabase recommends a
persistent branch for staging or QA because it is not paused or deleted when a
pull request closes. See the official
[Branching guide](https://supabase.com/docs/guides/deployment/branching) and
[branch configuration guide](https://supabase.com/docs/guides/deployment/branching/configuration).

Branching requires a Pro plan. Supabase bills branch compute and other usage;
branch usage is not covered by the Spend Cap, and compute credits do not apply.
The current published Micro compute rate starts at $0.01344 per branch-hour,
with disk, egress, and Storage charged by use. Verify pricing before creating or
retaining a branch. See the official
[branch usage guide](https://supabase.com/docs/guides/platform/manage-your-usage/branching).

A separate Supabase project provides a stronger administrative boundary but
adds its own project configuration and plan usage. Terroir already has an
isolated fixed-staging Supabase resource. Do not create another branch or
project until an owner confirms that the existing resource cannot meet the
required isolation.

## Promotion and rollback gates

Production promotion requires all of the following evidence for one exact SHA:

1. The SHA is the protected `origin/staging` tip.
2. Railway staging serves that SHA and the required staging smoke check passes.
3. Stateful tests use only isolated synthetic data and retain cleanup evidence.
4. The required backup and disposable restore drill are current and bound to
   the release decision.
5. The reviewed promotion workflow exists on `main`, the configured release
   owner authorizes the action, and the production environment restrictions are
   verified live.

Rollback is also a production operation. Record the failed and prior-known-good
SHAs, deployment state, migration state, and incident approval before acting.
Do not copy or restore database data as part of an application rollback without
a separate approved restore procedure.
