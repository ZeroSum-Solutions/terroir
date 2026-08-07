import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/isolated-test";

type ApiResult = { body: unknown; status: number };

async function api(
  page: Page,
  path: string,
  init?: { body?: unknown; idempotencyKey?: string; method?: string },
): Promise<ApiResult> {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        body: init?.body === undefined
          ? undefined
          : JSON.stringify(init.body),
        credentials: "same-origin",
        headers: {
          ...(init?.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(init?.idempotencyKey
            ? { "Idempotency-Key": init.idempotencyKey }
            : {}),
        },
        method: init?.method ?? "GET",
      });
      return {
        body: await response.json(),
        status: response.status,
      };
    },
    { path, init },
  );
}

test.describe("multi-restaurant isolation", () => {
  test.beforeAll(() => {
    if (process.env.TERROIR_E2E_ENABLED !== "1") {
      throw new Error(
        "TERROIR_E2E_ENABLED=1 and the validated staging contract are required.",
      );
    }
  });

  test("switches every tenant-scoped surface and preserves the signed choice", async ({
    isolatedFixture,
    page,
  }) => {
    await page.goto("/cellar", { waitUntil: "networkidle" });
    await expect(page).not.toHaveURL(/\/login/);

    const primarySwitch = await api(
      page,
      `/api/restaurant/${isolatedFixture.restaurantId}`,
      {
        idempotencyKey: `e2e-primary-${isolatedFixture.namespace}`,
        method: "PUT",
      },
    );
    expect(primarySwitch.status).toBe(200);
    await page.reload({ waitUntil: "networkidle" });

    const primaryCellar = await api(page, "/api/cellar");
    const primaryLists = await api(page, "/api/wine-lists");
    const primaryInsights = await api(page, "/api/insights");
    const primaryTeam = await api(page, "/api/team");
    const primaryRestaurant = await api(page, "/api/restaurant");
    const primaryEvidence = JSON.stringify({
      primaryCellar,
      primaryLists,
      primaryRestaurant,
    });

    expect(primaryCellar.status).toBe(200);
    expect(primaryLists.status).toBe(200);
    expect(primaryInsights).toMatchObject({
      body: { inventoryValue: 60, totalBottles: 3 },
      status: 200,
    });
    expect(primaryTeam).toMatchObject({
      body: { members: [{ role: "owner" }] },
      status: 200,
    });
    expect(primaryEvidence).toContain(isolatedFixture.wineId);
    expect(primaryEvidence).toContain(isolatedFixture.listId);
    expect(primaryEvidence).toContain(isolatedFixture.restaurantId);
    expect(primaryEvidence).not.toContain(isolatedFixture.secondWineId);
    expect(primaryEvidence).not.toContain(isolatedFixture.secondListId);
    expect(primaryEvidence).not.toContain(isolatedFixture.secondRestaurantId);

    const primaryPourDenial = await api(page, "/api/pour", {
      body: { kind: "pour", ml: 30, wine_id: isolatedFixture.secondWineId },
      idempotencyKey: `e2e-primary-deny-${isolatedFixture.namespace}`,
      method: "POST",
    });
    expect([403, 404]).toContain(primaryPourDenial.status);

    await page.getByRole("button", { name: "Settings" }).click();
    const secondRestaurantButton = page.getByRole("menuitem", {
      name: new RegExp(`Second E2E ${isolatedFixture.namespace}`, "i"),
    });
    await expect(secondRestaurantButton).toContainText("manager");
    await secondRestaurantButton.click();

    await expect(
      page.getByText(`Second Cuvee ${isolatedFixture.namespace}`).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(`Primary Cuvee ${isolatedFixture.namespace}`),
    ).toHaveCount(0);

    await expect
      .poll(async () => {
        const result = await api(page, "/api/restaurant");
        return (result.body as { restaurant?: { id?: string } })
          .restaurant?.id;
      })
      .toBe(isolatedFixture.secondRestaurantId);

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("menu")).toContainText(
      `Second E2E ${isolatedFixture.namespace}`,
    );
    await expect(page.getByRole("menu")).toContainText("manager");

    const secondCellar = await api(page, "/api/cellar");
    const secondLists = await api(page, "/api/wine-lists");
    const secondInsights = await api(page, "/api/insights");
    const secondTeam = await api(page, "/api/team");
    const secondRestaurant = await api(page, "/api/restaurant");
    const secondEvidence = JSON.stringify({
      secondCellar,
      secondLists,
      secondRestaurant,
    });

    expect(secondCellar.status).toBe(200);
    expect(secondLists.status).toBe(200);
    expect(secondInsights).toMatchObject({
      body: { inventoryValue: 210, totalBottles: 7 },
      status: 200,
    });
    expect(secondTeam).toMatchObject({
      body: { members: [{ role: "manager" }] },
      status: 200,
    });
    expect(secondEvidence).toContain(isolatedFixture.secondWineId);
    expect(secondEvidence).toContain(isolatedFixture.secondListId);
    expect(secondEvidence).toContain(isolatedFixture.secondRestaurantId);
    expect(secondEvidence).not.toContain(isolatedFixture.wineId);
    expect(secondEvidence).not.toContain(isolatedFixture.listId);
    expect(secondEvidence).not.toContain(isolatedFixture.restaurantId);

    const secondPour = await api(page, "/api/pour", {
      body: { kind: "pour", ml: 30, wine_id: isolatedFixture.secondWineId },
      idempotencyKey: `e2e-second-pour-${isolatedFixture.namespace}`,
      method: "POST",
    });
    expect(secondPour.status).toBe(200);
    const secondPourDenial = await api(page, "/api/pour", {
      body: { kind: "pour", ml: 30, wine_id: isolatedFixture.wineId },
      idempotencyKey: `e2e-second-deny-${isolatedFixture.namespace}`,
      method: "POST",
    });
    expect([403, 404]).toContain(secondPourDenial.status);

    const denied = await api(
      page,
      `/api/restaurant/${isolatedFixture.foreignRestaurantId}`,
      {
        idempotencyKey: `e2e-denied-${isolatedFixture.namespace}`,
        method: "PUT",
      },
    );
    expect(denied.status).toBe(403);
    expect(await api(page, "/api/restaurant")).toMatchObject({
      body: {
        restaurant: { id: isolatedFixture.secondRestaurantId },
      },
      status: 200,
    });

    if (process.env.TERROIR_E2E_FORCE_FAILURE === "1") {
      expect(
        false,
        "Intentional staging browser failure for encrypted evidence verification.",
      ).toBe(true);
    }
  });
});
