// C18 — numeric validation accepts numeric PREFIXES, not whole-cell
// values; no DB constraints on vintage/size/currency. Calls the REAL
// validateRow() + mapHeader() exports directly (pure functions), then
// verifies via a REAL apply what actually lands in the database.
import { mapHeader, validateRow } from "../../../src/domains/import/row-validator";
import { adminClient, tenantClient, tenantIds, log } from "./lib.mts";
import { confirmImportBatch, applyImportBatchChunk } from "../../../src/domains/import/batch-service";

const HEADER = ["producer", "name", "vintage", "varietal", "region", "country", "size_ml", "format", "currency", "quantity", "unit_cost", "bin", "section"];
const { columnToField } = mapHeader(HEADER);

function testCells(label: string, cells: string[]) {
  const result = validateRow(cells, columnToField);
  log(`\n--- ${label} ---`);
  log({ input: cells, result });
}

log("=== C18a: validateRow() with numeric-PREFIX adversarial values (pure function, no DB) ===");

testCells("vintage='2015abc' (prefix of a valid int)", ["P", "N", "2015abc", "", "", "", "", "", "", "6", "10.00", "", ""]);
testCells("size_ml='750ml' (prefix of a valid int)", ["P", "N", "", "", "", "", "750ml", "", "", "6", "10.00", "", ""]);
testCells("unit_cost='12.5.7' (multiple dots)", ["P", "N", "", "", "", "", "", "", "", "6", "12.5.7", "", ""]);
testCells("quantity='-1' (negative)", ["P", "N", "", "", "", "", "", "", "", "-1", "10.00", "", ""]);
testCells("quantity='99999' (absurd but 'valid')", ["P", "N", "", "", "", "", "", "", "", "99999", "10.00", "", ""]);
testCells("unit_cost='99999' (absurd but 'valid', no upper bound)", ["P", "N", "", "", "", "", "", "", "", "6", "99999", "", ""]);
testCells("vintage='99999' (out of MIN/CURRENT+1 range -> should be rejected)", ["P", "N", "99999", "", "", "", "", "", "", "6", "10.00", "", ""]);
testCells("size_ml='-1' (negative -> should be rejected by <=0 check)", ["P", "N", "", "", "", "", "-1", "", "", "6", "10.00", "", ""]);

log("\n=== C18b: DB-level CHECK constraints on wines/inventory_items (ground truth, already queried via psql separately) ===");
log("wines: no CHECK on vintage or size_ml. inventory_items: quantity>=0 and unit_cost>=0 only (no upper bound, no currency format check).");

log("\n=== C18c: run a real apply with the accepted-but-nonsensical prefix values and inspect the persisted row ===");
async function main() {
  const restaurantId = tenantIds.restaurantA;
  const userId = tenantIds.userA;
  const tenantA = await tenantClient("ownerA@audit.test");
  const admin = adminClient();

  // '2015abc' -> row-validator's Number.parseInt keeps 2015 (prefix parse).
  // '750ml' -> size_ml keeps 750. '99999' quantity has no upper bound.
  const csv = Buffer.from(
    "producer,name,vintage,quantity,unit_cost,size_ml,currency\n" +
      "Cheval Blanc,Tenuta Lafite C18,2015abc,99999,10.00,750ml,Freedom Bucks\n",
  );
  const confirmResult = await confirmImportBatch(tenantA, restaurantId, userId, "cellar-c18.csv", csv);
  if (!confirmResult.ok) {
    log({ confirmRejected: confirmResult.error });
    return;
  }
  log({ batchId: confirmResult.batchId, previewSummary: confirmResult.summary });

  const applyResult = await applyImportBatchChunk(tenantA, confirmResult.batchId);
  log({ applyOutcomes: applyResult.processed });
  const applied = applyResult.processed[0];
  if (!applied?.inventoryItemId) {
    log(">>> Row did not apply — REFUTES the DB-write half of this claim for this input.");
    return;
  }

  const { data: invRow } = await admin
    .from("inventory_items")
    .select("id, wine_id, quantity, unit_cost, currency, wines(vintage, size_ml, name, producer)")
    .eq("id", applied.inventoryItemId)
    .single();
  log("\n=== Persisted row after apply (what the partner would actually get in their catalog) ===");
  log(invRow);
  const w = (invRow as { wines: { vintage: number; size_ml: number } }).wines;
  log(`\n>>> BUG MANIFESTED ('2015abc' silently coerced to vintage=${w.vintage}, '750ml' silently coerced to size_ml=${w.size_ml}, quantity=99999 and currency='Freedom Bucks' both accepted with zero DB constraint): ${w.vintage === 2015 && w.size_ml === 750}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
