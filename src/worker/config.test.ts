import { describe, expect, it } from "vitest";
import { parseWorkerConfig } from "./config.ts";

const required = {
  NEXT_PUBLIC_SUPABASE_URL: "https://staging-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "staging-service-role-key",
};

describe("worker configuration", () => {
  it("returns bounded defaults without exposing credentials", () => {
    const config = parseWorkerConfig({
      ...required,
      RAILWAY_GIT_COMMIT_SHA: "provider-sha",
      TERROIR_RELEASE_SHA: "exact-local-deploy-sha",
    });
    expect(config).toMatchObject({
      concurrency: 4,
      claimLimit: 4,
      leaseSeconds: 120,
      heartbeatIntervalMs: 30_000,
      port: 3001,
      release: "exact-local-deploy-sha",
    });
  });

  it("fails with variable names and never includes secret values", () => {
    const secret = "do-not-print-this-worker-secret";
    expect(() =>
      parseWorkerConfig({
        ...required,
        SUPABASE_SERVICE_ROLE_KEY: secret,
        WORKER_CONCURRENCY: "2",
        WORKER_CLAIM_LIMIT: "3",
      }),
    ).toThrow("WORKER_CLAIM_LIMIT");
    try {
      parseWorkerConfig({
        ...required,
        SUPABASE_SERVICE_ROLE_KEY: secret,
        NEXT_PUBLIC_SUPABASE_URL: "not-a-url",
      });
    } catch (error) {
      expect(String(error)).toContain("NEXT_PUBLIC_SUPABASE_URL");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("requires heartbeat and health cadences to fit their leases", () => {
    expect(() =>
      parseWorkerConfig({
        ...required,
        WORKER_LEASE_SECONDS: "15",
        WORKER_HEARTBEAT_INTERVAL_MS: "7500",
      }),
    ).toThrow("WORKER_HEARTBEAT_INTERVAL_MS");
    expect(() =>
      parseWorkerConfig({
        ...required,
        WORKER_QUEUE_HEALTH_INTERVAL_MS: "10000",
        WORKER_HEALTH_STALE_AFTER_MS: "10000",
      }),
    ).toThrow("WORKER_HEALTH_STALE_AFTER_MS");
    expect(() =>
      parseWorkerConfig({
        ...required,
        WORKER_POLL_INTERVAL_MS: "2000",
        WORKER_DATABASE_ERROR_BACKOFF_MAX_MS: "1000",
      }),
    ).toThrow("WORKER_DATABASE_ERROR_BACKOFF_MAX_MS");
  });
});
