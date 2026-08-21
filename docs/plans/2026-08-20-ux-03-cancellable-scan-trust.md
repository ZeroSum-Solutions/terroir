# Cancellable Scan Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make invoice and bottle scans explain their current stage, expose estimated progress accessibly, cancel the active request safely, and recover without provider/model jargon.

**Architecture:** Keep the existing `Scanner` state machine and `AbortController`; replace the independent step-index state with a typed, mode-aware presentation stage derived from the current estimated progress. `ProcessingView` receives the stage and an explicit cancel callback, while `Scanner` owns all request abortion, key cleanup, and return-to-ready behavior. Make the existing error and ready views mode-aware so retry/manual actions cannot cross invoice and bottle workflows, and use one typed feedback contract for save/export failures and confirmations.

**Tech Stack:** TypeScript, React 19, Next.js 16 Client Components, Fetch/AbortController, Vitest with happy-dom, existing Tailwind v4 and Lucide.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](./2026-08-20-high-leverage-ux-portfolio-spec.md), UX-03.

## Global Constraints

- Preserve the existing `/api/scan` and `/api/scan-bottle` request, idempotency, persistence, retry, and manual-entry contracts.
- Progress is explicitly estimated; do not imply server-side percentage telemetry that does not exist.
- User-facing copy describes upload, extraction/identification, and review—not a provider or model.
- Cancel must abort the active request, clear the request key for the cancelled attempt, and return to a stable ready state without surfacing an error.
- Unmount must abort any active request.
- Bottle scanning remains discoverable inside `/scan`; do not create a second navigation destination or scanner redesign.
- Use existing tokens/dependencies, at least 44px controls, accessible names, `progressbar` semantics, and appropriate live-region roles.
- Begin with focused failing tests, obtain independent task review, and obtain a clean Grok 4.6 audit before the single final commit.

---

### Task 1: Define and render mode-aware processing stages

**Files:**

- Modify: `src/app/(app)/scan/views/processing-view.tsx`
- Create: `src/app/(app)/scan/views/processing-view.test.tsx`

**Interfaces:**

- Produces:

```ts
export type ScanStage = "upload" | "extract" | "identify" | "review";

export function stageForProgress(mode: ScanMode, progress: number): ScanStage;

interface ProcessingViewProps {
  progress: number;
  stage: ScanStage;
  mode: ScanMode;
  onCancel: () => void;
}
```

- Invoice sequence: Uploading invoice -> Extracting invoice details -> Preparing your review.
- Bottle sequence: Uploading label photo -> Identifying the wine -> Preparing your review.

- [ ] **Step 1: Write the failing stage and accessibility tests**

Test the exact boundaries `0`, `29`, `30`, `69`, `70`, and `95` for both modes. Render progress `45` and assert:

```ts
expect(progressbar).toHaveAttribute("aria-valuemin", "0");
expect(progressbar).toHaveAttribute("aria-valuemax", "100");
expect(progressbar).toHaveAttribute("aria-valuenow", "45");
expect(progressbar).toHaveAttribute(
  "aria-valuetext",
  "Extracting invoice details, estimated 45% complete",
);
expect(activeStep).toHaveAttribute("aria-current", "step");
```

Assert an `aria-live="polite"` stage announcement, a visible minimum-44px Cancel button, and absence of `Claude`, `Sonnet`, `OpenAI`, or any provider/model name.

Add a separate ownership assertion with deliberately mismatched inputs, such as `progress={45}` and `stage="review"`: the active label and `aria-valuetext` must use `Preparing your review`, not recompute `extract` from 45. `stageForProgress` owns derivation in Scanner; `ProcessingView` only consumes the passed `stage` and numeric progress.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
pnpm exec vitest run 'src/app/(app)/scan/views/processing-view.test.tsx'
```

Expected: FAIL because the view has no typed stage, progressbar semantics, live announcement, or Cancel action and currently exposes a model name.

- [ ] **Step 3: Implement the minimal presentation contract**

Keep the existing timer cadence and 90–95% pre-response cap, but make `stageForProgress` the only stage-threshold contract: upload is `< 30`, extraction/identification is `30–69`, and review is `>= 70`. Remove the old `< 60` step-index threshold with `stepIndex` so timer behavior and the boundary tests cannot disagree. Scanner calls `stageForProgress(mode, progress)` and passes the result; `ProcessingView` must consume that `stage` prop directly and must not call `stageForProgress` or derive a second stage from `progress`. Put `role="progressbar"`, the numeric ARIA values, and `aria-valuetext` on the bar container; mark the decorative fill `aria-hidden`. Mark only the active list item `aria-current="step"`, announce the active label in a visually-hidden polite live region, label the numeric value `Estimated progress`, replace the model label with task copy, and add:

```tsx
<button type="button" onClick={onCancel} className="mt-lg h-11 ...">
  Cancel scan
</button>
```

- [ ] **Step 4: Verify GREEN**

```bash
pnpm exec vitest run 'src/app/(app)/scan/views/processing-view.test.tsx'
```

Expected: stage boundaries, semantics, cancel callback, and provider-name absence all PASS.

### Task 2: Wire cancellation and request lifecycle in Scanner

**Files:**

- Modify: `src/app/(app)/scan/scanner.tsx`
- Create: `src/app/(app)/scan/scanner.test.tsx`

**Interfaces:**

- Consumes: `stageForProgress(mode, progress)` and the updated `ProcessingView` props.
- Produces: `cancelScan(): void`, which aborts `abortRef.current`, clears `abortRef.current` and `scanKeyRef.current`, resets progress/error state, and returns to `status="ready"` without deleting a previously completed persisted scan. The view stage is derived with `stageForProgress(mode, progress)` and has no independent mutable state.

- [ ] **Step 1: Write failing cancellation tests with a deferred fetch**

Mock `useRestaurant`, render `Scanner`, select an invoice file, and make `fetch` return a never-resolving promise that records `init.signal`. Assert the Processing view appears, click `Cancel scan`, then assert:

```ts
expect(capturedSignal.aborted).toBe(true);
expect(screenText()).toContain("Scan an invoice");
expect(screenText()).not.toContain("Couldn't read");
```

Repeat in Bottle mode and assert the stable state is `Scan a bottle label`. Add a separate test that starts a pending request, unmounts the root, and expects its signal to be aborted.

Prove cancellation does not reuse `startOver` without constructing the impossible state “hydrated persisted results while a fresh request is simultaneously processing.” Start from an empty local store, spy on `Storage.prototype.removeItem` (the observable effect of `saveScan(null)`), begin one deferred request, clear any setup calls, click Cancel, and assert `removeItem` was not called. Also assert the ready state is restored and the deferred request signal is aborted. Do not export or spy on the private `startOver` callback, and do not preseed a persisted scan just to force this assertion.

Add a separate idempotency lifecycle regression. Capture the first invoice request's `Idempotency-Key`, cancel that deferred attempt, select an invoice again, and capture the second request. Assert both URLs are exactly `/api/scan`, both keys are non-empty strings, and the second key differs from the cancelled attempt's key. This RED must prove cancellation clears `scanKeyRef.current`; do not satisfy it by changing modes or using the bottle endpoint.

Add a deferred bottle-JSON race regression. Let `fetch("/api/scan-bottle", ...)` resolve to an `ok: true` response whose `json()` returns a deferred promise. While JSON is pending, click Cancel; assert the captured signal is aborted and Ready shows `Scan a bottle label`. Resolve the JSON promise with a valid `BottleScanResult`, flush microtasks, and assert Ready remains visible and no Bottle Results content or mocked `BottleResultsView` appears. This must fail until the post-`await res.json()` abort guard exists.

Add a reset-on-start matrix for both modes without fake timers. First drive each mode through a successful attempt so Scanner sets progress to 100, use the corresponding Results/Bottle Results `onScanAnother` action to return to Ready, then start a second attempt while capturing the first `ProcessingView` props. For invoice and bottle, assert that first render is `{ progress: 0, stage: stageForProgress(mode, 0), mode }`; no render may expose the leftover 100/review state. The invoice case locks existing behavior, while the bottle case is RED until `startBottleScan` resets progress before entering processing.

Do not duplicate progress thresholds with fake timers in `scanner.test.tsx`. `stageForProgress` boundary tests in Task 1 are the sole threshold contract; Scanner lifecycle tests inspect only the first render props described above. Cancellation/request tests remain independent of `performance.now()` and timer cadence.

- [ ] **Step 2: Run the Scanner test and verify RED**

```bash
pnpm exec vitest run 'src/app/(app)/scan/scanner.test.tsx'
```

Expected: FAIL because there is no visible Cancel callback and unmount does not currently abort the active request.

- [ ] **Step 3: Implement cancellation without changing API behavior**

Add a dedicated `cancelScan` with `useCallback`; do not alias or call `startOver`. It must abort first, then clear the controller and cancelled scan idempotency key, reset `progress`, clear only transient scan error/raw text, and set ready while leaving an earlier completed persisted scan untouched. Remove `stepIndex`, `setStepIndex`, and their timer updates; reset progress before both invoice and bottle attempts and pass `stageForProgress(mode, progress)` to `ProcessingView`. Add a cleanup-only effect:

```ts
useEffect(() => () => abortRef.current?.abort(), []);
```

In both `startScan` and `startBottleScan`, clear `abortRef.current` only when the completing controller is still current, preventing an older request’s `finally` from clearing a newer controller. In `startBottleScan`, check `ac.signal.aborted` again immediately after `await res.json()` and before `setProgress`, `setBottleResult`, or `setStatus`; cancellation can occur while JSON is being decoded. Do not convert an `AbortError` into the Error view.

- [ ] **Step 4: Verify cancellation and the existing happy paths**

```bash
pnpm exec vitest run 'src/app/(app)/scan/scanner.test.tsx' \
  'src/app/api/scan/route.test.ts' \
  'src/app/api/scan-bottle/route.test.ts'
```

Expected: invoice cancel, bottle cancel during deferred JSON, no late bottle result after cancellation, no `saveScan(null)` side effect, a fresh invoice idempotency key after cancellation, both modes resetting the first processing render to progress 0 with their derived upload stage, and unmount abort PASS; existing route behavior remains green.

### Task 3: Make error recovery and bottle discoverability truthful

**Files:**

- Modify: `src/app/(app)/scan/views/error-view.tsx`
- Create: `src/app/(app)/scan/views/error-view.test.tsx`
- Modify: `src/app/(app)/scan/views/ready-view.tsx`
- Create: `src/app/(app)/scan/views/ready-view.test.tsx`
- Modify: `src/app/(app)/scan/scanner.tsx`
- Test: `src/app/(app)/scan/scanner.test.tsx`

**Interfaces:**

- `ErrorView` additionally consumes `mode: ScanMode`; invoice errors expose Retry, New photo, and Enter manually, while bottle errors expose Retry label scan and New photo without constructing an invoice manual-entry payload.
- Ready mode buttons expose toggle state with `aria-pressed`; the Bottle control remains on `/scan` and is the only new discoverability requirement.

- [ ] **Step 1: Write failing mode and target-size tests**

For `ErrorView`, assert `mode="invoice"` renders `Couldn't read the invoice`, `Retry invoice scan`, and `Enter manually`; `mode="bottle"` renders `Couldn't read the label`, `Retry label scan`, and no manual-invoice action. Both error panels must have `role="alert"` and an alert icon hidden from assistive technology.

For `ReadyView`, assert the Invoice and Bottle buttons expose mutually exclusive `aria-pressed` values and are at least 44px high. Assert selecting Bottle calls `onModeChange("bottle")`; do not add a `/scan-bottle` link. Audit every interactive button/action link in the modified Ready and Error views: each must retain `h-11`, `min-h-11`, or a larger fixed height at desktop as well as mobile. Tests must reject responsive overrides such as `md:h-[38px]`. This includes mode toggles, saved-result actions, `View all`, Take photo, Upload file, Retry, New photo, and Enter manually; large scan cards/drop targets may satisfy the rule with their existing larger box plus an explicit `min-h-11` contract.

In `scanner.test.tsx`, also drive invoice and bottle scans into their Error views with mode-specific rejected fetches, then click the rendered retry control. Clear the fetch spy immediately before each retry click. For invoice, assert the only retry request target is exactly `/api/scan`. For bottle, clear the fetch spy before clicking `Retry label scan`, then assert the only retry call is `fetch("/api/scan-bottle", expect.objectContaining({ method: "POST" }))` and assert no retry call targets `/api/scan`. Both assertions must inspect the URL, not merely the copy or callback count.

- [ ] **Step 2: Run the view tests and verify RED**

```bash
pnpm exec vitest run \
  'src/app/(app)/scan/views/error-view.test.tsx' \
  'src/app/(app)/scan/views/ready-view.test.tsx' \
  'src/app/(app)/scan/scanner.test.tsx'
```

Expected: FAIL because ErrorView always names an invoice, bottle mode can incorrectly expose manual invoice recovery and retries through `/api/scan`, the toggles lack pressed semantics, and desktop overrides still shrink controls below 44px.

- [ ] **Step 3: Implement mode-correct recovery and target sizes**

Add the `mode` prop to `ErrorView` and pass current Scanner mode. Keep retry bound to `lastFile`; for bottle mode, `retryScan` must route the file through `startBottleScan`, not `startScan`. Render manual entry only for invoice mode. Change ready toggle buttons to `aria-pressed={!isBottle}` and `aria-pressed={isBottle}`, and use `min-h-11` without changing the current inline switcher. Remove every `md:h-[38px]` override from the modified Ready/Error actions and give any other modified interactive action an explicit minimum-44px contract.

- [ ] **Step 4: Verify mode-correct retry and views GREEN**

Run the three focused view/scanner tests from Step 2. Expected: exact mode copy, bottle-only retry endpoint, pressed state, and minimum-44px desktop targets all PASS.

### Task 4: Make save/export feedback semantically truthful

**Files:**

- Modify: `src/app/(app)/scan/scanner.tsx`
- Modify: `src/app/(app)/scan/scanner.test.tsx`
- Modify: `src/app/(app)/scan/views/ready-view.tsx`
- Test: `src/app/(app)/scan/views/ready-view.test.tsx`

**Interfaces:**

- Scanner feedback distinguishes `{ kind: "success" | "error"; message: string }` so failures use `AlertTriangle` plus `role="alert"`, while confirmations use `Check` plus `role="status"`.
- Export callbacks catch synchronous download/DOM failures and convert them to error feedback; they must not report success after a thrown export.
- The existing post-save `savedResult` confirmation remains in `ReadyView`; only its confirmation text becomes a polite `role="status"` region, while adjacent action links and Dismiss stay outside that live region.

- [ ] **Step 1: Write five separate feedback regressions**

Keep these as separate tests so one status cannot accidentally satisfy another path:

1. **Save error:** reach invoice Results, make `/api/inventory/save-scan` reject or return a failing response, click Save, and assert `role="alert"`, the server/fallback message, and an `AlertTriangle` whose SVG is `aria-hidden="true"`.
2. **Export error:** reach invoice Results, mock `downloadCsv` to throw `new Error("export blocked")`, click CSV export, and assert `role="alert"` with `export blocked`, an alert icon, and no `Exported ...` success copy.
3. **Export success:** make `downloadCsv` succeed, click CSV export, and assert `role="status"`, `aria-live="polite"`, `Exported ...`, and the hidden Check icon.
4. **Existing saved-result success:** make inventory save return `{ itemCount: 2, wineCount: 2 }`, allow Scanner to return to Ready, and assert the text node containing `Saved 2 items to inventory` has `role="status"` and `aria-live="polite"`. Assert the adjacent `Add to wine list` and Dismiss controls are outside that status node. Do not satisfy this with the transient export feedback.
5. **Accuracy export error:** reach invoice Results, make the accuracy-report DOM export throw (for example, `URL.createObjectURL` throws `new Error("accuracy export blocked")`), click the accuracy export action, and assert `role="alert"`, `accuracy export blocked`, and no `Exported accuracy report` success copy.

Add the equivalent bottle-save failure assertion if the shared failure setter is not already covered by the invoice save test. Run the focused scanner/ready tests and expect RED because the current string toast always renders an assertive success icon, export exceptions escape, and the saved-result panel has no status semantics.

- [ ] **Step 2: Implement typed feedback and safe export reporting**

Replace `toast: string | null` with:

```ts
type Feedback = { kind: "success" | "error"; message: string };
const [feedback, setFeedback] = useState<Feedback | null>(null);
```

Set `kind="error"` in invoice-save and bottle-save catch paths. Wrap `exportCsv` and `exportAccuracyJson` in `try/catch`: only set success after the download/DOM work completes, and turn a thrown `Error` into error feedback without discarding its useful message. Render feedback errors with `AlertTriangle`, `role="alert"`, `aria-live="assertive"`; render export confirmations with `Check`, `role="status"`, `aria-live="polite"`. Mark both icons `aria-hidden="true"`. Update the existing auto-dismiss effect to guard on `feedback`, schedule `setFeedback(null)`, and depend on `[feedback]`; no stale `toast` identifier may remain. In `ReadyView`, put `role="status"` and `aria-live="polite"` only on the saved confirmation text, not the action-bearing panel; keep the panel persistent and independently dismissible. Do not expose provider/model names anywhere in these views.

- [ ] **Step 3: Run focused and full verification**

```bash
pnpm exec vitest run \
  'src/app/(app)/scan/views/processing-view.test.tsx' \
  'src/app/(app)/scan/views/error-view.test.tsx' \
  'src/app/(app)/scan/views/ready-view.test.tsx' \
  'src/app/(app)/scan/scanner.test.tsx' \
  'src/app/api/scan/route.test.ts' \
  'src/app/api/scan-bottle/route.test.ts'
pnpm test
pnpm exec tsc --noEmit
pnpm lint
git diff --check -- 'src/app/(app)/scan/scanner.tsx' \
  'src/app/(app)/scan/scanner.test.tsx' \
  'src/app/(app)/scan/views/processing-view.tsx' \
  'src/app/(app)/scan/views/processing-view.test.tsx' \
  'src/app/(app)/scan/views/error-view.tsx' \
  'src/app/(app)/scan/views/error-view.test.tsx' \
  'src/app/(app)/scan/views/ready-view.tsx' \
  'src/app/(app)/scan/views/ready-view.test.tsx'
```

Expected: focused and full tests PASS; type checking and lint exit 0; diff check prints nothing.

### Task 5: Independent review, Grok 4.6 audit, and one commit

- [ ] **Step 1: Obtain independent task-scope review**

Give a fresh reviewer UX-03, this plan, the complete scoped diff, and the focused output. Require explicit verification of invoice and bottle cancellation, no late bottle result after cancelling deferred JSON, no `saveScan(null)` cancellation side effect, a new invoice idempotency key after cancellation, both modes resetting the first processing render to progress 0/upload stage, controller cleanup/race safety including the post-JSON bottle abort guard, `ProcessingView` consuming rather than re-deriving its passed stage, the bottle retry calling only `/api/scan-bottle`, unmount abortion, semantic progress without duplicated timer thresholds, provider-name absence, 44px desktop targets, separate save/CSV/accuracy-export error coverage, export success status, confirmation-text-only saved-result status, the updated feedback dismiss effect, and typed error/success feedback. Resolve important findings test-first and rerun Task 4 Step 3.

- [ ] **Step 2: Pass the Grok 4.6 pre-commit gate**

Audit the complete scoped diff against this plan using exact model `x-ai/grok-4.6`. Require `APPROVE` with no unresolved blocking or important finding. On `REVISE`, first reproduce each valid finding in a focused test, make only scoped changes, rerun all verification, and re-audit. Do not commit before approval.

- [ ] **Step 3: Stage exact files and create the single UX-03 commit**

```bash
git add 'src/app/(app)/scan/scanner.tsx' \
  'src/app/(app)/scan/scanner.test.tsx' \
  'src/app/(app)/scan/views/processing-view.tsx' \
  'src/app/(app)/scan/views/processing-view.test.tsx' \
  'src/app/(app)/scan/views/error-view.tsx' \
  'src/app/(app)/scan/views/error-view.test.tsx' \
  'src/app/(app)/scan/views/ready-view.tsx' \
  'src/app/(app)/scan/views/ready-view.test.tsx'
git diff --cached --check
git commit -m "feat: make active scans cancellable"
```

Expected: one conventional commit containing only UX-03 production changes and regression tests.
