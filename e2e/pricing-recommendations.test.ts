import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.describe("@opp-9 wine-aware pricing timing", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL; shared DB — run locally only for now.",
  );
  test.describe.configure({ mode: "serial" });

  const producer = `E2E Pricing ${Date.now()}`;
  let restaurantId = "";
  let wineId = "";
  let listId = "";
  let jobIds: string[] = [];

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "pricing E2E requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function resolveRestaurantId() {
    const email = process.env.DEV_BYPASS_EMAIL;
    if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
    const admin = adminClient();
    const { data: users, error: userError } = await admin.auth.admin.listUsers({
      perPage: 200,
    });
    if (userError) throw userError;
    const user = users.users.find((candidate) => candidate.email === email);
    if (!user) throw new Error(`Dev user ${email} not found`);
    const { data, error } = await admin
      .from("memberships")
      .select("restaurant_id, role, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data?.[0] || !["owner", "manager"].includes(data[0].role)) {
      throw new Error("Pricing E2E requires an owner or manager dev user");
    }
    return data[0].restaurant_id;
  }

  async function login(page: Page) {
    const response = await page.request.get("/api/dev-login");
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  test.beforeAll(async () => {
    restaurantId = await resolveRestaurantId();
    const admin = adminClient();
    const { data: wine, error: wineError } = await admin
      .from("wines")
      .insert({
        restaurant_id: restaurantId,
        producer,
        name: "Tuesday Gamay",
        vintage: 2023,
        size_ml: 750,
        retail_median: 21,
      })
      .select("id")
      .single();
    if (wineError) throw wineError;
    wineId = wine.id;
    const { error: inventoryError } = await admin.from("inventory_items").insert({
      restaurant_id: restaurantId,
      wine_id: wineId,
      quantity: 6,
      unit_cost: 20,
    });
    if (inventoryError) throw inventoryError;
    const { data: list, error: listError } = await admin
      .from("wine_lists")
      .insert({ restaurant_id: restaurantId, name: `Pricing Fixture ${Date.now()}` })
      .select("id")
      .single();
    if (listError) throw listError;
    listId = list.id;
    const { data: section, error: sectionError } = await admin
      .from("wine_list_sections")
      .insert({ wine_list_id: listId, name: "By the glass" })
      .select("id")
      .single();
    if (sectionError) throw sectionError;
    const { error: itemError } = await admin.from("wine_list_items").insert({
      section_id: section.id,
      wine_id: wineId,
      // wine_list_items.restaurant_id is NOT NULL as of 0080 (denormalized,
      // composite-FK'd to wines(id, restaurant_id) and cross-checked against
      // the section's own restaurant by a BEFORE INSERT trigger) — must equal
      // both this wine's and this list's tenant, both of which are
      // restaurantId here.
      restaurant_id: restaurantId,
      glass_price: 28,
      glass_pour_ml: 148,
      bottle_price: 92,
    });
    if (itemError) throw itemError;
    const events = [
      "2026-08-18T12:00:00.000Z",
      "2026-08-14T12:00:00.000Z",
      "2026-08-14T13:00:00.000Z",
    ].map((occurred_at) => ({
      restaurant_id: restaurantId,
      wine_id: wineId,
      kind: "pour",
      ml_delta: 148,
      occurred_at,
    }));
    const { error: pourError } = await admin.from("pour_events").insert(events);
    if (pourError) throw pourError;
  });

  test.afterAll(async () => {
    const admin = adminClient();
    const errors: Error[] = [];
    const cleanup = [
      ["pricing_recommendations", admin.from("pricing_recommendations").delete().eq("wine_id", wineId)],
      ["pour_events", admin.from("pour_events").delete().eq("wine_id", wineId)],
      ["inventory_items", admin.from("inventory_items").delete().eq("wine_id", wineId)],
      ["wine_list_items", admin.from("wine_list_items").delete().eq("wine_id", wineId)],
      ["wine_list_sections", admin.from("wine_list_sections").delete().eq("wine_list_id", listId)],
      ["wine_lists", admin.from("wine_lists").delete().eq("id", listId)],
      ["wines", admin.from("wines").delete().eq("id", wineId)],
    ] as const;
    for (const [table, query] of cleanup) {
      const { error } = await query;
      if (error) errors.push(new Error(`${table} cleanup failed: ${error.message}`));
    }
    if (jobIds.length > 0) {
      const { error } = await admin.from("background_jobs").delete().in("id", jobIds);
      if (error) errors.push(new Error(`background_jobs cleanup failed: ${error.message}`));
    }
    if (errors.length) throw new AggregateError(errors, "Pricing E2E cleanup failed");
  });

  test("EV-9.1/9.3: recompute renders a timed, linked recommendation", async ({ page }) => {
    await login(page);
    const startedAt = new Date().toISOString();
    const response = await page.request.post("/api/pricing-recommendations/recompute");
    expect(response.ok(), await response.text()).toBeTruthy();
    const admin = adminClient();
    const { data: jobs } = await admin
      .from("background_jobs")
      .select("id")
      .eq("restaurant_id", restaurantId)
      .eq("job_type", "pricing_recommendations")
      .gte("created_at", startedAt);
    jobIds = (jobs ?? []).map((job) => job.id);

    await page.goto("/insights");
    const row = page.locator(`[data-metric="pricing-play-${wineId}"]`);
    await expect(row).toContainText(producer);
    await expect(row).toContainText("Feature BTG Tuesday");
    await expect(row.locator("a")).toHaveAttribute("href", `/cellar?wine=${wineId}`);
  });
});
