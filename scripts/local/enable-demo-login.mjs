#!/usr/bin/env node
/**
 * scripts/local/enable-demo-login.mjs
 *
 * Make the account the app is actually configured to log in as able to log
 * in, and land it in the cellar that has the data.
 *
 * Two separate faults, both of which end the same way — an empty screen:
 *
 *   1. /api/dev-login mints an OTP for DEV_BYPASS_EMAIL and calls
 *      verifyOtp (route.ts:91). That user existed locally with
 *      email_confirmed_at NULL, so verification failed and the route
 *      returned its opaque 502 (temporaryLoginUnavailable). There was no
 *      way into the app at all.
 *
 *   2. Even once confirmed, the account owned a restaurant of its own —
 *      auto-provisioned by handle_new_user() on first sign-up, and empty.
 *      The 250 seeded wines, 400 inventory items, lists, scans and pour
 *      history all belong to "LOCAL SEED - Osteria Scala"
 *      (de100000-0000-4000-8000-000000000001), which this account was not a
 *      member of. Logging in would have opened a working app with nothing
 *      in it.
 *
 * The membership is created rather than moved, and nothing is deleted: the
 * auto-provisioned restaurant stays where it is. resolveActiveMembership
 * (src/lib/api/resolve-active-membership.ts:38) picks the signed cookie
 * first and otherwise the most recently created membership, id DESC — so
 * inserting the Osteria Scala membership now makes it the one a fresh
 * session lands on, without taking anything away.
 *
 * Idempotent: re-running confirms an already-confirmed user and leaves an
 * existing membership alone.
 *
 * Usage:
 *   node scripts/local/enable-demo-login.mjs
 *   node scripts/local/enable-demo-login.mjs --confirm
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
const DEMO_RESTAURANT_ID =
  process.env.LOCAL_SEED_RESTAURANT_ID ?? "de100000-0000-4000-8000-000000000001";
const WRITE = process.argv.includes("--confirm");

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

const email = process.env.DEV_BYPASS_EMAIL;
if (!email) {
  console.error("DEV_BYPASS_EMAIL is required (it is what /api/dev-login signs in as).");
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error("LOCAL_SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
if (listErr) {
  console.error(`listUsers failed: ${listErr.message}`);
  process.exit(1);
}
const user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`no local auth user for DEV_BYPASS_EMAIL=${email} — run seed-local.mjs first.`);
  process.exit(1);
}

const { data: restaurant } = await admin
  .from("restaurants")
  .select("id, name")
  .eq("id", DEMO_RESTAURANT_ID)
  .maybeSingle();
if (!restaurant) {
  console.error(`demo restaurant ${DEMO_RESTAURANT_ID} not found — run seed-local-supabase.mjs.`);
  process.exit(1);
}

const { data: existing } = await admin
  .from("memberships")
  .select("restaurant_id, role")
  .eq("user_id", user.id);
const alreadyMember = (existing ?? []).some((m) => m.restaurant_id === DEMO_RESTAURANT_ID);

console.log(`\n  account:      ${email}`);
console.log(`  confirmed:    ${user.email_confirmed_at ? "yes" : "NO — dev-login returns 502"}`);
console.log(`  memberships:  ${(existing ?? []).length}`);
console.log(`  in demo venue: ${alreadyMember ? "yes" : "NO — would land in an empty restaurant"}`);
console.log(`  demo venue:   ${restaurant.name} (${restaurant.id})\n`);

if (!WRITE) {
  console.log("DRY RUN — pass --confirm to write.");
  process.exit(0);
}

if (!user.email_confirmed_at) {
  const { error } = await admin.auth.admin.updateUserById(user.id, { email_confirm: true });
  if (error) {
    console.error(`confirm failed: ${error.message}`);
    process.exit(1);
  }
  console.log("confirmed email — /api/dev-login can now verify its OTP");
}

if (!alreadyMember) {
  const { error } = await admin
    .from("memberships")
    .insert({ user_id: user.id, restaurant_id: DEMO_RESTAURANT_ID, role: "owner" });
  if (error) {
    console.error(`membership insert failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`added owner membership in ${restaurant.name}`);
}
console.log("\ndone.");
