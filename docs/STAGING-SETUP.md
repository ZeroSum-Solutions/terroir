# Staging and preview safety

This guide records the current GitHub, Railway, and Supabase gate state. It does
not authorize a deployment, migration, promotion, rollback, or production data
operation.

## GitHub state — snapshot as of 2026-08-20

> **This section is a dated snapshot, not current truth.** It was verified through
> the GitHub API on 2026-08-20 and has been overtaken in places by the later
> sections below ("Re-verification — 2026-08-22" and "Option A implementation —
> 2026-08-22"). Read those before acting on anything here. Corrections applied
> in place are marked **UPDATE**.

Verified through the GitHub API on 2026-08-20:

- `origin/staging` exists and is protected. It requires the strict
  `Staging smoke / Required staging smoke` check, enforces administrators and
  linear history, and blocks force pushes and branch deletion.
- The staging branch contains the `Staging smoke` and `Promote to production`
  workflow files. At the time of this snapshot neither existed on `main`.
  **UPDATE (still true 2026-08-30 for one of the two):** `Staging smoke` **does**
  now exist on `main` — `.github/workflows/staging-smoke.yml`, added 2026-08-22 in
  `1ca7f30` (#92); see "Option A implementation — 2026-08-22" below, and
  `docs/runbooks/production-migrations.md`, which depends on it being there.
  `Promote to production` is still genuinely absent from `main`, so the promotion
  blocker recorded two paragraphs down still stands.
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

- **Branch protection status (updated after G0-4).** At investigation time,
  `GET /repos/wiggdevin/terroir/branches/main` and `.../branches/staging` both
  returned `"protected": false`, and `GET .../branches/main/protection` and
  `GET .../rulesets` both 403'd with `"Upgrade to GitHub Pro or make this
  repository public to enable this feature."` — the repo was private and its
  owner, `ZeroSum-Solutions`, was on the GitHub Free org plan, which does not
  support protected branches on a private repo. That observation was accurate
  at the time. It was resolved the same day by slice **G0-4**: the repo was
  flipped from private to **public** (~13:14 on 2026-08-22), which lifted the
  plan restriction, and branch protection was installed on `main`. Re-verified
  after G0-4: the repo is public (`visibility: "public"`); `main` requires the
  status check `Typecheck / Lint / Test / Schema` and 1 approving review, and
  blocks force pushes and branch deletion (`enforce_admins` and
  `required_linear_history` are both currently `false`); `staging` remains
  unprotected — `GET .../branches/staging/protection` now returns a plain 404
  `"Branch not protected"` (no plan-upgrade error), i.e. it's simply not
  configured, not blocked by the org plan. `Preview health` is not yet in
  `main`'s required checks.
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
  `production` environment shows live `OPENROUTER_API_KEY`,
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
base (or, for Option A, the Railway `staging` environment repointed at the
`staging` git branch), then (3) once those runs are actually green, adding the
check context `Preview health / Railway preview /api/health` to `main`'s
existing required checks alongside `Typecheck / Lint / Test / Schema`. **Do
not add that required check before the Railway side works** — with Railway PR
previews still off, `Preview health` fails on every PR by design, and
requiring it would block every merge to `main` on a check that can never pass
yet. None of the three steps are reachable from this repository's code or CI
config.

## Option A implementation — 2026-08-22 (G0-3 runtime slice)

Implemented the cheapest truthful version of Option A: a `Staging smoke`
workflow on `main` (`.github/workflows/staging-smoke.yml`) that runs on every
push to `main`, polls `https://terroir-web-staging.up.railway.app/api/health`
for up to 7.5 minutes, and fails hard if it never observes the pushed commit's
SHA reported as `release` with `db: "connected"` and `status: "ok"`. This is
deliberately separate from, and smaller than, the migration/E2E `Staging
smoke` workflow that already exists on `origin/staging` — that workflow
belongs to the not-yet-reachable staging-branch model described above and is
untouched by this change.

Two findings from this investigation:

- **Railway's `staging` environment tracking `main` (not a `staging` branch)
  is accepted as the permanent model, not a defect to fix.** `railway service
  source connect --help` confirms sources are connected at the *service*
  level and fan out to "matching project environments" — there is no
  per-environment branch override reachable from the CLI or from
  `railway.toml`/config-as-code. Repointing the `staging` environment at the
  `staging` git branch is therefore dashboard-only *and* would only affect
  which commit staging serves, not add any capability this repo's code can
  drive. Given that, staging-tracks-main is the simpler and equally honest
  choice: the smoke gate now validates the exact commit that lands on `main`,
  on the exact infrastructure (`industrious-courtesy` / `staging`) that
  Railway already deploys it to. **No Railway-side change was made or is
  required.**
- **`/api/health` did not expose which commit it was serving.** Added a
  `release` field sourced from `RAILWAY_GIT_COMMIT_SHA` (Railway's
  automatically-injected env var for GitHub-triggered deploys; confirmed by
  `railway variables --json` key names — it does not appear there because
  it's a deploy-time reference variable, not a configured service variable).
  The field is omitted whenever the variable is unset (local dev, tests,
  non-Railway environments), so this is additive and non-breaking.

Live-verified before merge: curling the current staging origin returns
`{"status":"ok","db":"connected", ...}` with no `release` key yet (the field
doesn't exist in production until this change deploys), and a single-attempt
dry run of the workflow's poll logic against that live response correctly
exits non-zero. Full end-to-end verification (a real push landing a matching
`release` within the poll window) can only happen after this PR merges.

**Remaining owner step:** merge this PR, then watch the `Staging smoke`
workflow on the next two pushes to `main`. The G0-3 bar is two consecutive
green runs; that can't be produced without merging. If either run fails,
check the run log's "Last observed" line first — it reports the exact
`http`/`release`/`db` values staging returned, which distinguishes "Railway
just needs more time than 7.5 minutes for this build" (raise `MAX_ATTEMPTS`)
from a genuine regression.

## Incident — 2026-08-22: repo transfer severed Railway auto-deploy (G0-3B)

> **RESOLVED, same day.** The Railway GitHub App was installed on the
> `ZeroSum-Solutions` org and all four deploy triggers now point at
> `ZeroSum-Solutions/terroir`. Live proof: the `bb490c6` merge to `main`
> auto-deployed with no manual fire and its `Staging smoke` run went green.
> The interim manual-fire procedure below is retired; it is kept for the
> record and for any future repo transfer. **Repair lesson:** after the App
> install, Railway kept refusing `deploymentTriggerUpdate` for the org repo
> ("no one in the project has access to it") through 75+ minutes of retries —
> the mutation that actually works is **`serviceConnect`** on the service
> (`input: { repo, branch }`), which relinks the source and cascades the fix
> to that service's deploy triggers. Reach for `serviceConnect` first;
> `deploymentTriggerUpdate` is the wrong lever after a transfer.


The first two `Staging smoke` runs after the Option A merge both failed with
`release=<none>` on every attempt. Neither failure was the workflow's fault:
**no Railway environment (staging or production) received any deploy on
2026-08-22 at all.** The last webhook-triggered deploy was 2026-08-21 18:46
PT.

(The "every push to `main` triggers the same-SHA deploy" statements in the
sections above were accurate up to that deploy, and hold again as of the
resolution above.)

Root cause: the repository now lives at `ZeroSum-Solutions/terroir`, but the
Railway GitHub App is installed only for the `wiggdevin` personal account —
the `ZeroSum-Solutions` org has no Railway App installation. GitHub webhook
delivery does not follow a repository transfer the way git-clone redirects
do, so Railway stopped receiving push events entirely. All four Railway
deploy triggers (and both services' sources) still name `wiggdevin/terroir`,
and Railway refuses to update them to the org name until its App can see the
repo ("Cannot update deployment trigger for ZeroSum-Solutions/terroir because
no one in the project has access to it").

What still works: the old repo name redirects for git *clones*, so manually
fired deploys build the correct current `main`. Verified live: a manual fire
built and served `2cd9c5d` on staging, `/api/health` exposed the new
`release` field for the first time, and re-running the failed smoke run went
green against it.

**Interim procedure (retired — kept for the record)** — after each merge to
`main`, fire both web deploys through Railway's public GraphQL API
(`https://backboard.railway.com/graphql/v2`, authenticated with your Railway
account token) with the `environmentTriggersDeploy` mutation, passing the
project id plus the `terroir-web` service id and the target environment id
(staging, then production). Ids come from `railway status` / the dashboard.
The smoke workflow then goes green on its own once staging converges; if its
poll window expired first, `gh run rerun <run-id>` after convergence.
`terroir-worker` needs no fire: its triggers point at a stale integration
branch and the worker deploy model is owned by the G1-6 slice.

**The real fix (completed 2026-08-22):** the Railway GitHub App installed on
the `ZeroSum-Solutions` org, then `serviceConnect` relinked the web service to
`ZeroSum-Solutions/terroir` (see the resolution note at the top of this
section for why `deploymentTriggerUpdate` alone never worked), and the next
push to `main` auto-deployed without a manual fire. The `terroir-worker`
service reported "ServiceInstance not found" on `serviceConnect` — expected,
it has no deployable instance until the worker rollout
(`docs/runbooks/invoice-extract-worker.md`); its triggers are repointed
regardless.

Related hardening in this change: `staging-smoke.yml` now cancels a
superseded in-progress run (`cancel-in-progress: true`). Two merges landing
back-to-back previously queued two runs, and the older SHA's run could only
ever time out red — staging converges exclusively on the newest `main` SHA.
A cancelled run is not a failure signal; the newest SHA's run is the gate.

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

## Guardrail update — 2026-08-27 (CI-guardrails slice)

Re-verified through the GitHub API on 2026-08-27 while landing the
CI-guardrails changes. Two earlier claims no longer hold: the
branch-protection state recorded in "Re-verification — 2026-08-22" (see
the next bullet), and the statement that `Preview health` "fails on every
PR by design" — the fail-closed poll is unchanged but its job is now
gated behind `RAILWAY_PR_PREVIEWS_ENABLED` and reports "skipped" until
previews are provisioned (see the compensating-changes list below):

- **The repository is private again, and main's branch protection is gone.**
  `GET /repos/ZeroSum-Solutions/terroir` returns `"visibility": "private"`;
  `GET .../branches/main/protection` 403s with the Free-org-plan upgrade
  message, exactly the pre-G0-4 state. Flipping the repo back to private
  (after G0-4 made it public on 2026-08-22) silently dropped the protection
  that section "Re-verification — 2026-08-22" records as installed. At
  discovery time `main` had NO required checks, NO force-push protection,
  and NO deletion protection.

  **Resolved same day by owner decision (2026-08-27): the repo is public
  again** (`"visibility": "public"`, verified via PATCH + GET), and branch
  protection is reinstalled on `main` — stricter than the G0-4 version:
  required status check `Typecheck / Lint / Test / Schema` (strict=false),
  `enforce_admins: true` (G0-4 had `false`, which let admin merges bypass
  the check — that hole is closed), force pushes and deletions blocked. The
  G0-4-era 1-approving-review requirement was deliberately NOT reinstalled:
  with a solo maintainer and `enforce_admins: true` it would deadlock every
  merge, and with `enforce_admins: false` it was decorative. The CI check
  is the real gate and now binds everyone.

Two compensating changes landed in this slice:

- **`Preview health` no longer reports a permanently red check.** The
  fail-closed poll (commit `1cb8ef9`) is preserved verbatim but the job now
  runs only when the repository variable `RAILWAY_PR_PREVIEWS_ENABLED` is
  `'true'`. Railway PR Environments remain unprovisioned and unsafe to enable
  (see the 2026-08-22 re-verification above); until an isolated preview base
  exists the check reports "skipped" instead of training everyone to ignore a
  red X. When previews are provisioned, set the variable and the gate arms
  again unchanged.
- **A red `main` now notifies.** `.github/workflows/ci-main-alert.yml`
  triggers on a failed `CI` run for `main` and opens (or comments on) a
  GitHub issue labeled `ci-main-failure`, pinging the owner through native
  GitHub notifications. No secrets involved. This exists because every CI
  run on `main` was red from ~2026-08-10 to 2026-08-27 (PostgREST types
  drift, then two latent e2e breaks) and nothing surfaced it.
