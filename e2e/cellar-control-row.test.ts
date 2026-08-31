import { expect, test, type Page } from "@playwright/test";

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
 * desktop and phone widths — and that whichever one it is does not overflow
 * sideways, which is the other half of the same rule.
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
});
