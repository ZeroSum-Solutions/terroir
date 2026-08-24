// C13 — CHECK import_batch_rows_applied_has_inventory_id vs the FK's
// ON DELETE SET NULL. Try to violate it through the REAL apply path (not
// just reading the DDL): apply one row for real, then delete the resulting
// inventory_items row via the normal member-facing delete policy (NOT
// revert_import_batch) and see what actually happens.
import { adminClient, tenantClient, tenantIds, log } from "./lib.mts";
import { confirmImportBatch, applyImportBatchChunk } from "../../../src/domains/import/batch-service";

const restaurantId = tenantIds.restaurantA;
const userId = tenantIds.userA;

async function main() {
  const tenantA = await tenantClient("ownerA@audit.test");
  const admin = adminClient();

  const csv = Buffer.from(
    "producer,name,vintage,quantity,unit_cost\n" + "Cheval Blanc,Tenuta Lafite C13,2020,6,50.00\n",
  );
  const confirmResult = await confirmImportBatch(tenantA, restaurantId, userId, "cellar-c13.csv", csv);
  if (!confirmResult.ok) throw new Error(JSON.stringify(confirmResult.error));
  const applyResult = await applyImportBatchChunk(tenantA, confirmResult.batchId);
  const applied = applyResult.processed[0];
  log({ appliedRow: applied });
  if (!applied?.inventoryItemId) throw new Error("row did not apply");

  const { data: beforeRow } = await admin
    .from("import_batch_rows")
    .select("id, apply_status, applied_inventory_item_id")
    .eq("id", applied.rowId)
    .single();
  log({ import_batch_row_before_delete: beforeRow });

  log("\n=== Deleting the applied inventory_items row directly (normal member-delete policy, NOT revert_import_batch) ===");
  const { error: deleteError, count } = await tenantA
    .from("inventory_items")
    .delete({ count: "exact" })
    .eq("id", applied.inventoryItemId);
  log({ deleteError, deletedCount: count });

  const { data: afterRow } = await admin
    .from("import_batch_rows")
    .select("id, apply_status, applied_inventory_item_id")
    .eq("id", applied.rowId)
    .single();
  log({ import_batch_row_after_delete_attempt: afterRow });

  const { data: invStillThere } = await admin
    .from("inventory_items")
    .select("id")
    .eq("id", applied.inventoryItemId)
    .maybeSingle();
  log({ inventoryItemStillExists: invStillThere != null });

  const deleteWasBlocked = deleteError != null;
  log(`\n>>> BUG MANIFESTED (a legitimate, policy-permitted DELETE on inventory_items is blocked by the CHECK constraint via the FK's ON DELETE SET NULL action): ${deleteWasBlocked}`);
  if (deleteWasBlocked) log({ pgErrorCode: (deleteError as { code?: string }).code, message: (deleteError as { message?: string }).message });
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
