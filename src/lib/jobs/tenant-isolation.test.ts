// G1-6 — MANDATORY two-tenant fixture test.
//
// The worker runs with the Supabase service role, which bypasses RLS
// entirely. That means tenant scoping for this runner is a *convention*
// in application code (every query filtered by the job's restaurant_id)
// until it's proven by a test that actually exercises the service role
// against a real Postgres — a mocked Supabase client can't prove this,
// since RLS bypass and real FOR UPDATE SKIP LOCKED behavior only exist in
// a real database.
//
// Requires a live local Supabase (see docs/runbooks/invoice-extract-worker.md
// for how to start one and run this file). Skipped when
// NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set, the same
// convention e2e/reconcile-queue.test.ts and its siblings use for
// live-fixture tests that can't run on a bare CI runner.
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const mockProcessInvoiceScanOnce = vi.fn();
vi.mock("@/domains/scanning/invoice-scan-service", () => ({
  processInvoiceScanOnce: (...args: unknown[]) => mockProcessInvoiceScanOnce(...args),
}));

const { createServiceRoleClient } = await import("@/lib/supabase/service-role");
const { enqueueInvoiceExtractJob } = await import("@/lib/jobs/enqueue");
const { claimNextInvoiceExtractJob } = await import("@/lib/jobs/claim");
const { runInvoiceExtractJob } = await import("@/lib/jobs/invoice-extract-handler");
const { markJobDeadImmediately } = await import("@/lib/jobs/complete");
const { processOneInvoiceExtractJob } = await import("@/lib/jobs/run-once");

const hasLiveDb = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!hasLiveDb)(
  "G1-6 invoice_extract runner: cross-tenant containment (MANDATORY)",
  () => {
    let supabase: SupabaseClient<Database>;
    let restaurantA: string;
    let restaurantB: string;
    const storagePaths: string[] = [];

    beforeAll(async () => {
      const client = createServiceRoleClient();
      if (!client) throw new Error("expected a configured service-role client");
      supabase = client;

      const { data: rA, error: rAErr } = await supabase
        .from("restaurants")
        .insert({ name: "G1-6 Tenant A" } as never)
        .select("id")
        .single();
      if (rAErr || !rA) throw rAErr ?? new Error("failed to insert restaurant A");
      restaurantA = (rA as { id: string }).id;

      const { data: rB, error: rBErr } = await supabase
        .from("restaurants")
        .insert({ name: "G1-6 Tenant B" } as never)
        .select("id")
        .single();
      if (rBErr || !rB) throw rBErr ?? new Error("failed to insert restaurant B");
      restaurantB = (rB as { id: string }).id;
    });

    afterAll(async () => {
      if (storagePaths.length) {
        await supabase.storage.from("invoice-images").remove(storagePaths);
      }
      // Cascades: background_jobs and invoice_scans both FK restaurant_id
      // ON DELETE CASCADE, so deleting the two restaurants cleans up
      // every job/scan fixture this suite created.
      await supabase.from("restaurants").delete().in("id", [restaurantA, restaurantB]);
    });

    beforeEach(() => {
      mockProcessInvoiceScanOnce.mockReset();
    });

    it("rejects a crafted job whose restaurant_id does not own its subject scan, before any read or write of the other tenant's data", async () => {
      const { data: scanB, error: scanBErr } = await supabase
        .from("invoice_scans")
        .insert({
          restaurant_id: restaurantB,
          distributor_name: "Cross-Tenant Distributor",
          parsed_line_items: [],
          final_line_items: [],
          raw_image_path: `${restaurantB}/scan-crafted.jpg`,
          status: "processing",
        } as never)
        .select("*")
        .single();
      if (scanBErr || !scanB) throw scanBErr ?? new Error("failed to insert scan B");

      // Crafted job: restaurant_id claims A, subject_id actually belongs to B.
      // Nothing in the schema stops this insert — subject_id has no FK to
      // invoice_scans. Only the runner's own tenant-scoped read protects B.
      const { data: craftedJob, error: jobErr } = await supabase
        .from("background_jobs")
        .insert({
          restaurant_id: restaurantA,
          job_type: "invoice_extract",
          status: "queued",
          subject_table: "invoice_scans",
          subject_id: (scanB as { id: string }).id,
          idempotency_key: `crafted-${(scanB as { id: string }).id}`,
        } as never)
        .select("id")
        .single();
      if (jobErr || !craftedJob) throw jobErr ?? new Error("failed to insert crafted job");

      const claimed = await claimNextInvoiceExtractJob(supabase, "test-worker-crafted");
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe((craftedJob as { id: string }).id);
      expect(claimed!.restaurantId).toBe(restaurantA);

      const outcome = await runInvoiceExtractJob({ supabase, job: claimed! });

      expect(outcome.kind).toBe("dead");
      expect((outcome as { code: string }).code).toBe("tenant_mismatch_or_missing_subject");
      expect(mockProcessInvoiceScanOnce).not.toHaveBeenCalled();

      // Restaurant B's scan is byte-for-byte untouched.
      const { data: scanBAfter } = await supabase
        .from("invoice_scans")
        .select("*")
        .eq("id", (scanB as { id: string }).id)
        .single();
      expect(scanBAfter).toEqual(scanB);

      await markJobDeadImmediately(supabase, claimed!, outcome as { code: string; message: string });
      const { data: jobAfter } = await supabase
        .from("background_jobs")
        .select("status, restaurant_id, error_code")
        .eq("id", (craftedJob as { id: string }).id)
        .single();
      expect(jobAfter?.status).toBe("dead");
      // The crafted restaurant_id is preserved, not silently "corrected".
      expect(jobAfter?.restaurant_id).toBe(restaurantA);
      expect(jobAfter?.error_code).toBe("tenant_mismatch_or_missing_subject");
    });

    it("processing restaurant A's own job never reads or mutates restaurant B's rows", async () => {
      const pathA = `${restaurantA}/scan-legit.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("invoice-images")
        .upload(pathA, Buffer.from("fake-jpeg-bytes"), { contentType: "image/jpeg", upsert: true });
      if (uploadError) throw uploadError;
      storagePaths.push(pathA);

      const { data: scanA, error: scanAErr } = await supabase
        .from("invoice_scans")
        .insert({
          restaurant_id: restaurantA,
          distributor_name: "Tenant A Distributor",
          parsed_line_items: [],
          final_line_items: [],
          raw_image_path: pathA,
          status: "processing",
        } as never)
        .select("id")
        .single();
      if (scanAErr || !scanA) throw scanAErr ?? new Error("failed to insert scan A");

      // Untouched control row belonging to restaurant B.
      const { data: scanB, error: scanBErr } = await supabase
        .from("invoice_scans")
        .insert({
          restaurant_id: restaurantB,
          distributor_name: "Tenant B Control Row",
          parsed_line_items: [],
          final_line_items: [],
          raw_image_path: `${restaurantB}/scan-control.jpg`,
          status: "processing",
        } as never)
        .select("*")
        .single();
      if (scanBErr || !scanB) throw scanBErr ?? new Error("failed to insert scan B control row");

      mockProcessInvoiceScanOnce.mockImplementation(
        async (params: { supabase: SupabaseClient<Database>; preCreatedScanId?: string }) => {
          await params.supabase
            .from("invoice_scans")
            .update({ status: "complete", item_count: 1 } as never)
            .eq("id", params.preCreatedScanId as string);
          return { status: 200, body: { scanId: params.preCreatedScanId } };
        },
      );

      const enqueueResult = await enqueueInvoiceExtractJob({
        supabase,
        restaurantId: restaurantA,
        scanId: (scanA as { id: string }).id,
      });
      expect(enqueueResult.created).toBe(true);

      const result = await processOneInvoiceExtractJob(supabase, "test-worker-legit");
      expect(result.processed).toBe(true);
      if (!result.processed) throw new Error("unreachable");
      // Exact identity, not just "some job succeeded" — guards against a
      // stray queued row being claimed instead of the one this test made.
      expect(result.jobId).toBe(enqueueResult.jobId);
      expect(result.outcome).toBe("succeeded");

      expect(mockProcessInvoiceScanOnce).toHaveBeenCalledTimes(1);
      const callArgs = mockProcessInvoiceScanOnce.mock.calls[0][0] as {
        restaurantId: string;
        preCreatedScanId: string;
      };
      expect(callArgs.restaurantId).toBe(restaurantA);
      expect(callArgs.preCreatedScanId).toBe((scanA as { id: string }).id);

      const { data: scanAAfter } = await supabase
        .from("invoice_scans")
        .select("status")
        .eq("id", (scanA as { id: string }).id)
        .single();
      expect(scanAAfter?.status).toBe("complete");

      // Restaurant B's control row is completely untouched.
      const { data: scanBAfter } = await supabase
        .from("invoice_scans")
        .select("*")
        .eq("id", (scanB as { id: string }).id)
        .single();
      expect(scanBAfter).toEqual(scanB);

      const { data: jobAfter } = await supabase
        .from("background_jobs")
        .select("status")
        .eq("id", enqueueResult.jobId)
        .single();
      expect(jobAfter?.status).toBe("succeeded");
    });

    it("idempotent enqueue: a second enqueue for the same scan returns the existing job, never a second row", async () => {
      const { data: scan, error } = await supabase
        .from("invoice_scans")
        .insert({
          restaurant_id: restaurantA,
          distributor_name: "Idempotency Distributor",
          parsed_line_items: [],
          final_line_items: [],
          status: "processing",
        } as never)
        .select("id")
        .single();
      if (error || !scan) throw error ?? new Error("failed to insert scan for idempotency test");
      const scanId = (scan as { id: string }).id;

      const first = await enqueueInvoiceExtractJob({ supabase, restaurantId: restaurantA, scanId });
      const second = await enqueueInvoiceExtractJob({ supabase, restaurantId: restaurantA, scanId });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.jobId).toBe(first.jobId);

      const { count } = await supabase
        .from("background_jobs")
        .select("id", { count: "exact", head: true })
        .eq("job_type", "invoice_extract")
        .eq("idempotency_key", scanId);
      expect(count).toBe(1);

      // This job is deliberately left `queued` (this test only exercises
      // enqueue, not processing) — clean it up so it isn't the oldest
      // queued row a later test's claim picks up instead of its own.
      await supabase.from("background_jobs").delete().eq("id", first.jobId);
    });

    it("a job whose subject already persisted a result does not re-invoke the extraction service (no double Anthropic call)", async () => {
      const { data: scan, error } = await supabase
        .from("invoice_scans")
        .insert({
          restaurant_id: restaurantA,
          distributor_name: "Already Complete Distributor",
          parsed_line_items: [],
          final_line_items: [],
          raw_image_path: `${restaurantA}/already-complete.jpg`,
          status: "complete", // persisted by a (simulated) prior attempt
          item_count: 3,
        } as never)
        .select("id")
        .single();
      if (error || !scan) throw error ?? new Error("failed to insert already-complete scan");
      const scanId = (scan as { id: string }).id;

      const enqueueResult = await enqueueInvoiceExtractJob({ supabase, restaurantId: restaurantA, scanId });
      const result = await processOneInvoiceExtractJob(supabase, "test-worker-retry");

      expect(result.processed).toBe(true);
      if (!result.processed) throw new Error("unreachable");
      expect(result.jobId).toBe(enqueueResult.jobId);
      expect(result.outcome).toBe("succeeded");
      expect(mockProcessInvoiceScanOnce).not.toHaveBeenCalled();
    });
  },
);
