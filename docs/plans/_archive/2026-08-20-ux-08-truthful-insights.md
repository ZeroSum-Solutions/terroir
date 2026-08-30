# Truthful Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make every selected Insights metric truthful about its time period, expose the existing custom range, and remove actions that do not work.

**Architecture:** Keep URL search parameters as the single date-range source of truth. Derive distributor scan count and spend from the same already-filtered `invoice_scans` rows, using a pure summarizer for regression coverage, and add small presentational scope labels instead of introducing an analytics framework. Preserve the server-rendered page and isolate only the existing selector as a Client Component.

**Tech Stack:** Next.js 16.2.4 App Router, React 19.2.4, TypeScript 5, Supabase query builder, Tailwind CSS 4, Vitest 4.1.4, happy-dom.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](./2026-08-20-high-leverage-ux-portfolio-spec.md), UX-08.

## Global Constraints

- Preserve the light editorial hospitality identity and existing tokens in `DESIGN.md`.
- Add no dependency, analytics backend, charting package, or date-range model.
- Treat `390px` as the minimum review width and keep selected controls at least `44px` high.
- User-facing copy must distinguish `Current snapshot` from the selected range.
- Remove the disabled `Add to menu` and `Add to staff briefing` promises; do not build either loop.
- Do not change permissions, schema, provider configuration, or production data.
- Read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md` before changing the selector; retain `useSearchParams` in the Client Component and the `searchParams` prop in the Server Component.
- Use test-driven development and create no interim commit. The move receives one final commit only after the Grok 4.6 gate passes.

---

## File Map

- Create `src/app/(app)/insights/date-range-selector.test.tsx`: custom-option and URL-update interaction coverage.
- Create `src/app/(app)/insights/distributor-metrics.ts`: pure range-consistent distributor aggregation.
- Create `src/app/(app)/insights/distributor-metrics.test.ts`: scan-count and spend alignment coverage.
- Create `src/app/(app)/insights/insight-scope.tsx`: small `Current snapshot` / selected-range text treatment.
- Create `src/app/(app)/insights/insight-scope.test.tsx`: presentational scope-label coverage.
- Create `src/app/(app)/insights/page.truthfulness.test.ts`: page-level wiring contract for filtered distributor data and mounted scope labels.
- Create `src/app/(app)/insights/briefing-alert-card.test.tsx`: regression coverage for removal of dead actions.
- Modify `src/app/(app)/insights/date-range-selector.tsx`: render Custom and make radio state truthful.
- Modify `src/app/(app)/insights/page.tsx`: remove the unfiltered inventory query, use the pure distributor summary, and label metric scopes.
- Modify `src/app/(app)/insights/yield-report-section.tsx`: show the selected range beside range-filtered yield.
- Modify `src/app/(app)/insights/yield-report-section.test.tsx`: prove the yield scope label is mounted.
- Modify `src/app/(app)/insights/briefing-alert-card.tsx`: remove disabled action UI and stale comments.

### Task 1: Expose and apply the existing custom range

**Files:**
- Create: `src/app/(app)/insights/date-range-selector.test.tsx`
- Modify: `src/app/(app)/insights/date-range-selector.tsx`

**Interfaces:**
- Consumes: `range`, `from`, and `to` from `useSearchParams()`.
- Produces: a visible `Custom` radio; applying valid dates calls `router.push("/insights?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD", { scroll: false })` while retaining unrelated search parameters.

- [ ] **Step 1: Write the failing selector test**

Mock `next/navigation`, mount with `createRoot`, and exercise the real controls:

```tsx
const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  params: new URLSearchParams("range=30d&metric=scans"),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => navigation.params,
}));

it("offers Custom and applies its dates without dropping unrelated params", async () => {
  await act(async () => root.render(<DateRangeSelector />));
  const custom = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Custom",
  )!;
  await act(async () => custom.click());

  const from = container.querySelector<HTMLInputElement>("#dr-from")!;
  const to = container.querySelector<HTMLInputElement>("#dr-to")!;
  await act(async () => {
    setInputValue(from, "2026-08-01");
    setInputValue(to, "2026-08-20");
  });
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Apply",
  );
  expect(apply).toBeDefined();
  await act(async () => apply!.click());

  expect(navigation.push).toHaveBeenCalledWith(
    "/insights?range=custom&metric=scans&from=2026-08-01&to=2026-08-20",
    { scroll: false },
  );
});
```

Define `setInputValue` in the test with the native `HTMLInputElement.prototype.value` setter followed by an `input` event so React receives the change. Add a second case initialized with `range=custom&from=2026-08-01&to=2026-08-20`; assert the Custom control has `aria-checked="true"` and the date controls are visible.

Add a third case that clicks Custom twice while the URL remains `range=30d`; the date controls must remain open. This locks the intended “open the editor” behavior and prevents Custom from acting as an unrelated disclosure toggle. Assert the `radiogroup` has wrapping classes and every range radio has `min-h-11`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm exec vitest run 'src/app/(app)/insights/date-range-selector.test.tsx'
```

Expected: FAIL because no button named `Custom` exists.

- [ ] **Step 3: Add Custom to the existing option list and correct selection semantics**

Append the existing enum value to `RANGE_OPTIONS`:

```ts
{ value: "custom", label: "Custom" },
```

For each radio, set `type="button"` and `aria-checked={currentRange === opt.value}`. Clicking Custom always calls `setShowCustom(true)`; it never toggles closed. Clicking a preset closes the custom editor and calls `applyRange`. Give the radiogroup `flex flex-wrap items-center gap-2xs`, give every radio `min-h-11`, keep `from` and `to` in the URL only when a valid custom range is applied, and change both date inputs and Apply from `h-[28px]` to `min-h-11`. Give the custom row `flex flex-wrap items-center gap-xs` so it fits at 390px, and retain the existing programmatic labels.

- [ ] **Step 4: Run the selector test and confirm GREEN**

Run the Step 2 command.

Expected: all three selector cases PASS.

### Task 2: Derive paired distributor metrics from one filtered source

**Files:**
- Create: `src/app/(app)/insights/distributor-metrics.ts`
- Create: `src/app/(app)/insights/distributor-metrics.test.ts`
- Modify: `src/app/(app)/insights/page.tsx`

**Interfaces:**
- Consumes: the `allScans` array already filtered by `rangeSince` and `rangeUntil`; each scan has `distributor_name` and `final_line_items`.
- Produces: `summarizeDistributorMetrics(scans: DistributorMetricScan[]): DistributorMetric[]`, where `DistributorMetric` is `{ name: string; scans: number; spend: number }`, plus `distributorSpendShare(spend: number, totalSpend: number): number`.

- [ ] **Step 1: Write the failing pure aggregation test**

```ts
it("derives scan count and spend from the same scans", () => {
  expect(
    summarizeDistributorMetrics([
      {
        distributor_name: "Estate Imports",
        final_line_items: [
          { qty: 2, unitCost: 18.5 },
          { qty: 1, unitCost: 40 },
        ],
      },
      {
        distributor_name: "Estate Imports",
        final_line_items: [{ qty: 3, unitCost: 12 }],
      },
      {
        distributor_name: "Other",
        final_line_items: null,
      },
    ]),
  ).toEqual([
    { name: "Estate Imports", scans: 2, spend: 113 },
    { name: "Other", scans: 1, spend: 0 },
  ]);
});
```

Add a malformed-line case with strings, negative quantities, and missing values; only finite, non-negative numeric `qty * unitCost` values may contribute to spend.

Add a zero-spend guard:

```ts
expect(distributorSpendShare(0, 0)).toBe(0);
expect(distributorSpendShare(25, 100)).toBe(0.25);
```

- [ ] **Step 2: Run the aggregator test and confirm RED**

Run:

```bash
pnpm exec vitest run 'src/app/(app)/insights/distributor-metrics.test.ts'
```

Expected: FAIL because `distributor-metrics.ts` and `summarizeDistributorMetrics` do not exist.

- [ ] **Step 3: Implement the minimal summarizer**

```ts
export type DistributorMetricScan = {
  distributor_name: string;
  final_line_items: unknown;
};

export type DistributorMetric = {
  name: string;
  scans: number;
  spend: number;
};

export function summarizeDistributorMetrics(
  scans: DistributorMetricScan[],
): DistributorMetric[] {
  // One pass into a Map. Count every scan and sum only valid line items.
  // Return descending spend, then name for deterministic ties.
}

export function distributorSpendShare(spend: number, totalSpend: number): number {
  return totalSpend > 0 ? spend / totalSpend : 0;
}
```

Use a narrow runtime guard for `{ qty: number; unitCost: number }`; do not coerce strings. In `page.tsx`, delete the separate `scanItems` query and its unfiltered aggregation. Call `summarizeDistributorMetrics(allScans)`, compute `distTotalSpend` from the complete returned array without an `|| 1` substitute, and then take its first five entries for the displayed table. Render `metric.name`, `metric.spend`, and `metric.scans`; calculate each share only with `distributorSpendShare(metric.spend, distTotalSpend)` so an all-zero-spend range displays `0%` rather than dividing by zero or inventing a denominator.

- [ ] **Step 4: Run the aggregator test and confirm GREEN**

Run the Step 2 command.

Expected: both aggregation cases PASS.

### Task 3: Label metric scope and remove dead insight actions

**Files:**
- Create: `src/app/(app)/insights/insight-scope.tsx`
- Create: `src/app/(app)/insights/insight-scope.test.tsx`
- Create: `src/app/(app)/insights/page.truthfulness.test.ts`
- Create: `src/app/(app)/insights/briefing-alert-card.test.tsx`
- Modify: `src/app/(app)/insights/page.tsx`
- Modify: `src/app/(app)/insights/yield-report-section.tsx`
- Modify: `src/app/(app)/insights/yield-report-section.test.tsx`
- Modify: `src/app/(app)/insights/briefing-alert-card.tsx`

**Interfaces:**
- Consumes: `dateRangeLabel(range, sp.from, sp.to)` from `date-range.ts`.
- Produces: `<InsightScope metric="inventory" kind="snapshot" />` with `Current snapshot`, and `<InsightScope metric="scan-activity" kind="range" label={selectedRangeLabel} />` with the exact selected-range label. The `metric` prop renders as `data-insight-scope` so wiring is testable without changing accessible copy.

- [ ] **Step 1: Write failing scope and action tests**

```tsx
it("distinguishes a current snapshot from a selected range", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <>
      <InsightScope metric="inventory" kind="snapshot" />
      <InsightScope metric="scan-activity" kind="range" label="Aug 1 – Aug 20" />
    </>,
  );
  expect(document.body.textContent).toContain("Current snapshot");
  expect(document.body.textContent).toContain("Aug 1 – Aug 20");
});
```

In `briefing-alert-card.test.tsx`, mock `useRouter`, render a realistic alert, and assert that `View 2 bottles` and `Snooze 30 days` remain while `Add to menu` and `Add to staff briefing` are absent.

Update the existing `yield-report-section.test.tsx` fixture to pass `rangeLabel="Aug 1 – Aug 20"`. Assert `[data-insight-scope="yield"]` exists and its text content is exactly `Aug 1 – Aug 20`; retain the existing yield metric-link assertions.

In `page.truthfulness.test.ts`, read `page.tsx` and enforce the real wiring rather than accepting unused helpers:

```ts
const source = readFileSync(
  resolve("src/app/(app)/insights/page.tsx"),
  "utf8",
);

expect(source).not.toMatch(/\bscanItems\b/);
expect(source).toContain("summarizeDistributorMetrics(allScans)");
expect(source).toContain("distributorSpendShare(metric.spend, distTotalSpend)");
for (const metric of [
  "inventory",
  "varietal-spend",
  "scan-activity",
  "extraction-accuracy",
  "scan-throughput",
  "top-distributors",
  "recent-activity",
]) {
  expect(source).toContain(`metric="${metric}"`);
}
expect(source).toMatch(
  /<YieldReportSection\s+groups=\{yieldGroups\}\s+rangeLabel=\{selectedRangeLabel\}\s*\/>/,
);
```

This test intentionally fails if the unfiltered query returns, the summarizer is merely created but not mounted, the zero-spend guard is bypassed, a page-owned scope label is omitted, or the page stops passing the selected label into the Yield section. The Yield component itself owns `metric="yield"`; the page test must not expect that marker directly in `page.tsx`.

- [ ] **Step 2: Run the scope, page-wiring, yield, and action tests and confirm RED**

Run:

```bash
pnpm exec vitest run \
  'src/app/(app)/insights/insight-scope.test.tsx' \
  'src/app/(app)/insights/page.truthfulness.test.ts' \
  'src/app/(app)/insights/yield-report-section.test.tsx' \
  'src/app/(app)/insights/briefing-alert-card.test.tsx'
```

Expected: FAIL because `InsightScope` does not exist, page wiring still uses the unfiltered distributor source and omits scope labels, Yield does not accept/render `rangeLabel`, and the briefing still renders `Add to menu`.

- [ ] **Step 3: Add the small scope label and apply it to the selected cards**

Implement a non-interactive server-safe component:

```tsx
export function InsightScope(props:
  | { metric: string; kind: "snapshot" }
  | { metric: string; kind: "range"; label: string }
) {
  const text = props.kind === "snapshot" ? "Current snapshot" : props.label;
  return <span data-insight-scope={props.metric} className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{text}</span>;
}
```

In `page.tsx`, compute `selectedRangeLabel = dateRangeLabel(range, sp.from, sp.to)` and place labels only on metrics whose inputs are demonstrably scoped:

- `Current snapshot` beside the owner metric grid (`metric="inventory"`) and Spend by varietal (`metric="varietal-spend"`);
- `selectedRangeLabel` beside the page-owned Scan activity, Extraction accuracy, Scan throughput, Top distributors, and Recent activity cards.

Pass `rangeLabel={selectedRangeLabel}` to `YieldReportSection`; inside `yield-report-section.tsx`, render `<InsightScope metric="yield" kind="range" label={rangeLabel} />` in its existing heading row. Update its component test to assert that exact label. Do not add a range label to Pour analytics in this move: it has a separate client/API fetch path and this plan does not add the end-to-end wiring proof needed to make that new claim. Do not imply that cellar inventory, 86 count, drink-window state, or varietal inventory spend is historical. Keep the selector above both kinds of metrics and add the exact explanatory line: `Selected range applies to invoice scans, distributor metrics, and partial-bottle yield. Inventory value, bottle counts, availability, and varietal spend are current.`

Delete the disabled Add to menu button and the stale comment bullets for Add to menu / Add to staff briefing from `briefing-alert-card.tsx`. Do not add a replacement action.

- [ ] **Step 4: Run all UX-08 focused tests**

Run:

```bash
pnpm exec vitest run \
  'src/app/(app)/insights/date-range-selector.test.tsx' \
  'src/app/(app)/insights/distributor-metrics.test.ts' \
  'src/app/(app)/insights/insight-scope.test.tsx' \
  'src/app/(app)/insights/page.truthfulness.test.ts' \
  'src/app/(app)/insights/yield-report-section.test.tsx' \
  'src/app/(app)/insights/briefing-alert-card.test.tsx'
```

Expected: all cases PASS.

### Task 4: Verify, audit, and create the single UX-08 commit

**Files:** all files listed in this plan, and no others.

- [ ] **Step 1: Run affected and repository verification**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
git diff --check -- \
  'src/app/(app)/insights/date-range-selector.tsx' \
  'src/app/(app)/insights/date-range-selector.test.tsx' \
  'src/app/(app)/insights/distributor-metrics.ts' \
  'src/app/(app)/insights/distributor-metrics.test.ts' \
  'src/app/(app)/insights/insight-scope.tsx' \
  'src/app/(app)/insights/insight-scope.test.tsx' \
  'src/app/(app)/insights/page.truthfulness.test.ts' \
  'src/app/(app)/insights/page.tsx' \
  'src/app/(app)/insights/yield-report-section.tsx' \
  'src/app/(app)/insights/yield-report-section.test.tsx' \
  'src/app/(app)/insights/briefing-alert-card.tsx' \
  'src/app/(app)/insights/briefing-alert-card.test.tsx'
```

Expected: tests, type checking, lint, and diff check all exit `0`.

- [ ] **Step 2: Complete the Grok 4.6 pre-commit audit**

Give `x-ai/grok-4.6` the UX-08 spec section, this plan, and the complete unstaged diff for only the listed files. Require an `APPROVE` or `REVISE` verdict and findings classified as blocking, important, or advisory. For `REVISE`, fix every blocking and important finding, rerun Step 1, and re-audit the complete revised diff. Do not commit until the verdict is `APPROVE` with zero blocking and zero important findings.

- [ ] **Step 3: Stage exact paths and commit once**

```bash
git add \
  'src/app/(app)/insights/date-range-selector.tsx' \
  'src/app/(app)/insights/date-range-selector.test.tsx' \
  'src/app/(app)/insights/distributor-metrics.ts' \
  'src/app/(app)/insights/distributor-metrics.test.ts' \
  'src/app/(app)/insights/insight-scope.tsx' \
  'src/app/(app)/insights/insight-scope.test.tsx' \
  'src/app/(app)/insights/page.truthfulness.test.ts' \
  'src/app/(app)/insights/page.tsx' \
  'src/app/(app)/insights/yield-report-section.tsx' \
  'src/app/(app)/insights/yield-report-section.test.tsx' \
  'src/app/(app)/insights/briefing-alert-card.tsx' \
  'src/app/(app)/insights/briefing-alert-card.test.tsx'
git commit -m "fix: make insight periods truthful"
```

Expected: one UX-08 commit containing only these production files and their tests.
