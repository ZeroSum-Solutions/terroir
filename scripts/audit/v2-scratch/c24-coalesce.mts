// C24 (second half) — once a wrong lwin_id lands on a wine via the first
// apply, does a later, correct lwin_id for the SAME identity ever
// overwrite it? apply_import_batch_chunk's ON CONFLICT DO UPDATE uses
// coalesce(public.wines.lwin_id, excluded.lwin_id) — should keep the
// FIRST value forever. Confirm with two real apply calls.
import { adminClient, tenantClient, tenantIds, log } from "./lib.mts";
import { applyImportBatchChunk } from "../../../src/domains/import/batch-service";

const restaurantId = tenantIds.restaurantA;
const userId = tenantIds.userA;

async function main() {
  const admin = adminClient();
  const tenantA = await tenantClient("ownerA@audit.test");

  const { data: batch, error } = await admin
    .from("import_batches")
    .insert({ restaurant_id: restaurantId, created_by: userId, filename: "V2_c24_coalesce.csv", total_rows: 2 } as never)
    .select("id")
    .single();
  if (error || !batch) throw error;
  const batchId = (batch as { id: string }).id;

  const identity = { producer: "V2 C24 Coalesce Producer", name: "V2 C24 Coalesce Wine", vintage: "2018", size_ml: "750" };

  const rows = [
    {
      batch_id: batchId, restaurant_id: restaurantId, row_number: 1,
      raw: { ...identity, varietal: null, region: null, country: null, format: null, currency: "USD", quantity: "6", unit_cost: "20.00", bin: null, section: null },
      row_state: "valid", validation_errors: [], lwin_status: "matched", lwin_id: "V2_TEST_WRONG", lwin_score: 0.31,
      cost_status: "present", resolution: "auto",
    },
    {
      batch_id: batchId, restaurant_id: restaurantId, row_number: 2,
      raw: { ...identity, varietal: null, region: null, country: null, format: null, currency: "USD", quantity: "3", unit_cost: "20.00", bin: null, section: null },
      row_state: "valid", validation_errors: [], lwin_status: "matched", lwin_id: "V2_TEST_CORRECT", lwin_score: 0.95,
      cost_status: "present", resolution: "auto",
    },
  ];
  const { error: insErr } = await admin.from("import_batch_rows").insert(rows as never);
  if (insErr) throw insErr;

  const r1 = await applyImportBatchChunk(tenantA, batchId);
  log({ afterRow1: r1.processed });
  const { data: wineAfter1 } = await admin.from("wines").select("id, lwin_id").eq("restaurant_id", restaurantId).eq("name", identity.name).single();
  log({ wineAfterRow1: wineAfter1 });

  // Row 1 consumed the whole eligible set already (limit 100 >= 2 rows),
  // so both should have been processed in the same call. Verify explicitly:
  if (r1.processed.length < 2) {
    const r2 = await applyImportBatchChunk(tenantA, batchId);
    log({ afterRow2: r2.processed });
  }

  const { data: wineFinal } = await admin.from("wines").select("id, lwin_id").eq("restaurant_id", restaurantId).eq("name", identity.name).single();
  log({ wineFinal });
  log(`\n>>> BUG MANIFESTED (first-applied lwin_id 'V2_TEST_WRONG' (score 0.31) permanently stuck; the later, higher-confidence 'V2_TEST_CORRECT' (score 0.95) row for the SAME wine identity never overwrote it): ${(wineFinal as { lwin_id: string }).lwin_id === "V2_TEST_WRONG"}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
