import { adminClient, tenantClient, tenantIds, log } from "./lib.mts";
import { confirmImportBatch, applyImportBatchChunk } from "../../../src/domains/import/batch-service";

const restaurantId = tenantIds.restaurantA;
const userId = tenantIds.userA;

function csvExactMatch(nRows: number, _tag: string) {
  // Exact producer + display_name from the seeded lwin_catalog -> guaranteed
  // similarity=1.0 match, resolution='auto' (no operator step required).
  const header = "producer,name,vintage,quantity,unit_cost";
  const lines = [header];
  for (let i = 0; i < nRows; i++) lines.push(`Cheval Blanc,Tenuta Lafite ${i + 1},2019,6,30.00`);
  return Buffer.from(lines.join("\n") + "\n");
}

const tenantA = await tenantClient("ownerA@audit.test");
const bytes = csvExactMatch(3, "DUP2");

const [r1, r2] = await Promise.all([
  confirmImportBatch(tenantA, restaurantId, userId, "cellar-dup2.csv", bytes),
  confirmImportBatch(tenantA, restaurantId, userId, "cellar-dup2.csv", bytes),
]);
log({ r1: r1.ok ? { batchId: r1.batchId, summary: r1.summary } : r1.error });
log({ r2: r2.ok ? { batchId: r2.batchId, summary: r2.summary } : r2.error });

if (r1.ok && r2.ok) {
  for (const id of [r1.batchId, r2.batchId]) {
    const res = await applyImportBatchChunk(tenantA, id);
    log({ applied: id, outcomes: res.processed.map((p) => p.outcome), status: res.status });
  }
  const admin = adminClient();
  const { data: wines } = await admin.from("wines").select("id,name,producer").eq("restaurant_id", restaurantId).ilike("name", "Tenuta Lafite%");
  log({ wines });
  for (const w of (wines ?? []) as Array<{ id: string; name: string }>) {
    const { data: inv } = await admin.from("inventory_items").select("id,quantity").eq("wine_id", w.id);
    log({ wine: w.name, inventoryRows: inv });
  }
}
