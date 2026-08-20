import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.describe("@opp-6 bin management", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL; shared DB — run locally only for now.",
  );
  test.describe.configure({ mode: "serial" });

  const RUN = `${Date.now()}`;
  const BIN_CODE = `E2E-${RUN.slice(-8)}`;
  const ZONE = `E2E Zone ${RUN}`;
  const WINE_NAME = `Bottle Search ${RUN}`;
  const PRODUCER = `E2E Producer ${RUN}`;
  const QUANTITY = 7;

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "bins E2E requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function resolveRestaurantId(): Promise<string> {
    const email = process.env.DEV_BYPASS_EMAIL;
    if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
    const admin = adminClient();
    const { data: users, error: userError } =
      await admin.auth.admin.listUsers({ perPage: 200 });
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

  let restaurantId: string;
  let binId: string;
  let wineId: string;
  let inventoryId: string;

  test.beforeAll(async () => {
    restaurantId = await resolveRestaurantId();
    const admin = adminClient();
    const { data: bin, error: binError } = await admin
      .from("bins")
      .insert({
        restaurant_id: restaurantId,
        code: BIN_CODE,
        zone: ZONE,
        capacity: 24,
        priority: 3,
      })
      .select("id")
      .single();
    if (binError) throw binError;
    binId = bin.id;

    const { data: wine, error: wineError } = await admin
      .from("wines")
      .insert({
        restaurant_id: restaurantId,
        name: WINE_NAME,
        producer: PRODUCER,
        vintage: 2021,
        size_ml: 750,
      })
      .select("id")
      .single();
    if (wineError) throw wineError;
    wineId = wine.id;

    const { data: inventory, error: inventoryError } = await admin
      .from("inventory_items")
      .insert({
        restaurant_id: restaurantId,
        wine_id: wineId,
        quantity: QUANTITY,
        unit_cost: 30,
        bin_id: binId,
        bin_location: BIN_CODE,
      })
      .select("id")
      .single();
    if (inventoryError) throw inventoryError;
    inventoryId = inventory.id;
  });

  test.afterAll(async () => {
    const admin = adminClient();
    if (inventoryId) {
      await admin.from("inventory_items").delete().eq("id", inventoryId);
    }
    if (wineId) await admin.from("wines").delete().eq("id", wineId);
    if (binId) await admin.from("bins").delete().eq("id", binId);
  });

  test("EV-6.1/6.2: seeded bin renders occupancy and bottle search path", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/bins");

    const row = page.locator("[data-bin-row]", { hasText: BIN_CODE });
    await expect(row).toBeVisible();
    await expect(row).toContainText("1 wine · 7 bottles");

    await page.getByRole("searchbox", { name: "Find a bottle" }).fill(WINE_NAME.toLowerCase());
    const result = page.locator("[data-bottle-match]", { hasText: WINE_NAME });
    await expect(result).toContainText(PRODUCER);
    await expect(result).toContainText(`${ZONE} › ${BIN_CODE}`);
    await expect(result).toContainText(`${QUANTITY} bottles`);
  });
});
