// C11 — apply_import_batch_chunk writes inventory_items.bin_location but
// never bin_id. Run a REAL apply with a bin value and inspect the row,
// then check the actual downstream "unplaced" queries.
import { adminClient, tenantClient, tenantIds, log } from "./lib.mts";
import { confirmImportBatch, applyImportBatchChunk } from "../../../src/domains/import/batch-service";

const restaurantId = tenantIds.restaurantA;
const userId = tenantIds.userA;

async function main() {
  const admin = adminClient();
  const tenantA = await tenantClient("ownerA@audit.test");

  // Existing bin? Create one matching what our CSV will claim, to prove
  // this isn't merely "no matching bin exists yet" — apply_import_batch_chunk
  // does not even attempt to look one up.
  let { data: existingBin } = await admin
    .from("bins")
    .select("id, code")
    .eq("restaurant_id", restaurantId)
    .ilike("code", "R4-S12")
    .maybeSingle();
  if (!existingBin) {
    const { data: created, error: createErr } = await admin
      .from("bins")
      .insert({ restaurant_id: restaurantId, code: "R4-S12" } as never)
      .select("id, code")
      .single();
    if (createErr) throw createErr;
    existingBin = created;
  }
  log({ preExistingBinForThisCode: existingBin });

  // Exact producer + display_name from the seeded lwin_catalog -> guaranteed
  // match -> resolution='auto', no operator step required.
  const csv = Buffer.from(
    "producer,name,vintage,quantity,unit_cost,bin\n" +
      "Cheval Blanc,Tenuta Lafite C11,2021,6,45.00,R4-S12\n",
  );

  const confirmResult = await confirmImportBatch(tenantA, restaurantId, userId, "cellar-c11.csv", csv);
  if (!confirmResult.ok) throw new Error(JSON.stringify(confirmResult.error));
  log({ batchId: confirmResult.batchId });

  const applyResult = await applyImportBatchChunk(tenantA, confirmResult.batchId);
  log({ applyOutcomes: applyResult.processed });

  const appliedRow = applyResult.processed[0];
  if (!appliedRow?.inventoryItemId) throw new Error("row did not apply");

  const { data: invRow } = await admin
    .from("inventory_items")
    .select("id, bin_location, bin_id, quantity")
    .eq("id", appliedRow.inventoryItemId)
    .single();
  log("\n=== Resulting inventory_items row ===");
  log(invRow);
  const bug = (invRow as { bin_location: string | null; bin_id: string | null }).bin_location != null
    && (invRow as { bin_location: string | null; bin_id: string | null }).bin_id == null;
  log(`\n>>> BUG MANIFESTED (bin_location set, bin_id NULL, despite a matching bins row '${(existingBin as { code: string } | null)?.code}' already existing): ${bug}`);

  // Downstream consequence 1: Bins page's "unplaced" count query.
  const { data: unplaced } = await admin
    .from("inventory_items")
    .select("id, quantity")
    .eq("restaurant_id", restaurantId)
    .is("bin_id", null);
  log(`\n=== Bins page 'unplaced' query (.is('bin_id', null)) for restaurant A ===`);
  log({ unplacedRowCount: unplaced?.length, includesOurImportedRow: unplaced?.some((r: { id: string }) => r.id === appliedRow.inventoryItemId) });

  // Downstream consequence 2: public wine-list bin-code annotation query
  // (.not('bin_id','is',null)) would OMIT this row's bin code entirely.
  const { data: publicBinCode } = await admin
    .from("inventory_items")
    .select("wine_id, bin_id")
    .eq("id", appliedRow.inventoryItemId)
    .not("bin_id", "is", null);
  log(`\n=== Public list bin-code query (.not('bin_id','is',null)) would include this row: ${(publicBinCode?.length ?? 0) > 0} ===`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
