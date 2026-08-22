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

## Re-verification — 2026-08-22 (G0-3)

Re-checked through the GitHub API and the Railway CLI while investigating why
`Preview health` fails on every PR (INT-018 / G0-3). Two claims above no longer
hold and change what "failure blocks promotion" can mean today:

- **Neither `main` nor `staging` is currently a protected branch.**
  `GET /repos/wiggdevin/terroir/branches/main` and `.../branches/staging` both
  return `"protected": false`. `GET .../branches/main/protection` and
  `GET .../rulesets` both 403 with `"Upgrade to GitHub Pro or make this
  repository public to enable this feature."` The repo's owner,
  `ZeroSum-Solutions`, is confirmed on the GitHub **Free** org plan
  (`GET /orgs/ZeroSum-Solutions` → `plan.name: "free"`). Branch protection
  (required status checks, admin enforcement, linear history) is not available
  for a **private** repo owned by a Free-plan org, regardless of what is
  configured in the UI. This means no required check — not
  `Typecheck / Lint / Test / Schema`, not `Staging smoke`, not a future
  `Preview health` — currently blocks a merge to either branch. Restoring that
  requires the owner to upgrade `ZeroSum-Solutions` to GitHub Team (or move the
  repo to a Pro-plan personal account) before any required-check gate can be
  re-enabled. This is a precondition for the "failure blocks promotion"
  acceptance bar, independent of the Railway work below.
- **Railway PR-preview environments are not enabled**, and no code change to
  `preview-health.yml` can create one. `railway environment list` (industrious-
  courtesy project) shows only two environments, `production` and `staging`;
  there is no per-PR environment. `GET /repos/.../deployments?sha=<PR head>`
  returns `[]` for every recent PR head SHA — Railway never records a
  deployment for them. `preview-health.yml`'s poll logic (Railway bot PR
  comment + matching deployment + `/api/health` 200) is confirmed correct: it
  is exercising exactly what the Railway "PR Environments" dashboard feature
  would produce if turned on, and there is nothing to detect because the
  feature is off. Recent runs failing (e.g. run `32544129334`, PR #80) is the
  intended fail-closed behavior added in commit `1cb8ef9` ("ci: fail closed on
  missing Railway previews", 2026-08-20); before that commit the same
  no-preview condition exited 0 as a "graceful skip" (see run `32345031675`),
  which is why older PRs show green — they were never actually testing a
  preview.
- Turning PR Environments on as-is would fail the isolation bar this document
  already sets (do not enable until every preview has its own Supabase
  credentials, etc.): `railway variables --service terroir-web` on the
  `production` environment shows live `ANTHROPIC_API_KEY`,
  `NEXT_PUBLIC_SUPABASE_URL`/publishable key, `SENTRY_AUTH_TOKEN`, and
  `ACTIVE_RESTAURANT_COOKIE_SECRET`. Railway's PR Environments feature clones
  variables from a chosen base environment; only `production` and `staging`
  exist to clone from, and neither is a preview-safe base today. Enabling PR
  Environments therefore needs a new isolated base environment (its own
  Supabase branch/project, its own cookie secret, no production keys) created
  first, then PR Environments pointed at that base instead of `production`.
- **Option A (fixed staging smoke) is not a working shortcut around the above
  either, for a separate reason.** `GET /repos/.../deployments` shows
  Railway's bot deploying the *same* SHA to both `industrious-courtesy /
  production` and `industrious-courtesy / staging` at the same timestamp on
  every push to `main` (e.g. SHA `beeb2d45` deployed to both environments at
  `2026-08-22T01:46:11Z`). That means the Railway `staging` environment is
  currently tracking `main`, not the `staging` git branch — consistent with
  this document's own note above that the latest `staging`-tip run failed the
  exact-candidate SHA-binding smoke (Railway staging was never actually
  running the `staging` branch's code to bind against). Fixing Option A needs
  the owner to repoint the Railway `staging` environment's deploy trigger at
  the `staging` branch (Railway dashboard → service → Settings → Source), and
  still depends on the branch-protection fix above to actually gate anything.

Net: getting `Preview health` to two consecutive green runs needs, in order,
(1) an isolated preview-safe Railway base environment backed by its own
Supabase branch/project, (2) Railway PR Environments turned on against that
base, then (3) the GitHub org plan upgraded so `main` can require the check at
all. None of the three are reachable from this repository's code or CI config.

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
