import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/0074_background_job_lifecycle.sql",
  "utf8",
).toLowerCase();

const rollback = readFileSync(
  "supabase/migrations/down/0074_background_job_lifecycle.down.sql",
  "utf8",
).toLowerCase();

const concurrencyAcceptance = readFileSync(
  "supabase/tests/0074_background_job_concurrency.sql",
  "utf8",
).toLowerCase();

describe("background-job lifecycle migration", () => {
  it("defines the complete durable state and lease shape", () => {
    for (const state of [
      "queued",
      "running",
      "succeeded",
      "failed",
      "retrying",
      "cancelled",
    ]) {
      expect(migration).toContain(`'${state}'`);
    }

    for (const column of [
      "idempotency_key",
      "claimed_by",
      "lease_token",
      "heartbeat_at",
      "lease_expires_at",
      "dead_lettered_at",
    ]) {
      expect(migration).toContain(`add column ${column}`);
    }

    expect(migration).toContain("background_jobs_lifecycle_shape");
    expect(migration).toContain("background_jobs_transition_guard");
    expect(migration).toContain("background_jobs_idempotency_idx");
    expect(migration).toContain("background_jobs_running_lease_idx");
    expect(migration).toContain("background_jobs_dead_letter_idx");
  });

  it("enqueues idempotently without allowing direct authenticated writes", () => {
    expect(migration).toContain(
      "create or replace function public.enqueue_background_job(",
    );
    expect(migration).toContain(
      "on conflict (restaurant_id, job_type, idempotency_key)",
    );
    expect(migration).toContain(
      "idempotency key was reused with different job input",
    );
    expect(migration).toContain(
      "public.is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(migration).toMatch(
      /revoke select, insert, update, delete on public\.background_jobs\s+from public, anon, authenticated;/,
    );
    expect(migration).not.toContain(
      'create policy "members can create own background jobs"',
    );
  });

  it("claims atomically and protects every worker mutation with a lease", () => {
    expect(migration).toContain(
      "create or replace function public.claim_background_jobs(",
    );
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("attempt_count = jobs.attempt_count + 1");
    expect(migration).toContain("lease_token = gen_random_uuid()");

    for (const workerFunction of [
      "heartbeat_background_job",
      "complete_background_job",
      "fail_background_job",
    ]) {
      const start = migration.indexOf(
        `create or replace function public.${workerFunction}(`,
      );
      expect(start).toBeGreaterThanOrEqual(0);
      const body = migration.slice(start, migration.indexOf("$$;", start));
      expect(body).toContain("claimed_by = p_worker_id");
      expect(body).toContain("lease_token = p_lease_token");
      expect(body).toContain("lease_expires_at > now()");
    }

    expect(concurrencyAcceptance).toContain("dblink_send_query");
    expect(concurrencyAcceptance).toContain("concurrent-enqueue");
    expect(concurrencyAcceptance).toContain("concurrent-claim-a");
    expect(concurrencyAcceptance).toContain("count(distinct id)");
  });

  it("applies bounded exponential backoff and terminal dead-lettering", () => {
    expect(migration).toContain(
      "create or replace function public.background_job_backoff(",
    );
    expect(migration).toContain(
      "power(2::numeric, least(p_attempt_count - 1, 16))",
    );
    expect(migration).toContain("least(\n    86400,");
    expect(migration).toContain("error_code = 'lease_timeout'");
    expect(migration).toContain("dead_lettered_at = case");
    expect(migration).toContain(
      "create or replace function public.requeue_background_job(",
    );
  });

  it("limits visibility to current creator-members and tenant managers", () => {
    expect(migration).toContain(
      'create policy "job creators and managers can read background jobs"',
    );
    expect(migration).toMatch(
      /public\.is_member\(restaurant_id\)\s+and \(\s+created_by = auth\.uid\(\)\s+or public\.is_member_with_role\(restaurant_id, 'manager'\)/,
    );
    expect(migration).toContain(
      "revoke all on function public.claim_background_jobs(text, integer, integer, integer)\n  from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "grant execute on function public.claim_background_jobs(text, integer, integer, integer)\n  to service_role;",
    );
  });

  it("provides a rollback for every forward object", () => {
    for (const object of [
      "requeue_background_job",
      "cancel_background_job",
      "fail_background_job",
      "complete_background_job",
      "heartbeat_background_job",
      "claim_background_jobs",
      "enqueue_background_job",
      "background_job_backoff",
      "assert_background_job_transition",
      "background_jobs_transition_guard",
      "background_jobs_dead_letter_idx",
      "background_jobs_running_lease_idx",
      "background_jobs_claimable_idx",
      "background_jobs_idempotency_idx",
    ]) {
      expect(rollback).toContain(object);
    }

    expect(rollback).toContain("set status = 'processing'");
    expect(rollback).toContain(
      'create policy "members can read background jobs"',
    );
    expect(rollback).toContain(
      'create policy "members can create own background jobs"',
    );
  });
});
