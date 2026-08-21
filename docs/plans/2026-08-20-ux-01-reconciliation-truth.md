# Reconciliation Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make every reconciliation number, sign, label, and color describe `actual remaining - expected remaining`, including the historical audit presentation.

**Architecture:** Put the current-state variance contract in one pure helper, `getReconciliationVariance(actualMl, expectedMl)`, and consume it in the client reconcile row. Keep the database and RPC contract unchanged: historical `availability_events.delta` is persisted as `expected - actual`, so a pure `buildHistoryFromPersistedEvents` seam inverts each event once before grouping and rendering. Preserve existing aggregation behavior: each session retains a signed net and each day totals the absolute session nets.

**Tech Stack:** TypeScript, React 19, Next.js 16 App Router, Vitest, existing Tailwind v4 tokens and Lucide icons.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](./2026-08-20-high-leverage-ux-portfolio-spec.md), UX-01.

## Global Constraints

- Preserve persistence, inventory arithmetic, thresholds, and role permissions; this move is presentation correctness only.
- Use `actual - expected` everywhere after the history presentation boundary.
- Preserve the approved light editorial hospitality identity and existing design tokens from `DESIGN.md`.
- Add no dependency, schema change, provider configuration, or production-data mutation.
- Do not shrink existing 44px controls or remove accessible names. Resizing the existing 40px Actual and 32px Note fields belongs to the separate UX-07 scope and is not part of this correctness fix.
- Begin with a focused failing test, obtain an independent task review, and obtain a clean Grok 4.6 implementation audit before the single final commit.

---

### Task 1: Define the actual-minus-expected contract

**Files:**

- Create: `src/lib/reconciliation/variance.ts`
- Create: `src/lib/reconciliation/variance.test.ts`

**Interfaces:**

- Consumes: `actualMl: number` and `expectedMl: number`, both finite millilitre counts supplied by existing reconciliation code.
- Produces:

```ts
export type ReconciliationRelation = "over" | "under" | "exact";

export type ReconciliationVariance = {
  deltaMl: number;
  relation: ReconciliationRelation;
  percentage: number | null;
  symbol: "↑" | "↓" | "=";
  label: "over expected" | "under expected" | "exact";
};

export function getReconciliationVariance(
  actualMl: number,
  expectedMl: number,
): ReconciliationVariance;

export function formatSignedVarianceOz(deltaMl: number): string;
```

- `percentage` is `(actualMl - expectedMl) / expectedMl * 100`; it is `null` whenever `expectedMl === 0`, preventing false infinity or divide-by-zero copy.
- `formatSignedVarianceOz` imports the existing `ML_PER_OZ` constant and returns ASCII `+` for positive, Unicode minus `−` for negative, and unsigned `0.0 oz` for exact.

- [ ] **Step 1: Write the failing boundary tests**

Create `src/lib/reconciliation/variance.test.ts` with all four acceptance cases and exact user-facing semantics:

```ts
import { describe, expect, it } from "vitest";
import { getReconciliationVariance } from "./variance";

describe("getReconciliationVariance", () => {
  it("reports actual volume above tracked volume as over", () => {
    expect(getReconciliationVariance(130, 110)).toMatchObject({
      deltaMl: 20,
      relation: "over",
      symbol: "↑",
      label: "over expected",
    });
    expect(getReconciliationVariance(130, 110).percentage).toBeCloseTo(18.18, 2);
  });

  it("reports actual volume below tracked volume as under", () => {
    expect(getReconciliationVariance(90, 110)).toMatchObject({
      deltaMl: -20,
      relation: "under",
      symbol: "↓",
      label: "under expected",
    });
  });

  it("reports equal counts as exact", () => {
    expect(getReconciliationVariance(110, 110)).toEqual({
      deltaMl: 0,
      relation: "exact",
      percentage: 0,
      symbol: "=",
      label: "exact",
    });
  });

  it("does not invent a percentage when expected is zero", () => {
    expect(getReconciliationVariance(30, 0)).toMatchObject({
      deltaMl: 30,
      relation: "over",
      percentage: null,
      label: "over expected",
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/reconciliation/variance.test.ts
```

Expected: FAIL because `src/lib/reconciliation/variance.ts` or `getReconciliationVariance` does not exist.

- [ ] **Step 3: Implement the minimal pure helper**

Create `src/lib/reconciliation/variance.ts` with no React, formatting, color, or persistence knowledge:

```ts
export type ReconciliationRelation = "over" | "under" | "exact";

export type ReconciliationVariance = {
  deltaMl: number;
  relation: ReconciliationRelation;
  percentage: number | null;
  symbol: "↑" | "↓" | "=";
  label: "over expected" | "under expected" | "exact";
};

export function getReconciliationVariance(
  actualMl: number,
  expectedMl: number,
): ReconciliationVariance {
  const deltaMl = actualMl - expectedMl;
  const percentage = expectedMl === 0 ? null : (deltaMl / expectedMl) * 100;
  if (deltaMl > 0) {
    return { deltaMl, relation: "over", percentage, symbol: "↑", label: "over expected" };
  }
  if (deltaMl < 0) {
    return { deltaMl, relation: "under", percentage, symbol: "↓", label: "under expected" };
  }
  return { deltaMl, relation: "exact", percentage, symbol: "=", label: "exact" };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest run src/lib/reconciliation/variance.test.ts
```

Expected: all four cases PASS.

### Task 2: Make the live reconcile row consume the contract

**Files:**

- Modify: `src/app/(app)/cellar/reconcile-list.tsx`, inside `ReconcileRow` where `varianceMl`, sign, copy, and badge classes are derived.
- Create: `src/app/(app)/cellar/reconcile-list.test.tsx`
- Test: `src/lib/reconciliation/variance.test.ts`

**Interfaces:**

- Consumes: `getReconciliationVariance(actualMl, expectedMl)` from Task 1.
- Produces: a badge whose text and tone are derived from one `ReconciliationVariance` object; no independent sign/copy ternaries remain.

- [ ] **Step 1: Write a failing component regression for the shipped copy**

Render `ReconcileList` with one open-bottle fixture in happy-dom, mock `next/navigation`, and change the Actual input. Use a complete `OpenBottleRow` fixture so the test is executable rather than an interface sketch:

```ts
const item: OpenBottleRow = {
  wine_id: "wine-1",
  wine_list_item_id: "item-1",
  producer: "Test Producer",
  name: "Test Wine",
  vintage: 2022,
  size_ml: 750,
  sealed_count: 0,
  opened_at: "2026-08-20T12:00:00.000Z",
  open_remaining_ml: 110,
  glass_pour_ml: 148,
  pour_size_mode: "fixed",
};

it.each([
  {
    name: "subthreshold over",
    expected: 110,
    actual: 130,
    copy: /\+0\.7 oz · over expected/i,
    badgeTone: "bg-sage-wash",
    cardClasses: ["border-hairline", "bg-white"],
  },
  {
    name: "subthreshold under",
    expected: 110,
    actual: 90,
    copy: /−0\.7 oz · under expected/i,
    badgeTone: "bg-blush-wash",
    cardClasses: ["border-hairline", "bg-white"],
  },
  {
    name: "exact",
    expected: 110,
    actual: 110,
    copy: /0\.0 oz · exact/i,
    badgeTone: "bg-bridge-surface",
    cardClasses: ["border-hairline", "bg-white"],
  },
  {
    name: "zero expected without a flagged card",
    expected: 0,
    actual: 20,
    copy: /\+0\.7 oz · over expected/i,
    badgeTone: "bg-sage-wash",
    cardClasses: ["border-hairline", "bg-white"],
  },
  {
    name: "flagged over",
    expected: 110,
    actual: 170,
    copy: /\+2\.0 oz · over expected/i,
    badgeTone: "bg-sage-wash",
    cardClasses: ["border-sage-ink/30", "bg-sage-wash"],
  },
  {
    name: "flagged under",
    expected: 110,
    actual: 50,
    copy: /−2\.0 oz · under expected/i,
    badgeTone: "bg-blush-wash",
    cardClasses: ["border-primary/40", "bg-blush-wash"],
  },
])("renders $name truthfully", async ({ expected, actual, copy, badgeTone, cardClasses }) => {
  const fixture = { ...item, open_remaining_ml: expected };
  await act(async () => root.render(<ReconcileList initialItems={[fixture]} />));
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Actual remaining volume in ml"]',
  )!;
  // For exact, first enter a different value and then return to expected so
  // pending state exists and the explicit exact presentation is exercised.
  if (actual === expected) setInputValue(input, expected + 1);
  setInputValue(input, actual);
  const badge = findElementByText(container, copy);
  expect(badge.className).toContain(badgeTone);
  const card = badge.closest("li")!;
  for (const className of cardClasses) expect(card.className).toContain(className);
});
```

Define `setInputValue` with the native input value setter plus an `input` event inside `act`, and define `findElementByText` as a small local DOM query helper; do not add Testing Library. Build the displayed ounce strings from `ML_PER_OZ` in the executable test rather than duplicating a conversion constant. The `±20ml` fixtures deliberately stay below the default 1oz threshold: they lock badge copy and tone while proving the card remains `border-hairline bg-white`. The separate `±60ml` fixtures prove only above-threshold rows gain direction-specific flagged card chrome. Run this test before changing production code. Expected: RED because positive and negative live copy are reversed, exact is suppressed when the entered value equals expected, and both flagged directions share burgundy card chrome.

- [ ] **Step 2: Extend the pure test to lock semantic tone selection**

Add an exported class selector to the helper contract:

```ts
export function reconciliationTone(relation: ReconciliationRelation):
  | "positive"
  | "negative"
  | "neutral";
```

Add expectations that `over -> positive`, `under -> negative`, and `exact -> neutral`. Also add `formatSignedVarianceOz(deltaMl)` expectations for `+0.7 oz`, `−0.7 oz`, and `0.0 oz`. Run the focused test and expect RED because the presentation helpers are not defined.

- [ ] **Step 3: Implement the presentation helpers and use them in the row**

Implement the pure selector, then replace the duplicated row arithmetic with:

```ts
const variance = getReconciliationVariance(actualMl, expectedMl);
const varianceOz = variance.deltaMl / ML_PER_OZ;
const tone = reconciliationTone(variance.relation);
```

Render `formatSignedVarianceOz(variance.deltaMl)`, a middot separator, and `variance.label`. Show the badge whenever `pending !== null`, including an entered exact value. Use existing tokens so the meaning is stable: `positive` uses sage (`bg-sage-wash text-sage-ink`), `negative` uses burgundy (`bg-blush-wash text-primary`), and `neutral` uses `bg-bridge-surface text-grey`. Keep every subthreshold and exact card `border-hairline bg-white`. Only `Math.abs(variance.deltaMl / ML_PER_OZ) > varianceThresholdOz` changes card chrome: positive uses `border-sage-ink/30 bg-sage-wash`, negative uses `border-primary/40 bg-blush-wash`. An over-expected card must not inherit burgundy danger styling merely because it crossed the threshold.

- [ ] **Step 4: Verify live-row semantics**

Run:

```bash
pnpm exec vitest run src/lib/reconciliation/variance.test.ts 'src/app/(app)/cellar/reconcile-list.test.tsx'
pnpm exec tsc --noEmit
```

Expected: the pure contract and the actual `ReconcileList` presentation both PASS; type checking exits 0.

### Task 3: Correct the historical presentation boundary and aggregation

**Files:**

- Create: `src/app/(app)/cellar/reconcile/history/history-data.ts`
- Modify: `src/app/(app)/cellar/reconcile/history/page.tsx`
- Create: `src/app/(app)/cellar/reconcile/history/history-data.test.ts`

**Interfaces:**

- Consumes: persisted `ReconEvent.delta`, whose database contract is `old_remaining_ml - new_remaining_ml` (`expected - actual`).
- Produces: a pure `history-data.ts` module with `buildHistoryFromPersistedEvents(events)`. That public seam performs the only inversion and then delegates to private grouping helpers, so the App Router page cannot accidentally group raw persisted deltas.

- [ ] **Step 1: Export the pure history seam and write a failing regression**

Write `history-data.test.ts` against the not-yet-created sibling `history-data.ts`, using two events within one ten-minute session: persisted deltas `20` and `-5`. Assert:

```ts
const [day] = buildHistoryFromPersistedEvents(events);
expect(day.sessions[0].events.map((event) => event.delta)).toEqual([-20, 5]);
expect(day.sessions[0].totalVarianceMl).toBe(-15); // signed session net
expect(day.totalVarianceMl).toBe(15); // preserve abs(session net) aggregation
```

Also assert a persisted `null` delta stays `null` and contributes zero. Add a separate two-session fixture that preserves the current daily formula `sum(abs(session net))` rather than changing it to event magnitudes. Keep this pure module suite limited to the persistence-boundary inversion, null handling, signed session aggregation, and absolute daily aggregation. Signed strings, over/under labels, and Tailwind tone classes belong in the page regression below, not in `history-data.test.ts`.

- [ ] **Step 2: Run the history test and verify RED**

Run:

```bash
pnpm exec vitest run 'src/app/(app)/cellar/reconcile/history/history-data.test.ts'
```

Expected: FAIL because `history-data.ts` and its single-inversion entry point do not exist.

- [ ] **Step 3: Add an executable failing page regression before editing the page**

Create `src/app/(app)/cellar/reconcile/history/page.test.tsx` before changing `page.tsx`. Use `vi.hoisted` and `vi.mock("@/lib/auth-context", ...)`, plus `renderToStaticMarkup` from `react-dom/server`. The auth fixture must be complete enough to enter the query path:

```ts
const query = {
  select: vi.fn(() => query),
  eq: vi.fn(() => query),
  order: vi.fn(() => query),
  limit: vi.fn().mockResolvedValue({
    data: [persistedPositiveEvent, persistedNegativeEvent],
    error: null,
  }),
};

mocks.getAuthContext.mockResolvedValue({
  user: { id: "user-1" },
  userRole: "owner",
  restaurantId: "restaurant-1",
  restaurantName: "House",
  supabase: { from: vi.fn(() => query) },
});

const markup = renderToStaticMarkup(await ReconcileHistoryPage());
```

Give the two events different sessions so their signed session badges cannot net to zero. For persisted `delta: 20`, assert markup containing `−0.7 oz`, `under expected`, `bg-blush-wash`, and `text-primary`. For persisted `delta: -20`, assert `+0.7 oz`, `over expected`, `bg-sage-wash`, and `text-sage-ink`. Add a persisted-zero fixture and assert `0.0 oz`, `exact`, and the neutral class `bg-bridge-surface`. These are exact presentation-class assertions, not generic colour-word searches. Run:

```bash
pnpm exec vitest run 'src/app/(app)/cellar/reconcile/history/page.test.tsx'
```

Expected: RED against the unchanged page because it still groups raw persisted deltas, omits relation labels, and uses the old warning/success classes. If the test fails in auth, query chaining, or server rendering instead, fix the fixture until the failure is the intended presentation mismatch. Do not edit `page.tsx` before this RED is recorded.

- [ ] **Step 4: Invert once, then render only presentation deltas**

Create `history-data.ts` and implement the inversion as a private helper behind the public entry point:

```ts
function presentReconcileEvent(event: ReconEvent): ReconEvent {
  return { ...event, delta: event.delta == null ? null : -event.delta };
}

export function buildHistoryFromPersistedEvents(events: ReconEvent[]): DayGroup[] {
  return buildHistory(events.map(presentReconcileEvent));
}
```

Move the current `ReconEvent`, session/day types, `buildSession`, private `buildHistory`, `formatDateHeader`, and `formatTime` pure logic from `page.tsx` into that module. Preserve the current daily total formula `sessions.reduce((sum, session) => sum + Math.abs(session.totalVarianceMl), 0)` and each session's signed net. The page imports and calls only `buildHistoryFromPersistedEvents((events ?? []) as ReconEvent[])`; it must not map or negate deltas itself.

In the page, render event rows and signed session badges through the same signed formatter and over/under/exact relation vocabulary used by the live row. Remove `formatOz`'s absolute-value-only **event/session** contract and any plus-only prefix that leaves negative events unsigned. Rename `isOverpour`/`isUnderpour` to inventory-accurate names such as `hasMoreRemaining`/`hasLessRemaining`; pair `TrendingUp` with positive/over/sage (`bg-sage-wash text-sage-ink`), `TrendingDown` with negative/under/burgundy (`bg-blush-wash text-primary`), and exact with `bg-bridge-surface text-grey`. Keep the daily summary and chart deliberately unsigned: their existing values are `sum(abs(session net))`, and their labels continue to use an absolute ounce formatter with no plus/minus sign or over/under copy. Do not change the query or stored values.

- [ ] **Step 5: Verify the page now consumes the single-inversion seam**

Rerun the page regression from Step 3 only after `page.tsx` imports `buildHistoryFromPersistedEvents`. Expected: GREEN proves the server entry does not bypass the tested inversion contract and that event/session sign and tone are correct while day/chart presentation remains absolute.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
pnpm exec vitest run src/lib/reconciliation/variance.test.ts \
  'src/app/(app)/cellar/reconcile-list.test.tsx' \
  'src/app/(app)/cellar/reconcile/history/history-data.test.ts' \
  'src/app/(app)/cellar/reconcile/history/page.test.tsx'
pnpm test
pnpm exec tsc --noEmit
pnpm lint
git diff --check -- src/lib/reconciliation/variance.ts src/lib/reconciliation/variance.test.ts \
  'src/app/(app)/cellar/reconcile-list.tsx' \
  'src/app/(app)/cellar/reconcile-list.test.tsx' \
  'src/app/(app)/cellar/reconcile/history/history-data.ts' \
  'src/app/(app)/cellar/reconcile/history/history-data.test.ts' \
  'src/app/(app)/cellar/reconcile/history/page.test.tsx' \
  'src/app/(app)/cellar/reconcile/history/page.tsx'
```

Expected: focused tests and the full repository suite PASS; type checking and lint exit 0; diff check prints nothing.

### Task 4: Independent review, Grok 4.6 audit, and one commit

**Files:** the eight files named above; no unrelated path may be staged.

- [ ] **Step 1: Obtain independent task-scope review**

Give the approved UX-01 spec, this plan, tests, and complete scoped diff to a fresh reviewer. Require explicit checks for sign consistency, subthreshold neutral card chrome, direction-specific flagged card chrome, the zero-expected boundary, the persisted-delta inversion occurring exactly once, absolute day/chart presentation, and unchanged persistence/permissions. Resolve important findings and rerun Task 3 Step 6.

- [ ] **Step 2: Pass the Grok 4.6 pre-commit gate**

Audit the complete scoped diff against this plan with exact model `x-ai/grok-4.6`. The audit must return `APPROVE` with no unresolved blocking or important findings. On `REVISE`, change only the scoped files, add or update a failing regression first, rerun all verification, and re-audit. Do not commit before approval.

- [ ] **Step 3: Stage exact paths and create the single UX-01 commit**

```bash
git add src/lib/reconciliation/variance.ts src/lib/reconciliation/variance.test.ts \
  'src/app/(app)/cellar/reconcile-list.tsx' \
  'src/app/(app)/cellar/reconcile-list.test.tsx' \
  'src/app/(app)/cellar/reconcile/history/history-data.ts' \
  'src/app/(app)/cellar/reconcile/history/history-data.test.ts' \
  'src/app/(app)/cellar/reconcile/history/page.test.tsx' \
  'src/app/(app)/cellar/reconcile/history/page.tsx'
git diff --cached --check
git commit -m "fix: make reconciliation variance truthful"
```

Expected: one commit containing only UX-01 production code and regression tests.
