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

## Option B — Cheaper half-step

**What it gets us:** per-PR preview deploys with a health check.
Doesn't replace prod staging, but catches Chromium / runtime shifts
before merge.

**Steps:**

1. **Enable Railway PR previews** (Railway dashboard → Service →
   Settings → PR Environments). Each PR gets a temporary service at
   a generated URL.

2. **Add preview-health CI step** to `.github/workflows/ci.yml`:
   ```yaml
   - name: Wait for Railway preview
     if: github.event_name == 'pull_request'
     run: |
       # Railway posts the preview URL to the PR as a check;
       # poll /api/health until it's 200 or 5 minutes elapse.
       # ...
   ```
   (Actual implementation depends on Railway's preview-URL mechanism
   and how they expose it to GitHub.)

3. **Gate merge** on the preview-health check via a branch protection
   rule.

Option B doesn't catch Supabase-side regressions (RLS changes,
migration issues) since the preview still hits prod Supabase. But it
catches the most common class of "works on my laptop, breaks on
Railway" surprises.

## Tracking

Once either path is chosen and executed, update:
- `.council/architecture_index.md` → flip the "no staging wired up"
  note to describe the actual setup
- `.council/issue_backlog.md` → mark INT-018 resolved with the
  commit SHA that stood up the staging service
- `README.md` → add a "Development" section pointing at the staging
  URL

## Why this is still open as a finding

This doc scopes the work. Actually creating the Railway service and
Supabase branch requires dashboard-level access and a call on
Option A vs B. Pick one and execute; INT-018 closes when the
staging URL is live.
