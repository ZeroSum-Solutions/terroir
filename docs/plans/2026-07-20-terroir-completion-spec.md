# Terroir application completion plan

Status: council-reviewed and ready for owner authorization
Prepared: 2026-07-20
Repository baseline: `4508f3c` on `main`
Production: `https://terroir-web-production.up.railway.app`
Planning council: Codex, Kimi K3, and Fable 5 at medium effort
Council verdict: READY

## 1. Objective

Finish Terroir as a dependable, production-ready restaurant wine-management application. Every visible action must work, explain why it is unavailable, or be removed. Every documented critical workflow must be proven through an automated test or a recorded operational drill. Authentication, backups, staging, and release controls must be real rather than implied by passing unit tests.

The intended result is that a restaurant owner or manager can:

1. create and secure an account;
2. configure one or more restaurants and staff roles;
3. scan invoices and bottles into a trustworthy cellar;
4. manage pours, depletion, and reconciliation;
5. research wines, compare prices, and act on insights;
6. build, publish, share, print, and export wine lists;
7. invite staff and give each role an understandable experience;
8. rely on backups, recovery, monitoring, and a controlled deployment path.

## 2. Verified starting point

The codebase is healthy enough to extend, but it is not yet operationally complete.

| Check | Current evidence | Interpretation |
| --- | --- | --- |
| Unit and integration tests | 55 files, 419 tests passed | Strong regression base, not proof of full workflows |
| Lint | Passed | Baseline quality gate is green |
| Type check | `tsc --noEmit` passed | Baseline type gate is green |
| Production build | Passed | Current source compiles for deployment |
| Production health | `/api/health` returned 200 with database connected | Process and database are reachable only |
| Specification inventory | 269 core feature bullets in `app_spec.txt` | Conflicts with the file's 200-feature budget and the diary's 231/231 claim |
| Browser E2E | Login shell, unauthenticated redirect, and invalid public slug only; pour flow is skipped in CI | Critical workflows are not release-gated |
| Database backup | Scheduled workflow has failed daily because `SUPABASE_DB_URL` is absent | Recovery is not proven |
| Staging | No active production-like staging environment | Promotion cannot be rehearsed safely |
| Branch protection | No required checks or pull-request review rules on `main` | A failing change can reach production |
| Scanner baseline | Manual workflow exists, but no committed score baseline | Accuracy regressions are not measurable |
| Background jobs | Migration exists; no producer or worker implementation | Expensive work still runs synchronously |

### 2.1 Specification truth problem

`app_spec.txt` currently contains 269 core bullets across 17 domains:

| Domain | Bullets |
| --- | ---: |
| API layer | 38 |
| Authentication and session | 13 |
| Bottle scanning | 7 |
| Cellar and inventory | 27 |
| Database constraints and functions | 14 |
| Insights and analytics | 10 |
| Invoice scanning | 27 |
| Observability and operations | 9 |
| Pour and open bottles | 15 |
| Price comparison | 5 |
| Public wine list | 10 |
| Reconciliation | 9 |
| Restaurants and teams | 16 |
| Testing quality | 12 |
| User interface | 17 |
| Wine intelligence | 11 |
| Wine lists editor | 29 |
| **Total** | **269** |

The historical progress diary is useful evidence, but it is not an authoritative completion ledger. It records 231/231 while the original spec said both 269 and at most 200.

Resolution recorded 2026-07-23: the product owner directed the team to implement every enumerated feature. All 269 core-feature bullets are active requirements, the former maximum of 200 is superseded, and `docs/feature-ledger.json` is the authoritative completion ledger.

## 3. Definition of done

Terroir is complete only when all of the following are true:

- Every active requirement has one stable ID, an owner, implementation evidence, test evidence, and a current status.
- No production page contains an unexplained disabled action, placeholder, dead link, or inaccurate “coming soon” promise.
- Magic-link and password authentication work from the production domain, and the temporary bypass is removed.
- Owner, manager, and staff permissions are enforced in both the interface and server layer.
- Invoice import, bottle scan, pour and reconcile, list publish, public view, PDF export, and invitation acceptance pass isolated E2E tests in CI.
- A production-like staging deployment passes smoke tests before promotion.
- Database backups run successfully and at least one disposable restore drill is recorded.
- Scanner accuracy has a versioned baseline and a regression threshold.
- Long-running work has explicit job state, retry, timeout, and failure behavior.
- Production configuration is checked without exposing secret values.
- Documentation matches the deployed architecture and operating procedures.
- A release candidate soaks in staging, passes the complete gate, and has an exercised rollback path.

## 4. Product decisions and council defaults

The autonomous runner may use the defaults below. It must stop only where the table says approval is required.

| Decision | Default | Approval rule |
| --- | --- | --- |
| Authentication methods | Support magic link plus email/password; retain password reset | No approval unless provider or schema changes |
| Staff access to wine lists | Read-only view with edit controls absent | Safe default |
| Missing documented GET APIs | Add thin authenticated handlers over existing query modules | Safe unless a route would expose new public data |
| Offline promise | Amend to resilient ISR and graceful network-failure behavior; do not add a service worker | Stop only if true offline editing is required |
| Invitation delivery | Use a transactional email provider, with the generated link still copyable by owner/manager | Provider choice and production secret require approval |
| Staff briefing | A restaurant-scoped daily queue that can be viewed, reordered, removed, printed, and copied | Safe default; notifications are out of scope |
| Voice commands | Browser speech recognition with a typed fallback; all mutations require a confirmation screen | Stop if a paid speech provider is needed |
| Worker rollout | Prove job lifecycle with PDF generation, then move invoice OCR, then enrichment | Safe default |
| Backup connection | Add a dedicated least-privilege direct database URL to GitHub Actions | Secret creation and production restore require approval |
| Public list navigation | Show a switcher when the same restaurant has multiple published lists | Safe default |
| Large-file refactors | Split only code touched by a feature, preserving behavior | Safe default |
| Core feature count | Keep all 269 enumerated bullets active; the former maximum of 200 is superseded | Approved by product owner on 2026-07-23 |

### 4.1 Human provisioning checklist

Collect these approvals and capabilities as one batch before `TER-000` so the autonomous runner does not stall one credential at a time. Values remain in ZS Vault or the destination secret store and never enter this document.

- GitHub repository administrator access for branch protection, Actions secrets, and required checks.
- Railway project administrator access for staging, worker services, deployment variables, rollback, and temporary-bypass rotation.
- Supabase organization access for a separate staging project, auth URL configuration, storage policies, service-role E2E setup, and a least-privilege direct backup connection.
- Approval for the staging and worker resource budget.
- A transactional email provider account, verified sender domain, sandbox inbox, API secret, and production-send approval, plus staging SMTP or an equivalent test inbox for real Supabase magic-link E2E.
- Approved OCR, enrichment, wine-search, error-tracking, and analytics test credentials where current integrations require them.
- A disposable restore target and explicit confirmation that production is never a restore-drill destination.
- Named owners for security approval, product-spec amendments, production deployment, and incident rollback.

The runner may inventory whether each prerequisite exists, but it must not create accounts, spend money, change production configuration, or retrieve new secrets without the applicable approval.

## 5. Dependency and release sequence

```text
Immediate containment
  -> specification truth
  -> backup, staging, isolated tests, API and observability foundations
  -> full release protection
  -> authentication and restaurant administration
  -> remaining labeled product features
  -> end-to-end workflow and accessibility proof
  -> documentation truth
  -> staging soak and production release
```

The exact prerequisite graph is:

| Spec | Prerequisites |
| --- | --- |
| TER-000 | None |
| TER-001 | TER-000 |
| TER-002 | TER-001 |
| TER-003 | TER-001 |
| TER-004 | TER-001, TER-003 |
| TER-005 | TER-002, TER-003, TER-004 |
| TER-006 | TER-001, TER-004 |
| TER-020 | TER-001 |
| TER-021 | TER-002, TER-003, TER-020, TER-023 |
| TER-022 | TER-004, TER-020 |
| TER-023 | TER-001, TER-003, TER-020 |
| TER-024 | TER-020, TER-021, TER-023 |
| TER-025 | TER-001, TER-004, TER-014, TER-020 |
| TER-026 | TER-020, TER-021, TER-022, TER-025 |
| TER-027 | TER-020, TER-025, TER-026 |
| TER-028 | TER-004, TER-014, TER-020, TER-022, TER-024 |
| TER-010 | TER-003, TER-004, TER-023 |
| TER-011 | TER-010 |
| TER-012 | TER-010, TER-020 |
| TER-013 | TER-010, TER-014, TER-020, TER-024 |
| TER-014 | TER-010, TER-020 |
| TER-015 | TER-010, TER-014, TER-023 |
| TER-030 | TER-014, TER-020 |
| TER-031 | TER-014, TER-020 |
| TER-032 | TER-014, TER-020, TER-024 |
| TER-033 | TER-020, TER-024 |
| TER-034 | TER-033 |
| TER-035 | TER-001, TER-003 |
| TER-040 | TER-004, TER-020, TER-021, TER-022 |
| TER-041 | TER-004, TER-014, TER-020 |
| TER-042 | TER-004, TER-014, TER-021, TER-033, TER-034 |
| TER-043 | TER-004, TER-014, TER-015 |
| TER-044 | TER-025 through TER-043 as applicable |
| TER-045 | All implementation specs whose behavior it documents |
| TER-046 | TER-002 through TER-045 |

Phases are ordered by risk, not visual appeal:

1. Immediate containment, truth, and safety: `TER-000` through `TER-006`.
2. Contracts, asynchronous work, and observability: `TER-020` through `TER-024`.
3. Identity and restaurant administration: `TER-010` through `TER-015`.
4. Uncovered core domains: `TER-025` through `TER-028`.
5. Remaining labeled product features: `TER-030` through `TER-035`.
6. Full workflow proof and release: `TER-040` through `TER-046`.

## 6. Detailed implementation specifications

### TER-000: Contain the current production risks

**Outcome:** The known temporary access path and unprotected deployment branch are controlled before autonomous work begins.

**Scope:**

- Rotate the disclosed bypass token without removing the only currently working access path.
- Set an explicit expiry and restrict the bypass to production, the intended account, and a server-side hash comparison.
- Confirm the raw token is absent from source, build output, logs, and current Git objects. Do not rewrite repository history; revocation is the control if an old value ever entered history.
- Immediately require pull requests and the currently green CI checks on `main`; `TER-005` later upgrades this to the full release gate.
- Record the bypass owner, expiry, removal dependency, and emergency revocation procedure.

**Acceptance:** The prior disclosed token cannot authenticate; the rotated token expires as configured and cannot authenticate another account or environment; direct push to `main` is rejected; existing green checks are required.
**Verification:** Negative token test, redacted deployment-variable inventory, Git object search, and branch-protection API evidence.
**Dependencies:** None.
**Approval:** Token rotation, Railway configuration, and repository rule changes require explicit approval.

### TER-001: Establish the authoritative feature ledger

**Outcome:** One machine-checkable ledger replaces the contradictory 200, 231, and 269 completion claims.

**Scope:**

- Parse every core feature bullet from `app_spec.txt` and assign a permanent requirement ID.
- Classify each item as `active`, `amended`, `duplicate`, or `retired` with a reason.
- Resolve the “at most 200” budget clause explicitly instead of silently treating 269 as valid.
- Link active items to source, tests, operational evidence, and one completion spec in this document.
- Mark `claude-progress.txt` as historical evidence and prevent it from serving as the completion counter.
- Add a CI check for duplicate IDs, missing evidence fields, and unknown statuses.

**Acceptance:**

- The ledger accounts for all 269 current bullets exactly once.
- The generated totals match the checked-in source.
- Every active criterion names an actor, action, observable outcome, negative case, and evidence owner.
- Every non-active item has a rationale and recorded product-owner approval.
- The product owner explicitly approves either amending the 200-feature budget or the exact set of merged and retired bullets.
- CI fails when a requirement is added without an ID or evidence owner.

**Verification:** Ledger unit test, generated summary snapshot, product-owner sign-off, and independent review of all ambiguous mappings.
**Dependencies:** `TER-000`.
**Approval:** Any `amended` or `retired` classification and the 200-feature budget resolution require product-owner approval.
**Rollout:** Documentation and CI only; no production effect.

### TER-002: Repair backups and prove restoration

**Outcome:** Production data has a current encrypted backup that can be restored.

**Scope:**

- Provision `SUPABASE_DB_URL` as a least-privilege GitHub Actions secret without logging it.
- Make the scheduled backup workflow fail clearly on missing configuration or empty output.
- Store encrypted artifacts with explicit retention and checksum metadata.
- Add the missing backup and restoration runbook referenced by the workflow.
- Restore a backup into a disposable Supabase or PostgreSQL target and record the migration version, row count for every restored table, and deterministic content checksums for the ten largest non-empty tables.

**Acceptance:**

- Three consecutive backup runs succeed, with at least one scheduled run; manual dispatches may supply the other two.
- An artifact can be decrypted and restored without using production as the target.
- The restore report confirms expected tables, current migration version, every table's row count, and the ten required content checksums.
- Logs and artifacts contain no connection strings or credentials.

**Verification:** GitHub run links, artifact checksum, restore transcript with redacted identifiers, and runbook review.
**Dependencies:** `TER-001`.
**Approval:** Creating the secret and any operation against production requires explicit approval.
**Rollback:** Remove the workflow secret and revert workflow changes; never delete existing backup artifacts.

### TER-003: Create production-like staging and controlled promotion

**Outcome:** Every release is tested on a separate Railway service and separate Supabase project before production.

**Scope:**

- Create staging compute, database, storage, and authentication configuration.
- Seed synthetic fixtures only; prohibit production customer data.
- Set staging Site URL and allowed redirect URLs.
- Configure staging SMTP or an equivalent test inbox so magic-link and password-reset E2E can inspect real delivered messages.
- Replace the preview workflow's soft skip with a required staging smoke check.
- Document promotion, rollback, and environment-drift checks.

**Acceptance:**

- Staging deploys the candidate commit automatically.
- Authentication, upload, database writes, public list, and PDF generation run against staging services only.
- A failed smoke test prevents promotion.
- Environment inventory proves production and staging resources are distinct.

**Verification:** Staging URL, redacted environment map, deployment check, and smoke-test report.
**Dependencies:** `TER-001`.
**Approval:** New Railway and Supabase resources, secrets, and spend require approval.
**Rollback:** Delete only newly created staging resources after exporting configuration and logs.

### TER-004: Build an isolated E2E foundation

**Outcome:** Browser tests can create, exercise, and destroy their own restaurant data in CI.

**Scope:**

- Add deterministic E2E users, restaurant fixtures, object-storage fixtures, and cleanup.
- Use a per-run namespace or disposable database instead of a shared mutable account.
- For non-auth workflow setup only, allow a staging-only fixture helper to create a synthetic user through the Supabase admin API and inject that user's valid session. The helper must not be a deployed HTTP route, must reject production projects, and must never use the temporary bypass.
- Keep real magic-link, password, reset, and callback behavior out of the fixture shortcut; those paths require real-provider browser coverage in `TER-010`.
- Capture trace, screenshot, console, network, and server logs on failure.
- Remove the CI skip from the pour flow when isolation is proven.

**Acceptance:**

- Two parallel E2E runs do not interfere with each other.
- Re-running a failed test does not require manual cleanup.
- Tests fail on console errors, uncaught page errors, or unexpected 5xx responses.
- No production URL or production credential is accepted by the test harness.
- The fixture helper is unavailable in application builds and production runtime, and `TER-010` auth tests cannot import or call it.

**Verification:** Parallel CI runs and a forced-failure artifact review.
**Dependencies:** `TER-001`, `TER-003`.
**Rollback:** Keep current smoke tests while the new harness is introduced behind a separate CI job.

### TER-005: Protect main and define the release gate

**Outcome:** Production can receive only a reviewed commit that passed the complete required gate.

**Scope:**

- Require lint, type check, unit tests, build, E2E, and staging smoke checks.
- Require pull requests and prevent direct pushes to `main`.
- Make backup health a release precondition for schema changes.
- Add concurrency controls so an older deployment cannot overtake a newer one.
- Document the emergency rollback and break-glass owner.
- Freeze runtime merges during a staging outage; documentation-only changes may merge after all non-staging checks pass.

**Acceptance:** A deliberately failing branch cannot merge; a green candidate can promote once; the rollback drill returns the prior application version, preserves the pre-drill schema migration version, and leaves every restored table's row count plus deterministic checksums for the ten largest non-empty tables unchanged.
**Verification:** Branch-protection API evidence and a non-production failure drill.
**Dependencies:** `TER-002`, `TER-003`, `TER-004`.
**Approval:** Repository rule changes and deployment policy require owner approval.

### TER-006: Inventory every visible control and prevent new placeholders

**Outcome:** The “all labeled features working” promise is backed by an exhaustive, repeatable interface inventory.

**Scope:**

- Inventory links, buttons, menu items, form submissions, disabled controls, tooltips, and “coming soon” or placeholder copy across every route and role.
- Map each intended control to an active requirement and an interaction test.
- Remove accidental dead controls; where an unavailable state is legitimate, require a user-specific reason and recovery action.
- Add a static CI check for newly introduced placeholder phrases and disabled interactive elements without an approved annotation.
- Add a browser crawler that detects internal dead links, unhandled clicks, page errors, and unexpected 4xx or 5xx responses.

**Acceptance:** The inventory covers every application and public route for owner, manager, staff, and guest; every control has a working test or approved unavailable-state record; seeded dead links and placeholder controls fail CI.
**Verification:** Generated inventory, mutation test with seeded violations, browser crawl report, and product-owner sign-off on approved unavailable states.
**Dependencies:** `TER-001`, `TER-004`.
**Approval:** Retiring a labeled product promise follows the approval rule in `TER-001`.

### TER-010: Make production authentication complete

**Outcome:** Users can sign up, sign in by magic link or password, reset a password, sign out, and return to the intended page.

**Scope:**

- Correct Supabase Site URL and allowed production, staging, and local redirect URLs.
- Add email/password sign-up and sign-in to the existing login experience.
- Preserve magic-link delivery and password reset.
- Normalize `next` handling, reject open redirects, rotate sessions correctly, and show actionable error states.
- Add rate limiting and generic responses that do not reveal account existence.
- Capture a redacted before-and-after export of mutable Supabase auth URL and provider settings.

**Acceptance:**

- Each auth path works in production and staging from a clean browser.
- Magic links return to the originating environment, never localhost.
- Password reset produces a password that can be used on the login page.
- Expired, reused, and malformed links create no session, return the user to login with the same generic recovery message, and preserve no privileged redirect destination.
- An authenticated user reaching `/login` is redirected appropriately.

**Verification:** Unit tests, real-provider staging E2E, and one approved production canary account.
**Dependencies:** `TER-003`, `TER-004`, `TER-023`.
**Approval:** Supabase dashboard configuration and production canary use require approval.

### TER-011: Remove the temporary authentication bypass

**Outcome:** Production has no alternate token path around normal authentication.

**Scope:**

- Remove bypass UI, route, middleware/session branch, tests, documentation, and deployment variables.
- Revoke or rotate the temporary token before removal is announced.
- Search source, build output, logs, and deployment configuration for remnants.
- Treat revocation as mandatory even if an old value is found in immutable Git history; never rewrite shared history as a token-removal strategy.

**Acceptance:** The prior bypass URL and token cannot create a session, and all normal auth E2E tests remain green.
**Verification:** Negative browser test, repository search, redacted Railway variable inventory, and deployed smoke test.
**Dependencies:** `TER-010`.
**Approval:** Removing production variables and revoking the token require approval.
**Rollback:** Roll back application code only if normal auth is unavailable; do not restore a disclosed token.

### TER-012: Add multi-restaurant switching

**Outcome:** A user with access to multiple restaurants can see and change the active restaurant from the application shell.

**Scope:**

- Add a restaurant switcher to the settings or account menu.
- Use the existing signed active-restaurant cookie path.
- Refresh restaurant-scoped cached data after switching.
- Show role and current restaurant clearly; handle revoked access gracefully.

**Acceptance:** Switching updates cellar, lists, insights, team, pours, and settings without leaking prior-restaurant data; refresh preserves the choice; inaccessible IDs are rejected server-side.
**Verification:** Role matrix unit tests and two-restaurant E2E.
**Dependencies:** `TER-010`, `TER-020`.

### TER-013: Complete restaurant profile and branding settings

**Outcome:** Owners can maintain the restaurant identity and public-list branding after onboarding.

**Scope:**

- Add settings for name, logo, pricing strategy, targets, and auto-86 behavior.
- Validate and resize logo uploads; define file type, size, and deletion behavior.
- Preview public-list branding before saving.
- Record who changed material pricing settings.

**Acceptance:** Owner changes persist and appear on public lists; manager capabilities follow the agreed matrix; staff cannot mutate settings; invalid uploads and values have inline errors.
**Verification:** API authorization tests, storage cleanup test, settings E2E, and public-list visual check.
**Dependencies:** `TER-010`, `TER-014`, `TER-020`, `TER-024`.
**Approval:** Storage retention policy is covered by `TER-024`.

### TER-014: Align interface behavior with the role model

**Outcome:** Owner, manager, and staff users see only actions they can successfully perform.

**Scope:**

- Create a single tested capability map shared by navigation, pages, and APIs.
- Record explicitly whether owner and manager may create, resend, revoke, and inspect invitations; the council default is that both roles may do so.
- Give staff read-only access to lists, cellar, and operational views where permitted.
- Remove edit affordances for read-only users instead of letting predictable 403s occur.
- Preserve server-side checks and RLS as the authority.

**Acceptance:** Every route and material action has an expected result for all three roles; UI and API decisions match; cross-restaurant access is denied; role changes take effect after session refresh.
**Verification:** Generated role matrix tests, RLS integration tests, and three-role browser pass.
**Dependencies:** `TER-010`, `TER-020`.

### TER-015: Deliver and manage real invitations

**Outcome:** An owner or manager can invite a teammate by email, resend safely, copy a link, revoke an invitation, and see its state.

**Scope:**

- Integrate one approved transactional email provider.
- Render accessible text and HTML invitation templates with restaurant, inviter, role, expiry, and safe destination.
- Make resend invalidate or supersede the old token instead of leaving multiple valid rows.
- Add pending, accepted, expired, failed, and revoked states plus retry behavior.
- Keep copy-link as an explicit fallback and audit invitation events.

**Acceptance:** Email reaches a provider sandbox inbox; only the newest valid token can be accepted; accepted invitations cannot be reused; wrong-account and expired paths explain recovery without leaking membership.
**Verification:** Provider sandbox test, route and database tests, and invite/accept E2E.
**Dependencies:** `TER-010`, `TER-014`, `TER-023`.
**Approval:** Provider selection, sender-domain configuration, and production secret require approval.

### TER-020: Reconcile and harden the API contract

**Outcome:** Documented APIs exist at their exact promised method/path pairs, and all handlers follow consistent validation, authorization, error, and abuse-control rules.

**Scope:**

- `TER-020Aa`: Generate the source-only API route inventory
- `TER-020Ab`: Reconcile all active API requirements without amendments
- `TER-020Ac`: Enforce route-inventory drift checks in CI
- `TER-020B`: Standardize Zod validation and error envelopes
- `TER-020C`: Centralize authentication, authorization, and tenant isolation
- `TER-020D`: Apply per-user rate limits and request idempotency
- `TER-020E`: Implement all missing promised compatibility handlers at their exact paths
- `TER-020F`: Generate final contract tests and reject unregistered routes

`TER-020E` owns all 15 currently missing promised method/path pairs, including reads and compatibility writes. Existing alternate-path handlers remain extensions and do not satisfy those active promises.

Each child is an independently mergeable leaf spec with its own acceptance subset and completion record. The parent closes only after all eight children pass the parent acceptance criteria.

**Acceptance:** No active route promise is missing; malformed input never reaches business logic; no raw internal error reaches clients; duplicate retry-safe requests do not duplicate business effects; tenant isolation tests cover every route family.
**Verification:** Route inventory check, contract tests, fuzzed invalid inputs, and authorization matrix.
**Dependencies:** `TER-001`.

### TER-021: Implement the background-job lifecycle and worker

**Outcome:** Expensive tasks have durable state and do not depend on one web request remaining open.

**Scope:**

- `TER-021A`: define and migrate `queued`, `running`, `succeeded`, `failed`, `retrying`, and `cancelled` transitions plus idempotency and result fields.
- `TER-021B`: implement transactional claiming, heartbeats, attempt limits, exponential backoff, timeout, restart recovery, and dead-letter visibility.
- `TER-021C`: deploy the separately observable worker and add queue health, structured logs, and alerts.
- `TER-021D`: add shared UI progress, failure, retry, and refresh recovery behavior.
- `TER-021E`: pilot PDF generation behind a rollback flag.
- `TER-021F`: migrate invoice OCR after the PDF pilot passes its soak and the pre-migration scanner baseline in `TER-022` is recorded.
- `TER-021G`: migrate wine enrichment after invoice OCR passes its soak.

Each child is an independently mergeable leaf spec with its own acceptance subset and completion record. The parent closes only after all seven children pass the parent acceptance criteria.

**Acceptance:** A killed worker resumes or safely retries; duplicate delivery does not duplicate output; poisoned jobs stop after the limit and are actionable; enqueue endpoints return a durable job reference within 2 seconds at staging p95 while 10 concurrent clients submit 50 jobs over 5 minutes.
**Verification:** State-machine unit tests, kill-and-restart integration drill, load test, and staging E2E for each migrated job type.
**Dependencies:** `TER-002`, `TER-003`, `TER-020`, `TER-023`.
**Approval:** New Railway worker service or paid queue infrastructure requires approval.
**Rollback:** Keep synchronous paths behind a short-lived rollback flag until each job type passes staging soak.

### TER-022: Establish scanner accuracy and provider resilience

**Outcome:** Invoice and bottle scanning have measurable quality, cost, latency, and failure behavior.

**Scope:**

- Version a consent-safe fixture corpus and expected structured outputs.
- Run and record the current deterministic baseline before changing prompts, providers, or scoring code.
- Record field-level precision or exact-match metrics for producer, cuvee, vintage, format, quantity, cost, and line association.
- Add thresholds for regression, latency, provider errors, and estimated cost.
- Test rotation, glare, blur, duplicates, partial pages, handwritten marks, and non-wine lines.
- Define fallback and manual correction when OCR, enrichment, or search providers fail.

**Acceptance:** A committed pre-change baseline exists. The proposed release floors are at least 98% exact match for quantity and cost, 95% for vintage, 90% for producer and cuvee, and 98% invoice-line recall, with zero unreviewed low-confidence commits; staging p95 is below 90 seconds for invoices and 30 seconds for bottles; provider failure rate is below 5% over a rolling minimum of 20 canaries; estimated provider cost stays at or below $0.25 per invoice and $0.05 per bottle. The product owner ratifies or revises these numeric floors after seeing the baseline and before paid optimization. CI can run a non-billed fixture test, and an approved scheduled canary evaluates real providers without exposing invoice data. Any ratified threshold breach blocks release.
**Verification:** Baseline artifact, scoring report, redacted canary run, and manual-correction E2E.
**Dependencies:** `TER-004`, `TER-020`.
**Approval:** Real-provider calls, any fixture derived from customer data, and final threshold ratification require approval.

### TER-023: Make configuration, health, and observability truthful

**Outcome:** Missing dependencies are detected before a workflow fails, and operators can distinguish web, database, storage, provider, email, and worker failures.

**Scope:**

- Make `.env.example` and startup validation cover every required and optional variable, including wine search.
- Add readiness checks for required internal services without calling billed providers on every request.
- Emit structured, redacted logs with request, restaurant, job, and provider correlation IDs.
- Add metrics for auth failures, scan latency and errors, jobs, invitation delivery, list generation, and reconciliation.
- Define alert thresholds and a short incident runbook.

**Acceptance:** A missing required variable fails deployment before traffic; optional integrations produce a clear degraded state; health output reveals no secrets or personal data; one forced staging failure produces an alert containing environment, severity, service, event name, first and last occurrence, count, request or job correlation ID, and runbook link, with no personal data or secret value.
**Verification:** Configuration schema tests, log redaction tests, staging failure drill, and dashboard screenshots.
**Dependencies:** `TER-001`, `TER-003`, `TER-020`.

### TER-024: Define data lifecycle and privacy controls

**Outcome:** Uploaded invoices, bottle images, exports, invitations, logs, and job payloads have explicit retention and deletion behavior.

**Scope:**

- Inventory personal, operational, and potentially sensitive data by table, bucket, log, artifact, and provider.
- Define retention defaults and deletion propagation.
- Ensure signed URLs are short-lived and object paths are tenant-scoped.
- Prevent raw image or invoice content from entering general logs.
- Add owner-initiated export and deletion behavior where the active specification requires it.

**Acceptance:** Every data class has an owner and retention rule; cross-tenant object access fails; deletion removes or tombstones all governed copies; provider retention is documented.
**Verification:** Storage policy tests, deletion integration test, redacted data map, and runbook review.
**Dependencies:** `TER-020`, `TER-021`, `TER-023`.
**Approval:** Destructive production retention jobs require explicit approval and a successful backup.

### TER-025: Complete cellar and inventory

**Outcome:** Every active cellar and inventory assertion from `TER-CF-064` through `TER-CF-090` is implemented and proven.

**Scope:**

- Complete the enumerated inventory views, search, filters, sorting, wine detail, quantities, costs, formats, adjustments, availability, metadata, notes, images, deletion, and CSV export.
- Complete the enumerated cellar-section configuration, ordering, assignment, low-stock, and drink-window presentation behavior.
- Preserve role and tenant boundaries from `TER-014` and `TER-020`.

**Acceptance:** Each mapped ledger assertion has direct implementation evidence and a positive and negative test without adding behavior beyond its exact source text.
**Verification:** Inventory unit and route tests, role and tenant tests, and isolated cellar browser coverage.
**Dependencies:** `TER-001`, `TER-004`, `TER-014`, `TER-020`.

### TER-026: Complete wine intelligence

**Outcome:** Every active wine-intelligence assertion from `TER-CF-091` through `TER-CF-101` is implemented and proven.

**Scope:**

- Complete the enumerated drink-window, serving-temperature, decant, override, visual-cue, enrichment, batching, fallback, and manual-field preservation behavior.
- Use the provider resilience and worker contracts established by `TER-021` and `TER-022`.

**Acceptance:** Each mapped ledger assertion has deterministic or fixture-backed evidence, and provider failure never overwrites a manual value.
**Verification:** Calculation, enrichment, fallback, and manual-override tests plus isolated wine-detail browser coverage.
**Dependencies:** `TER-020`, `TER-021`, `TER-022`, `TER-025`.

### TER-027: Complete price comparison and analytics

**Outcome:** Every active price-comparison and insights assertion from `TER-CF-165` through `TER-CF-179` is implemented and proven.

**Scope:**

- Complete the enumerated market-price comparison, follow-up flag, sorting, and threshold behaviors.
- Complete the enumerated inventory-value, pour, revenue, aging, scan, date-range, and CSV analytics behaviors.

**Acceptance:** Each mapped ledger assertion has direct query evidence, empty and permission-denied behavior, and responsive browser coverage without adding metrics beyond the exact source bullets.
**Verification:** Query and export tests, fixture-backed calculation tests, and isolated price-comparison and insights browser coverage.
**Dependencies:** `TER-020`, `TER-025`, `TER-026`.

### TER-028: Prove bottle scan to inventory

**Outcome:** Every active bottle-scanning assertion from `TER-CF-057` through `TER-CF-063` is implemented and proven.

**Scope:**

- Complete the enumerated QR capture, tenant-scoped lookup, match correction, location, inventory creation, rejection, and rapid-successive-scan behavior.
- Apply the scanner quality and data-lifecycle controls from `TER-022` and `TER-024`.

**Acceptance:** A valid bottle reaches the correct restaurant inventory; foreign and malformed codes create no write; correction and rapid-scan paths remain usable.
**Verification:** Decoder and route tests, tenant-isolation tests, and isolated mobile bottle-scan E2E.
**Dependencies:** `TER-004`, `TER-014`, `TER-020`, `TER-022`, `TER-024`.

### TER-030: Make “Add to menu” functional

**Outcome:** A recommendation in Insights can be added to a selected wine list without leaving the workflow.

**Scope:**

- Replace the disabled action in `briefing-alert-card.tsx` with a list and section picker.
- Resolve the recommendation to an existing wine or create a reviewed draft.
- Suggest price using existing pricing strategy while allowing an authorized edit.
- Prevent duplicate list entries and preserve source attribution.

**Acceptance:** Owner and manager can add a recommendation to a draft list, see immediate confirmation, undo it, and open the created entry; staff sees no mutation control; published lists are never silently altered.
**Verification:** Component tests, API authorization and duplicate tests, and insights-to-list E2E.
**Dependencies:** `TER-014`, `TER-020`.

### TER-031: Complete the staff briefing workflow

**Outcome:** Managers can turn insights into a concise daily briefing that staff can consume.

**Scope:**

- Add restaurant-scoped daily briefing records and ordered items.
- Let owner and manager add from an insight, add a note, reorder, remove, and archive.
- Give staff a read-only current briefing view.
- Provide print and copy-to-clipboard output with date and restaurant identity.

**Acceptance:** Add the currently absent “Add to staff briefing” action and make it functional for authorized roles; duplicates are handled; archived briefings remain readable; no notification or messaging claim appears in the UI.
**Verification:** Schema and RLS tests, component tests, role tests, and insight-to-briefing E2E.
**Dependencies:** `TER-014`, `TER-020`.

### TER-032: Implement safe voice commands

**Outcome:** The floating action button can accept voice or typed commands and complete a small, explicit set of high-value intents.

**Scope:**

- Replace “Coming in v2” in `fab.tsx` with browser capability detection.
- Support search wine, open scanner, start pour, mark 86 or restore, and navigate to a named area.
- Show transcript, parsed intent, restaurant, target wine, and consequences before any mutation.
- Require confirmation for mutations and provide a typed fallback on every browser.
- Do not retain audio; document whether transcript text is retained.

**Acceptance:** Supported intents have deterministic parser tests; unsupported or ambiguous speech never mutates data; denial of microphone permission leaves the typed path usable; mobile controls meet touch-target and screen-reader requirements.
**Verification:** Parser tests, mocked speech adapter tests, manual browser matrix, and mutation-confirmation E2E.
**Dependencies:** `TER-014`, `TER-020`, `TER-024`.
**Approval:** Stop before introducing any paid speech API or sending audio to a third party.

### TER-033: Add public multi-list navigation

**Outcome:** Guests can switch among a restaurant's published lists without knowing separate URLs.

**Scope:**

- Show a compact switcher only when the restaurant has more than one published list.
- Return published metadata only and preserve stable slugs and canonical URLs.
- Keep theme, accessibility, analytics, and caching behavior consistent across lists.

**Acceptance:** Draft and archived lists never appear; a switch updates content and metadata; direct links remain valid; one-list restaurants see no extra control.
**Verification:** Query and visibility tests, cache invalidation test, and public browser E2E.
**Dependencies:** `TER-020`, `TER-024`.

### TER-034: Add mobile-native sharing

**Outcome:** Staff can share a public list from a phone using the native share sheet, with reliable fallbacks.

**Scope:**

- Use `navigator.share` when supported and user-invoked.
- Fall back to copying the canonical public URL and expose existing QR and print options.
- Report cancel separately from error and never share a draft URL.

**Acceptance:** Native share receives restaurant, list title, and canonical URL; desktop and unsupported browsers copy successfully; draft lists require publish first.
**Verification:** Adapter unit tests and manual iOS, Android, and desktop browser checks.
**Dependencies:** `TER-033`.

### TER-035: Make public reading resilient to network failure

**Outcome:** The active offline-related promise is honest and the public list fails gracefully.

**Scope:**

- Amend the ledger to promise cached and ISR-backed public reading, not offline editing.
- Preserve last successfully rendered public content during transient origin failures where platform caching allows it.
- Show a last-updated timestamp, and display “Showing cached menu” with that timestamp whenever the browser detects a network failure.
- Do not introduce a service worker unless the product owner rejects the default.

**Acceptance:** A cached public list remains readable during a simulated transient origin failure; the failure simulation always produces the cached-content label and last-updated timestamp; no write action claims offline support.
**Verification:** Cache-header assertions, controlled staging outage test, and mobile browser review.
**Dependencies:** `TER-001`, `TER-003`.

### TER-040: Prove invoice scan to inventory

**Outcome:** A real user can upload an invoice, review extracted lines, correct them, commit once, and see inventory and cost effects.

**Acceptance:** Multi-page upload, low-confidence correction, unmatched line, duplicate commit, partial provider failure, and refresh/resume paths are covered; committed inventory and cost history match expected fixtures.
**Verification:** Isolated browser E2E plus database assertions and captured job evidence.
**Dependencies:** `TER-004`, `TER-020`, `TER-021`, `TER-022`.

### TER-041: Prove pour and reconciliation

**Outcome:** The existing pour test becomes a reliable release gate.

**Acceptance:** Open bottle, multiple pours, depletion, auto-86 transition, count reconciliation, variance, audit record, and reversal or correction paths pass without a CI skip or shared state.
**Verification:** Isolated browser E2E and database audit assertions.
**Dependencies:** `TER-004`, `TER-014`, `TER-020`.

### TER-042: Prove list authoring, publication, and export

**Outcome:** A manager can take cellar wine through list editing to guest consumption and export.

**Acceptance:** Create list, organize sections, add wine, set price, preview, publish, view public page, switch lists, share, generate PDF, export CSV, unpublish, and cache invalidation all pass; staff remains read-only.
**Verification:** Isolated browser E2E, PDF text and visual assertions, CSV schema assertion, and public unauthenticated check.
**Dependencies:** `TER-004`, `TER-014`, `TER-021`, `TER-033`, `TER-034`.

### TER-043: Prove invitation and role lifecycle

**Outcome:** Team membership works from invitation delivery through revocation.

**Acceptance:** Invite, resend, accept, expired link, reused link, wrong account, role change, access refresh, member removal, and cross-restaurant denial pass with provider sandbox evidence.
**Verification:** Isolated browser E2E, provider sandbox record, and RLS assertions.
**Dependencies:** `TER-004`, `TER-014`, `TER-015`.

### TER-044: Complete accessibility, responsive, and failure-state QA

**Outcome:** Core workflows are usable at restaurant operating sizes and with assistive technology.

**Scope:**

- Test at 390, 768, and 1280 CSS pixels.
- Define core pages as login, onboarding, dashboard, invoice scan and review, bottle scan, cellar, open bottles and reconciliation, wine search and detail, list editor, public list, team, insights, and restaurant settings. Define core flows as the seven E2E workflows in the definition of done plus restaurant switching, insight-to-menu, staff briefing, and voice-command confirmation.
- Cover keyboard operation, focus order, dialogs, form errors, live status, contrast, screen-reader names, reduced motion, and 44-pixel touch targets.
- Review loading, empty, partial, permission-denied, provider-down, retry, and success states.

**Acceptance:** Axe-core against WCAG 2.2 AA reports zero serious or critical violations on every core page; every core flow completes by keyboard; mobile controls do not overlap or clip; each external-provider feature has a recovery state.
**Verification:** Versioned axe-core report, screenshot matrix, keyboard checklist, and device smoke pass.
**Dependencies:** `TER-025` through `TER-043` as applicable.

### TER-045: Restore documentation truth and maintainability

**Outcome:** A new maintainer can operate the deployed system without following stale paths or implied components.

**Scope:**

- Update README, architecture, staging, backup, auth, worker, data-lifecycle, and release documents.
- Remove or replace stale `.council` references.
- Document the 65-route API inventory and the feature ledger workflow.
- Split oversized files only where feature work touched them; extracted modules must have a single declared responsibility and direct tests for moved behavior.

**Acceptance:** Every runbook command is rehearsed in its stated environment; no doc claims missing staging, missing worker, or obsolete auth behavior; source links resolve; every extracted module has a single responsibility stated in its module comment and a direct regression test.
**Verification:** Link and command check, operator walkthrough, and no-behavior-change regression tests for refactors.
**Dependencies:** All implementation specs whose behavior is documented.

### TER-046: Run the final release candidate and close the ledger

**Outcome:** One immutable commit is proven in staging, promoted to production, and recorded as the completed application baseline.

**Scope:**

- Freeze the candidate and run every required gate from a clean checkout.
- Restore the latest backup into a disposable target before any schema promotion.
- Deploy to staging, run all workflows, and soak continuously for at least 24 hours.
- During the soak, run public-list and authenticated read canaries every 15 minutes, one create-and-clean-up pour and draft-list flow every hour, and one scanner fixture canary every four hours.
- Promote the same artifact to production and run non-destructive canaries.
- Close every active requirement with evidence and publish known limitations.

**Acceptance:** All required checks pass on the promoted SHA; no active requirement lacks evidence; production auth, public list, health, queue, and key read paths pass; rollback target is recorded; during the 24-hour observation window, HTTP 5xx stays below 1%, synthetic auth and public-list success stay at or above 99%, background-job success stays at or above 95% with queue age below 5 minutes, public-list p95 response time stays below 2 seconds, and no unresolved severity-1 or severity-2 event is opened. Low-volume metrics must be supported by the scheduled synthetic canaries.
**Verification:** Release manifest with commit, artifact, migrations, checks, staging report, production canary, and rollback reference.
**Dependencies:** `TER-002` through `TER-045`.
**Approval:** Production schema changes, deployment, data writes, and rollback require explicit approval at the release boundary.

## 7. Autonomous execution contract

### 7.1 Unit of work

- One primary leaf spec ID per branch and pull request.
- A parent spec expected to exceed 400 changed production lines must define ordered leaf specs before implementation begins. Each leaf needs its own bounded scope, acceptance subset, dependencies, tests, rollback, and completion record. Parent status remains `in_progress` until every leaf is complete.
- Target no more than 400 changed production lines per leaf, excluding generated files, migrations, tests, and fixtures. Split a leaf again before implementation when that limit would hide multiple risks.
- Branch naming: `feat/ter-NNNx-short-name`, `fix/ter-NNNx-short-name`, or `ops/ter-NNNx-short-name`, where the optional lowercase suffix identifies a leaf.
- Conventional commit messages with the spec ID in the body.
- Never mix existing untracked user files into a commit.

### 7.2 Required loop for each spec

1. Read the feature ledger, this specification, applicable `AGENTS.md`, current source, and current framework documentation.
2. Reproduce the missing behavior or add a failing test first where practical.
3. Write a short change contract: touched surfaces, invariants, data effects, and rollback.
4. Implement the smallest complete vertical slice.
5. Run targeted tests, then lint, type check, all tests, and production build.
6. Run relevant isolated E2E and role or tenant checks.
7. Review the diff for secrets, unrelated files, stale labels, error states, accessibility, and migrations.
8. Deploy to staging when runtime behavior changes and attach evidence.
9. Update the ledger and documentation in the same pull request.
10. Request approval only at a listed boundary; otherwise continue to the next ready spec after merge.

### 7.3 Completion record for every spec

```yaml
spec_id: TER-NNN-or-TER-NNNX
parent_spec: none-or-TER-NNN
commit: full-sha
status: in_progress | complete | blocked | rolled_back
requirements_closed: []
tests:
  targeted: command-and-result
  full: command-and-result
  e2e: command-and-result
staging:
  url: redacted-if-needed
  result: pass-or-not-applicable
data_change:
  migration: none-or-path
  backup_verified: true-or-not-applicable
security:
  tenant_check: pass
  secret_scan: pass
evidence: []
known_limits: []
rollback: description
```

### 7.4 Mandatory stop conditions

The autonomous runner must stop and report the exact blocker when:

- a required secret, external account, paid service, new infrastructure, or admin setting is missing;
- a task needs unapproved production data access, schema mutation, deployment, or destructive operation;
- the latest backup is unhealthy before a schema change;
- normal authentication regresses or the only path forward would restore the disclosed bypass;
- product behavior is materially ambiguous and no council default covers it;
- a migration cannot be proven against a disposable restore;
- a test fails twice for nondeterministic reasons and the cause is not understood;
- a ratified quality threshold remains unmet after three bounded improvement experiments, or meeting it would exceed an approved provider-cost ceiling;
- the worktree contains overlapping user changes that cannot be preserved;
- the requested slice would conceal a larger security, privacy, or tenant-isolation change.

### 7.5 Gates by change type

| Change | Additional required evidence |
| --- | --- |
| Authentication or authorization | Negative tests, redirect audit, role matrix, staging real-provider pass |
| Database migration | Current backup, disposable migration and rollback rehearsal, RLS tests |
| External provider | Sandbox or staging canary, timeout and retry test, cost and retention note |
| Worker or queue | Duplicate-delivery test, kill/restart drill, dead-letter evidence |
| Public page | Anonymous browser test, cache behavior, accessibility, mobile screenshot |
| PDF or export | Content assertion, visual sample, authorization and expiration check |
| Production configuration | Redacted inventory before and after, no values in logs or command arguments |

## 8. Excluded work

The following are not separate rebuild projects because their core implementation already exists. They remain subject to regression and E2E proof:

- cellar CRUD, stock adjustments, bulk import, and count workflows;
- bottle and invoice scan review interfaces;
- pours, open-bottle tracking, auto-86, and reconciliation foundations;
- wine search, intelligence, notes, pricing comparison, and insight foundations;
- wine-list editor, public slug route, QR, print, PDF, and CSV foundations;
- signed active-restaurant selection on the server;
- role checks and RLS foundations;
- health route, error tracking hooks, analytics events, and job-table migration;
- the current 419-test regression suite.

These areas should change only when a numbered completion spec requires it. Passing current tests is evidence to preserve, not evidence that the remaining workflow is done.

## 9. Main failure modes and controls

1. **Completion theater:** Counting files or old diary entries as completed features. Control: `TER-001` ledger with evidence-bearing statuses.
2. **Mock-only confidence:** Browser tests pass against mocks while real auth, email, OCR, storage, or PDF fails. Control: provider sandbox plus staging canaries.
3. **Unsafe autonomous data work:** A migration or cleanup reaches production without a restorable backup. Control: `TER-002`, disposable drills, and hard stop conditions.
4. **Tenant or role drift:** Interface changes appear correct while API or RLS allows cross-restaurant access. Control: generated role and tenant matrix on every sensitive route.
5. **Environment drift:** Local and CI pass while Railway or Supabase settings differ. Control: staging, redacted configuration checks, and same-artifact promotion.
6. **Queue duplication:** Retried OCR, PDF, or enrichment jobs duplicate inventory or artifacts. Control: idempotency keys, claim locks, and duplicate-delivery tests.
7. **UI honesty regression:** New disabled controls or promises appear without implementation. Control: label audit in CI and release review.
8. **Unbounded scope:** Large refactors obscure user outcomes and consume the autonomous run. Control: one spec per pull request and opportunistic splitting only.

## 10. First executable tranche

The first tranche should run in this exact order:

1. `TER-000`: rotate and constrain the bypass, then require current green checks on `main`.
2. `TER-001`: produce the 269-item ledger and obtain approval for the budget and classifications.
3. `TER-002`: repair scheduled backups and complete a disposable restore.
4. `TER-003`: create isolated staging and validate auth redirects there.
5. `TER-004`: establish isolated authenticated E2E fixtures.
6. `TER-006`: inventory visible controls and install the placeholder and dead-link gate.
7. `TER-005`: upgrade branch protection to the complete release gate.
8. `TER-020`: reconcile the API contract needed by all later interface work.
9. `TER-023`: install the configuration and observability foundation needed by auth and email.
10. `TER-010`: repair full authentication.
11. `TER-011`: remove and revoke the temporary bypass.

No broad feature implementation should precede these items. They convert the current healthy codebase into a safe platform for the remaining autonomous work.

## 11. Final verification checklist

- [ ] Feature ledger accounts for all active, amended, duplicate, and retired requirements.
- [ ] Visible-control inventory and placeholder gate pass.
- [ ] No unexplained disabled, placeholder, or coming-soon control remains.
- [ ] Auth bypass is removed and revoked.
- [ ] Backups and disposable restoration are green.
- [ ] Staging and protected promotion are active.
- [ ] All seven critical product workflows pass isolated E2E.
- [ ] Owner, manager, and staff role matrix passes at UI, API, and RLS layers.
- [ ] Scanner baseline meets thresholds.
- [ ] Worker restart and duplicate-delivery drills pass.
- [ ] Mobile and accessibility matrix passes.
- [ ] Docs and environment inventory match production.
- [ ] Release manifest points to the exact production commit and rollback target.
