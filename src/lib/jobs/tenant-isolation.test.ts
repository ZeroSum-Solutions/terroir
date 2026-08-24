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
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
// Fail LOUD, never skip, when the live stack should be there (integration
// critic finding): a silent describe.skipIf here once let a full run
// report green with every MANDATORY live-DB suite unexecuted. CI always
// brings up the local stack, so a missing env var there is an error, not
// a reason to skip.
if (!hasLiveDb && process.env.CI) {
  throw new Error(
    "MANDATORY live-DB suite: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY missing in CI - refusing to skip silently.",
  );
}

const hasPublishableKey = Boolean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

/**
 * Mints a real one-off authenticated staff session for `restaurantId`,
 * mirroring src/domains/import/tenant-isolation.test.ts's signedInClient.
 *
 * Blast radius from C20 (migration 0083, a sibling fix lane, landed before
 * this C25 fix started): enqueue_invoice_extract_job is SECURITY DEFINER
 * and requires a real auth.uid() — it raises "authentication required"
 * (auth.uid() is null under a service-role connection, independent of any
 * EXECUTE grant). This file's pre-existing tests called
 * enqueueInvoiceExtractJob with the service-role client, which was the
 * only option before 0083 replaced enqueue.ts's raw table access with this
 * RPC. Discovered by re-running this file's full suite per the "watch for
 * blast radius" requirement while verifying C25, not one of C25's own
 * findings — fixed here because it now fails `pnpm test` on this branch.
 */
async function staffSession(
  admin: SupabaseClient<Database>,
  restaurantId: string,
): Promise<{ client: SupabaseClient<Database>; userId: string }> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `fix-staff-${unique}@terroir.test`;
  const password = `Fix-Test-${unique}!`;

  const { data: user, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !user) throw userErr ?? new Error("failed to create staff test user");

  const { error: memErr } = await admin.from("memberships").insert({
    user_id: user.user.id,
    restaurant_id: restaurantId,
    role: "staff",
  } as never);
  if (memErr) throw memErr;

  const throwaway = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data: session, error: signInErr } = await throwaway.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr || !session.session) throw signInErr ?? new Error("staff sign-in failed");

  const client = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
    },
  );
  return { client, userId: user.user.id };
}

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

      const staffA = await staffSession(supabase, restaurantA);
      const enqueueResult = await enqueueInvoiceExtractJob({
        supabase: staffA.client,
        restaurantId: restaurantA,
        scanId: (scanA as { id: string }).id,
      });
      await supabase.auth.admin.deleteUser(staffA.userId);
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

      const staffA = await staffSession(supabase, restaurantA);
      const first = await enqueueInvoiceExtractJob({ supabase: staffA.client, restaurantId: restaurantA, scanId });
      const second = await enqueueInvoiceExtractJob({ supabase: staffA.client, restaurantId: restaurantA, scanId });
      await supabase.auth.admin.deleteUser(staffA.userId);

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

      const staffA = await staffSession(supabase, restaurantA);
      const enqueueResult = await enqueueInvoiceExtractJob({ supabase: staffA.client, restaurantId: restaurantA, scanId });
      await supabase.auth.admin.deleteUser(staffA.userId);
      const result = await processOneInvoiceExtractJob(supabase, "test-worker-retry");

      expect(result.processed).toBe(true);
      if (!result.processed) throw new Error("unreachable");
      expect(result.jobId).toBe(enqueueResult.jobId);
      expect(result.outcome).toBe("succeeded");
      expect(mockProcessInvoiceScanOnce).not.toHaveBeenCalled();
    });

    it("aborts WITHOUT calling the extraction service when another worker has already stolen the claim (closes the double-bill window on reclaim)", async () => {
      const pathA = `${restaurantA}/scan-claim-stolen.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("invoice-images")
        .upload(pathA, Buffer.from("fake-jpeg-bytes"), { contentType: "image/jpeg", upsert: true });
      if (uploadError) throw uploadError;
      storagePaths.push(pathA);

      const { data: scan, error: scanErr } = await supabase
        .from("invoice_scans")
        .insert({
          restaurant_id: restaurantA,
          distributor_name: "Claim Stolen Distributor",
          parsed_line_items: [],
          final_line_items: [],
          raw_image_path: pathA,
          status: "processing",
        } as never)
        .select("id")
        .single();
      if (scanErr || !scan) throw scanErr ?? new Error("failed to insert scan for claim-stolen test");

      const { data: insertedJob, error: jobErr } = await supabase
        .from("background_jobs")
        .insert({
          restaurant_id: restaurantA,
          job_type: "invoice_extract",
          status: "queued",
          subject_table: "invoice_scans",
          subject_id: (scan as { id: string }).id,
          idempotency_key: `claim-stolen-${(scan as { id: string }).id}`,
        } as never)
        .select("id")
        .single();
      if (jobErr || !insertedJob) throw jobErr ?? new Error("failed to insert job for claim-stolen test");

      const claimed = await claimNextInvoiceExtractJob(supabase, "test-worker-original");
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe((insertedJob as { id: string }).id);
      expect(claimed!.claimedBy).toBe("test-worker-original");

      // Simulate exactly what a concurrent stuck-job reclaim followed by a
      // second worker's claim produces: the row is still "processing", but
      // claimed_by now belongs to someone else. The ORIGINAL worker's
      // in-memory `claimed` object is now stale — this is the scenario
      // that produced the double-bill window.
      const { error: stealError } = await supabase
        .from("background_jobs")
        .update({ claimed_by: "test-worker-thief" } as never)
        .eq("id", claimed!.id);
      if (stealError) throw stealError;

      const outcome = await runInvoiceExtractJob({ supabase, job: claimed! });

      expect(outcome.kind).toBe("retry");
      expect((outcome as { code: string }).code).toBe("claim_lost_before_extraction");
      expect(mockProcessInvoiceScanOnce).not.toHaveBeenCalled();
    });

    // C25 (db audit 2026-08-23): enqueueInvoiceExtractJob used to revive a
    // dead job via a raw client-scoped UPDATE. background_jobs has no
    // UPDATE policy for `authenticated` at all, so — before migration 0083
    // (landed by a sibling fix lane closing C20, which also revoked the
    // authenticated INSERT/UPDATE/DELETE table grants outright) — that
    // UPDATE reached RLS with a table-level grant but no permissive
    // policy, silently affecting 0 rows: HTTP 200, empty array, no error,
    // indistinguishable from a legitimate race. This block locks that fix
    // in from an authenticated staff member's real session, not
    // service_role, since the whole point is what RLS/grants do to a
    // real client. describe.skipIf below also requires the anon/publishable
    // key needed to sign a real user in.
    describe.skipIf(!hasPublishableKey)(
      "enqueue_invoice_extract_job dead-job revival (C25)",
      () => {
        it("a real authenticated staff member's raw UPDATE against a dead job fails LOUD (not a silent no-op), and the sanctioned RPC actually revives it", async () => {
          const staffA = await staffSession(supabase, restaurantA);

          const { data: scan, error: scanErr } = await supabase
            .from("invoice_scans")
            .insert({
              restaurant_id: restaurantA,
              distributor_name: "C25 Dead Job Distributor",
              parsed_line_items: [],
              final_line_items: [],
              status: "failed",
            } as never)
            .select("id")
            .single();
          if (scanErr || !scan) throw scanErr ?? new Error("failed to insert scan for C25 test");
          const scanId = (scan as { id: string }).id;

          const { data: job, error: jobErr } = await supabase
            .from("background_jobs")
            .insert({
              restaurant_id: restaurantA,
              created_by: staffA.userId,
              job_type: "invoice_extract",
              status: "dead",
              subject_table: "invoice_scans",
              subject_id: scanId,
              idempotency_key: scanId,
              attempt_count: 5,
              max_attempts: 5,
            } as never)
            .select("id")
            .single();
          if (jobErr || !job) throw jobErr ?? new Error("failed to insert dead job for C25 test");
          const jobId = (job as { id: string }).id;

          // The forged raw revive UPDATE the pre-0083 enqueue.ts issued
          // client-side. Must fail with an explicit error now, not a
          // silent 200/[].
          const { data: rawResult, error: rawError } = await staffA.client
            .from("background_jobs")
            .update({
              status: "queued",
              attempt_count: 0,
              claimed_by: null,
              claimed_at: null,
            } as never)
            .eq("id", jobId)
            .eq("status", "dead")
            .select("id");

          expect(rawResult).toBeNull();
          expect(rawError).not.toBeNull();
          expect((rawError as { code?: string } | null)?.code).toBe("42501");

          const { data: afterRaw } = await supabase
            .from("background_jobs")
            .select("status, attempt_count")
            .eq("id", jobId)
            .single();
          expect(afterRaw?.status).toBe("dead");
          expect(afterRaw?.attempt_count).toBe(5);

          // The sanctioned path: the real staff session calls the RPC.
          const { data: rpcResult, error: rpcError } = await staffA.client
            .rpc("enqueue_invoice_extract_job", {
              p_restaurant_id: restaurantA,
              p_scan_id: scanId,
            } as never)
            .single();
          expect(rpcError).toBeNull();
          expect((rpcResult as { job_id: string; created: boolean } | null)?.job_id).toBe(jobId);
          expect((rpcResult as { job_id: string; created: boolean } | null)?.created).toBe(false);

          const { data: afterRpc } = await supabase
            .from("background_jobs")
            .select("status, attempt_count, claimed_by")
            .eq("id", jobId)
            .single();
          expect(afterRpc?.status).toBe("queued");
          expect(afterRpc?.attempt_count).toBe(0);
          expect(afterRpc?.claimed_by).toBeNull();

          await supabase.auth.admin.deleteUser(staffA.userId);
        });
      },
    );
  },
);
