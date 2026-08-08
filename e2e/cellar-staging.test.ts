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
    headers: { "Idempotency-Key": `e2e-cellar-primary-${namespace}` },
  });
  expect(response.status()).toBe(200);
}

test.describe("TER-025 isolated staging cellar", () => {
  test.setTimeout(120_000);
  test.skip(
    process.env.TERROIR_E2E_ENABLED !== "1" ||
      process.env.CELLAR_E2E_ENABLED !== "1",
    "TERROIR_E2E_ENABLED=1 and CELLAR_E2E_ENABLED=1 are required.",
  );

  test("owner filters, inspects, and makes one audited quantity adjustment", async ({
    isolatedConfig,
    isolatedFixture,
    page,
  }) => {
    await selectPrimaryRestaurant(
      page,
      isolatedFixture.restaurantId,
      isolatedFixture.namespace,
    );
    await page.goto("/cellar", { waitUntil: "networkidle" });

    const wineLabel = new RegExp(
      `Primary Cuvee ${isolatedFixture.namespace}`,
      "i",
    );
    const search = page.getByPlaceholder(
      "Search name, producer, varietal, region, vintage…",
    );
    await search.fill("2020");
    await page.getByLabel("Region or country").selectOption("France");
    await page.getByLabel("Minimum vintage").fill("2020");
    await page.getByLabel("Maximum vintage").fill("2020");
    await page.getByLabel("Sort by").selectOption("quantity");
    await expect(page.getByRole("button", { name: wineLabel })).toBeVisible();

    await page.getByRole("button", { name: "Clear inventory filters" }).click();
    await page.getByRole("button", { name: wineLabel }).click();
    const drawer = page.getByRole("dialog", { name: wineLabel });
    await expect(drawer.getByText("Average cost")).toBeVisible();
    await expect(drawer.getByText("Last purchase")).toBeVisible();
    await expect(drawer.getByLabel("Inventory by format")).toBeVisible();

    await drawer.getByRole("button", { name: "Adjust quantity" }).click();
    const adjustment = page.getByRole("dialog", { name: "Adjust quantity" });
    await adjustment.getByLabel("Current sealed quantity").fill("2");
    await adjustment
      .getByLabel("Reason")
      .fill("TER-025 isolated staging count");
    await adjustment
      .getByRole("button", { name: "Save audited adjustment" })
      .click();
    await expect(page.getByText("Quantity adjusted and logged")).toBeVisible();

    const crossTenant = await page.request.patch(
      `/api/cellar/${isolatedFixture.secondWineId}/quantity`,
      {
        data: { quantity: 1, reason: "Must not cross tenant" },
        headers: {
          "Idempotency-Key": `e2e-cellar-cross-${isolatedFixture.namespace}`,
        },
      },
    );
    expect(crossTenant.status()).toBe(404);

    const admin = createClient<Database>(
      isolatedConfig.supabaseUrl,
      isolatedConfig.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: inventory, error: inventoryError } = await admin
      .from("inventory_items")
      .select("quantity")
      .eq("restaurant_id", isolatedFixture.restaurantId)
      .eq("wine_id", isolatedFixture.wineId);
    if (inventoryError) throw inventoryError;
    expect(
      (inventory ?? []).reduce((sum, item) => sum + item.quantity, 0),
    ).toBe(2);

    const { data: audit, error: auditError } = await admin
      .from("availability_events")
      .select("delta,note,user_id")
      .eq("restaurant_id", isolatedFixture.restaurantId)
      .eq("wine_id", isolatedFixture.wineId)
      .eq("direction", "adjustment")
      .eq("note", "TER-025 isolated staging count");
    if (auditError) throw auditError;
    expect(audit).toEqual([
      {
        delta: -1,
        note: "TER-025 isolated staging count",
        user_id: isolatedFixture.userId,
      },
    ]);
  });

  test("staff stays read-only in the UI and API", async ({
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

    await page.goto("/cellar/config", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/cellar(?:\?|$)/);
    const wineLabel = new RegExp(
      `Primary Cuvee ${isolatedFixture.namespace}`,
      "i",
    );
    await page.getByRole("button", { name: wineLabel }).click();
    const drawer = page.getByRole("dialog", { name: wineLabel });
    await expect(
      drawer.getByRole("button", { name: "Adjust quantity" }),
    ).toHaveCount(0);

    const denied = await page.request.patch(
      `/api/cellar/${isolatedFixture.wineId}/quantity`,
      { data: { quantity: 1, reason: "Staff must not mutate" } },
    );
    expect(denied.status()).toBe(403);
  });
});
