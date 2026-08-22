// G1-6 — invoice_extract worker entrypoint.
//
// A standalone long-poll loop, not a Next.js request handler: the owner
// decision (Q3) is a Railway worker process for this job type, not a
// serverless/cron trigger. `pnpm run worker` runs this file directly via
// tsx (see package.json). Business logic lives in src/lib/jobs/*; this
// file only wires it into a process (env, loop, signals).
//
// Deliberately not a generic job-handler platform: it claims and runs
// exactly one job type, invoice_extract. See docs/runbooks/invoice-extract-worker.md.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import {
  POLL_INTERVAL_MS,
  RECLAIM_SWEEP_INTERVAL_MS,
  STUCK_AFTER_SECONDS,
} from "@/lib/jobs/constants";
import { reclaimStuckInvoiceExtractJobs } from "@/lib/jobs/reclaim";
import { processOneInvoiceExtractJob } from "@/lib/jobs/run-once";

const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`[worker] received ${signal}; finishing current job then exiting`);
    stopping = true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const supabase = createServiceRoleClient();
  if (!supabase) {
    console.error("[worker] service-role client is not configured; exiting.");
    process.exitCode = 1;
    return;
  }

  console.log(`[worker] ${WORKER_ID} starting invoice_extract poll loop`);
  let lastReclaimAt = 0;

  while (!stopping) {
    const now = Date.now();
    if (now - lastReclaimAt >= RECLAIM_SWEEP_INTERVAL_MS) {
      lastReclaimAt = now;
      try {
        const reclaimed = await reclaimStuckInvoiceExtractJobs(supabase, STUCK_AFTER_SECONDS);
        if (reclaimed > 0) {
          console.log(`[worker] reclaimed ${reclaimed} stuck job(s)`);
        }
      } catch (error) {
        console.error("[worker] stuck-job reclaim sweep failed:", error);
      }
    }

    try {
      const result = await processOneInvoiceExtractJob(supabase, WORKER_ID);
      if (!result.processed) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      console.log(`[worker] job ${result.jobId} -> ${result.outcome}`);
    } catch (error) {
      console.error("[worker] job-processing loop error:", error);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  console.log(`[worker] ${WORKER_ID} stopped cleanly`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error("[worker] fatal:", error);
    process.exit(1);
  },
);
