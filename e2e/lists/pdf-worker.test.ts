import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import type { APIResponse } from "@playwright/test";
import { expect, test } from "../fixtures/isolated-test";
import type { Database } from "../../src/types/database";

test.describe("wine-list PDF worker pilot", () => {
  test.skip(
    process.env.TERROIR_E2E_ENABLED !== "1" ||
      process.env.PDF_WORKER_E2E_ENABLED !== "1",
    "TERROIR_E2E_ENABLED=1 and PDF_WORKER_E2E_ENABLED=1 are required.",
  );

  test("deduplicates enqueue, denies another active tenant, and downloads PDF", async ({
    isolatedConfig,
    isolatedFixture,
    page,
  }) => {
    test.setTimeout(300_000);

    const switchResponse = await page.request.put(
      `/api/restaurant/${isolatedFixture.restaurantId}`,
      {
        data: {},
        headers: {
          "Idempotency-Key": `e2e-pdf-switch-${isolatedFixture.namespace}`,
        },
      },
    );
    expect(switchResponse.ok()).toBe(true);

    const idempotencyKey = `e2e-pdf-${isolatedFixture.namespace}`;
    const requestPdf = () => page.request.post("/api/pdf", {
      data: { listId: isolatedFixture.listId, template: "minimal" },
      headers: { "Idempotency-Key": idempotencyKey },
    });
    const first = await requestPdf();
    const replay = await requestPdf();
    expect(first.status()).toBe(202);
    expect(replay.status()).toBe(202);
    const firstJob = await first.json() as { jobId: string };
    const replayJob = await replay.json() as { jobId: string };
    expect(replayJob.jobId).toBe(firstJob.jobId);

    const crossTenant = await page.request.post("/api/pdf", {
      data: { listId: isolatedFixture.secondListId },
      headers: {
        "Idempotency-Key": `e2e-pdf-cross-${isolatedFixture.namespace}`,
      },
    });
    expect(crossTenant.status()).toBe(404);

    let artifact: APIResponse | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      artifact = await page.request.post("/api/pdf", {
        data: { jobId: firstJob.jobId },
      });
      if (artifact.status() !== 202) break;
      await page.waitForTimeout(2_000);
    }
    expect(artifact?.status()).toBe(200);
    expect(artifact?.headers()["content-type"]).toContain("application/pdf");
    if (!artifact) throw new Error("PDF artifact response was not received");
    expect((await artifact.body()).subarray(0, 4).toString()).toBe("%PDF");

    const switchAway = await page.request.put(
      `/api/restaurant/${isolatedFixture.secondRestaurantId}`,
      {
        data: {},
        headers: {
          "Idempotency-Key": `e2e-pdf-switch-away-${isolatedFixture.namespace}`,
        },
      },
    );
    expect(switchAway.ok()).toBe(true);
    const crossTenantArtifact = await page.request.post("/api/pdf", {
      data: { jobId: firstJob.jobId },
    });
    expect(crossTenantArtifact.status()).toBe(404);
    const switchBack = await page.request.put(
      `/api/restaurant/${isolatedFixture.restaurantId}`,
      {
        data: {},
        headers: {
          "Idempotency-Key": `e2e-pdf-switch-back-${isolatedFixture.namespace}`,
        },
      },
    );
    expect(switchBack.ok()).toBe(true);

    await page.goto(`/lists/${isolatedFixture.listId}`, {
      waitUntil: "networkidle",
    });
    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("button", { name: "Download PDF" }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const downloadedPdf = await readFile(downloadPath!);
    expect(downloadedPdf.subarray(0, 4).toString()).toBe("%PDF");

    const admin = createClient<Database>(
      isolatedConfig.supabaseUrl,
      isolatedConfig.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: jobs, error: jobError } = await admin
      .from("background_jobs")
      .select("id")
      .eq("restaurant_id", isolatedFixture.restaurantId)
      .eq("job_type", "wine_list_pdf")
      .eq("idempotency_key", idempotencyKey);
    if (jobError) throw jobError;
    expect(jobs).toEqual([{ id: firstJob.jobId }]);

    const { data: artifacts, error: artifactError } = await admin.storage
      .from("generated-exports")
      .list(isolatedFixture.restaurantId);
    if (artifactError) throw artifactError;
    expect(artifacts?.map((entry) => entry.name)).toContain(
      `${isolatedFixture.listId}_minimal.pdf`,
    );
  });

  test("drains a 10-request PDF load into one canonical artifact", async ({
    isolatedConfig,
    isolatedFixture,
    page,
  }) => {
    test.setTimeout(300_000);

    const switchResponse = await page.request.put(
      `/api/restaurant/${isolatedFixture.restaurantId}`,
      {
        data: {},
        headers: {
          "Idempotency-Key": `e2e-pdf-load-switch-${isolatedFixture.namespace}`,
        },
      },
    );
    expect(switchResponse.ok()).toBe(true);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        page.request.post("/api/pdf", {
          data: { listId: isolatedFixture.listId, template: "minimal" },
          headers: {
            "Idempotency-Key": `e2e-pdf-load-${isolatedFixture.namespace}-${index}`,
          },
        }),
      ),
    );
    expect(responses.map((response) => response.status())).toEqual(
      Array(10).fill(202),
    );
    const jobIds = await Promise.all(
      responses.map(async (response) =>
        ((await response.json()) as { jobId: string }).jobId,
      ),
    );
    expect(new Set(jobIds).size).toBe(10);

    const admin = createClient<Database>(
      isolatedConfig.supabaseUrl,
      isolatedConfig.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    let succeeded = 0;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const { data: jobs, error } = await admin
        .from("background_jobs")
        .select("id,status,attempt_count")
        .in("id", jobIds);
      if (error) throw error;
      succeeded = (jobs ?? []).filter(
        (job) => job.status === "succeeded" && job.attempt_count === 1,
      ).length;
      if (succeeded === 10) break;
      await page.waitForTimeout(1_000);
    }
    expect(succeeded).toBe(10);

    const { data: artifacts, error: artifactError } = await admin.storage
      .from("generated-exports")
      .list(isolatedFixture.restaurantId);
    if (artifactError) throw artifactError;
    expect(
      artifacts?.filter(
        (entry) => entry.name === `${isolatedFixture.listId}_minimal.pdf`,
      ),
    ).toHaveLength(1);
  });
});
