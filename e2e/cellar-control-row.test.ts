import { expect, test, type Page } from "@playwright/test";
import { expectRowFitsInFrame, measureRowFit } from "./one-row-rule";

/**
 * GLOBAL-01 / CELLAR-01 — Devin's rule, enforced where it actually lives.
 *
 * The rule is about a frame, not a file: "If you cannot fit all the buttons
 * horizontally in one frame, then there are too many buttons." The static
 * ratchet (scripts/check-control-rows.mjs) counts SOURCE containers and
 * therefore reports /cellar as 2 — the control bar and the sticky masthead.
 * Those two never appear together: the masthead only mounts once the
 * IntersectionObserver sentinel below the control bar has scrolled out, so at
 * every scroll position exactly one of them is on screen.
 *
 * A source count cannot tell you that. This can. Both containers carry
 * `data-cellar-control-row`; this spec asserts that exactly one of them
 * INTERSECTS THE VIEWPORT, at the top of the page and deep into a scroll, at
 * desktop and phone widths.
 *
 * ── THE OTHER HALF OF THE RULE ────────────────────────────────────────────
 *
 * One row in the frame is necessary and NOT sufficient. The rule is "if you
 * cannot FIT ALL THE BUTTONS horizontally in one frame, then there are too
 * many buttons" — so the row also has to fit. Until 2026-08-30 this spec
 * only checked that the PAGE did not scroll sideways, which /cellar passed
 * at 390px while showing 3 of its 10 controls and hiding the other 7 behind
 * 740px of scroll INSIDE the row: an `overflow-x-auto` child absorbs the
 * overflow, so `documentElement.scrollWidth` never grows.
 *
 * `expectRowFitsInFrame` (e2e/one-row-rule.ts) closes that: every control in
 * the row measured with `getBoundingClientRect()` against
 * `window.innerWidth`, and no sideways-scrollable element inside the row.
 * A horizontally scrolling row is not a row that fits — it is the same
 * "too many buttons" defect with the evidence hidden.
 *
 * Conventions match global-search.test.ts: dev-login auth, hard skip unless
 * Supabase is loopback, because .env.local holds production credentials.
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

/** Rows whose box overlaps the viewport rect — "what is in the frame". */
async function controlRowsInFrame(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-cellar-control-row]"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return r.bottom > 0 && r.top < window.innerHeight;
      })
      .map((el) =>
        el.hasAttribute("data-cellar-masthead") ? "masthead" : "control-bar",
      ),
  );
}

test.describe("@global-01 the cellar shows exactly one control row", () => {
  test.skip(
    !isLoopbackSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL),
    "Requires a loopback Supabase; .env.local points at production.",
  );
  test.describe.configure({ mode: "serial" });

  async function login(page: Page) {
    const response = await page.request.get("/api/dev-login");
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  for (const [label, width, height] of [
    ["desktop", 1440, 900],
    ["phone", 390, 844],
  ] as const) {
    test(`${label}: one row at the top, one row when scrolled`, async ({ page }) => {
      await login(page);
      await page.setViewportSize({ width, height });
      await page.goto("/cellar");
      await page.locator("[data-cellar-control-row]").first().waitFor();

      expect(await controlRowsInFrame(page)).toEqual(["control-bar"]);

      // Far enough that the sentinel has passed under the app header and the
      // masthead has taken over.
      await page.mouse.wheel(0, 2400);
      await page.waitForFunction(
        () => document.querySelector("[data-cellar-masthead]") !== null,
        undefined,
        { timeout: 5_000 },
      );

      const scrolled = await controlRowsInFrame(page);
      expect(
        scrolled,
        `expected one control row in frame while scrolled, saw: ${scrolled.join(", ")}`,
      ).toEqual(["masthead"]);
    });
  }

  test("phone: the single row does not force the page sideways", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/cellar");
    await page.locator("[data-cellar-control-row]").first().waitFor();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, "horizontal page overflow at 390px").toBeLessThanOrEqual(1);
  });

  for (const [label, width, height] of [
    ["desktop", 1440, 900],
    ["phone", 390, 844],
  ] as const) {
    test(`${label}: every control in the row fits inside the frame`, async ({ page }) => {
      await login(page);
      await page.setViewportSize({ width, height });
      await page.goto("/cellar");
      await page.locator("[data-cellar-control-row]").first().waitFor();

      const top = await measureRowFit(page, "[data-cellar-control-row]");
      expectRowFitsInFrame(top, `/cellar control bar at ${width}px`);

      // And again for the sticky masthead, which is the row in frame for the
      // rest of the page's scroll depth.
      await page.mouse.wheel(0, 2400);
      await page.waitForFunction(
        () => document.querySelector("[data-cellar-masthead]") !== null,
        undefined,
        { timeout: 5_000 },
      );
      const stuck = await measureRowFit(page, "[data-cellar-control-row]");
      expectRowFitsInFrame(stuck, `/cellar sticky masthead at ${width}px`);
    });
  }

  /**
   * Fewer controls is only the right answer while every action is still
   * reachable. The row demotes Open bottles, Reconcile and Cellar settings
   * into one overflow control on a phone — and Cellar settings there at every
   * width, because it is the only route to /cellar/config. This is the half of
   * the fix a fit measurement cannot see.
   */
  test("phone: the demoted actions are all reachable from the overflow menu", async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/cellar");
    await page.locator("[data-cellar-control-row]").first().waitFor();

    await page.getByRole("button", { name: "More cellar actions" }).click();
    const menu = page.getByRole("menu", { name: "More cellar actions" });
    await expect(menu.getByRole("menuitem", { name: /^Open bottles \d+$/ })).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /^Reconcile \d+ open bottles?$/ }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Cellar settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("desktop: only Cellar settings is demoted; the rest are pills in the row", async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/cellar");
    await page.locator("[data-cellar-control-row]").first().waitFor();

    const row = page.locator("[data-cellar-control-row]").first();
    await expect(row.getByRole("link", { name: /^Open bottles \d+$/ })).toBeVisible();
    await expect(
      row.getByRole("button", { name: /^Reconcile \d+ open bottles? →$/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: "More cellar actions" }).click();
    const menu = page.getByRole("menu", { name: "More cellar actions" });
    await expect(menu.getByRole("menuitem", { name: "Cellar settings" })).toBeVisible();
    // The phone-demoted pair is `sm:hidden`, so it is never offered twice in
    // the same frame.
    await expect(menu.getByRole("menuitem", { name: /^Open bottles/ })).toBeHidden();
  });
});
