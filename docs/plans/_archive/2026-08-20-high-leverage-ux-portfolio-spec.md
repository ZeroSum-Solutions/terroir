# Terroir High-Leverage UX Portfolio

Status: approved for implementation

Prepared: 2026-08-20

Repository baseline: `97848c5` on `feat/ux-high-leverage`

Design source of truth: [`DESIGN.md`](../../DESIGN.md)

Plan auditor: Grok 4.6 (`x-ai/grok-4.6`)

## 1. Objective

Remove the ten most consequential sources of operator confusion, lost work, and inaccessible interaction without redesigning Terroir or expanding its product surface. The portfolio favors correctness and trust in core restaurant workflows over speculative features.

The intended result is that:

1. cellar variance language never contradicts the recorded count;
2. operators can tell loading, failure, and genuine emptiness apart;
3. a long-running scan explains its stage and can be cancelled safely;
4. a wine list remains operable at a 390px viewport;
5. destructive actions use one predictable, accessible confirmation pattern;
6. team members and pending invitations are recognizable and understandable;
7. frequent floor forms keep invalid drafts and expose accessible errors;
8. insight dates and metrics describe the same period truthfully;
9. guests can interpret and share the public menu without insider knowledge;
10. the app shell always names the current restaurant and role.

## 2. Evidence and prioritization

The portfolio combines four evidence sources:

- route and component inspection across the authenticated and public journeys;
- a focused accessibility and interaction-quality audit;
- the product requirements, feature ledger, and recently shipped opportunity work;
- a Grok 4.6 portfolio audit that removed high-cost platform work and retained the tightest user-facing fixes.

The selection is deliberately bounded. It does not infer customer research that is absent from the repository. It ranks source-proven failure modes by severity, journey reach, implementation confidence, and dependency value.

## 3. Users and critical jobs

| User | Critical jobs protected by this portfolio |
| --- | --- |
| Owner or buyer | Understand inventory truth, review insights, manage team access, publish a credible guest menu |
| Manager or wine director | Scan intake, correct results, reconcile stock, manage pricing and lists |
| Floor staff | Record pours and 86s quickly, understand current context, recover from invalid entries |
| Guest | Read prices and availability, understand freshness, share the menu |

The implementation must describe existing role capabilities. It must not broaden or narrow authorization rules.

## 4. Design and interaction constraints

- Preserve the approved light editorial hospitality identity in `DESIGN.md`: white canvas, plaster beige, powder blue, sage, burgundy, Cormorant Garamond, and Inter.
- Reuse existing tokens and dependencies. Do not introduce a component library or other heavy dependency.
- Treat 390px as the minimum supported mobile review width.
- Interactive controls in the selected workflows must provide at least a 44px target.
- Every icon-only control must have an accessible name.
- Loading, error, and empty states must be visually and semantically distinct.
- Errors must preserve user-entered drafts whenever retry is possible.
- User-facing copy must describe the task, not an implementation provider or model.
- No production credential, provider configuration, schema expansion, or permission expansion is authorized by this portfolio.

## 5. The ten moves

### UX-01 — Reconciliation Truth

**Problem:** The current variance is calculated as actual minus expected, while positive and negative messages describe the opposite condition.

**Outcome:** Every reconciliation count communicates the same over, under, or exact result in its number, sign, label, and color.

**Required scope:**

- centralize or otherwise make the `actual - expected` interpretation explicit;
- correct positive, negative, exact, and zero-expected copy;
- keep sign and semantic color paired with the corrected meaning;
- add focused tests for over, under, exact, and zero expected.

**Out of scope:** changing reconciliation persistence, inventory arithmetic, thresholds, or permissions.

**Acceptance:** A positive variance cannot be described as fewer than expected, a negative variance cannot be described as more than expected, and the four boundary cases are regression-tested.

### UX-02 — Honest Data States

**Problem:** Several high-value routes convert database failures into a genuine-empty presentation.

**Outcome:** Operators can distinguish a request in progress, a failed request, and an empty result, then retry locally without losing the app shell.

**Required scope:**

- provide one small local Loading/Error/Empty presentation family;
- apply it to Lists, Open Bottles, Reconciliation History, Pricing, and Team;
- provide a route-local or local retry on each error state;
- expose Open Bottles from the Cellar workflow.

**Out of scope:** global query libraries, offline mode, background synchronization, or every route in the application.

**Acceptance:** A forced query failure on each named surface renders an error with a usable retry and never renders the corresponding empty-state message.

### UX-03 — Cancellable Scan Trust

**Problem:** Invoice processing can hold the operator for up to 90 seconds without semantic progress or a visible cancel action, and it exposes provider terminology.

**Outcome:** The scan explains what is happening, supports cancellation, and offers a credible recovery path.

**Required scope:**

- use named upload, extraction, and review stages;
- expose progress with progress semantics and announced stage changes;
- show Cancel while work is active and wire it to the existing `AbortController`;
- retain retry and manual recovery;
- remove the model name from user-facing copy;
- give error feedback the correct icon and live-region role;
- expose bottle scanning from the Scan surface.

**Out of scope:** background jobs, OCR-provider changes, persistence changes, or a scanner redesign.

**Acceptance:** Cancelling aborts the active request and returns to a stable recoverable state; stage changes are programmatically exposed; no provider/model name appears.

### UX-04 — Mobile List Editor Survival

**Problem:** At 390px the list-editor action rail overflows, core section operations disappear, and a zero-section list can become a dead end.

**Outcome:** A manager can recover and perform the essential list-editing actions from a phone.

**Required scope:**

- make the action area wrap or scroll intentionally with labeled, 44px controls;
- expose section add, rename, and delete on mobile;
- expose the existing template picker on mobile;
- show a zero-section recovery action;
- fix the unauthenticated return path from `/wine-list/:id` to `/lists/:id`.

**Out of scope:** keyboard reordering, a new template system, list collaboration, or a complete editor redesign.

**Acceptance:** The named actions remain reachable at 390px without document-level horizontal overflow, and a list with zero sections has a clear recovery action.

### UX-05 — Action Safety Dialogs

**Problem:** Confirmation behavior varies among native confirms, partial overlays, timers, and dialogs with incomplete focus handling.

**Outcome:** Selected destructive actions use one predictable and accessible confirmation contract.

**Required scope:**

- add one dependency-free local dialog or mobile bottom-sheet primitive;
- implement `role="dialog"`, `aria-modal`, labelled title and description, Escape handling, focus containment, scroll lock, and focus restoration;
- define immediate, undo, and confirm tiers in code or tests;
- migrate only: 86, list delete, section delete, unpublish, member revoke/remove, and scan discard.

**Out of scope:** migrating every modal, adding a UI framework, or changing server-side deletion behavior.

**Acceptance:** Each named irreversible action requires a named confirmation, keyboard focus cannot leave the open dialog, Escape closes it when safe, and focus returns to the trigger.

### UX-06 — Team Clarity

**Problem:** Team rows can show truncated UUIDs, compress poorly on phones, and describe staff permissions inaccurately.

**Outcome:** Owners can recognize people and understand the difference between active membership and pending access.

**Required scope:**

- show a recognizable name and email instead of a UUID;
- provide 390px member and invitation cards;
- label the groups Members and Pending;
- keep copy-link and revoke actions for pending invitations;
- make role descriptions match currently implemented permissions.

**Out of scope:** transactional email, a new RBAC platform, permission changes, profile editing, or a new invitation backend.

**Acceptance:** No member identity is presented as a truncated UUID; the two lifecycle states are distinct; role copy is backed by current authorization behavior.

### UX-07 — Floor Forms and Targets

**Problem:** Frequent operational forms contain unlabeled or undersized controls and can silently discard invalid edits.

**Outcome:** Invoice correction, pour, and 86 flows are usable by touch and assistive technology without losing an invalid draft.

**Required scope:**

- add small local Field and icon-button helpers;
- migrate only invoice correction, pour, and 86 controls;
- connect labels, descriptions, errors, `aria-invalid`, and `aria-describedby`;
- preserve invalid drafts until the operator corrects or cancels them;
- enforce at least a 44px target for migrated controls.

**Out of scope:** a site-wide form framework, all application inputs, or new validation rules.

**Acceptance:** The named fields have programmatic labels and linked errors, invalid input remains editable, and migrated targets meet the 44px floor.

### UX-08 — Truthful Insights

**Problem:** The custom date range is implemented but unreachable, and distributor spend and scan counts do not consistently describe the same interval.

**Outcome:** Every selected insight says whether it is a current snapshot or range-filtered metric, and paired metrics use the same range.

**Required scope:**

- render the existing custom-range option;
- align distributor spend and scan-count filtering;
- label relevant cards or sections as snapshot or selected range;
- remove the disabled Add to menu and Add to staff briefing actions.

**Out of scope:** building those action loops, new analytics, new charting, or changing the date-range model.

**Acceptance:** Custom is selectable, paired distributor values derive from the same interval, and no disabled/dead insight action remains.

### UX-09 — Guest Menu Clarity

**Problem:** Public menu prices rely on insider knowledge, sharing is manual, and freshness is unclear.

**Outcome:** A guest can understand, share, and assess the currency of a menu from a phone.

**Required scope:**

- label glass and bottle prices;
- add Web Share with a clipboard fallback;
- show a last-updated value;
- retain and clarify availability messaging already supported by the data;
- reserve logo dimensions or use an appropriate image treatment to prevent layout shift.

**Out of scope:** a menu switcher unless the existing route already receives multiple published lists naturally, guest accounts, or new public data.

**Acceptance:** Single and dual prices remain unambiguous, sharing succeeds through native share or clipboard fallback, and the header does not shift when the logo loads.

### UX-10 — Restaurant and Role Context

**Problem:** The persistent shell does not clearly name the current restaurant and role, while the mobile action menu advertises an unavailable Voice action.

**Outcome:** Operators always know the context in which they are acting, and the shell contains no dead action.

**Required scope:**

- render the current restaurant name and current role persistently in the authenticated shell;
- preserve the existing four primary navigation destinations;
- remove the Voice stub and its promise.

**Out of scope:** a restaurant switcher, multi-tenant onboarding, speech support, permission changes, or a new navigation system.

**Acceptance:** Restaurant and role are visible at desktop and 390px without obscuring navigation, and no Voice action or coming-soon copy remains.

## 6. Dependency and delivery order

The portfolio IDs remain stable, but implementation follows dependency order:

1. UX-01 Reconciliation Truth
2. UX-02 Honest Data States
3. UX-03 Cancellable Scan Trust
4. UX-05 Action Safety Dialogs
5. UX-04 Mobile List Editor Survival
6. UX-07 Floor Forms and Targets
7. UX-06 Team Clarity
8. UX-08 Truthful Insights
9. UX-09 Guest Menu Clarity
10. UX-10 Restaurant and Role Context

UX-05 precedes UX-04, UX-06, and UX-07 so their selected destructive controls can reuse the audited primitive. Other moves remain independently reviewable.

## 7. Execution and evidence contract

Each move must:

1. begin with a focused test that fails for the intended reason;
2. make the smallest production change that passes the focused test;
3. run affected tests, type checking, lint, and `git diff --check`;
4. receive an independent task-scope review;
5. receive a Grok 4.6 audit of the implementation diff against its plan;
6. resolve all blocking and important audit findings and re-audit as needed;
7. create one conventional commit containing that move and its tests only.

The branch must also pass the full repository verification suite after all ten commits. Authentication-dependent browser tests must use isolated or mocked data and must not mutate the shared production database.

## 8. Portfolio completion criteria

The portfolio is complete only when:

- all ten plan documents have an approving Grok 4.6 audit;
- all ten moves satisfy their acceptance criteria and have one isolated commit each;
- every move has a clean pre-commit Grok 4.6 implementation audit;
- the final full test, type, lint, build, documentation, and diff checks pass;
- responsive and keyboard checks cover the changed interactive surfaces;
- the feature branch is pushed, reviewed, merged to `main`, and required GitHub checks pass;
- local `main` matches the merged remote commit and the temporary branch/worktree are removed cleanly.

## 9. Audit history

The initial Grok 4.6 portfolio audit returned **REVISE** because the candidate list mixed focused UX repair with larger platform initiatives. The portfolio above incorporates the audit by:

- removing new email delivery, RBAC, background-job, multi-tenant switcher, and voice work;
- turning disabled Insights actions into removal rather than speculative implementation;
- limiting the dialog, form, data-state, and touch-target work to named surfaces;
- carrying the list-editor auth return fix inside UX-04;
- carrying discoverability links inside UX-02 and UX-03;
- sequencing the shared action-safety primitive before dependent surface work.

The ten implementation plans require separate Grok 4.6 approval before code execution.
