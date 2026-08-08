import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "../src/types/database";
import { expect, test } from "./fixtures/isolated-test";

test.describe("TER-027 isolated staging analytics", () => {
  test.describe.configure({ timeout: 120_000 });
  test.skip(
    process.env.TERROIR_E2E_ENABLED !== "1" ||
      process.env.ANALYTICS_E2E_ENABLED !== "1",
    "TERROIR_E2E_ENABLED=1 and ANALYTICS_E2E_ENABLED=1 are required.",
  );

  test("custom insights export and market shift remain tenant-scoped", async ({
    isolatedConfig,
    isolatedFixture,
    page,
  }) => {
    const admin = createClient<Database>(
      isolatedConfig.supabaseUrl,
      isolatedConfig.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const insideScanId = randomUUID();
    const outsideScanId = randomUUID();
    const lineItemA = randomUUID();
    const lineItemB = randomUUID();
    const baseLineItems = [
      {
        confidence: 0.9,
        id: lineItemA,
        name: "Primary Cuvee",
        producer: "Terroir E2E",
        qty: 1,
        region: "Champagne",
        unitCost: 25,
        varietal: "Chardonnay",
        vintage: 2020,
      },
      {
        confidence: 0.9,
        id: lineItemB,
        name: "Primary Cuvee",
        producer: "Terroir E2E",
        qty: 1,
        region: "Champagne",
        unitCost: 25,
        varietal: "Chardonnay",
        vintage: 2020,
      },
    ];
    const { error: scansError } = await admin.from("invoice_scans").insert([
      {
        created_at: "2026-01-15T12:00:00.000Z",
        distributor_name: `Inside ${isolatedFixture.namespace}`,
        edits: { [`${lineItemA}:name`]: true },
        final_line_items: baseLineItems as Json,
        id: insideScanId,
        item_count: 2,
        parsed_line_items: baseLineItems as Json,
        restaurant_id: isolatedFixture.restaurantId,
      },
      {
        created_at: "2025-01-15T12:00:00.000Z",
        distributor_name: `Outside ${isolatedFixture.namespace}`,
        edits: {},
        final_line_items: [baseLineItems[0]] as Json,
        id: outsideScanId,
        item_count: 1,
        parsed_line_items: [baseLineItems[0]] as Json,
        restaurant_id: isolatedFixture.restaurantId,
      },
    ]);
    if (scansError) throw scansError;

    const { error: inventoryError } = await admin.from("inventory_items").insert([
      {
        added_via: "invoice_scan",
        currency: "USD",
        id: randomUUID(),
        invoice_scan_id: insideScanId,
        quantity: 2,
        restaurant_id: isolatedFixture.restaurantId,
        unit_cost: 25,
        wine_id: isolatedFixture.wineId,
      },
      {
        added_via: "invoice_scan",
        currency: "USD",
        id: randomUUID(),
        invoice_scan_id: outsideScanId,
        quantity: 1,
        restaurant_id: isolatedFixture.restaurantId,
        unit_cost: 30,
        wine_id: isolatedFixture.wineId,
      },
    ]);
    if (inventoryError) throw inventoryError;

    const { error: firstMarketError } = await admin
      .from("wines")
      .update({
        retail_median: 100,
        retail_refreshed_at: "2026-01-01T00:00:00.000Z",
      })
      .eq("id", isolatedFixture.wineId)
      .eq("restaurant_id", isolatedFixture.restaurantId);
    if (firstMarketError) throw firstMarketError;
    const { error: secondMarketError } = await admin
      .from("wines")
      .update({
        retail_median: 120,
        retail_refreshed_at: "2026-02-01T00:00:00.000Z",
      })
      .eq("id", isolatedFixture.wineId)
      .eq("restaurant_id", isolatedFixture.restaurantId);
    if (secondMarketError) throw secondMarketError;

    const selected = await page.request.put(
      `/api/restaurant/${isolatedFixture.restaurantId}`,
      {
        data: {},
        headers: { "Idempotency-Key": randomUUID() },
      },
    );
    expect(selected.status()).toBe(200);

    await page.goto("/insights", { waitUntil: "domcontentloaded" });
    await page.getByRole("radio", { name: "Custom" }).click();
    await page.getByLabel("From").fill("2026-01-01");
    await page.getByLabel("To").fill("2026-01-31");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(
      /\/insights\?range=custom&from=2026-01-01&to=2026-01-31$/,
    );
    await expect(page.getByText("50%", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText(/2 line items processed · 1 auto-accepted · 1 corrected/),
    ).toBeVisible();

    const exportLink = page.getByRole("link", { name: "Export CSV" });
    await expect(exportLink).toHaveAttribute(
      "href",
      "/api/insights/csv?range=custom&from=2026-01-01&to=2026-01-31",
    );
    const exportResponse = await page.request.get(
      await exportLink.getAttribute("href") as string,
    );
    expect(exportResponse.status()).toBe(200);
    const csv = await exportResponse.text();
    expect(csv).toContain(`Inside ${isolatedFixture.namespace},2,1,1,50%`);
    expect(csv).not.toContain(`Outside ${isolatedFixture.namespace}`);

    await page.goto("/price-comparison", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Market rose 20%", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText(`Second Cuvee ${isolatedFixture.namespace}`),
    ).toHaveCount(0);

    const { data: market, error: marketError } = await admin
      .from("wines")
      .select("retail_median,retail_previous_median,retail_previous_refreshed_at")
      .eq("id", isolatedFixture.wineId)
      .eq("restaurant_id", isolatedFixture.restaurantId)
      .single();
    if (marketError) throw marketError;
    expect(market).toEqual({
      retail_median: 120,
      retail_previous_median: 100,
      retail_previous_refreshed_at: "2026-01-01T00:00:00+00:00",
    });
  });
});
