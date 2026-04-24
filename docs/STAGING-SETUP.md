# Staging environment — setup guide

Addresses **INT-018** (no staging environment). Currently `main` auto-deploys
to production on Railway with only the CI gates (typecheck / lint / vitest /
schema drift / types drift / downs drift) standing between a developer's
laptop and a live customer.

This document is the setup playbook. Executing it requires Railway dashboard
access + a Supabase-admin decision on branch vs. separate project.

---

## Goal

`main → staging → prod` promotion, where the same commit is exercised
against a staging Railway service + staging Supabase before a manual
promotion to prod.

## Option A — Full staging (recommended)

**What it gets us:** genuine pre-prod smoke. Catches Chromium version
drift, Railway runtime shifts, Supabase RLS surprises, SDK majors —
anything the unit tests don't cover but a real HTTP+DB integration
does.

**Steps:**

1. **Create a second Railway service** in the same project, name it
   `terroir-web-staging`. Point it at a new `staging` git branch
   (create locally: `git branch staging main && git push -u origin
   staging`). Configure the service's deploy trigger to `staging`
   only.

2. **Supabase staging** — pick one:
   - **Supabase branches** (GA as of 2025): create a branch from
     prod. Each branch gets its own database + auth schema but shares
     project-level settings. Cheapest to maintain.
   - **Separate Supabase project**: more isolation, higher monthly
     cost, more env-var management. Overkill unless we're testing
     migrations that could corrupt prod data.

3. **Wire env vars on the staging service** (Railway dashboard →
   Variables):
   - `NEXT_PUBLIC_SUPABASE_URL` → staging branch/project URL
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` → staging
   - `SUPABASE_SERVICE_ROLE_KEY` → staging
   - `ACTIVE_RESTAURANT_COOKIE_SECRET` → new random `openssl rand
     -base64 48` (don't share with prod)
   - `ANTHROPIC_API_KEY` → either a separate staging key or same
     (same is acceptable; no PII difference)
   - `AZURE_DOC_INTELLIGENCE_*` → same
   - `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` → same DSN, BUT add
     `SENTRY_ENVIRONMENT=staging` so Sentry dashboards separate
     staging noise from prod incidents.

4. **Promotion workflow** — add `.github/workflows/promote-to-prod.yml`
   that's triggered manually from the Actions tab:
   ```yaml
   on:
     workflow_dispatch:
       inputs:
         sha: { required: true }
   jobs:
     promote:
       steps:
         - run: |
             git push origin ${{ inputs.sha }}:main
   ```
   The CI gates already run on the push-to-main, and Railway deploys
   on the push.

5. **Automerge to staging** — add a branch-protection rule on
   `staging` that auto-merges from `main` when `main`'s CI is green.
   Or manually: `git push origin main:staging` after each landed PR.

6. **Developer-facing preview URL**: `https://terroir-web-staging.up.
   railway.app`. Add to `.council/progress.md` + this README so cold-
   start developers know where to smoke-test.

## Option B — Cheaper half-step (CI step landed; dashboard toggle pending)

**What it gets us:** per-PR preview deploys with a health check.
Doesn't replace prod staging, but catches Chromium / runtime shifts
before merge.

**Status:** The CI workflow is **already in place** as
`.github/workflows/preview-health.yml`. It polls the GitHub
Deployments API for a Railway-originated preview deployment on each
PR, waits up to 5 minutes for it to reach `success`, then curls its
`/api/health` and fails the gate on non-200.

**Graceful degradation:** when no Railway deployment is found within
the timeout (i.e., the Railway dashboard toggle below is NOT flipped),
the step succeeds with a skip message. Safe to land PRs today; the
gate activates automatically the moment the toggle flips.

**Remaining steps to activate:**

1. **Enable Railway PR previews** (Railway dashboard → Service →
   Settings → PR Environments → toggle on). Each PR then gets a
   temporary service at a generated URL, reported to GitHub via the
   Deployments API. **No code change required** — the existing
   workflow will start exercising preview URLs immediately.

2. **Gate merge** on the `Preview health / Railway preview /api/health`
   check via a branch-protection rule on `main` (Settings →
   Branches → main → Require status checks to pass).

Option B doesn't catch Supabase-side regressions (RLS changes,
migration issues) since the preview still hits prod Supabase. But it
catches the most common class of "works on my laptop, breaks on
Railway" surprises.

### Verifying the gate end-to-end

After flipping the Railway toggle + adding the branch-protection
rule, verify both are wired correctly by opening a throwaway PR and
watching for:

1. **Railway posts a deployment.** Within ~30-90 s of the PR
   opening, the PR timeline shows a `Deployment` event from Railway
   with environment label `pr-N`. If it doesn't appear, the
   dashboard toggle isn't on.

2. **The `Preview health` workflow runs.** Check the Actions tab on
   the PR — `Preview health / Railway preview /api/health` should
   start polling. Logs show `Polling for Railway preview on
   <repo> @ <sha> ...` for up to 5 min.

3. **`/api/health` is curled on the preview URL.** Log shows
   `Preview ready — curling <url>/api/health`. A 200 reply logs
   `✅ Preview /api/health returned 200` and the check passes.

4. **The status check is required in the PR UI.** The "Merge pull
   request" button is disabled until the check reports success, and
   the check appears in the required-checks list at the bottom of
   the PR.

If step 1 passes but step 2 doesn't, check the workflow file is
present on the PR's base branch (`main`). If steps 1-3 pass but
step 4 doesn't, the branch-protection rule didn't take — the check
name to require is exactly `Preview health / Railway preview /api/health`
(job name inside `preview-health.yml`, not the workflow name).

## Tracking

Once either path is chosen and executed, update:
- `.council/architecture_index.md` → flip the "no staging wired up"
  note to describe the actual setup
- `.council/issue_backlog.md` → mark INT-018 resolved with the
  commit SHA that stood up the staging service
- `README.md` → add a "Development" section pointing at the staging
  URL

## Why this is still open as a finding

This doc scopes the work. Option B's **CI side is landed** — the
preview-health workflow is in place and will start gating merges as
soon as the Railway dashboard PR-Environments toggle is flipped.
Option A still requires dashboard-level access + a call on Supabase
branch vs. separate project.

INT-018 moves from "open" to "half-scoped" once the workflow lands,
and closes fully when either path is activated on the Railway side.
