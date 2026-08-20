import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.describe("@opp-7 staff, comp, and anomaly analytics", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL and service-role fixtures; local only.",
  );
  test.describe.configure({ mode: "serial" });

  const run = `${Date.now()}`;
  const producer = `E2E Staff Analytics ${run}`;
  let membershipId: string;
  let originalRole: "owner" | "manager" | "staff";
  let restaurantId: string;
  let userId: string;
  let wineId: string;
  let reasonId: string;
  let closeoutId: string | undefined;

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("OPP-7 E2E requires Supabase URL and service-role key.");
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
      .select("id, restaurant_id, role, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data?.[0]) throw new Error("No membership for dev user");
    return {
      membershipId: data[0].id,
      originalRole: data[0].role,
      restaurantId: data[0].restaurant_id,
      userId: user.id,
    };
  }

  async function login(page: Page) {
    const response = await page.request.get("/api/dev-login");
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  test.beforeAll(async () => {
    ({ membershipId, originalRole, restaurantId, userId } = await resolveActor());
    const admin = adminClient();
    const { data: wine, error: wineError } = await admin
      .from("wines")
      .insert({
        restaurant_id: restaurantId,
        producer,
        name: "Comp Fixture",
        vintage: 2024,
        size_ml: 750,
      })
      .select("id")
      .single();
    if (wineError) throw wineError;
    wineId = wine.id;
    const { data: reason, error: reasonError } = await admin
      .from("reason_codes")
      .insert({
        restaurant_id: restaurantId,
        code: `opp7-${run}`,
        label: `Guest recovery ${run}`,
        category: "comp",
      })
      .select("id")
      .single();
    if (reasonError) throw reasonError;
    reasonId = reason.id;
  });

  test.afterAll(async () => {
    const admin = adminClient();
    if (membershipId && originalRole) {
      await admin.from("memberships").update({ role: originalRole }).eq("id", membershipId);
    }
    if (wineId) {
      await admin.from("stock_adjustments").delete().eq("wine_id", wineId);
      await admin.from("bottle_closeouts").delete().eq("wine_id", wineId);
      await admin.from("pour_events").delete().eq("wine_id", wineId);
    }
    if (reasonId) await admin.from("reason_codes").delete().eq("id", reasonId);
    if (wineId) await admin.from("wines").delete().eq("id", wineId);
  });

  test("EV-7.1/7.2: stock events use the session actor and require an active reason", async ({ page }) => {
    await login(page);
    const invalid = await page.request.post("/api/stock-adjustments", {
      data: {
        wine_id: wineId,
        kind: "comp",
        bottles: 1,
        reason_code_id: "00000000-0000-4000-8000-000000000007",
      },
    });
    expect(invalid.status()).toBe(422);
    expect((await invalid.json()).error.code).toBe("invalid_reason_code");

    const recorded = await page.request.post("/api/stock-adjustments", {
      data: {
        wine_id: wineId,
        kind: "comp",
        bottles: 1,
        reason_code_id: reasonId,
        note: `api-${run}`,
        acting_user_id: "00000000-0000-4000-8000-000000000099",
      },
    });
    expect(recorded.status(), await recorded.text()).toBe(201);
    const admin = adminClient();
    const { data: apiEvent, error } = await admin
      .from("stock_adjustments")
      .select("acting_user_id, reason_code_id")
      .eq("wine_id", wineId)
      .eq("note", `api-${run}`)
      .single();
    if (error) throw error;
    expect(apiEvent).toEqual({ acting_user_id: userId, reason_code_id: reasonId });

    await page.goto(`/cellar?wine=${wineId}`);
    const form = page.getByRole("region", { name: "Stock adjustment" });
    await form.getByRole("combobox", { name: "Reason" }).selectOption(reasonId);
    await form.getByRole("textbox", { name: "Note" }).fill(`ui-${run}`);
    await form.getByRole("button", { name: "Record event" }).click();
    await expect(form.getByRole("status")).toHaveText("Event recorded.");
  });

  test("EV-7.3: manager view shows house-relative member metrics and neutral variance copy", async ({ page }) => {
    const admin = adminClient();
    await admin.from("memberships").update({ role: "manager" }).eq("id", membershipId);
    const { error: pourError } = await admin.from("pour_events").insert({
      restaurant_id: restaurantId,
      wine_id: wineId,
      actor_user_id: userId,
      kind: "pour",
      ml_delta: 150,
    });
    if (pourError) throw pourError;
    const { data: closeout, error: closeoutError } = await admin
      .from("bottle_closeouts")
      .insert({
        restaurant_id: restaurantId,
        wine_id: wineId,
        preservation_method: "none",
        closed_by: userId,
        theoretical_remaining_ml: 750,
        actual_remaining_ml: 700,
      })
      .select("id")
      .single();
    if (closeoutError) throw closeoutError;
    closeoutId = closeout.id;

    await login(page);
    await page.goto("/team");
    const analytics = page.getByRole("region", { name: "Member analytics" });
    await expect(analytics).toContainText("House median");
    const row = page.locator(`[id="member-${userId}"]`);
    await expect(row).toContainText("Variance investigation");
    await expect(row.locator("[data-metric]")).toHaveCount(4);
  });

  test("EV-7.4: staff gets 403 from the analytics API; roster stays visible without analytics", async ({ page }) => {
    const admin = adminClient();
    await admin.from("memberships").update({ role: "staff" }).eq("id", membershipId);
    await login(page);
    try {
      const api = await page.request.get("/api/member-analytics");
      expect(api.status()).toBe(403);
      const team = await page.goto("/team");
      expect(team?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Member analytics" }),
      ).toHaveCount(0);
    } finally {
      await admin.from("memberships").update({ role: originalRole }).eq("id", membershipId);
    }
    expect(closeoutId).toBeTruthy();
  });
});
