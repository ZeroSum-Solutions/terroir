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
      "Idempotency-Key": `e2e-cellar-primary-${namespace}-${restaurantId.slice(0, 8)}-${randomUUID()}`,
    },
  });
  expect(response.status()).toBe(200);
}

test.describe("TER-025 isolated staging cellar", () => {
  test.describe.configure({ timeout: 120_000 });
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
    await page.goto("/cellar", { waitUntil: "domcontentloaded" });

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

    const admin = createClient<Database>(
      isolatedConfig.supabaseUrl,
      isolatedConfig.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const foreignWineId = randomUUID();
    const foreignInventoryId = randomUUID();
    const { error: foreignWineError } = await admin.from("wines").insert({
      country: "France",
      id: foreignWineId,
      name: `Foreign Cuvee ${isolatedFixture.namespace}`,
      producer: "Terroir E2E",
      region: "Champagne",
      restaurant_id: isolatedFixture.foreignRestaurantId,
      size_ml: 750,
      vintage: 2020,
    });
    if (foreignWineError) throw foreignWineError;
    const { error: foreignInventoryError } = await admin
      .from("inventory_items")
      .insert({
        added_via: "manual",
        id: foreignInventoryId,
        quantity: 4,
        restaurant_id: isolatedFixture.foreignRestaurantId,
        unit_cost: 40,
        wine_id: foreignWineId,
      });
    if (foreignInventoryError) throw foreignInventoryError;

    await selectPrimaryRestaurant(
      page,
      isolatedFixture.secondRestaurantId,
      isolatedFixture.namespace,
    );
    const positiveControl = await page.request.patch(
      `/api/cellar/${isolatedFixture.secondWineId}/quantity`,
      { data: { quantity: 7, reason: "Cross-tenant positive control" } },
    );
    expect(positiveControl.status()).toBe(200);
    expect(await positiveControl.json()).toMatchObject({
      quantity: 7,
      wineId: isolatedFixture.secondWineId,
    });
    await selectPrimaryRestaurant(
      page,
      isolatedFixture.restaurantId,
      isolatedFixture.namespace,
    );

    const activeTenantDenial = await page.request.patch(
      `/api/cellar/${isolatedFixture.secondWineId}/quantity`,
      { data: { quantity: 1, reason: "Active tenant must win" } },
    );
    expect(activeTenantDenial.status()).toBe(404);

    const crossTenant = await page.request.patch(
      `/api/cellar/${foreignWineId}/quantity`,
      { data: { quantity: 1, reason: "Must not cross tenant" } },
    );
    expect(crossTenant.status()).toBe(404);

    const { data: foreignInventory, error: foreignInventoryReadError } =
      await admin
        .from("inventory_items")
        .select("quantity")
        .eq("id", foreignInventoryId);
    if (foreignInventoryReadError) throw foreignInventoryReadError;
    expect(foreignInventory).toEqual([{ quantity: 4 }]);
    const { data: foreignAudit, error: foreignAuditError } = await admin
      .from("availability_events")
      .select("id")
      .eq("wine_id", foreignWineId);
    if (foreignAuditError) throw foreignAuditError;
    expect(foreignAudit).toEqual([]);

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

    const configResponse = await page.request.get("/cellar/config", {
      maxRedirects: 0,
    });
    expect([302, 303, 307, 308]).toContain(configResponse.status());
    const location = configResponse.headers().location;
    expect(location).toBeDefined();
    expect(new URL(location!, isolatedConfig.baseUrl).pathname).toBe("/cellar");
    await page.goto("/cellar", { waitUntil: "domcontentloaded" });
    const wineLabel = new RegExp(
      `Primary Cuvee ${isolatedFixture.namespace}`,
      "i",
    );
    await page.getByRole("button", { name: wineLabel }).click();
    const drawer = page.getByRole("dialog", { name: wineLabel });
    await expect(drawer).toBeVisible();
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
