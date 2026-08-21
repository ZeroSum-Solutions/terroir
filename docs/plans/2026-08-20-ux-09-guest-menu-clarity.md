# Guest Menu Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let a guest interpret prices and availability, assess menu freshness, and share the public menu from a phone without insider knowledge.

**Architecture:** Keep the public page server-rendered and add one narrowly scoped Client Component for browser sharing APIs. Extend the existing published-list query with timestamps already present in the schema, compute freshness with a pure helper, and reserve explicit logo dimensions without introducing image-host configuration. The route continues to fetch exactly one published list by slug, so no menu switcher is added.

**Tech Stack:** Next.js 16.2.4 App Router, React 19.2.4 Server and Client Components, TypeScript 5, Supabase, Tailwind CSS 4, Vitest 4.1.4, happy-dom, Web Share API, Clipboard API.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](./2026-08-20-high-leverage-ux-portfolio-spec.md), UX-09.

## Global Constraints

- Preserve the public menu's current theme and the identity in `DESIGN.md`; do not redesign the menu.
- Add no dependency, guest account, public data source, or published-list switcher.
- Keep the route's existing `.single()` published-list contract.
- Do not modify `src/lib/wine-list/render.ts`; freshness is a public-page concern and must use its existing rendered result as a read-only visibility boundary.
- Treat `390px` as the minimum review width and make Share at least `44px` high.
- Use `Glass` and `Bottle` labels; use `Unavailable` rather than restaurant shorthand in guest copy.
- Do not expose bin data beyond the existing `show_bin_codes` contract.
- Do not mutate production data during testing.
- Read `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` and `node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md` before implementation. Keep browser APIs inside the new Client Component; reserve explicit intrinsic logo dimensions.
- Use test-driven development and create no interim commit. The move receives one final commit only after the Grok 4.6 gate passes.

---

## File Map

- Create `src/app/list/[slug]/menu-freshness.ts`: pure newest-timestamp and display formatter.
- Create `src/app/list/[slug]/menu-freshness.test.ts`: valid, invalid, and ordering coverage.
- Create `src/app/list/[slug]/public-menu-share.tsx`: native share with clipboard recovery and announced status.
- Create `src/app/list/[slug]/public-menu-share.test.tsx`: native-share and clipboard-fallback interaction coverage.
- Create `src/app/list/[slug]/page.clarity.test.tsx`: server-rendered price, availability, freshness, logo, and Share integration coverage.
- Modify `src/app/list/[slug]/page.tsx`: select timestamps, render the new guest clarity content, and mount Share.

### Task 1: Compute and display trustworthy menu freshness

**Files:**
- Create: `src/app/list/[slug]/menu-freshness.ts`
- Create: `src/app/list/[slug]/menu-freshness.test.ts`
- Modify: `src/app/list/[slug]/page.tsx`

**Interfaces:**
- Consumes: the list `updated_at` and raw item `updated_at` ISO strings already stored by Supabase, restricted on the server to item IDs that survive the existing rendered-section pipeline.
- Produces: `newestValidTimestamp(values: Array<string | null | undefined>): string | null` and `formatMenuFreshness(iso: string): string`.

- [ ] **Step 1: Write the failing freshness tests**

```ts
it("uses the newest valid list or visible-item timestamp", () => {
  expect(
    newestValidTimestamp([
      "2026-08-18T10:00:00.000Z",
      "not-a-date",
      "2026-08-20T16:30:00.000Z",
      null,
    ]),
  ).toBe("2026-08-20T16:30:00.000Z");
});

it("formats a stable guest-facing freshness label", () => {
  expect(formatMenuFreshness("2026-08-20T16:30:00.000Z")).toBe(
    "Updated Aug 20, 2026",
  );
});
```

Add a case asserting `newestValidTimestamp([null, "bad"])` returns `null`.

- [ ] **Step 2: Run the freshness test and confirm RED**

Run:

```bash
pnpm exec vitest run 'src/app/list/[slug]/menu-freshness.test.ts'
```

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the pure helper and extend the public query**

Implement `newestValidTimestamp` by parsing each value once, rejecting non-finite timestamps, and returning the original ISO string associated with the largest epoch. Implement `formatMenuFreshness` with `Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })` and prefix `Updated `.

In `page.tsx`, add root `updated_at` and nested `wine_list_items(updated_at, ...)` to the existing select string and add `updated_at: string` to the raw `PublicWineItem`. Do not modify `renderWineListSections` and do not read `updated_at` from its transformed item type. After `sections` is produced, derive visibility and timestamps explicitly:

```ts
const renderedItemIds = new Set(
  sections.flatMap((section) => section.items.map((item) => item.id)),
);
const renderedItemTimestamps = visibleSections.flatMap((section) =>
  section.wine_list_items
    .filter((item) => renderedItemIds.has(item.id))
    .map((item) => item.updated_at),
);
const freshestIso = newestValidTimestamp([
  list.updated_at,
  ...renderedItemTimestamps,
]);
```

Because `visibleSections` already removes `hidden` items and `renderedItemIds` excludes items removed by the `hide` 86 strategy, only actually rendered wines can advance freshness. Root `wine_lists.updated_at` is non-null, but render `Updated recently` as a defensive fallback if all received values are invalid.

- [ ] **Step 4: Run the freshness tests and confirm GREEN**

Run the Step 2 command.

Expected: all freshness cases PASS.

### Task 2: Add native Share with clipboard fallback

**Files:**
- Create: `src/app/list/[slug]/public-menu-share.tsx`
- Create: `src/app/list/[slug]/public-menu-share.test.tsx`

**Interfaces:**
- Consumes: `{ title: string; text: string }`; the client reads `window.location.href` at activation time.
- Produces: a `Share menu` button and a polite status message: `Menu shared`, `Link copied`, or a recoverable failure instruction.

- [ ] **Step 1: Write failing browser-interaction tests**

```tsx
it("uses native share when available", async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "share", { configurable: true, value: share });
  window.history.replaceState({}, "", "/list/dinner");
  await renderShare();
  await act(async () => findButton("Share menu").click());
  expect(share).toHaveBeenCalledWith({
    title: "Dinner · Example",
    text: "View the current wine list at Example.",
    url: window.location.href,
  });
  expect(container.textContent).toContain("Menu shared");
});
```

Add a second case with `navigator.share` undefined and `navigator.clipboard.writeText` mocked; assert the current URL is copied and `Link copied` is announced. Add a third case where native share rejects with a non-`AbortError`; assert the component attempts clipboard fallback. Add a fourth using `const cancelled = new Error("cancelled"); cancelled.name = "AbortError"`; assert clipboard is not called and no success or error status appears. Cancellation detection must work by the error's `name`, not by `instanceof DOMException`.

- [ ] **Step 2: Run the share test and confirm RED**

Run:

```bash
pnpm exec vitest run 'src/app/list/[slug]/public-menu-share.test.tsx'
```

Expected: FAIL because `PublicMenuShare` does not exist.

- [ ] **Step 3: Implement the minimal Client Component**

Start the file with `"use client"`. Use a single async handler:

```ts
const payload = { title, text, url: window.location.href };
if (typeof navigator.share === "function") {
  try {
    await navigator.share(payload);
    setStatus("Menu shared");
    return;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    ) return;
  }
}
try {
  await navigator.clipboard.writeText(payload.url);
  setStatus("Link copied");
} catch {
  setStatus("Unable to share. Copy the address from your browser.");
}
```

Render a semantic `button` with `min-h-11`, `print:hidden`, visible `Share menu` text, and `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2`. Mark the decorative share icon from the existing `lucide-react` dependency `aria-hidden="true"`. Use a separate `<span role="status" aria-live="polite" className="print:hidden">` for non-empty status. Do not request browser permissions in advance and do not copy anything until the guest activates the button.

- [ ] **Step 4: Run the share tests and confirm GREEN**

Run the Step 2 command.

Expected: native share, clipboard fallback, and native-failure recovery cases PASS.

### Task 3: Make price, availability, and logo layout explicit

**Files:**
- Create: `src/app/list/[slug]/page.clarity.test.tsx`
- Modify: `src/app/list/[slug]/page.tsx`

**Interfaces:**
- Consumes: the existing glass/bottle values, `is_marked_eightysixed`, restaurant logo URL, and the Task 1/2 helpers.
- Produces: unambiguous guest-facing labels, reserved logo space, freshness, availability copy, and Share integration.

- [ ] **Step 1: Write the failing server-page integration test**

Follow the Supabase and `notFound` mock pattern in `page.theme.test.tsx`. Build a complete list fixture containing every field selected or read by the page: root `name`, `template`, `theme`, `updated_at`, `restaurant_id`, `show_bin_codes`; restaurant `name`, `eightysix_strategy`, `logo_url`; section `id`, `name`, `position`; item `id`, `position`, `updated_at`, `glass_price`, `bottle_price`, `tasting_note`, `blurb`, `hidden`, `name_override`; and wine `id`, `name`, `producer`, `vintage`, `varietal`, `region`, `serving_temp_min`, `serving_temp_max`, `serving_temp_label`, `is_eightysixed`. Use strategy `mark`, a logo URL, and one visible marked-unavailable wine with glass price `14` and bottle price `58`. Render `PublicWineListPage` to static markup and assert:

```tsx
expect(main.textContent).toContain("Glass $14");
expect(main.textContent).toContain("Bottle $58");
expect(main.textContent).toContain("Unavailable");
expect(main.textContent).toContain("Updated Aug 20, 2026");
expect(main.textContent).toContain("Share menu");
const logo = main.querySelector<HTMLImageElement>('img[alt="Example"]')!;
expect(logo.getAttribute("width")).toBe("200");
expect(logo.getAttribute("height")).toBe("40");
```

Add a second fixture with only one price and assert the remaining label is still explicit. Make the mock `single` function a spy, assert it is called once, and assert the page contains no published-list switcher; this locks the one-list route contract without adding a second query.

Add a freshness visibility fixture with an old list timestamp plus three items: a rendered available item updated Aug 18, a `hidden: true` item updated Aug 20, and an unavailable item updated Aug 19 under strategy `hide`. Assert the guest sees `Updated Aug 18, 2026`, not Aug 19 or Aug 20. This must exercise the real page transform so hidden and strategy-hidden items cannot advance freshness.

- [ ] **Step 2: Run the clarity test and confirm RED**

Run:

```bash
pnpm exec vitest run 'src/app/list/[slug]/page.clarity.test.tsx'
```

Expected: FAIL because prices are bare, availability says `86'd`, freshness and Share are absent, and the logo has no dimensions.

- [ ] **Step 3: Render the minimal guest clarity changes**

In the header, add a `flex flex-wrap items-start justify-between gap-md` content row with a `min-w-0 flex-1` title/freshness group and a `shrink-0 print:hidden` Share region. Mount `<PublicMenuShare title={`${list.name} · ${restaurantName}`} text={`View the current wine list at ${restaurantName}.`} />` and the freshness label near the list title. For an empty restaurant name, use `list.name` as the share title and `View the current wine list.` as text. The wrap is required at 390px; do not force title and Share into one non-wrapping line.

Change price output to `Glass ${format}` and `Bottle ${format}` in both single- and dual-price cases. Replace the guest-visible `86'd` label with `Unavailable`; retain the existing muted and strikethrough treatment and eightysix strategy. Update the empty-state support line to `Availability changes during service; check back soon for the latest list.`

Keep the existing `<img>` because arbitrary restaurant-hosted URLs are not configured for Next Image. Add intrinsic `width={200}` and `height={40}`, keep `object-contain`, and use a fixed `h-10 w-[200px] max-w-full` frame so layout space is reserved before the logo loads.

Extend `page.clarity.test.tsx` to assert the header row contains `flex-wrap`, the Share button contains `print:hidden` plus the exact focus-ring tokens from Task 2, and the icon has `aria-hidden="true"`.

- [ ] **Step 4: Run all UX-09 focused tests**

```bash
pnpm exec vitest run \
  'src/app/list/[slug]/menu-freshness.test.ts' \
  'src/app/list/[slug]/public-menu-share.test.tsx' \
  'src/app/list/[slug]/page.clarity.test.tsx' \
  'src/app/list/[slug]/page.theme.test.tsx' \
  'src/app/list/[slug]/public-bin-codes.test.ts'
```

Expected: all cases PASS, including existing theme and bin-code boundaries.

### Task 4: Verify, audit, and create the single UX-09 commit

**Files:** all files listed in this plan, and no others.

- [ ] **Step 1: Run affected and repository verification**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
git diff --check -- \
  'src/app/list/[slug]/menu-freshness.ts' \
  'src/app/list/[slug]/menu-freshness.test.ts' \
  'src/app/list/[slug]/public-menu-share.tsx' \
  'src/app/list/[slug]/public-menu-share.test.tsx' \
  'src/app/list/[slug]/page.tsx' \
  'src/app/list/[slug]/page.clarity.test.tsx'
git diff --exit-code -- src/lib/wine-list/render.ts
```

Expected: tests, type checking, lint, diff check, and the shared-renderer unchanged check all exit `0`.

- [ ] **Step 2: Complete responsive and keyboard evidence**

At a local or isolated preview, inspect `/list/<published-fixture-slug>` at exactly `390px` and desktop width. Verify the header wraps without horizontal overflow, logo space does not change after load, price labels remain paired with their values, Share is absent from print preview, Share has a visible focus indicator, Enter and Space activate it, and status announcements do not move focus. Use mocked/isolated list data; do not alter the shared production database.

- [ ] **Step 3: Complete the Grok 4.6 pre-commit audit**

Give `x-ai/grok-4.6` the UX-09 spec section, this plan, focused test evidence, and the complete unstaged diff for only the listed files. Require an `APPROVE` or `REVISE` verdict and findings classified as blocking, important, or advisory. For `REVISE`, fix every blocking and important finding, rerun Steps 1–2, and re-audit the complete revised diff. Do not commit until the verdict is `APPROVE` with zero blocking and zero important findings.

- [ ] **Step 4: Stage exact paths and commit once**

```bash
git add \
  'src/app/list/[slug]/menu-freshness.ts' \
  'src/app/list/[slug]/menu-freshness.test.ts' \
  'src/app/list/[slug]/public-menu-share.tsx' \
  'src/app/list/[slug]/public-menu-share.test.tsx' \
  'src/app/list/[slug]/page.tsx' \
  'src/app/list/[slug]/page.clarity.test.tsx'
git commit -m "feat: clarify the public wine menu"
```

Expected: one UX-09 commit containing only these production files and their tests.
