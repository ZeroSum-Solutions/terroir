import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import {
  assertIsolatedE2eConfig,
  type IsolatedE2eConfig,
} from "./config";
import type { IsolatedFixture } from "./isolated-fixture";

/** Seeds lifecycle-valid job rows for TER-021D browser verification. */
export async function seedBackgroundJobFixture(
  config: IsolatedE2eConfig,
  fixture: IsolatedFixture,
): Promise<void> {
  assertIsolatedE2eConfig(config);
  const admin = createClient<Database>(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const now = new Date();
  const finishedAt = now.toISOString();
  const startedAt = new Date(now.getTime() - 30_000).toISOString();
  const rows: Database["public"]["Tables"]["background_jobs"]["Insert"][] = [
    {
      created_by: fixture.userId,
      id: fixtureUuid(`${fixture.namespace}:job:queued`),
      idempotency_key: `e2e-${fixture.namespace}-queued`,
      job_type: "invoice_ocr",
      restaurant_id: fixture.restaurantId,
      status: "queued",
      subject_table: "invoice_scans",
    },
    {
      attempt_count: 1,
      claimed_by: `e2e-worker-${fixture.namespace}`,
      created_by: fixture.userId,
      heartbeat_at: startedAt,
      id: fixtureUuid(`${fixture.namespace}:job:running`),
      idempotency_key: `e2e-${fixture.namespace}-running`,
      job_type: "wine_enrichment",
      lease_expires_at: new Date(now.getTime() + 90_000).toISOString(),
      lease_token: fixtureUuid(`${fixture.namespace}:job:lease`),
      restaurant_id: fixture.restaurantId,
      started_at: startedAt,
      status: "running",
      subject_id: fixture.wineId,
      subject_table: "wines",
    },
    {
      attempt_count: 1,
      created_by: fixture.userId,
      error_code: "provider_timeout",
      error_message: "E2E retry fixture",
      id: fixtureUuid(`${fixture.namespace}:job:retrying`),
      idempotency_key: `e2e-${fixture.namespace}-retrying`,
      job_type: "invoice_ocr",
      restaurant_id: fixture.restaurantId,
      run_after: new Date(now.getTime() + 60_000).toISOString(),
      status: "retrying",
      subject_table: "invoice_scans",
    },
    {
      attempt_count: 1,
      created_by: fixture.userId,
      finished_at: finishedAt,
      id: fixtureUuid(`${fixture.namespace}:job:succeeded`),
      idempotency_key: `e2e-${fixture.namespace}-succeeded`,
      job_type: "wine_enrichment",
      restaurant_id: fixture.restaurantId,
      status: "succeeded",
      subject_id: fixture.wineId,
      subject_table: "wines",
    },
    {
      attempt_count: 3,
      created_by: fixture.userId,
      dead_lettered_at: finishedAt,
      error_code: "attempts_exhausted",
      error_message: "E2E dead-letter fixture",
      finished_at: finishedAt,
      id: fixtureUuid(`${fixture.namespace}:job:dead-letter`),
      idempotency_key: `e2e-${fixture.namespace}-dead-letter`,
      job_type: "wine_list_pdf",
      restaurant_id: fixture.restaurantId,
      status: "failed",
      subject_id: fixture.listId,
      subject_table: "wine_lists",
    },
    {
      created_by: fixture.userId,
      id: fixtureUuid(`${fixture.namespace}:job:second-tenant`),
      idempotency_key: `e2e-${fixture.namespace}-second-tenant`,
      job_type: "wine_enrichment",
      restaurant_id: fixture.secondRestaurantId,
      status: "queued",
      subject_id: fixture.secondWineId,
      subject_table: "wines",
    },
  ];

  const { error } = await admin.from("background_jobs").insert(rows);
  if (error) throw error;
}

function fixtureUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
