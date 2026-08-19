import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.describe("@opp-3 insights drill-down", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL; shared DB — run locally only for now.",
  );
  test.describe.configure({ mode: "serial" });

  const producer = `E2E Insights ${Date.now()}`;
  let restaurantId: string;
  let wineId: string;

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "insights E2E requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function resolveRestaurantId(): Promise<string> {
    const email = process.env.DEV_BYPASS_EMAIL;
    if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
    const admin = adminClient();
    let user: { id: string } | undefined;
    for (let page = 1; !user; page++) {
      const { data: users, error: userError } =
        await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (userError) throw userError;
      user = users.users.find((candidate) => candidate.email === email);
      if (users.users.length < 200) break;
    }
    if (!user) throw new Error(`Dev user ${email} not found`);
    const { data, error } = await admin
      .from("memberships")
      .select("restaurant_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data?.[0]) throw new Error("No membership for dev user");
    return data[0].restaurant_id;
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
      .insert({
        restaurant_id: restaurantId,
        producer,
        name: "Dashboard Fixture",
        vintage: 2024,
        size_ml: 750,
        is_eightysixed: true,
      })
      .select("id")
      .single();
    if (error) throw error;
    wineId = data.id;
    const { error: inventoryError } = await admin.from("inventory_items").insert({
      restaurant_id: restaurantId,
      wine_id: wineId,
      quantity: 1,
      unit_cost: 25,
    });
    if (inventoryError) throw inventoryError;
  });

  test.afterAll(async () => {
    if (!wineId) return;
    const admin = adminClient();
    const { error: inventoryError } = await admin
      .from("inventory_items")
      .delete()
      .eq("wine_id", wineId);
    const { error: wineError } = await admin
      .from("wines")
      .delete()
      .eq("id", wineId);
    const cleanupError = inventoryError ?? wineError;
    if (cleanupError) throw cleanupError;
  });

  test("EV-3.1/3.3: every metric is linked and 86'd drills into the out filter", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/insights");

    const metrics = page.locator("[data-metric]");
    await expect(metrics.first()).toBeVisible();
    await expect(page.locator("#pour-analytics-heading")).toBeVisible();
    const linkState = await metrics.evaluateAll((elements) =>
      elements.map((element) => {
        const anchor = element.matches("a[href]")
          ? element
          : element.querySelector("a[href]");
        return anchor?.getAttribute("href") ?? "";
      }),
    );
    expect(linkState.length).toBeGreaterThan(0);
    expect(
      linkState.every((href) => /^\/cellar(?:\?|$)/.test(href)),
    ).toBeTruthy();

    await page.locator('[data-metric="eightysixed-count"] a').click();
    await expect(page).toHaveURL(/\/cellar\?filter=out$/);
  });
});
