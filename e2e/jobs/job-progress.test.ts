import { expect, test } from "../fixtures/isolated-test";
import { seedBackgroundJobFixture } from "../fixtures/background-job-fixture";

test.describe("background job progress", () => {
  test.beforeAll(() => {
    if (process.env.TERROIR_E2E_ENABLED !== "1") {
      throw new Error(
        "TERROIR_E2E_ENABLED=1 and the validated staging contract are required.",
      );
    }
  });

  test("recovers progress and retry state across mobile refresh and tenant switch", async ({
    isolatedConfig,
    isolatedFixture,
    page,
  }) => {
    await seedBackgroundJobFixture(isolatedConfig, isolatedFixture);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/cellar", { waitUntil: "networkidle" });

    const progress = page.getByTestId("background-job-progress");
    await expect(progress).toContainText("Queued");
    await expect(progress).toContainText("Running");
    await expect(progress).toContainText("Retrying");
    await expect(progress).toContainText("Dead-lettered");
    await expect(progress).toContainText("Succeeded");

    const retry = progress.getByRole("button", {
      name: "Retry Wine-list PDF",
    });
    const retryBounds = await retry.boundingBox();
    expect(retryBounds?.height).toBeGreaterThanOrEqual(44);
    await retry.click();
    const pdfJob = progress.locator("article").filter({
      hasText: "Wine-list PDF",
    });
    await expect(pdfJob).toContainText("Queued");

    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.getByTestId("background-job-progress").locator("article").filter({
        hasText: "Wine-list PDF",
      }),
    ).toContainText("Queued");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("menuitem", {
      name: new RegExp(`Second E2E ${isolatedFixture.namespace}`, "i"),
    }).click();
    const secondTenantProgress = page.getByTestId("background-job-progress");
    await expect(secondTenantProgress).toContainText("Wine enrichment");
    await expect(secondTenantProgress).not.toContainText("Wine-list PDF");
  });
});
