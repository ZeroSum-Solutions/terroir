import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.describe("@opp-10 partial-bottle close-out loop", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL and service-role fixtures; local only.",
  );
  test.describe.configure({ mode: "serial" });

  const run = `${Date.now()}`;
  const producer = `E2E Partial Bottle ${run}`;
  let restaurantId: string;
  let userId: string;
  let wineId: string;
  let bottleId: string;
  let reasonId: string;

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("OPP-10 E2E requires Supabase URL and service-role key.");
    }
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function resolveActor() {
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
    return { userId: user.id, restaurantId: data[0].restaurant_id };
  }

  async function login(page: Page) {
    const response = await page.request.get("/api/dev-login");
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  test.beforeAll(async () => {
    ({ userId, restaurantId } = await resolveActor());
    const admin = adminClient();
    const { data: wine, error: wineError } = await admin
      .from("wines")
      .insert({ restaurant_id: restaurantId, producer, name: "Close-out Fixture", vintage: 2025, size_ml: 750 })
      .select("id")
      .single();
    if (wineError) throw wineError;
    wineId = wine.id;
    const { error: inventoryError } = await admin.from("inventory_items").insert({
      restaurant_id: restaurantId,
      wine_id: wineId,
      quantity: 1,
      unit_cost: 25,
    });
    if (inventoryError) throw inventoryError;
    const { data: reason, error: reasonError } = await admin
      .from("reason_codes")
      .insert({ restaurant_id: restaurantId, code: `opp10-${run}`, label: `Spoilage ${run}`, category: "spoilage" })
      .select("id")
      .single();
    if (reasonError) throw reasonError;
    reasonId = reason.id;
  });

  test.afterAll(async () => {
    const admin = adminClient();
    if (wineId) {
      const { error: closeoutError } = await admin
        .from("bottle_closeouts").delete().eq("wine_id", wineId);
      if (closeoutError) throw closeoutError;
      const { error: pourError } = await admin
        .from("pour_events").delete().eq("wine_id", wineId);
      if (pourError) throw pourError;
      const { error: bottleError } = await admin
        .from("open_bottles").delete().eq("wine_id", wineId);
      if (bottleError) throw bottleError;
      const { error: inventoryError } = await admin
        .from("inventory_items").delete().eq("wine_id", wineId);
      if (inventoryError) throw inventoryError;
    }
    if (reasonId) {
      const { error: reasonError } = await admin
        .from("reason_codes").delete().eq("id", reasonId);
      if (reasonError) throw reasonError;
    }
    if (wineId) {
      const { error: wineError } = await admin
        .from("wines").delete().eq("id", wineId);
      if (wineError) throw wineError;
    }
  });

  test("EV-10.1/10.2/10.3: preserve, close with variance, and drill through yield", async ({ page }) => {
    await login(page);
    const opened = await page.request.post("/api/open-bottles", {
      data: { wine_id: wineId, preservation_method: "coravin" },
    });
    expect(opened.status(), await opened.text()).toBe(201);
    bottleId = (await opened.json()).open_bottle.id;
    const admin = adminClient();
    const { error: pourError } = await admin.from("pour_events").insert({
      restaurant_id: restaurantId,
      wine_id: wineId,
      open_bottle_id: bottleId,
      actor_user_id: userId,
      kind: "pour",
      ml_delta: 100,
    });
    if (pourError) throw pourError;

    await page.goto(`/cellar?wine=${wineId}`);
    const closeout = page.getByRole("region", { name: "Partial bottle close-out" });
    await expect(closeout).toContainText("650 ml theoretical remaining");
    await closeout.locator('input[name="actual_remaining_ml"]').fill("620");
    await closeout.locator('input[name="written_off_ml"]').fill("30");
    await closeout.getByRole("combobox").selectOption(reasonId);
    await closeout.getByRole("button", { name: "Close bottle" }).click();

    await expect.poll(async () => {
      const { data } = await admin
        .from("bottle_closeouts")
        .select("variance_ml")
        .eq("open_bottle_id", bottleId)
        .single();
      return data?.variance_ml;
    }).toBe(-30);
    const { data: finish } = await admin
      .from("pour_events")
      .select("kind")
      .eq("open_bottle_id", bottleId)
      .eq("kind", "finish_bottle");
    expect(finish).toHaveLength(1);

    await page.goto("/insights");
    const yieldSection = page.getByRole("region", { name: "Partial-bottle yield" });
    await expect(yieldSection).toContainText("Coravin");
    await expect(yieldSection).toContainText("100 ml actual");
    await expect(yieldSection).toContainText("100 ml theoretical");
    await yieldSection.locator(`[data-metric="yield-${bottleId}-actual"] a`).click();
    await expect(page).toHaveURL(new RegExp(`/cellar\\?wine=${wineId}$`));
  });
});
