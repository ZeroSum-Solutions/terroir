import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
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
 * The first two shapes are inserted as deterministic local fixtures; the
 * third is held by the prodshape seed:
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
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
  Boolean(process.env.DEV_BYPASS_EMAIL);

/** Prodshape tenant, one of the 93 rows carrying production's blank producer. */
const BLANK_PRODUCER_WINE_ID = "de200001-0000-4000-8000-000000000009";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "producer E2E requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function login(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe("the producer, shown once", () => {
  test.skip(
    !CAN_RUN,
    "needs a loopback Supabase stack, service role, and DEV_BYPASS_EMAIL",
  );
  test.describe.configure({ mode: "serial" });

  const fixtureSuffix = Date.now().toString(36);
  const repeatedProducer = `E2E-${fixtureSuffix} Esporão`;
  const repeatedName = `${repeatedProducer} Reserva Tinto`;
  const prefixProducer = `E2E-${fixtureSuffix} Oberrotweil`;
  const prefixName = `E2E-${fixtureSuffix} Oberrotweiler Spätburgunder Spätlese Trocken`;
  let prefixWineId = "";
  const wineIds: string[] = [];

  test.beforeAll(async () => {
    const admin = adminClient();
    const { data: list, error: listError } = await admin
      .from("wine_lists")
      .select("id, restaurant_id")
      .eq("slug", "local-seed-full-list")
      .single();
    if (listError) throw listError;

    const { data: section, error: sectionError } = await admin
      .from("wine_list_sections")
      .select("id")
      .eq("wine_list_id", list.id)
      .order("position")
      .limit(1)
      .single();
    if (sectionError) throw sectionError;

    const { data: wines, error: wineError } = await admin
      .from("wines")
      .insert([
        {
          restaurant_id: list.restaurant_id,
          producer: repeatedProducer,
          name: repeatedName,
          vintage: 2020,
        },
        {
          restaurant_id: list.restaurant_id,
          producer: prefixProducer,
          name: prefixName,
          vintage: 2021,
        },
      ])
      .select("id, producer");
    if (wineError) throw wineError;
    wineIds.push(...wines.map((wine) => wine.id));
    prefixWineId = wines.find((wine) => wine.producer === prefixProducer)?.id ?? "";
    if (!prefixWineId) throw new Error("prefix producer fixture was not created");

    const repeatedWineId = wines.find(
      (wine) => wine.producer === repeatedProducer,
    )?.id;
    if (!repeatedWineId) throw new Error("repeated producer fixture was not created");

    const { error: itemError } = await admin.from("wine_list_items").insert([
      {
        section_id: section.id,
        wine_id: repeatedWineId,
        restaurant_id: list.restaurant_id,
        position: 99_998,
      },
      {
        section_id: section.id,
        wine_id: prefixWineId,
        restaurant_id: list.restaurant_id,
        position: 99_999,
        name_override: "Sommelier Reserve Pour",
      },
    ]);
    if (itemError) throw itemError;
  });

  test.afterAll(async () => {
    if (wineIds.length === 0) return;
    const admin = adminClient();
    const { error: itemError } = await admin
      .from("wine_list_items")
      .delete()
      .in("wine_id", wineIds);
    const { error: wineError } = await admin.from("wines").delete().in("id", wineIds);
    if (itemError || wineError) {
      throw new Error(
        `producer fixture cleanup failed: ${itemError?.message ?? wineError?.message}`,
      );
    }
  });

  test("the published guest menu names a winery once per line", async ({ page }) => {
    // Public — no login. This is what a customer reads.
    await page.goto("/list/local-seed-full-list");
    const menu = page.locator("main");
    await expect(menu).toContainText(repeatedName);
    await expect(menu).not.toContainText(`${repeatedProducer} ${repeatedProducer}`);
  });

  test("a name_override on the guest menu is left exactly as typed", async ({ page }) => {
    await page.goto("/list/local-seed-full-list");
    // The owner's own words for this bottle. Never rewritten, never stripped.
    // The seed writes "<producer> Reserve Pour" on one item in nineteen and
    // fix-demo-wine-lists.mjs renames the producer half to the real producer
    // once the cellar holds real bottlings, so the wording is what to look for.
    await expect(page.locator("main")).toContainText("Sommelier Reserve Pour");
  });

  test.describe("signed in", () => {
    test("keeps a wine name that only opens with the producer's letters", async ({
      page,
    }) => {
      await login(page);
      await page.goto(`/cellar/${prefixWineId}`);

      // The heading alone, not the page text: the broken form is the eyebrow
      // "Oberrotweil" followed by an h1 of "er Spätburgunder Spätlese Trocken",
      // and flattened page text cannot tell that apart from the correct one.
      const heading = page.locator("h1");
      await expect(heading).toHaveText(prefixName);
      // The failure a character-wise startsWith strip produces, named so it
      // cannot creep back in.
      await expect(heading).not.toHaveText(
        "er Spätburgunder Spätlese Trocken",
      );
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
