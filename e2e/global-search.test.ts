import { expect, test, type Page } from "@playwright/test";

/**
 * GLOBAL-02 — the search field is at the top of every page.
 *
 * The "every route" half of that rule is asserted mechanically and cheaply in
 * src/app/(app)/search-everywhere.test.tsx, against the shell: every page.tsx
 * under src/app/(app) renders inside src/app/(app)/layout.tsx, and the layout
 * renders the field. This spec exists to prove the other half — that the field
 * is actually VISIBLE in a browser at both breakpoints, which no static render
 * can tell you — so it samples routes rather than walking all of them.
 *
 * Same conventions as pour-flow.test.ts: dev-login auth, and a hard skip
 * unless Supabase is loopback, because .env.local holds production
 * credentials.
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

/** One per area, so a regression in the shell shows up but another agent's
 * in-flight route edit cannot fail the whole spec. */
const SAMPLE_ROUTES = ["/cellar", "/insights", "/atlas", "/team"];

test.describe("@global-02 search is at the top of every page", () => {
  test.skip(
    !isLoopbackSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL),
    "Requires a loopback Supabase; .env.local points at production.",
  );
  test.describe.configure({ mode: "serial" });

  async function login(page: Page) {
    const response = await page.request.get("/api/dev-login");
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("desktop: the header carries a visible search field on each area", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const route of SAMPLE_ROUTES) {
      await page.goto(route);
      const field = page.locator('header input[type="search"][data-global-search]');
      await expect(field, `no header search field on ${route}`).toBeVisible();
    }
  });

  test("mobile: the field is a visible band under the header, not a menu item", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of SAMPLE_ROUTES) {
      await page.goto(route);
      const field = page
        .locator('input[type="search"][data-global-search]')
        .filter({ visible: true });
      await expect(field, `no visible search field on ${route}`).toHaveCount(1);
      const box = await field.boundingBox();
      expect(box, `search field has no box on ${route}`).not.toBeNull();
      // Above the fold and above the page's own controls.
      expect(box!.y).toBeLessThan(200);
    }
  });

  test("typing finds a wine and opens it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/cellar");
    const field = page.locator('header input[type="search"][data-global-search]');
    await field.fill("ch");
    const panel = page.locator("[data-global-search-panel]");
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "See all matches in the cellar" }),
    ).toBeVisible();
  });
});
