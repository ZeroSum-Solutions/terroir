# Honest Data States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ensure Lists, Open Bottles, Reconciliation History, Distributor Pricing, and Team distinguish loading, query failure, and genuine emptiness, with a segment-local retry for every failure.

**Architecture:** Keep data fetching in the existing Server Components. Throw named Supabase query errors before any `?? []` fallback so Next.js segment error boundaries can handle failures without replacing the authenticated shell. A small local route-data-state family supplies consistent loading, error, and empty semantics; each named segment owns its copy and Next 16 `unstable_retry` boundary. Scope the Lists and Team landing-page boundaries inside URL-transparent `(index)` route groups so a landing failure cannot replace `/lists/[id]` or any later Team child route. Add one persistent Open Bottles link to the existing Cellar bridge band.

**Tech Stack:** TypeScript, React 19, Next.js 16 App Router (`loading.tsx`, `error.tsx`, `unstable_retry`), Vitest/happy-dom, Tailwind v4, Lucide.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](./2026-08-20-high-leverage-ux-portfolio-spec.md), UX-02.

## Global Constraints

- Named surfaces only: Lists, Open Bottles, Reconciliation History, Distributor Pricing, and Team.
- Errors must never fall through to the corresponding empty-state message.
- Retry must re-fetch the failed segment and preserve the authenticated app shell.
- Preserve existing queries, authorization, sorting, and successful-result presentation.
- Reuse existing tokens and dependencies; add no global query library, offline mode, background synchronization, schema, or permission change.
- Treat 390px as the minimum review width, use at least 44px retry/link targets, and give every loading/error state programmatic semantics.
- Begin with focused failing tests, obtain independent task review, and obtain a clean Grok 4.6 audit before the single final commit.

---

### Task 1: Establish the small route-data-state family

**Files:**

- Create: `src/components/route-data-state.tsx`
- Create: `src/components/route-data-state.test.tsx`

**Interfaces:**

- Produces:

```ts
export function RouteDataLoading(props: {
  label: string;
  children?: React.ReactNode;
}): React.ReactNode;

export function RouteDataError(props: {
  title: string;
  description: string;
  onRetry: () => void;
}): React.ReactNode;

export function RouteDataEmpty(props: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}): React.ReactNode;
```

- `RouteDataLoading` provides `role="status"`, `aria-live="polite"`, `aria-busy="true"`, and a visible or screen-reader label while allowing route-specific skeleton children.
- `RouteDataError` provides `role="alert"`, stable title/description, and a minimum-44px “Try again” button.
- `RouteDataEmpty` is not an alert; it presents a labelled empty panel and optional action without live-region urgency.

- [ ] **Step 1: Read the checked-in Next 16 conventions**

Run:

```bash
sed -n '1,210p' node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md
sed -n '1,180p' node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md
sed -n '1,180p' node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route-groups.md
```

Expected: confirm `error.tsx` must be a Client Component, transient server failures should call `unstable_retry()` rather than legacy `reset()`, and a parenthesized route group does not change the URL. There must be only one page resolving to each landing URL.

- [ ] **Step 2: Write failing semantic and retry tests**

Using happy-dom plus `createRoot`/`act`, assert that loading exposes `role=status` and `aria-busy=true`, error exposes `role=alert`, clicking “Try again” calls its callback once, the button height class is at least `h-11`, and empty content has neither `role=alert` nor loading copy.

- [ ] **Step 3: Run the focused test and verify RED**

```bash
pnpm exec vitest run src/components/route-data-state.test.tsx
```

Expected: FAIL because the component family does not exist.

- [ ] **Step 4: Implement the minimal family and verify GREEN**

Mark the family module `"use client"` because `RouteDataError` owns an `onClick` callback. Server `loading.tsx` files may render this small Client Component without becoming Client Components themselves. Use existing `rounded-card`, `border-hairline`, `bridge-surface`, `blush-wash`, `primary`, `ink`, and `grey` tokens. Keep the family presentational; it must not import Next navigation or own query state.

```bash
pnpm exec vitest run src/components/route-data-state.test.tsx
```

Expected: PASS.

### Task 2: Add segment-local loading and error boundaries

**Files:**

- Move: `src/app/(app)/lists/loading.tsx` -> `src/app/(app)/lists/(index)/loading.tsx`
- Create: `src/app/(app)/lists/(index)/error.tsx`
- Create: `src/app/(app)/cellar/open/loading.tsx`
- Create: `src/app/(app)/cellar/open/error.tsx`
- Create: `src/app/(app)/cellar/reconcile/history/loading.tsx`
- Create: `src/app/(app)/cellar/reconcile/history/error.tsx`
- Create: `src/app/(app)/price-comparison/loading.tsx`
- Create: `src/app/(app)/price-comparison/error.tsx`
- Move: `src/app/(app)/team/loading.tsx` -> `src/app/(app)/team/(index)/loading.tsx`
- Create: `src/app/(app)/team/(index)/error.tsx`

**Interfaces:**

- Each `error.tsx` consumes the Next 16 props `{ error: Error & { digest?: string }; unstable_retry: () => void }` and delegates the retry callback to `RouteDataError`.
- Each `loading.tsx` delegates semantics to `RouteDataLoading` while retaining an appropriately shaped route skeleton.
- Lists and Team place their landing `page.tsx`, `loading.tsx`, `error.tsx`, and landing page test together under `(index)`. `/lists` and `/team` remain unchanged URLs, while `/lists/[id]` is outside the landing error boundary. Do not leave `error.tsx` or `loading.tsx` at the Lists or Team parent segment.

- [ ] **Step 1: Add a failing boundary-contract test**

Extend `route-data-state.test.tsx` to dynamically import all five `error.tsx` files and all five `loading.tsx` files, using `src/app/(app)/lists/(index)` and `src/app/(app)/team/(index)` for those landing surfaces. Render each error with a spy `unstable_retry` and assert that its surface-specific title and description are present and a click invokes the spy. Render each loader and assert its tabulated label is exposed by `role="status"` with `aria-busy="true"`. Copy must name the surface and never reuse wine-list wording on another route. Test titles:

| Segment | Error title | Loading label |
| --- | --- | --- |
| Lists | `Wine lists couldn't be loaded` | `Loading wine lists` |
| Open Bottles | `Open bottles couldn't be loaded` | `Loading open bottles` |
| Reconciliation History | `Reconciliation history couldn't be loaded` | `Loading reconciliation history` |
| Distributor Pricing | `Distributor pricing couldn't be loaded` | `Loading distributor pricing` |
| Team | `Team couldn't be loaded` | `Loading team` |

Run the component test and expect RED because the boundaries are missing or still lack the shared semantics.

- [ ] **Step 2: Implement the boundaries with `unstable_retry`**

Each boundary follows this exact shape, varying only copy:

```tsx
"use client";

import { useEffect } from "react";
import { RouteDataError } from "@/components/route-data-state";

export default function ListsError({ error, unstable_retry }: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => { console.error(error); }, [error]);
  return <RouteDataError title="Wine lists couldn't be loaded" description="The request failed. Your lists have not been changed." onRetry={unstable_retry} />;
}
```

Do not show `error.message` to the user. Move the Lists and Team loaders into their `(index)` route groups and wrap their existing skeleton markup in `RouteDataLoading`; add compact route-shaped skeletons for the three missing loaders. Confirm with `rg --files` that `src/app/(app)/lists/error.tsx` and `src/app/(app)/team/error.tsx` do not exist, so the landing boundaries cannot hijack sibling or future child routes.

- [ ] **Step 3: Verify the boundary family**

```bash
pnpm exec vitest run src/components/route-data-state.test.tsx
pnpm exec tsc --noEmit
```

Expected: all five boundaries call `unstable_retry`; loaders type-check as Server Components importing a presentational component.

### Task 3: Make query failure and empty results mutually exclusive

**Files:**

- Move and modify: `src/app/(app)/lists/page.tsx` -> `src/app/(app)/lists/(index)/page.tsx`
- Create: `src/app/(app)/lists/(index)/page.test.tsx`
- Modify: `src/app/(app)/cellar/open/page.tsx`
- Create: `src/app/(app)/cellar/open/page.test.tsx`
- Modify: `src/app/(app)/cellar/reconcile/history/page.tsx`
- Create: `src/app/(app)/cellar/reconcile/history/page.test.tsx`
- Modify: `src/app/(app)/price-comparison/page.tsx`
- Create: `src/app/(app)/price-comparison/page.test.tsx`
- Move and modify: `src/app/(app)/team/page.tsx` -> `src/app/(app)/team/(index)/page.tsx`
- Move and modify: `src/app/(app)/team/page.test.tsx` -> `src/app/(app)/team/(index)/page.test.tsx`
- Modify: `src/app/(app)/lists/wine-list-landing.tsx`
- Modify: `src/app/(app)/team/team-actions.tsx`

**Interfaces:**

- Server pages throw the exact Supabase `error` object before deriving arrays.
- Zero-row success continues to the existing empty outcome, now rendered with `RouteDataEmpty`.
- Moving the two landing pages changes only their relative imports: Lists imports `WineListLanding` from `../wine-list-landing`; Team imports `MemberAnalyticsSection` and `TeamActions` from `../...`. Their URLs, metadata, auth behavior, and child routes remain unchanged.

- [ ] **Step 1: Add one forced-error and one zero-row test per page**

Mock `getAuthContext` with a thenable Supabase chain. For each surface, first return `{ data: null, error: new Error("forced query failure") }` and assert `await expect(Page(...)).rejects.toThrow("forced query failure")`. Then return `{ data: [], error: null }` and assert the page returns its empty props/markup rather than throwing. The Reconciliation History fixture must return an authenticated `owner` or `manager`; add separate unchanged redirect assertions for staff and unauthenticated contexts so a redirect cannot masquerade as query-error proof.

Cover every query that can create a false empty:

| Page | Queries whose errors must throw |
| --- | --- |
| Lists | `wine_lists` |
| Open Bottles | `open_bottles` |
| Reconciliation History | `availability_events` |
| Distributor Pricing | `inventory_items` throws; `wines` retail lookup is a non-emptying partial failure |
| Team | `memberships`, `invitations` |

For Lists, also return one archived list and no active lists, then inspect the returned `WineListLanding` props or render it: the archived item must remain in `archivedLists`, the `All wine lists are archived` recovery must remain reachable, and the generic `Create your first wine list` state must not replace it. This is a successful archived-only result, not emptiness.

For Team, add a separate failing case for memberships and invitations so one success cannot mask the other failure. Add a successful lifecycle case with `memberships: []` and one pending invitation: render the returned tree and assert both the member empty panel and `Pending invitations (1)` are visible. The member empty panel must not suppress the independent pending section.

For Distributor Pricing, assert three distinct outcomes: inventory error throws; successful inventory that derives `comparisons.length === 0` renders the genuine empty state; successful inventory plus a retail-wine lookup error still renders distributor comparisons with a non-blocking `role="status"` notice that market benchmarks are temporarily unavailable. Include a non-empty raw inventory fixture whose unusable wine/scan relationship produces zero comparisons, proving the empty predicate remains the derived `comparisons.length === 0`, not merely `items.length === 0`. Expected RED: current pages ignore at least one primary error and produce empty data.

- [ ] **Step 2: Throw before every `?? []` fallback**

Destructure named errors and immediately throw:

```ts
const { data: lists, error: listsError } = await query;
if (listsError) throw listsError;
const allLists = (lists ?? []).map(/* unchanged */);
```

For `Promise.all`, retain parallelism. Throw membership and invitation errors on Team because either result is a named lifecycle section. On Pricing, throw only the primary `inventory_items` error that can empty the comparison source; do not promote the secondary `wines` retail lookup to the route error boundary. Keep successful inventory usable when that retail lookup fails and render a truthful partial-data notice. Remove the Open Bottles `console.error` fallthrough. Do not rewrite queries or catches at a parent scope.

- [ ] **Step 3: Normalize the five genuine-empty panels**

Use `RouteDataEmpty` for the existing genuine no-list, no-open-bottle, no-history, no-pricing-data, and no-member outcomes. Preserve their useful recovery actions: create list, return/go to reconcile, go to scanner, or create invitation when authorized, and raise those recovery links/buttons to `h-11` or `min-h-11` with focused assertions. Lists must keep rendering `WineListLanding` when archived lists exist, even if the active list array is empty; the genuine no-list presentation is only `lists.length === 0 && archivedLists.length === 0`. In `TeamActions`, make `members.length === 0` render the member empty state while pending invitations remain a separate lifecycle section; do not label a failed member query as empty. In Pricing, keep the genuine-empty branch exactly after comparison derivation and guarded by `comparisons.length === 0`.

- [ ] **Step 4: Run the page matrix**

```bash
pnpm exec vitest run \
  'src/app/(app)/lists/(index)/page.test.tsx' \
  'src/app/(app)/cellar/open/page.test.tsx' \
  'src/app/(app)/cellar/reconcile/history/page.test.tsx' \
  'src/app/(app)/price-comparison/page.test.tsx' \
  'src/app/(app)/team/(index)/page.test.tsx' \
  src/components/route-data-state.test.tsx
```

Expected: each primary forced error rejects; genuine zero-comparison results produce empty content; archived-only Lists remains recoverable; members-empty plus pending-invitation Team renders both lifecycle sections; Pricing retail lookup failure remains a partial success.

### Task 4: Expose Open Bottles from Cellar

**Files:**

- Modify: `src/app/(app)/cellar/cellar-shell.tsx`
- Create: `src/app/(app)/cellar/cellar-shell-open-bottles.test.tsx`

**Interfaces:**

- Produces: persistent `Link href="/cellar/open"` labelled `Open bottles`, with the current open count and a 44px target, in the Cellar bridge band.

- [ ] **Step 1: Write the failing reachability test**

Mock `next/navigation` (`useSearchParams`, `useRouter`, and `usePathname`) using the same shape as existing Cellar tests. Render `CellarShell` with minimum viable props and assert one accessible link named `/Open bottles/i` points to `/cellar/open`, remains present when `reconcileItems` is empty, and contains an `h-11` or `min-h-11` class. Expected RED: the dedicated route is currently not linked, not a router-hook setup failure.

- [ ] **Step 2: Add the bounded link**

Import `Link` from `next/link` and add the link beside existing Cellar management controls, using `alerts.openCount` for copy. Do not replace the Open filter, navigation system, or Reconcile action.

- [ ] **Step 3: Run focused and full verification**

```bash
pnpm exec vitest run src/components/route-data-state.test.tsx \
  'src/app/(app)/lists/(index)/page.test.tsx' \
  'src/app/(app)/cellar/open/page.test.tsx' \
  'src/app/(app)/cellar/reconcile/history/page.test.tsx' \
  'src/app/(app)/price-comparison/page.test.tsx' \
  'src/app/(app)/team/(index)/page.test.tsx' \
  'src/app/(app)/cellar/cellar-shell-open-bottles.test.tsx'
pnpm test
pnpm exec tsc --noEmit
pnpm lint
git diff --check -- src/components/route-data-state.tsx src/components/route-data-state.test.tsx \
  'src/app/(app)/lists' 'src/app/(app)/cellar/open' \
  'src/app/(app)/cellar/reconcile/history' 'src/app/(app)/price-comparison' \
  'src/app/(app)/team' 'src/app/(app)/cellar/cellar-shell.tsx' \
  'src/app/(app)/cellar/cellar-shell-open-bottles.test.tsx'
```

Expected: focused and full tests PASS; type checking and lint exit 0; diff check prints nothing.

### Task 5: Independent review, Grok 4.6 audit, and one commit

- [ ] **Step 1: Obtain independent task-scope review**

Give a fresh reviewer UX-02, this plan, all new tests, and the complete scoped diff. Require a five-surface matrix proving: loading has semantics, each primary emptying query error throws, each boundary retries with `unstable_retry`, Lists and Team landing boundaries do not wrap sibling child routes, archived-only Lists is preserved, members-empty plus pending Team is preserved, Pricing emptiness remains `comparisons.length === 0`, and `/cellar/open` is reachable. Resolve important findings test-first and rerun Task 4 Step 3.

- [ ] **Step 2: Pass the Grok 4.6 pre-commit gate**

Audit the complete scoped diff against this plan using exact model `x-ai/grok-4.6`. Require `APPROVE` with no unresolved blocking or important finding. On `REVISE`, add a failing regression for each valid finding, make only scoped changes, rerun verification, and re-audit. Do not commit before approval.

- [ ] **Step 3: Stage the exact UX-02 path set and commit once**

Stage only the paths below—never `git add .` or `git add -A`. Confirm the cached diff contains no UX-01 or later-move code, then run:

```bash
git add src/components/route-data-state.tsx \
  src/components/route-data-state.test.tsx \
  'src/app/(app)/lists/loading.tsx' \
  'src/app/(app)/lists/page.tsx' \
  'src/app/(app)/lists/(index)/loading.tsx' \
  'src/app/(app)/lists/(index)/error.tsx' \
  'src/app/(app)/lists/(index)/page.tsx' \
  'src/app/(app)/lists/(index)/page.test.tsx' \
  'src/app/(app)/lists/wine-list-landing.tsx' \
  'src/app/(app)/cellar/open/loading.tsx' \
  'src/app/(app)/cellar/open/error.tsx' \
  'src/app/(app)/cellar/open/page.tsx' \
  'src/app/(app)/cellar/open/page.test.tsx' \
  'src/app/(app)/cellar/reconcile/history/loading.tsx' \
  'src/app/(app)/cellar/reconcile/history/error.tsx' \
  'src/app/(app)/cellar/reconcile/history/page.tsx' \
  'src/app/(app)/cellar/reconcile/history/page.test.tsx' \
  'src/app/(app)/price-comparison/loading.tsx' \
  'src/app/(app)/price-comparison/error.tsx' \
  'src/app/(app)/price-comparison/page.tsx' \
  'src/app/(app)/price-comparison/page.test.tsx' \
  'src/app/(app)/team/loading.tsx' \
  'src/app/(app)/team/page.tsx' \
  'src/app/(app)/team/page.test.tsx' \
  'src/app/(app)/team/(index)/loading.tsx' \
  'src/app/(app)/team/(index)/error.tsx' \
  'src/app/(app)/team/(index)/page.tsx' \
  'src/app/(app)/team/(index)/page.test.tsx' \
  'src/app/(app)/team/team-actions.tsx' \
  'src/app/(app)/cellar/cellar-shell.tsx' \
  'src/app/(app)/cellar/cellar-shell-open-bottles.test.tsx'
git diff --cached --check
git commit -m "fix: distinguish failed and empty data states"
```

Expected: one conventional commit containing the shared state family, five route integrations and tests, and the Cellar reachability link.
