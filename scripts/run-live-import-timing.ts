#!/usr/bin/env -S npx tsx
/**
 * P3 — one-command live-DB timing run for the chunked import pipeline.
 *
 * Splits (or reuses an already-split) CSV into chunk files + a per-chunk
 * manifest via the real oracle (scripts/validate-bulk-import.ts), then
 * walks every chunk through the REAL confirm -> apply -> done pipeline
 * against a live local Supabase stack, as one import_session, reporting
 * per-chunk and total wall-clock timing.
 *
 * Usage:
 *   npx tsx scripts/run-live-import-timing.ts [path/to/file.csv]
 *   (defaults to fixtures/generated/partner-cellar-20k.csv — regenerate it
 *   first with `node scripts/fixtures/generate-partner-cellar.mjs` if
 *   missing)
 *
 * When the real partner CSV arrives, this is the ONE command to rerun the
 * identical test against it: `npx tsx scripts/run-live-import-timing.ts
 * path/to/real-partner-file.csv`.
 *
 * Requires a live local Supabase stack (NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY in env —
 * same convention as src/domains/import/tenant-isolation.test.ts). Never
 * targets production: refuses to run against any URL that doesn't look
 * like a local stack (127.0.0.1/localhost).
 *
 * Test-setup note (see p3-live.test.ts's own header for the same caveat):
 * a local dev stack's lwin_catalog is typically unseeded, so every row is
 * LWIN-unmatched and lands resolution='pending' at confirm time. This
 * script flips pending (unmatched-LWIN, cost-present) rows to 'auto' via
 * the admin client before each apply pass — a stand-in for "this row
 * matched a populated catalog," exercising the real apply/count/status
 * machinery this run actually measures, not the LWIN-matching RPC itself
 * (already measured separately, docs/runbooks/csv-import.md).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
if (!/127\.0\.0\.1|localhost/.test(supabaseUrl)) {
  console.error(`Refusing to run: ${supabaseUrl} does not look like a local stack.`);
  process.exit(1);
}

const csvPath = process.argv[2] ?? "fixtures/generated/partner-cellar-20k.csv";
if (!existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

type PerChunkManifest = {
  chunk_index: number;
  chunk_total: number;
  chunk_sha256: string;
  source_csv_sha256: string;
};

function chunksDirFor(p: string) {
  return (p.endsWith(".csv") ? p.slice(0, -4) : p) + ".chunks";
}
function chunksManifestPathFor(p: string) {
  return (p.endsWith(".csv") ? p.slice(0, -4) : p) + ".chunks.manifest.json";
}

async function main() {
  console.log(`=== P3 live import timing run: ${csvPath} ===`);

  console.log("--- Step 1: split + validate via the real oracle ---");
  const t0 = Date.now();
  execFileSync("npx", ["tsx", "scripts/validate-bulk-import.ts", csvPath], { stdio: "inherit" });
  console.log(`Split+validate wall clock: ${Date.now() - t0}ms\n`);

  const manifestPath = chunksManifestPathFor(csvPath);
  const chunksDir = chunksDirFor(csvPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    chunk_total: number;
    source_csv_sha256: string;
    chunks: PerChunkManifest[];
  };

  const admin = createClient(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });
  const run = Date.now();
  const password = "P3-Timing-Run-123!";

  const { data: restaurant, error: rErr } = await admin
    .from("restaurants")
    .insert({ name: `P3 Timing Run ${run}` } as never)
    .select("id")
    .single();
  if (rErr || !restaurant) throw rErr ?? new Error("failed to insert restaurant");
  const restaurantId = (restaurant as { id: string }).id;

  const { data: user, error: uErr } = await admin.auth.admin.createUser({
    email: `p3-timing-${run}@terroir.test`,
    password,
    email_confirm: true,
  });
  if (uErr || !user) throw uErr ?? new Error("failed to create user");
  const userId = user.user.id;

  const { error: mErr } = await admin
    .from("memberships")
    .insert({ user_id: userId, restaurant_id: restaurantId, role: "staff" } as never);
  if (mErr) throw mErr;

  const throwaway = createClient(supabaseUrl!, publishableKey!, { auth: { persistSession: false } });
  const { data: session, error: sErr } = await throwaway.auth.signInWithPassword({
    email: user.user.email!,
    password,
  });
  if (sErr || !session.session) throw sErr ?? new Error("sign-in failed");
  const staffClient: SupabaseClient = createClient(supabaseUrl!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
  });

  console.log(`--- Step 2: create session (declared_chunk_total=${manifest.chunk_total}) ---`);
  const { data: importSession, error: isErr } = await staffClient
    .from("import_sessions")
    .insert({
      restaurant_id: restaurantId,
      created_by: userId,
      label: `Timing run ${csvPath}`,
      source_sha256: manifest.source_csv_sha256,
      declared_chunk_total: manifest.chunk_total,
    } as never)
    .select("id")
    .single();
  if (isErr || !importSession) throw isErr ?? new Error("failed to create session");
  const sessionId = (importSession as { id: string }).id;

  const overallStart = Date.now();
  const chunkTimings: Array<{ chunkIndex: number; confirmMs: number; applyMs: number; applyCalls: number; rowsApplied: number }> = [];

  for (const chunk of manifest.chunks) {
    const chunkFile = `${chunksDir}/part-${String(chunk.chunk_index).padStart(4, "0")}.csv`;
    const buffer = readFileSync(chunkFile);
    const fileObj = new File([buffer], chunkFile.split("/").pop()!, { type: "text/csv" });

    const confirmStart = Date.now();
    // Call confirmImportBatch's underlying logic directly via the domain
    // function (dynamic import so this script has zero build-step
    // dependency) rather than a real HTTP round trip — same RPCs, same
    // atomicity, minus Next.js request-handling overhead (explicitly
    // named as excluded from this measurement).
    const { confirmImportBatch } = await import("../src/domains/import/batch-service");
    const confirmed = await confirmImportBatch(staffClient as never, restaurantId, userId, fileObj.name, buffer, {
      sessionId,
      chunkIndex: chunk.chunk_index,
      chunkTotal: chunk.chunk_total,
      sourceSha256: chunk.source_csv_sha256,
    });
    const confirmMs = Date.now() - confirmStart;
    if (!confirmed.ok) throw new Error(`confirm failed for chunk ${chunk.chunk_index}: ${JSON.stringify(confirmed.error)}`);
    if (confirmed.alreadyExists) throw new Error(`chunk ${chunk.chunk_index} unexpectedly already existed`);
    const batchId = confirmed.batchId;

    // Test-setup shortcut (see module header): flip pending-due-to-
    // unmatched-LWIN rows to auto so apply has real work to do.
    await admin
      .from("import_batch_rows")
      .update({ resolution: "auto" } as never)
      .eq("batch_id", batchId)
      .eq("resolution", "pending")
      .eq("cost_status", "present");

    const { applyImportBatchChunk } = await import("../src/domains/import/batch-service");
    const applyStart = Date.now();
    let applyCalls = 0;
    let rowsApplied = 0;
    for (;;) {
      const result = await applyImportBatchChunk(staffClient as never, batchId);
      applyCalls += 1;
      rowsApplied += result.processed.filter((p) => p.outcome === "applied").length;
      if (result.counts.eligibleNotApplied === 0) break;
      if (applyCalls > 200) throw new Error(`chunk ${chunk.chunk_index}: apply did not converge after 200 calls`);
    }
    const applyMs = Date.now() - applyStart;

    chunkTimings.push({ chunkIndex: chunk.chunk_index, confirmMs, applyMs, applyCalls, rowsApplied });
    console.log(
      `chunk ${chunk.chunk_index}/${chunk.chunk_total}: confirm=${confirmMs}ms, apply=${applyMs}ms over ${applyCalls} call(s), ${rowsApplied} rows applied`,
    );
  }

  const totalMs = Date.now() - overallStart;
  console.log("\n--- Summary ---");
  for (const t of chunkTimings) {
    console.log(`  chunk ${t.chunkIndex}: confirm ${t.confirmMs}ms, apply ${t.applyMs}ms (${t.applyCalls} calls, ${t.rowsApplied} rows) -> ${(t.rowsApplied / (t.applyMs / 1000)).toFixed(0)} rows/sec`);
  }
  const totalConfirm = chunkTimings.reduce((s, t) => s + t.confirmMs, 0);
  const totalApply = chunkTimings.reduce((s, t) => s + t.applyMs, 0);
  const totalRows = chunkTimings.reduce((s, t) => s + t.rowsApplied, 0);
  console.log(`  TOTAL: confirm ${totalConfirm}ms, apply ${totalApply}ms, wall clock ${totalMs}ms, ${totalRows} rows applied, ${(totalRows / (totalApply / 1000)).toFixed(0)} rows/sec (apply-only)`);

  console.log("\n--- Cleanup ---");
  await admin.from("restaurants").delete().eq("id", restaurantId);
  await admin.auth.admin.deleteUser(userId);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
