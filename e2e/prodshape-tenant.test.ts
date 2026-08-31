import { expect, test, type Page } from "@playwright/test";
import {
  PRODSHAPE_RESTAURANT_ID,
  PRODSHAPE_RESTAURANT_NAME,
  enterProdShape,
  leaveProdShape,
} from "./prodshape";

/**
 * The guard on the production-shaped fixture (scripts/local/prodshape.sh).
 *
 * Two claims, and the first one is the load-bearing half: adding a second
 * membership to the dev-login owner is exactly the change that would silently
 * break every other spec in this directory, because
 * `src/lib/api/resolve-active-membership.ts` falls back to the MOST RECENTLY
 * CREATED membership and a dozen specs re-implement that lookup themselves.
 * The fixture's memberships are therefore written with a deliberately old
 * `created_at`; this asserts the consequence rather than trusting it.
 *
 * The second claims the switch works through the app's own route, not a
 * hand-forged cookie. See e2e/prodshape.ts.
 */

const DEMO_NAME = "LOCAL SEED - Osteria Scala";

function isLoopbackSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

async function login(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** The name the app resolves for this session, read off the shell it renders. */
async function activeRestaurantName(page: Page): Promise<string> {
  await page.goto("/cellar");
  const body = (await page.textContent("body")) ?? "";
  if (body.includes(PRODSHAPE_RESTAURANT_NAME)) return PRODSHAPE_RESTAURANT_NAME;
  if (body.includes(DEMO_NAME)) return DEMO_NAME;
  return "(neither fixture tenant)";
}

test.describe("@prodshape the production-shaped tenant", () => {
  test.skip(
    !isLoopbackSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL),
    "Requires a loopback Supabase; .env.local points at production.",
  );
  test.describe.configure({ mode: "serial" });

  test("a session with no cookie still lands in the demo tenant", async ({ page }) => {
    await login(page);
    expect(await activeRestaurantName(page)).toBe(DEMO_NAME);
  });

  test("the switch enters the fixture and leaves it again", async ({ page }) => {
    await login(page);

    const seeded = await page.request.get(
      `/api/restaurant/${PRODSHAPE_RESTAURANT_ID}`,
    );
    test.skip(
      !seeded.ok(),
      "Fixture not seeded — run `scripts/local/prodshape.sh --confirm`.",
    );

    await enterProdShape(page);
    expect(await activeRestaurantName(page)).toBe(PRODSHAPE_RESTAURANT_NAME);

    await leaveProdShape(page);
    expect(await activeRestaurantName(page)).toBe(DEMO_NAME);
  });
});
