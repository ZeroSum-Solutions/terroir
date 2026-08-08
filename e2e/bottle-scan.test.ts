import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { expect, test } from "./fixtures/isolated-test";

test.describe("TER-028 isolated mobile bottle scan", () => {
  test.describe.configure({ timeout: 120_000 });
  test.skip(
    process.env.TERROIR_E2E_ENABLED !== "1" ||
      process.env.BOTTLE_SCAN_E2E_ENABLED !== "1",
    "TERROIR_E2E_ENABLED=1 and BOTTLE_SCAN_E2E_ENABLED=1 are required.",
  );

  test("camera lookup confirms two bottles without crossing tenants", async ({
    isolatedConfig,
    isolatedFixture,
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = createClient<Database>(
      isolatedConfig.supabaseUrl,
      isolatedConfig.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const secondScanWineId = randomUUID();
    const { error: secondScanWineError } = await admin.from("wines").insert({
      country: "France",
      id: secondScanWineId,
      name: `Rapid Scan Cuvee ${isolatedFixture.namespace}`,
      producer: "Terroir E2E",
      region: "Burgundy",
      restaurant_id: isolatedFixture.restaurantId,
      size_ml: 750,
      vintage: 2021,
    });
    if (secondScanWineError) throw secondScanWineError;

    const selected = await page.request.put(
      `/api/restaurant/${isolatedFixture.restaurantId}`,
      {
        data: {},
        headers: {
          "Idempotency-Key":
            `e2e-bottle-scan-primary-${isolatedFixture.namespace}-${randomUUID()}`,
        },
      },
    );
    expect(selected.status()).toBe(200);

    const malformedLookup = await page.request.post("/api/scan-bottle", {
      data: { qr_payload: "not-a-wine-id" },
      headers: {
        "Idempotency-Key":
          `e2e-bottle-scan-malformed-${isolatedFixture.namespace}-${randomUUID()}`,
      },
    });
    expect(malformedLookup.status()).toBe(400);

    const foreignLookup = await page.request.post("/api/scan-bottle", {
      data: { qr_payload: isolatedFixture.secondWineId },
      headers: {
        "Idempotency-Key":
          `e2e-bottle-scan-foreign-${isolatedFixture.namespace}-${randomUUID()}`,
      },
    });
    expect(foreignLookup.status()).toBe(404);
    expect(await foreignLookup.json()).toMatchObject({
      error: { code: "not_found" },
    });

    const foreignConfirmation = await page.request.post(
      "/api/scan-bottle/confirm",
      {
        data: {
          bin_location: "X-1",
          section: "Foreign",
          wine_id: isolatedFixture.secondWineId,
        },
        headers: {
          "Idempotency-Key":
            `e2e-bottle-confirm-foreign-${isolatedFixture.namespace}-${randomUUID()}`,
        },
      },
    );
    expect(foreignConfirmation.status()).toBe(404);

    await page.addInitScript((wineIds: string[]) => {
      let detectorIndex = 0;
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
        configurable: true,
        get: () => 2,
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => new MediaStream(),
        },
      });
      Object.defineProperty(window, "BarcodeDetector", {
        configurable: true,
        value: class BarcodeDetector {
          private delivered = false;
          private readonly wineId =
            wineIds[Math.min(detectorIndex++, wineIds.length - 1)];

          async detect() {
            if (this.delivered) return [];
            this.delivered = true;
            return [{ rawValue: this.wineId }];
          }
        },
      });
    }, [isolatedFixture.wineId, secondScanWineId]);

    await page.goto("/scan-bottle", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Match found")).toBeVisible();
    await expect(
      page.getByText(`Primary Cuvee ${isolatedFixture.namespace}`),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await page.getByRole("button", { name: "Correct" }).click();
    await page
      .getByLabel("Search for the correct wine")
      .fill(`Primary Cuvee ${isolatedFixture.namespace}`);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Primary Cuvee ${isolatedFixture.namespace}`, "i"),
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Match found")).toBeVisible();
    await page.getByRole("button", { name: "Correct" }).click();
    await page
      .getByLabel("Search for the correct wine")
      .fill(`Primary Cuvee ${isolatedFixture.namespace}`);
    await page
      .getByRole("button", {
        name: new RegExp(`Primary Cuvee ${isolatedFixture.namespace}`, "i"),
      })
      .click();
    await expect(page.getByText("Match found")).toBeVisible();

    await page.getByRole("button", { name: "Confirm" }).click();
    await page.getByLabel("Section").fill("Reserve");
    await page.getByLabel("Bin location").fill("R-1");
    await page.getByRole("button", { name: "Save location" }).click();
    await expect(page.getByText("Bottle confirmed")).toBeVisible();

    await page.getByRole("button", { name: "Scan another bottle" }).click();
    await expect(page.getByText("Match found")).toBeVisible();
    await expect(
      page.getByText(`Rapid Scan Cuvee ${isolatedFixture.namespace}`),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
    await page.getByLabel("Section").fill("Main Cellar");
    await page.getByLabel("Bin location").fill("M-2");
    await page.getByRole("button", { name: "Save location" }).click();
    await expect(page.getByText("2 scanned")).toBeVisible();
    await page.getByRole("button", { name: "End session (2 scanned)" }).click();
    await expect(page.getByText("2 bottles scanned in this session.")).toBeVisible();
    await expect(page.getByText("Reserve")).toBeVisible();
    await expect(page.getByText("R-1")).toBeVisible();
    await expect(page.getByText("Main Cellar")).toBeVisible();
    await expect(page.getByText("M-2")).toBeVisible();

    const { data: scanned, error: scannedError } = await admin
      .from("inventory_items")
      .select("added_via,bin_location,quantity,section,unit_cost")
      .eq("restaurant_id", isolatedFixture.restaurantId)
      .in("wine_id", [isolatedFixture.wineId, secondScanWineId])
      .eq("added_via", "bottle_scan")
      .order("bin_location");
    if (scannedError) throw scannedError;
    expect(scanned).toEqual([
      {
        added_via: "bottle_scan",
        bin_location: "M-2",
        quantity: 1,
        section: "Main Cellar",
        unit_cost: 0,
      },
      {
        added_via: "bottle_scan",
        bin_location: "R-1",
        quantity: 1,
        section: "Reserve",
        unit_cost: 0,
      },
    ]);

    const { data: foreignScans, error: foreignScansError } = await admin
      .from("inventory_items")
      .select("id")
      .eq("restaurant_id", isolatedFixture.secondRestaurantId)
      .eq("added_via", "bottle_scan");
    if (foreignScansError) throw foreignScansError;
    expect(foreignScans).toEqual([]);
  });
});
