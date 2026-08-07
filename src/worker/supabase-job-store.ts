import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database.ts";
import type { BackgroundJob, JobStore, QueueHealth } from "./types.ts";

type Client = SupabaseClient<Database>;

function requireLease(job: BackgroundJob): string {
  if (!job.lease_token) throw new Error("Claimed background job has no lease token");
  return job.lease_token;
}

function assertSuccess(error: { message: string } | null): void {
  if (error) throw new Error("Background job store operation failed");
}

function asJob(data: unknown): BackgroundJob {
  if (!data || typeof data !== "object") {
    throw new Error("Background job store returned an invalid row");
  }
  return data as BackgroundJob;
}

async function countStatus(client: Client, statuses: string[]): Promise<number> {
  const query = client
    .from("background_jobs")
    .select("id", { count: "exact", head: true });
  const { count, error } =
    statuses.length === 1
      ? await query.eq("status", statuses[0])
      : await query.in("status", statuses);
  assertSuccess(error);
  return count ?? 0;
}

async function oldestQueuedAt(client: Client): Promise<string | null> {
  const { data, error } = await client
    .from("background_jobs")
    .select("created_at")
    .in("status", ["queued", "retrying"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  assertSuccess(error);
  return data?.created_at ?? null;
}

export function createSupabaseJobStore(client: Client): JobStore {
  return {
    async claim(input) {
      const { data, error } = await client.rpc("claim_background_jobs", {
        p_worker_id: input.workerId,
        p_limit: input.limit,
        p_lease_seconds: input.leaseSeconds,
        p_base_backoff_seconds: input.baseBackoffSeconds,
      });
      assertSuccess(error);
      if (!Array.isArray(data)) throw new Error("Claim RPC returned an invalid payload");
      return data.map(asJob);
    },

    async heartbeat(job, workerId, leaseSeconds) {
      const { error } = await client.rpc("heartbeat_background_job", {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_lease_token: requireLease(job),
        p_lease_seconds: leaseSeconds,
      });
      assertSuccess(error);
    },

    async complete(job, workerId, result) {
      const { error } = await client.rpc("complete_background_job", {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_lease_token: requireLease(job),
        p_result: result as Database["public"]["Functions"]["complete_background_job"]["Args"]["p_result"],
      });
      assertSuccess(error);
    },

    async fail(job, workerId, failure, baseBackoffSeconds) {
      const { data, error } = await client.rpc("fail_background_job", {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_lease_token: requireLease(job),
        p_error_code: failure.code,
        p_error_message: failure.message,
        p_retryable: failure.retryable,
        p_base_backoff_seconds: baseBackoffSeconds,
      });
      assertSuccess(error);
      const status = asJob(data).status;
      if (status !== "failed" && status !== "retrying") {
        throw new Error("Failure RPC returned an invalid status");
      }
      return status;
    },

    async queueHealth(): Promise<QueueHealth> {
      const [queued, retrying, running, deadLettered, oldest] = await Promise.all([
        countStatus(client, ["queued"]),
        countStatus(client, ["retrying"]),
        countStatus(client, ["running"]),
        countStatus(client, ["failed"]),
        oldestQueuedAt(client),
      ]);
      return { queued, retrying, running, deadLettered, oldestQueuedAt: oldest };
    },
  };
}

export function createWorkerSupabaseClient(
  url: string,
  serviceRoleKey: string,
): Client {
  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { "X-Client-Info": "terroir-worker" } },
  });
}
