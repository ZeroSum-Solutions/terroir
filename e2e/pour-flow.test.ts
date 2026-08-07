import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/isolated-test";

async function selectPrimaryRestaurant(
  page: Page,
  restaurantId: string,
  namespace: string,
): Promise<void> {
  const response = await page.request.put(`/api/restaurant/${restaurantId}`, {
    headers: { "Idempotency-Key": `e2e-pour-primary-${namespace}` },
  });
  expect(response.status()).toBe(200);
}

/**
 * TER-004 / BND-038 — an isolated, authenticated pour and reconcile cycle.
 * The fixture owns one synthetic restaurant and is removed in fixture teardown,
 * including after a failed assertion or a Playwright retry.
 */
test.describe("isolated pour → reconcile", () => {
  test.setTimeout(60_000);
  test.skip(
    process.env.TERROIR_E2E_ENABLED !== "1",
    "Run only in the isolated staging E2E job.",
  );

  test("configure → pour → reconcile cycle", async ({
    isolatedFixture,
    page,
  }) => {
    await page.goto("/cellar", { waitUntil: "networkidle" });
    await expect(page).not.toHaveURL(/\/login/);
    await selectPrimaryRestaurant(
      page,
      isolatedFixture.restaurantId,
      isolatedFixture.namespace,
    );
    await page.reload({ waitUntil: "networkidle" });

    const cardLabel = new RegExp(
      `Primary Cuvee ${isolatedFixture.namespace}`,
      "i",
    );
    const row = page.getByRole("button", { name: cardLabel }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const startText = (await row.textContent()) ?? "";
    const startMatch = startText.match(/~(\d+) glass/);
    expect(startMatch, `no glass count in row text: ${startText}`).toBeTruthy();
    const startGlasses = Number(startMatch![1]);
    expect(startGlasses).toBeGreaterThan(1);

    await row.click();
    const drawer = page.getByRole("dialog", { name: /./ });
    await expect(drawer).toBeVisible();
    const pourButton = drawer.getByRole("button", { name: /^Pour \d/i });
    await expect(pourButton).toBeVisible();
    await pourButton.click();
    await drawer.getByRole("button", { name: "Close", exact: true }).click();

    await expect(async () => {
      const currentText = (await row.textContent()) ?? "";
      const match = currentText.match(/~(\d+) glass/);
      expect(match).toBeTruthy();
      expect(Number(match![1])).toBe(startGlasses - 1);
    }).toPass({ timeout: 10_000 });

    await page
      .getByRole("button", { name: /^Reconcile \d+ open bottle/i })
      .click();
    const reconcileDialog = page.getByRole("dialog", {
      name: /Reconcile open bottles/i,
    });
    await expect(reconcileDialog).toBeVisible();
    const reconcileRow = reconcileDialog
      .locator("li")
      .filter({ hasText: cardLabel })
      .first();
    await expect(reconcileRow).toBeVisible();
    await reconcileRow.getByRole("button", { name: "Half", exact: true }).click();

    const saveButton = reconcileDialog.getByRole("button", {
      name: /Save \d+ change/i,
    });
    await expect(saveButton).toBeVisible();
    await saveButton.click();
    await expect(reconcileDialog.getByRole("alert")).toHaveCount(0);
    await expect(
      reconcileDialog.getByRole("button", { name: /No changes yet/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
