#!/usr/bin/env node
/**
 * scripts/local/seed-local.mjs
 *
 * Idempotent local-only seed: ensures the dev-login bypass user
 * (DEV_BYPASS_EMAIL, default devlocal@terroir.test) exists in the local
 * GoTrue instance, with a restaurant + owner membership so logging in via
 * /api/dev-login lands in a working venue.
 *
 * Provisioning happens almost entirely via the existing
 * `handle_new_user()` trigger (supabase/migrations/0001_auth_boundary.sql):
 * inserting into auth.users automatically creates a restaurant + owner
 * membership row. This script just needs to create that one auth user
 * (once) and otherwise verify the membership is intact.
 *
 * Safe to re-run: if the user already exists, nothing is created twice.
 *
 * Usage:
 *   node scripts/local/seed-local.mjs
 *
 * Env (from .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL   — must be a local (127.0.0.1/localhost) URL
 *   SUPABASE_SERVICE_ROLE_KEY  — local service-role key
 *   DEV_BYPASS_EMAIL           — defaults to devlocal@terroir.test
 *   DEV_LOCAL_PASSWORD         — optional, defaults to a fixed dev password
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

config({ path: path.join(REPO_ROOT, ".env.local") });

// --- Safety gate: refuse anything but a local Supabase target. -----------
// Node can't `source` a bash script, so we spawn assert-local-db.sh as a
// subprocess with the same env this process resolved and require it to
// exit 0. This is the equivalent enforcement for a non-bash caller.
try {
  execFileSync("bash", [path.join(__dirname, "assert-local-db.sh")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
} catch {
  console.error("seed-local: aborting — assert-local-db.sh refused the target.");
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEV_EMAIL = process.env.DEV_BYPASS_EMAIL ?? "devlocal@terroir.test";
const DEV_PASSWORD = process.env.DEV_LOCAL_PASSWORD ?? "Terroir-local-123!";
const RESTAURANT_NAME = "Devlocal Test Restaurant";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "seed-local: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local).",
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function findUserByEmail(email) {
  // Local dev stack has a handful of users at most — one page is enough.
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`listUsers failed: ${error.message}`);
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

async function ensureUser() {
  const existing = await findUserByEmail(DEV_EMAIL);
  if (existing) {
    console.log(`seed-local: user already exists (${DEV_EMAIL}, id=${existing.id})`);
    return existing;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: DEV_EMAIL,
    password: DEV_PASSWORD,
    email_confirm: true,
    user_metadata: {
      full_name: "Devlocal Test User",
      // handle_new_user() reads this to name the auto-provisioned
      // restaurant (supabase/migrations/0001_auth_boundary.sql).
      restaurant_name: RESTAURANT_NAME,
    },
  });
  if (error) throw new Error(`createUser failed: ${error.message}`);
  console.log(`seed-local: created user ${DEV_EMAIL} (id=${data.user.id})`);
  return data.user;
}

async function ensureMembership(userId) {
  const { data: memberships, error } = await admin
    .from("memberships")
    .select("restaurant_id, role")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`memberships lookup failed: ${error.message}`);

  if (memberships && memberships.length > 0) {
    const m = memberships[0];
    console.log(
      `seed-local: membership present (restaurant_id=${m.restaurant_id}, role=${m.role})`,
    );
    return m.restaurant_id;
  }

  // handle_new_user() should have created this on user insert. Missing
  // membership means the user existed from before that trigger ran (or was
  // manually cleaned up) — provision it directly so the seed stays
  // idempotent and self-healing.
  console.log("seed-local: no membership found — provisioning restaurant + owner membership.");
  const { data: restaurant, error: restaurantError } = await admin
    .from("restaurants")
    .insert({ name: RESTAURANT_NAME })
    .select("id")
    .single();
  if (restaurantError) {
    throw new Error(`restaurant insert failed: ${restaurantError.message}`);
  }

  const { error: membershipError } = await admin.from("memberships").insert({
    user_id: userId,
    restaurant_id: restaurant.id,
    role: "owner",
  });
  if (membershipError) {
    throw new Error(`membership insert failed: ${membershipError.message}`);
  }

  console.log(`seed-local: provisioned restaurant ${restaurant.id}`);
  return restaurant.id;
}

async function main() {
  console.log(`seed-local: target ${SUPABASE_URL}`);
  const user = await ensureUser();
  const restaurantId = await ensureMembership(user.id);

  console.log("");
  console.log("seed-local: done.");
  console.log(`  DEV_BYPASS_EMAIL=${DEV_EMAIL}`);
  console.log(`  user_id=${user.id}`);
  console.log(`  restaurant_id=${restaurantId}`);
}

main().catch((error) => {
  console.error("seed-local: FAILED —", error.message ?? error);
  process.exit(1);
});
