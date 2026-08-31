import { expect, type Page } from "@playwright/test";

/**
 * Drive a session into the production-SHAPED local tenant, and back out.
 *
 * `LOCAL SEED - Osteria Scala` is the best case on every axis a wine renders
 * on — 250 wines, 250 photographs, no blank producers, every row spine-linked.
 * Production is the worst case on all four. `LOCAL PRODSHAPE - Trattoria
 * Bianca` (scripts/local/prodshape.sh) holds production's ratios instead, so a
 * QA pass can see what production actually looks like through the real UI.
 *
 * ── HOW THE SWITCH WORKS, AND WHY IT IS NOT A HAND-FORGED COOKIE ───────────
 *
 * `src/lib/api/resolve-active-membership.ts` resolves the active restaurant
 * from a signed `active_restaurant_id` cookie, falling back to the most
 * recently created membership. The app already owns both halves of that:
 * `PUT /api/restaurant/{id}` verifies membership and then writes the signed,
 * HttpOnly cookie itself (`setActiveRestaurant`). Signing one here would mean
 * a second copy of the HMAC — and a fixture that keeps working after the app's
 * own signing changes is a fixture that has stopped testing the app.
 *
 * `page.request` shares the browser context's cookie jar, so the cookie the
 * route sets is the cookie the next `page.goto` sends.
 *
 * ── THE DEFAULT IS UNCHANGED ───────────────────────────────────────────────
 *
 * The fixture's memberships are written with a deliberately OLD `created_at`
 * (2026-01-05), so a session that has not called `enterProdShape` still lands
 * in the demo tenant — which every other spec in this directory assumes, a
 * dozen of them via their own `created_at DESC limit 1` lookup. Nothing here
 * changes that; a spec that enters the fixture should leave it again in an
 * `afterAll` if it shares a context.
 */

export const DEMO_RESTAURANT_ID = "de100000-0000-4000-8000-000000000001";
export const PRODSHAPE_RESTAURANT_ID = "de200000-0000-4000-8000-000000000001";
export const PRODSHAPE_RESTAURANT_NAME = "LOCAL PRODSHAPE - Trattoria Bianca";

/** The one wine in the fixture that owns a photograph, as production has one. */
export const PRODSHAPE_WINE_WITH_PHOTO_ID = "de200001-0000-4000-8000-000000000137";

async function setActiveRestaurant(page: Page, restaurantId: string): Promise<void> {
  const response = await page.request.put(`/api/restaurant/${restaurantId}`);
  expect(
    response.ok(),
    `switching to ${restaurantId} failed: ${await response.text()}`,
  ).toBeTruthy();
}

/** Put this browser context into the production-shaped tenant. Log in first. */
export async function enterProdShape(page: Page): Promise<void> {
  await setActiveRestaurant(page, PRODSHAPE_RESTAURANT_ID);
}

/** Return this browser context to the demo tenant every other spec assumes. */
export async function leaveProdShape(page: Page): Promise<void> {
  await setActiveRestaurant(page, DEMO_RESTAURANT_ID);
}
