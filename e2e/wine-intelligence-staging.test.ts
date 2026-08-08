import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import type { Database } from "../src/types/database";
import { expect, test } from "./fixtures/isolated-test";

async function selectPrimaryRestaurant(
  page: Page,
  restaurantId: string,
  namespace: string,
) {
  const response = await page.request.put(`/api/restaurant/${restaurantId}`, {
    data: {},
    headers: {
      "Idempotency-Key":
        `e2e-intelligence-${namespace}-${restaurantId.slice(0, 8)}-${randomUUID()}`,
    },
  });
  expect(response.status()).toBe(200);
}

test.describe("TER-026 isolated staging wine intelligence", () => {
  test.describe.configure({ timeout: 120_000 });
  test.skip(
    process.env.TERROIR_E2E_ENABLED !== "1" ||
      process.env.WINE_INTELLIGENCE_E2E_ENABLED !== "1",
    "TERROIR_E2E_ENABLED=1 and WINE_INTELLIGENCE_E2E_ENABLED=1 are required.",
  );

  test("owner sees guidance and enrichment preserves a manual drink window", async ({
    isolatedConfig,
    isolatedFixture,
    page,
  }) => {
    const admin = createClient<Database>(
      isolatedConfig.supabaseUrl,
      isolatedConfig.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error: seedError } = await admin
      .from("wines")
      .update({
        varietal: "Cabernet Sauvignon",
        region: "Napa Valley",
        drink_window_start: null,
        drink_window_end: null,
        peak_year: null,
        serving_temp_min: null,
        serving_temp_max: null,
        serving_temp_label: null,
        decant_minutes: null,
        manual_overrides: [],
      })
      .eq("id", isolatedFixture.wineId)
      .eq("restaurant_id", isolatedFixture.restaurantId);
    if (seedError) throw seedError;

    await selectPrimaryRestaurant(
      page,
      isolatedFixture.restaurantId,
      isolatedFixture.namespace,
    );
    const enriched = await page.request.post(
      `/api/wines/${isolatedFixture.wineId}/enrich`,
      {
        headers: { "Idempotency-Key": randomUUID() },
        data: {},
      },
    );
    expect(enriched.status()).toBe(200);
    expect(await enriched.json()).toMatchObject({ source: "rule_engine" });

    await page.goto("/cellar", { waitUntil: "domcontentloaded" });
    const wineLabel = new RegExp(
      `Primary Cuvee ${isolatedFixture.namespace}`,
      "i",
    );
    await page.getByRole("button", { name: wineLabel }).click();
    let drawer = page.getByRole("dialog", { name: wineLabel });
    await expect(drawer.getByLabel("Drink window")).toBeVisible();
    await expect(drawer.getByLabel("Serving temperature")).toContainText(
      "60–65°F",
    );
    await expect(drawer.getByLabel("Decant time")).toContainText("1h 30m");
    await expect(drawer.getByText("Optimal", { exact: true })).toBeVisible();

    await drawer.getByRole("button", { name: "Edit metadata" }).click();
    const edit = page.getByRole("dialog", { name: "Edit wine" });
    await edit.getByLabel("Start year").fill("2010");
    await edit.getByLabel("Peak year").fill("2011");
    await edit.getByLabel("End year").fill("2012");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Metadata updated")).toBeVisible();

    const reenriched = await page.request.post(
      `/api/wines/${isolatedFixture.wineId}/enrich`,
      {
        headers: { "Idempotency-Key": randomUUID() },
        data: {},
      },
    );
    expect(reenriched.status()).toBe(200);

    const { data: persisted, error: persistedError } = await admin
      .from("wines")
      .select(
        "drink_window_start,drink_window_end,peak_year,manual_overrides,serving_temp_min,decant_minutes",
      )
      .eq("id", isolatedFixture.wineId)
      .eq("restaurant_id", isolatedFixture.restaurantId)
      .single();
    if (persistedError) throw persistedError;
    expect(persisted).toMatchObject({
      drink_window_start: 2010,
      drink_window_end: 2012,
      peak_year: 2011,
      serving_temp_min: 60,
      decant_minutes: 90,
    });
    expect(persisted.manual_overrides).toContain("drink_window");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: wineLabel }).click();
    drawer = page.getByRole("dialog", { name: wineLabel });
    await expect(drawer.getByText("Start 2010")).toBeVisible();
    await expect(drawer.getByText("Peak 2011")).toBeVisible();
    await expect(drawer.getByText("End 2012")).toBeVisible();
    await expect(drawer.getByText("Past peak", { exact: true })).toBeVisible();

    const crossTenant = await page.request.post(
      `/api/wines/${isolatedFixture.secondWineId}/enrich`,
      { headers: { "Idempotency-Key": randomUUID() }, data: {} },
    );
    expect(crossTenant.status()).toBe(404);
  });

  test("staff cannot invoke or see re-enrichment controls", async ({
    isolatedConfig,
    isolatedFixture,
    page,
  }) => {
    await selectPrimaryRestaurant(
      page,
      isolatedFixture.restaurantId,
      isolatedFixture.namespace,
    );
    const admin = createClient<Database>(
      isolatedConfig.supabaseUrl,
      isolatedConfig.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error: roleError } = await admin
      .from("memberships")
      .update({ role: "staff" })
      .eq("restaurant_id", isolatedFixture.restaurantId)
      .eq("user_id", isolatedFixture.userId);
    if (roleError) throw roleError;

    await page.goto("/cellar", { waitUntil: "domcontentloaded" });
    const wineLabel = new RegExp(
      `Primary Cuvee ${isolatedFixture.namespace}`,
      "i",
    );
    await page.getByRole("button", { name: wineLabel }).click();
    const drawer = page.getByRole("dialog", { name: wineLabel });
    await expect(drawer.getByRole("button", { name: "Re-enrich" })).toHaveCount(0);

    const denied = await page.request.post(
      `/api/wines/${isolatedFixture.wineId}/enrich`,
      { data: {} },
    );
    expect(denied.status()).toBe(403);
  });
});
