// C16 — permanent row errors are never persisted; every chunk re-selects
// the earliest APPLY_CHUNK_SIZE eligible rows -> a deterministically
// failing row (passes app validation, fails the DB numeric(10,2) cast)
// can starve all rows after it forever. Uses the REAL
// applyImportBatchChunk() export, called exactly as the app calls it
// (p_limit = APPLY_CHUNK_SIZE = 100), repeatedly.
import { adminClient, tenantClient, tenantIds, log } from "./lib.mts";
import { applyImportBatchChunk } from "../../../src/domains/import/batch-service";
import { APPLY_CHUNK_SIZE } from "../../../src/domains/import/constants";

const restaurantId = tenantIds.restaurantA;
const userId = tenantIds.userA;

async function main() {
  const admin = adminClient();
  const tenantA = await tenantClient("ownerA@audit.test");

  const { data: batch, error } = await admin
    .from("import_batches")
    .insert({ restaurant_id: restaurantId, created_by: userId, filename: "V2_c16_poison.csv", total_rows: 101 } as never)
    .select("id")
    .single();
  if (error || !batch) throw error;
  const batchId = (batch as { id: string }).id;
  log({ batchId, APPLY_CHUNK_SIZE });

  // Rows 1-100: pass row-validator's finite/non-negative check but
  // overflow numeric(10,2) precision (max 99999999.99) at apply time.
  // Row 101: a normal, applicable row.
  const rows = [];
  for (let n = 1; n <= 100; n++) {
    rows.push({
      batch_id: batchId, restaurant_id: restaurantId, row_number: n,
      raw: {
        producer: `V2 C16 Poison Producer ${n}`, name: `V2 C16 Poison Wine ${n}`,
        vintage: "2020", varietal: null, region: null, country: null, size_ml: "750",
        format: null, currency: "USD", quantity: "6", unit_cost: "100000000.00",
        bin: null, section: null,
      },
      row_state: "valid", validation_errors: [], lwin_status: "unmatched", lwin_id: null, lwin_score: null,
      cost_status: "present", resolution: "auto",
    });
  }
  rows.push({
    batch_id: batchId, restaurant_id: restaurantId, row_number: 101,
    raw: {
      producer: "Cheval Blanc", name: "Tenuta Lafite C16", vintage: "2020", varietal: null,
      region: null, country: null, size_ml: "750", format: null, currency: "USD",
      quantity: "6", unit_cost: "10.00", bin: null, section: null,
    },
    row_state: "valid", validation_errors: [], lwin_status: "matched", lwin_id: "V5_00000001", lwin_score: 0.9,
    cost_status: "present", resolution: "auto",
  });

  const { error: insErr } = await admin.from("import_batch_rows").insert(rows as never);
  if (insErr) throw insErr;
  log("inserted 101 rows (100 poison + 1 good, good row is row_number=101, LAST in eligibility order).");

  log("\n=== Calling applyImportBatchChunk() repeatedly (exactly as the app does, p_limit=100) ===");
  for (let call = 1; call <= 4; call++) {
    const result = await applyImportBatchChunk(tenantA, batchId);
    const rowNumbers = result.processed.map((p) => p.rowNumber).sort((a, b) => a - b);
    const outcomeTally: Record<string, number> = {};
    for (const p of result.processed) outcomeTally[p.outcome] = (outcomeTally[p.outcome] ?? 0) + 1;
    const sampleError = result.processed.find((p) => p.outcome === "error")?.errorMessage;
    log(`call #${call}: processed rowNumbers=[${rowNumbers[0]}..${rowNumbers[rowNumbers.length - 1]}] (n=${rowNumbers.length}) outcomes=${JSON.stringify(outcomeTally)} row101Included=${rowNumbers.includes(101)} status=${result.status} counts=${JSON.stringify(result.counts)}`);
    if (call === 1) log(`  sample error message: ${sampleError}`);
  }

  const { data: row101 } = await admin
    .from("import_batch_rows")
    .select("row_number, apply_status")
    .eq("batch_id", batchId)
    .eq("row_number", 101)
    .single();
  log(`\nrow 101 (the ONLY genuinely applicable row) final apply_status after 4 calls: ${(row101 as { apply_status: string }).apply_status}`);
  log(`>>> BUG MANIFESTED (poison rows 1-100 are re-selected every call; the one good row behind them never gets a turn): ${(row101 as { apply_status: string }).apply_status === "not_applied"}`);

  const { data: poisonRow1 } = await admin
    .from("import_batch_rows")
    .select("row_number, apply_status, updated_at")
    .eq("batch_id", batchId)
    .eq("row_number", 1)
    .single();
  log({ poisonRow1AfterAllCalls: poisonRow1 });
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
