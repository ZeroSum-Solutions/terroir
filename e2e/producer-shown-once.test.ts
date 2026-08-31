import { expect, test, type Page } from "@playwright/test";
import { enterProdShape, leaveProdShape } from "./prodshape";

/**
 * BUG-01, through the real pages.
 *
 * A CSV import wrote 1,277 wines with an EMPTY `producer` and the producer run
 * into the front of `name`; migration `0137` recovered the producer into its
 * own column and correctly left `name` alone. Nothing concatenates a producer
 * twice — the duplication is in the data — so every surface that renders
 * `producer` beside `name` shows the winery twice. Measured against 400
 * production rows: 391 of 400.
 *
 * The three shapes here are the ones the local stack actually holds, not
 * invented ones:
 *   • `Esporão` / `Esporão Reserva Tinto`     — the plain duplication.
 *   • `Oberrotweil` / `Oberrotweiler …`       — the trap. A character-wise
 *     `startsWith` strip renders it "er Spätburgunder Spätlese Trocken".
 *   • `''` / `Juniper Vale Rioja Gran Reserva` — the 23% of production whose
 *     producer `0137` could not recover, which is the OPPOSITE failure: a
 *     sentence with a hole where the winery should be.
 *
 * Auth follows the sibling specs: `/api/dev-login`, hard skip unless Supabase
 * is loopback, because `.env.local` holds production credentials.
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

const CAN_RUN =
  isLoopbackSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.DEV_BYPASS_EMAIL);

/** Demo tenant, the wine whose name merely OPENS with its producer's letters. */
const OBERROTWEIL_WINE_ID = "de100001-0000-4000-8000-000000000172";
/** Prodshape tenant, one of the 93 rows carrying production's blank producer. */
const BLANK_PRODUCER_WINE_ID = "de200001-0000-4000-8000-000000000009";

async function login(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe("the producer, shown once", () => {
  test("the published guest menu names a winery once per line", async ({ page }) => {
    // Public — no login. This is what a customer reads.
    await page.goto("/list/local-seed-full-list");
    const menu = page.locator("main");
    await expect(menu).toContainText("Esporão Reserva Tinto");
    await expect(menu).not.toContainText("Esporão Esporão");
  });

  test("a name_override on the guest menu is left exactly as typed", async ({ page }) => {
    await page.goto("/list/local-seed-full-list");
    // The owner's own words for this bottle. Never rewritten, never stripped.
    await expect(page.locator("main")).toContainText("Northline Reserve Pour");
  });

  test.describe("signed in", () => {
    test.skip(!CAN_RUN, "needs a loopback Supabase stack and DEV_BYPASS_EMAIL");

    test("keeps a wine name that only opens with the producer's letters", async ({
      page,
    }) => {
      await login(page);
      await page.goto(`/cellar/${OBERROTWEIL_WINE_ID}`);

      // The heading alone, not the page text: the broken form is the eyebrow
      // "Oberrotweil" followed by an h1 of "er Spätburgunder Spätlese Trocken",
      // and flattened page text cannot tell that apart from the correct one.
      const heading = page.locator("h1");
      await expect(heading).toHaveText(
        "Oberrotweiler Spätburgunder Spätlese Trocken",
      );
      // The failure a character-wise startsWith strip produces, named so it
      // cannot creep back in.
      await expect(heading).not.toHaveText("er Spätburgunder Spätlese Trocken");
    });

    test("does not leave a hole where a blank producer would go", async ({ page }) => {
      await login(page);
      await enterProdShape(page);
      try {
        await page.goto(`/cellar/${BLANK_PRODUCER_WINE_ID}`);

        const main = page.locator("main");
        await expect(main).toContainText(
          "No reference entry matched this wine closely enough to trust",
        );
        // "matched  closely" — the two-space hole a blank producer left.
        await expect(main).not.toContainText("matched  closely");
      } finally {
        await leaveProdShape(page);
      }
    });
  });
});
