import { expect, test, type Page } from "@playwright/test";
import {
  expectRowFitsInFrame,
  expectTouchTargets,
  measureRowFit,
} from "./one-row-rule";
import { enterProdShape, leaveProdShape } from "./prodshape";

/**
 * GLOBAL-01 across the surfaces /cellar's pass did not reach.
 *
 * Devin's rule, verbatim: "If you cannot fit all the buttons horizontally in
 * one frame, then there are too many buttons." `e2e/cellar-control-row.test.ts`
 * asks that question of /cellar; this asks it of the other six rows that were
 * reported as suspects, using the same measurement module so there is exactly
 * one definition of "fits" in this repo.
 *
 * Every case here was measured at 390×844 against the running app BEFORE any
 * fix, and the numbers are recorded next to each test. One reported suspect —
 * `ChunkUploadProgress`'s per-chunk row — measured clean and is not gated here;
 * see the note at the bottom of this file.
 *
 * 390×844 is the viewport that matters: it is the owner's phone, and it is the
 * width at which every one of these rows failed.
 */

function isLoopbackSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

const PHONE = { width: 390, height: 844 };

/** The seed's one published, active list — archived and restored by SD-14. */
const PUBLISHED_LIST_ID = "de100005-0000-4000-8000-000000000001";

async function login(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe("@global-01 every control row fits the phone frame", () => {
  test.skip(
    !isLoopbackSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL),
    "Requires a loopback Supabase; .env.local points at production.",
  );
  // Not `serial`: these six surfaces are independent, and a serial describe
  // block skips every test after the first failure — which is precisely the
  // moment you want all six numbers. `workers: 1` already sequences them.
  test.describe.configure({ mode: "default" });

  /**
   * BEFORE: 4 chips — All 65px, Complete 101px, Processing 107px, Failed 82px —
   * against 354px of usable row. The fourth wrapped: three at y=275, "Failed" at
   * y=327. Two visual lines, one `flex-wrap` element, invisible to the ratchet.
   */
  test("/scans: the status filter is one control, not a wrapping chip strip", async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize(PHONE);
    await page.goto("/scans");
    await page.locator("[data-scan-filter-row]").waitFor();

    const fit = await measureRowFit(page, "[data-scan-filter-row]");
    expectRowFitsInFrame(fit, "/scans status filter at 390px");
    expectTouchTargets(fit, "/scans status filter at 390px");
  });

  /**
   * BEFORE: an archived AND published list card showed five controls — Copy link
   * 99px, Open 79px, Clone 81px, Restore 44px, Delete 44px. The fifth painted at
   * x=[373…417] on a 390px screen: 27px of it off the right edge, with no scroll
   * anywhere to reach it. Reaching that state needs a list that is both
   * published and archived, which the seed does not ship, so the test makes one
   * and puts it back.
   */
  test("/lists: a card footer fits even when the list is archived AND published", async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize(PHONE);

    const archived = await page.request.patch(`/api/wine-lists/${PUBLISHED_LIST_ID}`, {
      data: { archived: true },
    });
    expect(archived.ok(), await archived.text()).toBeTruthy();
    try {
      await page.goto("/lists?show_archived=1");
      await page.locator("[data-list-card-actions]").first().waitFor();

      // Every card, by id: the footer's control count depends on the list's
      // own published/archived state, and the five-control case is one card.
      const ids = await page.locator("[data-list-card-actions]").evaluateAll(
        (nodes) => nodes.map((node) => node.getAttribute("data-list-card-actions") ?? ""),
      );
      expect(ids.length, "expected at least one list card").toBeGreaterThan(0);
      for (const id of ids) {
        const where = `/lists card footer ${id} at 390px`;
        // `measureRowFit` measures the row the eye can see, so the archived
        // section's cards have to be brought into the frame first.
        await page.locator(`[data-list-card-actions="${id}"]`).scrollIntoViewIfNeeded();
        const fit = await measureRowFit(page, `[data-list-card-actions="${id}"]`);
        expectRowFitsInFrame(fit, where);
        expectTouchTargets(fit, where);
      }
      // Same half of the fix `e2e/cellar-control-row.test.ts` checks: three
      // controls is only right while the three that left are still reachable.
      await page
        .getByRole("button", { name: "More actions for By the Glass" })
        .click();
      const menu = page.getByRole("menu", { name: "More actions for By the Glass" });
      for (const action of ["Clone", "Restore", "Permanently delete"]) {
        await expect(menu.getByRole("menuitem", { name: action })).toBeVisible();
      }
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    } finally {
      const restored = await page.request.patch(`/api/wine-lists/${PUBLISHED_LIST_ID}`, {
        data: { archived: false },
      });
      expect(restored.ok(), await restored.text()).toBeTruthy();
    }
  });

  /**
   * BEFORE: the six preset pills fitted on one line (36…350 of 354). Picking
   * Custom added a from field 130px, a to field 130px and Apply 57px as a
   * sibling row, and the control went to NINE controls on THREE visual lines —
   * y=674, y=726, y=778.
   */
  test("/insights: the date range stays one line once Custom is picked", async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize(PHONE);
    await page.goto("/insights");
    await page.locator("[data-date-range-row]").waitFor();

    const presets = await measureRowFit(page, "[data-date-range-row]");
    expectRowFitsInFrame(presets, "/insights date range (presets) at 390px");
    expectTouchTargets(presets, "/insights date range (presets) at 390px");

    await page.getByRole("radio", { name: "Custom" }).click();
    await page.locator("#dr-from").waitFor();

    const custom = await measureRowFit(page, "[data-date-range-row]");
    expectRowFitsInFrame(custom, "/insights date range (Custom open) at 390px");
    expectTouchTargets(custom, "/insights date range (Custom open) at 390px");

    // Fewer controls in the row is only the right answer while the demoted ones
    // are still usable. The panel is a stacked FORM, so it is not held to one
    // line — it is held to being on screen and tappable.
    const panel = await measureRowFit(page, "[data-date-range-custom]");
    expect(
      panel.clipped.map((c) => c.label),
      "the custom-range panel puts a control outside the 390px frame",
    ).toEqual([]);
    expect(panel.controls.length, "custom-range panel controls").toBe(3);
    expectTouchTargets(panel, "/insights custom-range panel at 390px");
    await expect(page.getByRole("button", { name: "Apply" })).toBeVisible();
  });

  /**
   * BEFORE, in the production-shaped tenant (51 actionable items — the demo
   * tenant's shorter labels happen to fit, which is why this one runs against
   * prodshape): "Select actionable (51)" 147px + "51 selected" 56px + "Accept 51
   * items" 146px against 354px. Two visual lines, the accept button pushed under
   * the other two.
   */
  test("/reconcile-queue: the bulk rail is one line at the production row count", async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize(PHONE);
    await enterProdShape(page);
    try {
      await page.goto("/reconcile-queue");
      await page.locator("[data-bulk-rail]").waitFor({ timeout: 20_000 });
      // The rail is `position: sticky; bottom:` — it only pins once the page is
      // scrolled far enough that it would otherwise be below the fold, and the
      // queue is long. Measure it where a phone actually sees it.
      await page.locator("[data-bulk-rail]").scrollIntoViewIfNeeded();

      const idle = await measureRowFit(page, "[data-bulk-rail]");
      expectRowFitsInFrame(idle, "/reconcile-queue bulk rail (none selected) at 390px");
      expectTouchTargets(idle, "/reconcile-queue bulk rail (none selected) at 390px");

      // The widest state: every label carries its largest number.
      await page.getByRole("button", { name: /^Select actionable \(\d+\)$/ }).click();
      await expect(page.getByRole("button", { name: "Clear actionable" })).toBeVisible();

      const selected = await measureRowFit(page, "[data-bulk-rail]");
      expectRowFitsInFrame(selected, "/reconcile-queue bulk rail (all selected) at 390px");
      expectTouchTargets(selected, "/reconcile-queue bulk rail (all selected) at 390px");
    } finally {
      await leaveProdShape(page);
    }
  });

  /**
   * BEFORE: the bin table is 773px wide inside a 352px `overflow-x-auto`, so
   * 421px of it is off-screen — and the two controls on every row, Edit and
   * Retire, were entirely inside that off-screen part. 46 buttons on a 23-bin
   * cellar, none reachable without discovering a sideways scroll the page gives
   * no hint of (`documentElement.scrollWidth` never grows).
   *
   * The table itself may keep scrolling: six columns of bin data are data, not
   * buttons, and the rule is about buttons. What may not happen is a CONTROL
   * living behind that scroll. The reproducible demo seed has no bin rows, so
   * this check explicitly enters the production-shaped fixture that owns them.
   * `measureRowFit` on the `<tr>` answers exactly
   * that — the scroll container is the row's ancestor, not its descendant, so
   * what this asserts is "every control on this row is inside the 390px frame",
   * which is the half of the rule the table geometry does not excuse.
   */
  test("/bins: every row control is in the frame despite the table's scroll", async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize(PHONE);
    await enterProdShape(page);
    try {
      await page.goto("/bins");
      await page.locator("[data-bin-row]").first().waitFor();
      await page.locator("[data-bin-row]").first().scrollIntoViewIfNeeded();

      const fit = await measureRowFit(page, "[data-bin-row]");
      expectRowFitsInFrame(fit, "/bins row controls at 390px");
      expectTouchTargets(fit, "/bins row controls at 390px");
    } finally {
      await leaveProdShape(page);
    }
  });

  /**
   * BEFORE: both controls fitted on one line — and neither could be tapped
   * reliably. Print was `h-[36px]` and measured 36px tall; "Back to editor" was
   * an unpadded inline link and measured 21px. The floor is 44px.
   */
  test("/lists/[id]/print: the controls fit AND clear the 44px floor", async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize(PHONE);
    await page.goto(`/lists/${PUBLISHED_LIST_ID}/print`);
    await page.locator("[data-print-controls]").waitFor();

    const fit = await measureRowFit(page, "[data-print-controls]");
    expectRowFitsInFrame(fit, "/lists/[id]/print controls at 390px");
    expectTouchTargets(fit, "/lists/[id]/print controls at 390px");
  });
});

/**
 * ── REFUTED, and deliberately not gated ──────────────────────────────────
 *
 * `src/app/(app)/import/chunk-upload-progress.tsx`'s per-chunk row was reported
 * as a non-wrapping row that would overflow. It does not. The row only mounts
 * after a >4,000-row chunked upload whose second chunk is byte-identical to the
 * first, which no fixture reaches, so its widest state — "Chunk 2", a failure
 * message, "Import anyway" and "Skip this chunk" — was measured by putting that
 * exact markup into a real page at 390px: the row painted x=[37…353] inside a
 * 390px frame with 0px of sideways scroll and 0px of page overflow, every
 * control inside the frame. Both buttons stay at or above 44px (`min-h-11`);
 * they wrap their own labels rather than pushing the row wide. There is nothing
 * to fix, so nothing was changed there.
 */
