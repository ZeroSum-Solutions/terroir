#!/usr/bin/env node
/**
 * scripts/local/fix-demo-scan-statuses.mjs
 *
 * Put the demo tenant's seeded invoice scans into the STATUS VOCABULARY THE
 * APP USES, so /scans stops showing "1–20 of 60" over five chips that all
 * read 0.
 *
 * The base seeder wrote `committed` and `needs_review`; the scan pipeline
 * (src/domains/scanning) writes `processing | complete | review | failed`,
 * and the scan-history chips (scan-list-status.ts) count exactly those. A
 * seeded word the chips cannot count is not a display bug in the page, it is
 * a fixture that never spoke the product's language.
 *
 *   committed    -> complete
 *   needs_review -> review, with status_reason = arithmetic_mismatch, the
 *                   reason the pipeline itself records for a review row
 *                   (scan-status-reason.ts), so the row explains itself.
 *
 * Only those two seed words are rewritten; a scan already in a real status
 * is never touched. Idempotent.
 *
 * Usage:
 *   node scripts/local/fix-demo-scan-statuses.mjs              # dry run
 *   node scripts/local/fix-demo-scan-statuses.mjs --confirm
 */

import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const SUPABASE_URL = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:57321";
const SERVICE_KEY =
  process.env.LOCAL_SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONFIRM = process.argv.includes("--confirm");
const RESTAURANT_NAME =
  process.argv.find((a) => a.startsWith("--restaurant="))?.slice("--restaurant=".length) ??
  "LOCAL SEED - Osteria Scala";

try {
  execFileSync("bash", [path.join(__dirname, "assert-local-db.sh")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL },
  });
} catch {
  console.error("aborting — assert-local-db.sh refused the target.");
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error("LOCAL_SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required.");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const REWRITES = {
  committed: { status: "complete", status_reason: null },
  needs_review: { status: "review", status_reason: "arithmetic_mismatch" },
};

const { data: restaurant, error: restaurantError } = await db
  .from("restaurants")
  .select("id, name")
  .eq("name", RESTAURANT_NAME)
  .maybeSingle();
if (restaurantError) throw restaurantError;
if (!restaurant) {
  console.error(`No restaurant named "${RESTAURANT_NAME}".`);
  process.exit(1);
}

const { data: scans, error } = await db
  .from("invoice_scans")
  .select("id, status")
  .eq("restaurant_id", restaurant.id);
if (error) throw error;

const byStatus = new Map();
for (const s of scans) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
console.log(`Restaurant: ${restaurant.name}`);
console.log(`Scans: ${scans.length} · ` + [...byStatus].map(([k, n]) => `${k} ${n}`).join(" · "));

const plan = Object.entries(REWRITES)
  .map(([from, to]) => ({ from, to, ids: scans.filter((s) => s.status === from).map((s) => s.id) }))
  .filter((p) => p.ids.length > 0);
for (const p of plan) console.log(`  ${p.from} → ${p.to.status}: ${p.ids.length}`);
if (plan.length === 0) console.log("  nothing to rewrite");

if (!CONFIRM) {
  console.log("\nDry run — nothing written. Pass --confirm to rewrite them.");
  process.exit(0);
}

for (const p of plan) {
  const { error: updateError } = await db.from("invoice_scans").update(p.to).in("id", p.ids);
  if (updateError) throw updateError;
  console.log(`  rewrote ${p.ids.length} ${p.from} → ${p.to.status}`);
}

const { data: after } = await db
  .from("invoice_scans")
  .select("status")
  .eq("restaurant_id", restaurant.id);
const afterCounts = new Map();
for (const s of after ?? []) afterCounts.set(s.status, (afterCounts.get(s.status) ?? 0) + 1);
console.log("Verified (re-read): " + [...afterCounts].map(([k, n]) => `${k} ${n}`).join(" · "));
