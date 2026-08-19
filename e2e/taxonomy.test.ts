import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.describe("@opp-4 navigable wine taxonomy", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL; shared DB — run locally only for now.",
  );
  test.describe.configure({ mode: "serial" });

  const run = `${Date.now()}`;
  const producerA = `Taxonomy Alpha ${run}`;
  const producerB = `Taxonomy Beta ${run}`;
  const regionA = `Taxonomy Napa ${run}`;
  const regionB = `Taxonomy Rhone ${run}`;
  const names = [`Alpha One ${run}`, `Alpha Two ${run}`, `Beta One ${run}`];
  let restaurantId = "";
  let wineIds: string[] = [];

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "taxonomy E2E requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function resolveRestaurantId() {
    const email = process.env.DEV_BYPASS_EMAIL;
    if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
    const admin = adminClient();
    const { data: users, error: userError } = await admin.auth.admin.listUsers({ perPage: 200 });
    if (userError) throw userError;
    const user = users.users.find((candidate) => candidate.email === email);
    if (!user) throw new Error(`Dev user ${email} not found`);
    const { data, error } = await admin
      .from("memberships")
      .select("restaurant_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data?.[0]) throw new Error("No membership for dev user");
    return data[0].restaurant_id as string;
  }

  async function login(page: Page) {
    const response = await page.request.get("/api/dev-login");
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  test.beforeAll(async () => {
    restaurantId = await resolveRestaurantId();
    const admin = adminClient();
    const { data, error } = await admin
      .from("wines")
      .insert([
        {
          restaurant_id: restaurantId,
          name: names[0],
          producer: producerA,
          region: regionA,
          country: "USA",
          varietal: "Cabernet Sauvignon",
          vintage: 2018,
          size_ml: 750,
        },
        {
          restaurant_id: restaurantId,
          name: names[1],
          producer: producerA,
          region: regionA,
          country: "USA",
          varietal: "Merlot",
          vintage: 2020,
          size_ml: 750,
        },
        {
          restaurant_id: restaurantId,
          name: names[2],
          producer: producerB,
          region: regionB,
          country: "France",
          varietal: "Syrah",
          vintage: 2021,
          size_ml: 1_500,
        },
      ])
      .select("id");
    if (error) throw error;
    wineIds = data!.map((row) => row.id);
    const { error: inventoryError } = await admin.from("inventory_items").insert([
      { restaurant_id: restaurantId, wine_id: wineIds[0], quantity: 2 },
      { restaurant_id: restaurantId, wine_id: wineIds[1], quantity: 4 },
      { restaurant_id: restaurantId, wine_id: wineIds[2], quantity: 1 },
    ]);
    if (inventoryError) throw inventoryError;
  });

  test.afterAll(async () => {
    if (!wineIds.length) return;
    const admin = adminClient();
    await admin.from("inventory_items").delete().in("wine_id", wineIds);
    await admin.from("wines").delete().in("id", wineIds);
  });

  test("EV-4.1–4.3: region persists through reload and producer groups show exact rollups", async ({ page }) => {
    await login(page);
    await page.goto("/cellar");

    await page.getByLabel("Region").selectOption({ label: `${regionA} (2)` });
    await expect(page.getByText(names[0], { exact: true })).toBeVisible();
    await expect(page.getByText(names[1], { exact: true })).toBeVisible();
    await expect(page.getByText(names[2], { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`region=${encodeURIComponent(regionA)}`));

    await page.reload();
    await expect(page.getByLabel("Region")).toHaveValue(regionA);
    await expect(page.getByText(names[2], { exact: true })).toHaveCount(0);

    await page.getByLabel("Region").selectOption("");
    await page.getByLabel("Group by").selectOption("producer");
    await expect(page).toHaveURL(/group_by=producer/);

    const alpha = page.locator("[data-cellar-taxonomy-group]", { hasText: producerA });
    const beta = page.locator("[data-cellar-taxonomy-group]", { hasText: producerB });
    await expect(alpha.locator("[data-group-rollup]")).toHaveText("2 wines · 6 bottles");
    await expect(beta.locator("[data-group-rollup]")).toHaveText("1 wine · 1 bottle");

    await page.goto(`/cellar?wine=${wineIds[0]}`);
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(names[0], { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`wine=${wineIds[0]}`));
  });
});
