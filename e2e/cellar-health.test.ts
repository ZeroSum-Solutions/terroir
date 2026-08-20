import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

test.describe("@opp-2 wine-aware cellar health", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL; shared DB — run locally only for now.",
  );
  test.describe.configure({ mode: "serial" });

  const producer = `E2E Cellar Health ${Date.now()}`;
  let restaurantId = "";
  let userId = "";
  let wineId = "";
  let configId = "";
  let createdConfig = false;
  let previousThreshold = 0.08;
  const jobIds: string[] = [];

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "cellar-health E2E requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function resolveActor() {
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
      throw new Error("Cellar-health E2E requires an owner or manager dev user");
    }
    return { restaurantId: data[0].restaurant_id, userId: user.id };
  }

  async function login(page: Page) {
    const response = await page.request.get("/api/dev-login");
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  async function recompute(request: APIRequestContext) {
    const startedAt = new Date().toISOString();
    const response = await request.post("/api/cellar-health/recompute");
    expect(response.ok(), await response.text()).toBeTruthy();
    const admin = adminClient();
    const { data, error } = await admin
      .from("background_jobs")
      .select("id")
      .eq("restaurant_id", restaurantId)
      .eq("created_by", userId)
      .eq("job_type", "cellar_health")
      .gte("created_at", startedAt)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (data?.[0]) jobIds.push(data[0].id);
  }

  test.beforeAll(async () => {
    ({ restaurantId, userId } = await resolveActor());
    const admin = adminClient();
    const { data: config, error: configError } = await admin
      .from("cellar_config")
      .select("id, health_appreciation_threshold")
      .eq("restaurant_id", restaurantId)
      .limit(1)
      .maybeSingle();
    if (configError) throw configError;
    if (config) {
      configId = config.id;
      previousThreshold = config.health_appreciation_threshold;
      const { error } = await admin
        .from("cellar_config")
        .update({ health_appreciation_threshold: 0.08 })
        .eq("id", configId);
      if (error) throw error;
    } else {
      const { data, error } = await admin
        .from("cellar_config")
        .insert({ restaurant_id: restaurantId, health_appreciation_threshold: 0.08 })
        .select("id")
        .single();
      if (error) throw error;
      configId = data.id;
      createdConfig = true;
    }

    const { data: wine, error: wineError } = await admin
      .from("wines")
      .insert({
        restaurant_id: restaurantId,
        producer,
        name: "Threshold Fixture",
        vintage: 2022,
        size_ml: 750,
        retail_median: 110,
      })
      .select("id")
      .single();
    if (wineError) throw wineError;
    wineId = wine.id;
    const { error: inventoryError } = await admin.from("inventory_items").insert({
      restaurant_id: restaurantId,
      wine_id: wineId,
      quantity: 6,
      unit_cost: 100,
      added_at: "2025-01-01T00:00:00.000Z",
    });
    if (inventoryError) throw inventoryError;
  });

  test.afterAll(async ({ request }) => {
    const admin = adminClient();
    const cleanupErrors: Error[] = [];
    if (wineId) {
      collectCleanupError(
        (await admin.from("cellar_health").delete().eq("wine_id", wineId)).error,
        "cellar_health",
        cleanupErrors,
      );
      collectCleanupError(
        (await admin.from("inventory_items").delete().eq("wine_id", wineId)).error,
        "inventory_items",
        cleanupErrors,
      );
      collectCleanupError(
        (await admin.from("wines").delete().eq("id", wineId)).error,
        "wines",
        cleanupErrors,
      );
    }
    if (configId) {
      if (createdConfig) {
        collectCleanupError(
          (await admin.from("cellar_config").delete().eq("id", configId)).error,
          "cellar_config",
          cleanupErrors,
        );
      } else {
        collectCleanupError(
          (
            await admin
              .from("cellar_config")
              .update({ health_appreciation_threshold: previousThreshold })
              .eq("id", configId)
          ).error,
          "cellar_config",
          cleanupErrors,
        );
      }
    }
    try {
      const loginResponse = await request.get("/api/dev-login");
      if (!loginResponse.ok()) throw new Error(await loginResponse.text());
      await recompute(request);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (jobIds.length) {
      collectCleanupError(
        (await admin.from("background_jobs").delete().in("id", jobIds)).error,
        "background_jobs",
        cleanupErrors,
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Cellar-health E2E cleanup failed");
    }
  });

  test("EV-2.3/2.4: recompute names the rule, responds to config, and drills into Cellar", async ({
    page,
  }) => {
    await login(page);
    await recompute(page.request);

    const admin = adminClient();
    const { data: first } = await admin
      .from("cellar_health")
      .select("segment, reason")
      .eq("wine_id", wineId)
      .single();
    expect(first?.segment).toBe("cash_trap");
    expect(first?.reason).toMatch(/^cash_trap rule:/);

    await page.goto("/insights");
    const metric = page.locator('[data-metric="cellar-health-cash_trap-count"] a');
    await expect(metric).toHaveAttribute("href", "/cellar?health=cash_trap");
    await metric.click();
    await expect(page).toHaveURL(/\/cellar\?health=cash_trap$/);
    await expect(page.getByText(producer, { exact: true })).toBeVisible();

    const { error: configError } = await admin
      .from("cellar_config")
      .update({ health_appreciation_threshold: 0.2 })
      .eq("id", configId);
    if (configError) throw configError;
    await recompute(page.request);

    const { data: second } = await admin
      .from("cellar_health")
      .select("segment, reason")
      .eq("wine_id", wineId)
      .single();
    expect(second?.segment).toBe("dead_stock");
    expect(second?.reason).toMatch(/^dead_stock rule:/);

    await page.goto("/cellar?health=dead_stock");
    await expect(page.getByText(producer, { exact: true })).toBeVisible();
  });
});

function collectCleanupError(
  error: { message: string } | null,
  table: string,
  errors: Error[],
) {
  if (error) errors.push(new Error(`${table} cleanup failed: ${error.message}`));
}
