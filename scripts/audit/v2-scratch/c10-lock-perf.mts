// C10 — measure apply_import_batch_chunk throughput, with and without
// wines_derive_lineage advisory-lock contention across two concurrent
// chunk calls. Uses the REAL applyImportBatchChunk() export.
import { adminClient, tenantClient, tenantIds, log } from "./lib.mts";
import { applyImportBatchChunk } from "../../../src/domains/import/batch-service";

const restaurantId = tenantIds.restaurantA;
const userId = tenantIds.userA;

async function makeBatch(admin: ReturnType<typeof adminClient>, rows: number, identityFn: (n: number) => { producer: string; name: string }) {
  const { data: batch, error } = await admin
    .from("import_batches")
    .insert({ restaurant_id: restaurantId, created_by: userId, filename: `V2_c10_${rows}rows.csv`, total_rows: rows } as never)
    .select("id")
    .single();
  if (error || !batch) throw error ?? new Error("no batch");
  const batchId = (batch as { id: string }).id;

  const CHUNK = 250;
  for (let start = 0; start < rows; start += CHUNK) {
    const recs = [];
    for (let i = start; i < Math.min(start + CHUNK, rows); i++) {
      const n = i + 1;
      const { producer, name } = identityFn(n);
      recs.push({
        batch_id: batchId,
        restaurant_id: restaurantId,
        row_number: n,
        raw: {
          producer, name,
          vintage: String(2000 + (n % 20)), varietal: null, region: null, country: null,
          size_ml: "750", format: null, currency: "USD", quantity: "6", unit_cost: "19.99",
          bin: null, section: null,
        },
        row_state: "valid", validation_errors: [], lwin_status: "unmatched", lwin_id: null, lwin_score: null,
        cost_status: "present", resolution: "auto",
      });
    }
    const { error: insErr } = await admin.from("import_batch_rows").insert(recs as never);
    if (insErr) throw insErr;
  }
  return batchId;
}

async function runToCompletion(client: Awaited<ReturnType<typeof tenantClient>>, batchId: string, label: string) {
  const times: number[] = [];
  let totalApplied = 0;
  const t0 = Date.now();
  while (true) {
    const start = Date.now();
    const res = await applyImportBatchChunk(client, batchId);
    const ms = Date.now() - start;
    times.push(ms);
    totalApplied += res.processed.filter((p) => p.outcome === "applied").length;
    if (res.processed.length === 0) break;
  }
  const totalMs = Date.now() - t0;
  log(`[${label}] chunks=${times.length} perChunkMs=${JSON.stringify(times)} totalApplied=${totalApplied} totalMs=${totalMs}`);
  return { totalMs, totalApplied, chunks: times.length, perChunkMs: times };
}

async function main() {
  const admin = adminClient();
  const tenantA = await tenantClient("ownerA@audit.test");

  log("=== Baseline: 1000 rows, ALL UNIQUE identities (no lock contention) ===");
  const baseBatch = await makeBatch(admin, 1000, (n) => ({ producer: `V2 C10 Baseline Producer ${n}`, name: `V2 C10 Baseline Wine ${n}` }));
  const baseline = await runToCompletion(tenantA, baseBatch, "baseline-unique");
  const baselineRowsPerSec = baseline.totalApplied / (baseline.totalMs / 1000);
  log(`baseline rows/sec = ${baselineRowsPerSec.toFixed(1)}; extrapolated wall-clock for 20,000 rows = ${(20000 / baselineRowsPerSec).toFixed(1)}s (${(20000 / baselineRowsPerSec / 60).toFixed(2)} min)`);

  log("\n=== Contention setup: two 200-row batches, rows PAIRWISE SHARE identity (same producer+name+vintage+size) between the two batches ===");
  // Batch X rows 1..200 and batch Y rows 1..200 use the IDENTICAL identity
  // per index -> derive_wine_lineage's advisory lock (keyed on
  // restaurant_id|producer_norm|cuvee_norm) collides across the two
  // concurrent chunk calls for every row.
  const sharedIdentity = (n: number) => ({ producer: `V2 C10 Shared Producer ${n}`, name: `V2 C10 Shared Wine ${n}` });
  const batchX = await makeBatch(admin, 200, sharedIdentity);
  const batchY = await makeBatch(admin, 200, sharedIdentity);

  log("Firing applyImportBatchChunk(X) and applyImportBatchChunk(Y) CONCURRENTLY (Promise.all) — both chunks share all 200 identities...");
  const cT0 = Date.now();
  const [resX, resY] = await Promise.all([
    (async () => { const t = Date.now(); const r = await applyImportBatchChunk(tenantA, batchX); return { r, ms: Date.now() - t }; })(),
    (async () => { const t = Date.now(); const r = await applyImportBatchChunk(tenantA, batchY); return { r, ms: Date.now() - t }; })(),
  ]);
  const cTotalMs = Date.now() - cT0;
  log({ concurrentTotalWallMs: cTotalMs, chunkX_ms: resX.ms, chunkX_outcomes: tally(resX.r.processed), chunkY_ms: resY.ms, chunkY_outcomes: tally(resY.r.processed) });

  log("\n=== Control: same two 200-row batches applied SEQUENTIALLY (no concurrency) for comparison ===");
  const batchX2 = await makeBatch(admin, 200, sharedIdentity);
  const batchY2 = await makeBatch(admin, 200, sharedIdentity);
  const sT0 = Date.now();
  const rX2 = await applyImportBatchChunk(tenantA, batchX2);
  const rY2 = await applyImportBatchChunk(tenantA, batchY2);
  const sTotalMs = Date.now() - sT0;
  log({ sequentialTotalWallMs: sTotalMs, chunkX2_outcomes: tally(rX2.processed), chunkY2_outcomes: tally(rY2.processed) });

  log("\n=== Comparison ===");
  log({
    concurrentWallMs: cTotalMs,
    sequentialWallMs: sTotalMs,
    slowerFactor: (cTotalMs / sTotalMs).toFixed(2),
    interpretation: cTotalMs > sTotalMs * 1.3
      ? "concurrent run took LONGER than sequential -> lock serialization overhead measured, not parallelism gain"
      : "concurrent run was not meaningfully slower than sequential in this run",
  });
}

function tally(processed: Array<{ outcome: string }>) {
  const t: Record<string, number> = {};
  for (const p of processed) t[p.outcome] = (t[p.outcome] ?? 0) + 1;
  return t;
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
