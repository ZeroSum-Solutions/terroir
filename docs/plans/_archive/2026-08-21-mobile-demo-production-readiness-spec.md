# Terroir Mobile Demo Production Readiness

Status: approved for autonomous execution

Prepared: 2026-08-21

Repository baseline: `b473093c16f715e76abb5297abbbe352274851d1` on `main`

Design source of truth: [`DESIGN.md`](../../DESIGN.md)

## Objective

Prove and, only where evidence requires it, finish the existing Terroir mobile-web experience for tomorrow's demonstration. Preserve the reviewed work merged in PR #78, keep authentication and authorization intact, use the existing Railway and Supabase production path, and do not expand the product into a native app or a new PWA.

## Demo-critical journeys

The readiness pass covers the current product's advertised mobile-web surface:

1. authentication entry, protected-route redirect, session continuity, logout, and any recovery affordance the product currently advertises;
2. authenticated shell and primary navigation;
3. invoice and bottle scan entry, cellar and open-bottle operations, reconciliation, pricing, wine-list editing, team management, and insights;
4. public wine-menu reading, price and availability interpretation, and sharing;
5. loading, empty, validation, error, cancellation, confirmation, and retry states reached by those journeys.

Production data may be observed through approved flows but must not be destructively mutated for verification. Configured test accounts and credentials may be used only through the approved credential workflow and must never appear in logs or evidence.

## Success criteria

### MDR-01 — Preserved baseline and isolation

- All work is performed on an isolated feature branch/worktree based exactly on the merged PR #78 commit.
- No reviewed PR #78 behavior is reverted, and unrelated user work is not discarded.

### MDR-02 — Deterministic repository gate

- Fresh installs or the existing lockfile-respecting install completes.
- Feature-ledger, API-contract, product-conformance, typecheck, lint, unit/route tests, contract tests, schema drift, generated-type drift, down-migration, local-seed dry-run, end-to-end, and production-build gates all exit zero.
- No required check is counted as passing when skipped.

### MDR-03 — Mobile interaction quality

- The demo-critical journeys are checked in the Codex in-app browser at 390x844 and 430x932 viewports.
- They have no document-level horizontal overflow, obscured primary navigation, clipped essential action, or material layout shift.
- Essential interactive controls provide at least a 44px touch target or an equivalent 44px hit area; forms retain accessible labels and linked errors; keyboard focus remains visible and usable.
- Loading, empty, validation, error, cancellation, confirmation, and retry states are distinguishable where applicable.
- No material uncaught console error, failed first-party request, or broken asset is present in the verified journeys.

### MDR-04 — Authentication and session readiness

- An unauthenticated visit to a protected route fails closed and reaches the authentication entry flow without an open redirect.
- The current product-supported sign-in method is usable at both mobile viewports with clear validation and error feedback.
- A configured test account can establish a session, a page refresh preserves it, and logout clears it and prevents immediate protected-route reuse.
- Any recovery affordance currently advertised by the product works; if none is advertised, the audit records that fact with source and live-page evidence rather than inventing a new recovery feature.
- Authentication secrets, service-role credentials, and session tokens do not appear in client-visible output or captured evidence.

### MDR-05 — Advertised feature readiness

- Every advertised in-scope feature has either a verified live demo entry point or a deterministic automated proof tied to its route or workflow.
- The demonstration path does not expose dead navigation, placeholder actions, or claims for unavailable functionality.
- Public menu entry remains accessible without authentication and does not disclose protected restaurant data.

### MDR-06 — Production hosting and deployment

- Required Railway and Supabase configuration names are present through approved provider/config inspection without printing values.
- The exact commit merged to `main` is the commit deployed by the established production service.
- The production health endpoint, authentication entry flow, protected-route behavior, and public-menu entry point pass fresh smoke checks after deployment.
- Provider logs for the smoke window contain no material startup, authentication, or request failures.

### MDR-07 — Published production-readiness loop

- The live `/loop-library` catalog is queried after implementation is green.
- The exact published loop that best fits production readiness is recorded by its catalog title and source, adapted to these criteria, and executed against the current Terroir branch.
- Material findings are remediated and the loop stops only on verified success or its explicit blocked/no-progress condition.

#### Selected loop and Terroir adaptation

Live catalog checked: 2026-08-21 via the published Forward Future catalog at
`https://signals.forwardfuture.com/loop-library/catalog.json`.

Selected exact catalog entry: **The stale-safe batch release loop** (`013`,
`stale-safe-batch-release-loop`). The catalog says to use it when several branches
or pull requests may be ready and the release must avoid stale worktrees, partial
overlays, and incomplete changes. Its success condition is that the released
revision is the latest integrated `main` containing every selected change.

For Terroir, execute it as follows:

1. inventory current local and remote branches, worktrees, pull requests, checks,
   dependencies, and ownership before selecting the release batch;
2. exclude and record stale, superseded, conflicting, unrelated, or unfinished
   candidates while preserving user work;
3. integrate only the reviewed mobile-demo readiness branch, rerun the complete
   combined gate, and select the newest `main` revision containing the batch;
4. deploy a complete artifact from that exact integrated `main` revision through
   Railway, serialize deployment, then verify the production health, auth entry,
   protected-route, public-menu, and mobile journeys before closing the batch.

The loop stops only when production proves the exact integrated commit, or at an
explicit approval, credential, provider, branch-protection, or no-progress
blocker. Deployment from this task worktree or a partial file overlay is forbidden.

### MDR-08 — Independent review

- A different agent independently verifies every criterion from this document against current artifacts and returns `VERDICT: PASS` only when every row passes.
- Code, mobile visual, and security review cover the actual final diff and the authentication/deployment evidence.
- Every blocker, high-severity, and material correctness or visual finding is fixed and rechecked before release.

### MDR-09 — Release and repository hygiene

- Intended changes use conventional commits, are pushed, reviewed, and merged through the repository's established GitHub workflow without rewriting history or force-pushing.
- Required post-merge GitHub checks pass on the merge commit.
- Local `main` and `origin/main` resolve to that same commit.
- Only clean, merged, no-longer-needed Terroir feature worktrees and branches are removed; the final worktree list and statuses are clean.
- The exact merged commit is deployed and passes the production mobile smoke checks.

## Execution constraints

- Audit before changing code. If no product defect is proven, do not create a speculative fix.
- For every feature or bug fix, write a focused failing test first, confirm the failure is for the intended reason, implement the smallest fix, and confirm the focused test passes before broader gates.
- Preserve server-side authorization and tenant boundaries. Do not weaken authentication, print credentials, use production service-role keys in previews, or bypass human login, CAPTCHA, MFA, OAuth, or administrator approval.
- Reuse the existing stack, dependencies, design tokens, deployment provider, and project conventions. No new heavy UI dependency, native app, or PWA expansion is in scope.
- Stop with the exact blocker and smallest user action if a human-only approval, unavailable credential, provider outage, protected-branch rule, or unresolved product decision prevents proof.
