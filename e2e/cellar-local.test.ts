import { expect, test, type Page } from "@playwright/test";

const PASSWORD = process.env.LOCAL_SEED_USER_PASSWORD ?? "Terroir-local-123!";
const FOREIGN_WINE_ID = "fa100001-0000-4000-8000-000000000001";

async function signIn(page: Page, role: "manager" | "staff") {
  await page.goto("/login?mode=password&next=%2Fcellar");
  await page.getByLabel("Work email").fill(`${role}+local@terroir.test`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/cellar(?:\?|$)/, { timeout: 15_000 });
}

test.describe("TER-025 local isolated cellar", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    process.env.LOCAL_E2E_ENABLED !== "1",
    "Requires the deterministic local Supabase seed.",
  );

  test("manager can filter, inspect, and make a reasoned quantity adjustment", async ({
    page,
  }) => {
    await signIn(page, "manager");
    await expect(page.getByRole("heading", { name: "Cellar" })).toBeVisible();

    const search = page.getByPlaceholder(
      "Search name, producer, varietal, region, vintage…",
    );
    await search.fill("1999");
    await expect(
      page.getByRole("button", { name: /Bordeaux Cabernet Blend Lot 001/i }),
    ).toBeVisible();

    await page.getByLabel("Colour").selectOption("red");
    await page.getByLabel("Region or country").selectOption("France");
    await page.getByLabel("Minimum vintage").fill("1999");
    await page.getByLabel("Maximum vintage").fill("1999");
    await page.getByLabel("Sort by").selectOption("quantity");
    await expect(
      page.getByRole("button", { name: /Bordeaux Cabernet Blend Lot 001/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Clear inventory filters" }).click();
    await search.fill("");
    await page
      .getByRole("button", { name: /Bordeaux Cabernet Blend Lot 001/i })
      .click();

    const drawer = page.getByRole("dialog", { name: /Bordeaux Cabernet Blend Lot 001/i });
    await expect(drawer.getByText("Average cost")).toBeVisible();
    await expect(drawer.getByText("Last purchase")).toBeVisible();
    await expect(drawer.getByLabel("Inventory by format")).toBeVisible();

    await drawer.getByRole("button", { name: "Adjust quantity" }).click();
    const adjustment = page.getByRole("dialog", { name: "Adjust quantity" });
    const quantity = adjustment.getByLabel("Current sealed quantity");
    const before = Number(await quantity.inputValue());
    expect(before).toBeGreaterThan(0);
    await quantity.fill(String(before - 1));
    await adjustment.getByLabel("Reason").fill("TER-025 isolated browser count");
    await adjustment
      .getByRole("button", { name: "Save audited adjustment" })
      .click();
    await expect(page.getByText("Quantity adjusted and logged")).toBeVisible();

    const crossTenant = await page.request.patch(
      `/api/cellar/${FOREIGN_WINE_ID}/quantity`,
      {
        headers: { "Idempotency-Key": "ter025-cross-tenant-browser-0001" },
        data: { quantity: 1, reason: "Must not cross tenant" },
      },
    );
    expect(crossTenant.status()).toBe(404);
  });

  test("staff is read-only and cannot enter cellar configuration", async ({ page }) => {
    await signIn(page, "staff");
    await page.goto("/cellar/config");
    await expect(page).toHaveURL(/\/cellar(?:\?|$)/);

    await page
      .getByRole("button", { name: /Bordeaux Cabernet Blend Lot 001/i })
      .click();
    const drawer = page.getByRole("dialog", { name: /Bordeaux Cabernet Blend Lot 001/i });
    await expect(drawer.getByRole("button", { name: "Adjust quantity" })).toHaveCount(0);

    const denied = await page.request.patch(
      "/api/cellar/de100001-0000-4000-8000-000000000001/quantity",
      { data: { quantity: 1, reason: "Staff must not mutate" } },
    );
    expect(denied.status()).toBe(403);
  });
});
