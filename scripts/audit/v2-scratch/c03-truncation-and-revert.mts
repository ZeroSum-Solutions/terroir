// C03 — PostgREST 1000-row cap silently truncating batch counting, and
// apply-after-revert. Exercises the REAL exported functions from
// src/domains/import/batch-service.ts (applyImportBatchChunk,
// revertImportBatch) against a real 1500-row batch, as a real signed-in
// tenant (RLS-governed) client — not a mock.
import { adminClient, tenantClient, tenantIds, log } from "./lib.mts";
import { applyImportBatchChunk, revertImportBatch } from "../../../src/domains/import/batch-service";
import { execSync } from "node:child_process";

const admin = adminClient();
const restaurantId = tenantIds.restaurantA;
const userId = tenantIds.userA;
const ROWS = 1500;

function psql(sql: string): string {
  return execSync(`bash scripts/audit/psql.sh -t -A -c "${sql.replace(/"/g, '\\"')}"`, {
    cwd: "/Users/zero/projects/terroir-vw-audit",
  })
    .toString()
    .trim();
}

async function main() {
  log(`=== C03 setup: 1 import_batches row + ${ROWS} import_batch_rows (restaurant A) ===`);

  const { data: batch, error: batchErr } = await admin
    .from("import_batches")
    .insert({ restaurant_id: restaurantId, created_by: userId, filename: "V2_c03_1500rows.csv", total_rows: ROWS } as never)
    .select("id")
    .single();
  if (batchErr || !batch) throw batchErr ?? new Error("no batch row");
  const batchId = (batch as { id: string }).id;
  log({ batchId });

  const CHUNK = 250;
  for (let start = 0; start < ROWS; start += CHUNK) {
    const rows = [];
    for (let i = start; i < Math.min(start + CHUNK, ROWS); i++) {
      const n = i + 1;
      rows.push({
        batch_id: batchId,
        restaurant_id: restaurantId,
        row_number: n,
        raw: {
          producer: `V2 C03 Producer ${n}`,
          name: `V2 C03 Wine ${n}`,
          vintage: String(2000 + (n % 20)),
          varietal: null,
          region: null,
          country: null,
          size_ml: "750",
          format: null,
          currency: "USD",
          quantity: "6",
          unit_cost: "19.99",
          bin: null,
          section: null,
        },
        row_state: "valid",
        validation_errors: [],
        lwin_status: "unmatched",
        lwin_id: null,
        lwin_score: null,
        cost_status: "present",
        resolution: "auto",
      });
    }
    const { error } = await admin.from("import_batch_rows").insert(rows as never);
    if (error) throw error;
  }
  log(`inserted ${ROWS} rows.`);

  const trueTotal = psql(`select count(*) from public.import_batch_rows where batch_id = '${batchId}';`);
  log(`psql ground truth: total rows in table = ${trueTotal}`);

  const tenantA = await tenantClient("ownerA@audit.test");

  log("\n=== Applying via the REAL applyImportBatchChunk() function, 100 rows/call, until >=1000 applied ===");
  let call = 0;
  let lastResult: Awaited<ReturnType<typeof applyImportBatchChunk>> | null = null;
  const t0 = Date.now();
  while (true) {
    call += 1;
    const callStart = Date.now();
    const result = await applyImportBatchChunk(tenantA, batchId);
    const callMs = Date.now() - callStart;
    lastResult = result;
    const outcomeTally: Record<string, number> = {};
    for (const p of result.processed) outcomeTally[p.outcome] = (outcomeTally[p.outcome] ?? 0) + 1;
    log(`call #${call} (${callMs}ms): processedThisCall=${result.processed.length} outcomes=${JSON.stringify(outcomeTally)} -> status=${result.status} counts=${JSON.stringify(result.counts)}`);
    if (result.processed.length === 0) {
      log("no more rows processed this call — stopping loop.");
      break;
    }
    if (result.counts.applied >= 1000) break;
    if (call > 20) {
      log("safety stop at 20 calls.");
      break;
    }
  }
  const totalMs = Date.now() - t0;
  log(`\ntotal apply loop wall time: ${totalMs}ms over ${call} calls`);

  log("\n=== Ground truth via psql (bypasses PostgREST's 1000-row cap; superuser reads full table) ===");
  const trueApplied = psql(`select count(*) from public.import_batch_rows where batch_id = '${batchId}' and apply_status = 'applied';`);
  const trueNotAppliedEligible = psql(
    `select count(*) from public.import_batch_rows where batch_id = '${batchId}' and apply_status = 'not_applied' and resolution in ('auto','include');`,
  );
  const dbBatchStatus = psql(`select status from public.import_batches where id = '${batchId}';`);
  log({ trueApplied, trueNotAppliedEligible, dbBatchStatus });

  log("\n=== Comparison ===");
  log({
    "app-computed (PostgREST-backed) status": lastResult?.status,
    "app-computed counts.eligibleNotApplied": lastResult?.counts.eligibleNotApplied,
    "app-computed counts.total (from truncated select)": lastResult?.counts.total,
    "psql ground truth eligibleNotApplied": trueNotAppliedEligible,
    "psql ground truth total rows": trueTotal,
    "import_batches.status column in DB": dbBatchStatus,
  });

  const wronglyCompleted = lastResult?.status === "completed" && Number(trueNotAppliedEligible) > 0;
  log(`\n>>> BUG MANIFESTED (falsely-completed while eligible rows remain): ${wronglyCompleted}`);

  if (dbBatchStatus !== "completed") {
    log("\nDB status is not 'completed' yet — cannot test revert-then-reapply from app-observed state. Forcing via one more probe read to see if app now agrees...");
  }

  log("\n=== Part 2: revert, then call applyImportBatchChunk again on the (reverted) batch ===");
  // revertImportBatch's signature grew a restaurantId (belt-and-suspenders
  // tenant filter) and a service-role client (Sol audit 2026-08-27 round 3,
  // finding 3 — orphan-wine cleanup's cross-tenant reference checks) after
  // this script was first written. Reusing `admin` (already constructed
  // above for the psql-adjacent ground-truth reads) gives this script the
  // same cleanup fidelity the real revert route has, rather than silently
  // reporting orphanCleanupSkipped for every run.
  const revertResult = await revertImportBatch(tenantA, restaurantId, batchId, admin);
  log({ revertResult });
  const statusAfterRevert = psql(`select status from public.import_batches where id = '${batchId}';`);
  log({ statusAfterRevert });

  const appliedBeforeReapply = psql(`select count(*) from public.import_batch_rows where batch_id = '${batchId}' and apply_status = 'applied';`);
  log({ appliedBeforeReapply });

  const reapplyResult = await applyImportBatchChunk(tenantA, batchId);
  log("applyImportBatchChunk call AFTER revert:");
  const outcomeTally2: Record<string, number> = {};
  for (const p of reapplyResult.processed) outcomeTally2[p.outcome] = (outcomeTally2[p.outcome] ?? 0) + 1;
  log({ processedThisCall: reapplyResult.processed.length, outcomes: outcomeTally2, status: reapplyResult.status, counts: reapplyResult.counts });

  const statusAfterReapply = psql(`select status from public.import_batches where id = '${batchId}';`);
  const appliedAfterReapply = psql(`select count(*) from public.import_batch_rows where batch_id = '${batchId}' and apply_status = 'applied';`);
  const newInventoryCount = psql(
    `select count(*) from public.inventory_items i join public.import_batch_rows r on r.applied_inventory_item_id = i.id where r.batch_id = '${batchId}';`,
  );
  log({ statusAfterReapply, appliedAfterReapply, newInventoryCountLinkedToThisBatch: newInventoryCount });

  const appliedAfterRevertBug = Number(reapplyResult.processed.filter((p) => p.outcome === "applied").length) > 0;
  log(`\n>>> BUG MANIFESTED (apply_import_batch_chunk wrote NEW inventory on a 'reverted' batch, outcome='applied' rows this call): ${appliedAfterRevertBug}`);
  log(`>>> import_batches.status is '${statusAfterReapply}' while apply_status='applied' rows exist for it: ${appliedAfterReapply}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
