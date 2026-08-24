// C09 — no idempotency key (duplicate confirm), non-transactional confirm
// + REVOKEd compensating DELETE (orphan batch), and whether a partial
// failure reports as "done" to the UI. Exercises the REAL
// confirmImportBatch / applyImportBatchChunk from batch-service.ts.
import { adminClient, tenantClient, tenantIds, log } from "./lib.mts";
import { confirmImportBatch, applyImportBatchChunk } from "../../../src/domains/import/batch-service";
import type { SupabaseClient } from "@supabase/supabase-js";

const restaurantId = tenantIds.restaurantA;
const userId = tenantIds.userA;

function csv(nRows: number, tag: string) {
  const header = "producer,name,vintage,quantity,unit_cost";
  const lines = [header];
  for (let i = 0; i < nRows; i++) lines.push(`V2 C09 ${tag} Producer ${i},V2 C09 ${tag} Wine ${i},2019,6,30.00`);
  return Buffer.from(lines.join("\n") + "\n");
}

async function part1_duplicateFire() {
  log("=== Part 1: fire confirmImportBatch() TWICE with byte-identical CSV (no idempotency key) ===");
  const tenantA = await tenantClient("ownerA@audit.test");
  const bytes = csv(5, "DUP");

  const [r1, r2] = await Promise.all([
    confirmImportBatch(tenantA, restaurantId, userId, "cellar-dup.csv", bytes),
    confirmImportBatch(tenantA, restaurantId, userId, "cellar-dup.csv", bytes),
  ]);
  log({ r1: r1.ok ? { batchId: r1.batchId, totalRows: r1.totalRows } : r1.error });
  log({ r2: r2.ok ? { batchId: r2.batchId, totalRows: r2.totalRows } : r2.error });

  if (r1.ok && r2.ok) {
    log(`>>> BUG: two independent batches created from the identical file, ids differ: ${r1.batchId !== r2.batchId}`);
  }

  // Apply both fully and show doubled inventory for what is semantically one shipment.
  if (r1.ok && r2.ok) {
    for (const id of [r1.batchId, r2.batchId]) {
      let guard = 0;
      while (guard++ < 5) {
        const res = await applyImportBatchChunk(tenantA, id);
        if (res.counts.eligibleNotApplied === 0) break;
      }
    }
    const admin = adminClient();
    const { data } = await admin
      .from("wines")
      .select("id, name, producer, inventory_items(id, quantity)")
      .eq("restaurant_id", restaurantId)
      .ilike("name", "V2 C09 DUP Wine%");
    const rows = (data ?? []) as Array<{ id: string; name: string; inventory_items: Array<{ id: string; quantity: number }> }>;
    log("\nwines + their inventory_items rows after applying BOTH duplicate batches:");
    for (const w of rows) {
      log(`  ${w.name}: ${w.inventory_items.length} inventory_items row(s) -> ${JSON.stringify(w.inventory_items.map((i) => i.quantity))}`);
    }
    const doubled = rows.some((w) => w.inventory_items.length > 1);
    log(`\n>>> BUG MANIFESTED (duplicate confirm -> duplicate inventory_items per wine): ${doubled}`);
  }
}

async function part2_orphanOnRowsInsertFailure() {
  log("\n=== Part 2: simulate a rows-insert failure mid-confirm; check the compensating DELETE ===");
  const tenantA = await tenantClient("ownerA@audit.test");

  // A thin proxy: pass every call straight through to the real tenant
  // client EXCEPT import_batch_rows.insert(), which we force to fail —
  // simulating a realistic failure mode (payload/timeout on a large
  // bulk insert) for the SAME application code path in confirmImportBatch.
  const proxyClient = {
    rpc: (...args: unknown[]) => (tenantA as unknown as { rpc: (...a: unknown[]) => unknown }).rpc(...args),
    from: (table: string) => {
      if (table === "import_batch_rows") {
        return {
          insert: async () => ({
            data: null,
            error: { message: "simulated: statement timeout / payload too large", code: "57014" },
          }),
        };
      }
      return (tenantA as unknown as { from: (t: string) => unknown }).from(table);
    },
  } as unknown as SupabaseClient;

  let threw: unknown = null;
  try {
    await confirmImportBatch(proxyClient, restaurantId, userId, "cellar-fails-midway.csv", csv(5, "ORPHAN"));
  } catch (err) {
    threw = err;
  }
  log({ confirmImportBatchThrew: threw ? String((threw as Error).message ?? threw) : null });

  const admin = adminClient();
  const { data: orphanBatches } = await admin
    .from("import_batches")
    .select("id, filename, total_rows, status, created_at")
    .eq("restaurant_id", restaurantId)
    .eq("filename", "cellar-fails-midway.csv");
  log({ orphanBatchesFoundInDb: orphanBatches });

  if (orphanBatches && orphanBatches.length > 0) {
    const orphanId = (orphanBatches[0] as { id: string }).id;
    const { count } = await admin
      .from("import_batch_rows")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", orphanId);
    log({ orphanBatchId: orphanId, childRowCount: count });

    // Now show that the app's OWN compensating delete (same call the code
    // makes) is denied when attempted with the tenant's real, non-elevated
    // credentials — proving why the orphan could never self-heal.
    const { error: deleteError, count: deleteCount } = await tenantA
      .from("import_batches")
      .delete({ count: "exact" })
      .eq("id", orphanId);
    log({ tenantDeleteAttempt: { error: deleteError, deletedCount: deleteCount } });

    // Does the app now consider this empty, failed batch "done"?
    const applyOnOrphan = await applyImportBatchChunk(tenantA, orphanId);
    log({ applyImportBatchChunkOnOrphan: { status: applyOnOrphan.status, counts: applyOnOrphan.counts } });
    log(
      `>>> BUG MANIFESTED (orphan batch, total_rows=${(orphanBatches[0] as { total_rows: number }).total_rows}, 0 real rows, reported status='${applyOnOrphan.status}'): ${applyOnOrphan.status === "completed"}`,
    );
  } else {
    log(">>> No orphan batch found — the delete succeeded or the batch insert itself was rolled back (would REFUTE this half of the claim).");
  }
}

async function main() {
  await part1_duplicateFire();
  await part2_orphanOnRowsInsertFailure();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
