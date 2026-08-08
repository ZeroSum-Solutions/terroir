import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import type { Database } from "../src/types/database";
import { expect, test } from "./fixtures/isolated-test";

async function selectPrimaryRestaurant(
  page: Page,
  restaurantId: string,
  namespace: string,
) {
  const response = await page.request.put(`/api/restaurant/${restaurantId}`, {
    data: {},
    headers: {
      "Idempotency-Key":
        `e2e-worker-enrich-${namespace}-${restaurantId.slice(0, 8)}-${randomUUID()}`,
    },
  });
  expect(response.status()).toBe(200);
}

test.describe("TER-021G isolated wine-enrichment worker", () => {
  test.describe.configure({ timeout: 180_000 });
  test.skip(
    process.env.TERROIR_E2E_ENABLED !== "1" ||
      process.env.WINE_ENRICHMENT_WORKER_E2E_ENABLED !== "1",
    "TERROIR_E2E_ENABLED=1 and WINE_ENRICHMENT_WORKER_E2E_ENABLED=1 are required.",
  );

  test("queues one tenant-bound job, replays its identity, and preserves manual fields", async ({
    isolatedConfig,
    isolatedFixture,
    page,
  }) => {
    const admin = createClient<Database>(
      isolatedConfig.supabaseUrl,
      isolatedConfig.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error: seedError } = await admin
      .from("wines")
      .update({
        varietal: "Cabernet Sauvignon",
        region: "Napa Valley",
        drink_window_start: 2010,
        drink_window_end: 2012,
        peak_year: 2011,
        serving_temp_min: null,
        serving_temp_max: null,
        serving_temp_label: null,
        decant_minutes: null,
        manual_overrides: ["drink_window"],
      })
      .eq("id", isolatedFixture.wineId)
      .eq("restaurant_id", isolatedFixture.restaurantId);
    if (seedError) throw seedError;

    await selectPrimaryRestaurant(
      page,
      isolatedFixture.restaurantId,
      isolatedFixture.namespace,
    );
    const idempotencyKey = `worker-enrich-${randomUUID()}`;
    const first = await page.request.post(
      `/api/wines/${isolatedFixture.wineId}/enrich`,
      { headers: { "Idempotency-Key": idempotencyKey }, data: {} },
    );
    expect(first.status()).toBe(202);
    const firstBody = await first.json() as { jobId: string; status: string };
    expect(firstBody.status).toBe("queued");

    const replay = await page.request.post(
      `/api/wines/${isolatedFixture.wineId}/enrich`,
      { headers: { "Idempotency-Key": idempotencyKey }, data: {} },
    );
    expect(replay.status()).toBe(202);
    expect(replay.headers()["idempotency-replayed"]).toBe("true");
    expect(await replay.json()).toEqual(firstBody);

    await expect.poll(async () => {
      const { data, error } = await admin
        .from("background_jobs")
        .select("status")
        .eq("id", firstBody.jobId)
        .eq("restaurant_id", isolatedFixture.restaurantId)
        .single();
      if (error) throw error;
      return data.status;
    }, { timeout: 120_000 }).toBe("succeeded");

    const { data: jobs, error: jobsError } = await admin
      .from("background_jobs")
      .select("id,attempt_count")
      .eq("restaurant_id", isolatedFixture.restaurantId)
      .eq("job_type", "wine_enrichment")
      .eq("idempotency_key", idempotencyKey);
    if (jobsError) throw jobsError;
    expect(jobs).toEqual([{ id: firstBody.jobId, attempt_count: 1 }]);

    const { data: persisted, error: persistedError } = await admin
      .from("wines")
      .select(
        "drink_window_start,drink_window_end,peak_year,serving_temp_min,manual_overrides",
      )
      .eq("id", isolatedFixture.wineId)
      .eq("restaurant_id", isolatedFixture.restaurantId)
      .single();
    if (persistedError) throw persistedError;
    expect(persisted).toMatchObject({
      drink_window_start: 2010,
      drink_window_end: 2012,
      peak_year: 2011,
      serving_temp_min: 60,
    });
    expect(persisted.manual_overrides).toContain("drink_window");

    const foreign = await page.request.post(
      `/api/wines/${isolatedFixture.secondWineId}/enrich`,
      { headers: { "Idempotency-Key": randomUUID() }, data: {} },
    );
    expect(foreign.status()).toBe(404);
  });
});
