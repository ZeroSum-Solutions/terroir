#!/usr/bin/env node
/**
 * scripts/audit/seed-two-tenants.mjs
 *
 * Idempotent two-tenant seed for the ISOLATED audit-verification Supabase
 * stack (supabase/config.toml project_id "terroir-audit-local", ports in
 * the 583xx block — see scripts/audit/README.md). Creates two independent
 * restaurants via the real signup path (handle_new_user() trigger, see
 * supabase/migrations/0001_auth_boundary.sql) so verifier agents get a
 * realistic cross-tenant fixture to probe RLS against.
 *
 * Tenant A (ownerA@audit.test / "Alpha Cellars"):
 *   - 4 wines: one with lwin_id NULL, one published on a wine list
 *     (list + section + item, exercising the anon public-read path), one
 *     with an inventory_items row, one with a CLOSED open_bottles row
 *     (closed_at set) for bottle-lifecycle material.
 * Tenant B (ownerB@audit.test / "Beta Bar"):
 *   - 1 wine, 1 wine list with 1 section — a target for cross-tenant
 *     linkage attempts.
 *
 * Safe to re-run: every write is check-then-create, keyed on the fixed
 * emails/names below.
 *
 * Usage:
 *   node scripts/audit/seed-two-tenants.mjs
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

config({ path: path.join(REPO_ROOT, ".env.local") });

// --- Safety gate: refuse anything but a local Supabase target. -----------
try {
  execFileSync("bash", [path.join(REPO_ROOT, "scripts/local/assert-local-db.sh")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
} catch {
  console.error("seed-two-tenants: aborting — assert-local-db.sh refused the target.");
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.LOCAL_SEED_USER_PASSWORD ?? "Terroir-audit-local-123!";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "seed-two-tenants: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local).",
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

async function listAllUsers() {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    out.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return out;
}

/** Ensure an owner user + their restaurant exist (via handle_new_user()). */
async function ensureTenant(email, restaurantName) {
  const users = await listAllUsers();
  let user = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: `Owner (${restaurantName})`,
        // handle_new_user() reads this to name the auto-provisioned
        // restaurant (supabase/migrations/0001_auth_boundary.sql).
        restaurant_name: restaurantName,
      },
    });
    if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
    user = data.user;
    console.log(`seed-two-tenants: created user ${email} (id=${user.id})`);
  } else {
    console.log(`seed-two-tenants: user already exists (${email}, id=${user.id})`);
  }

  const { data: memberships, error: memErr } = await admin
    .from("memberships")
    .select("restaurant_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  if (memErr) throw new Error(`memberships lookup failed: ${memErr.message}`);

  let restaurantId;
  if (memberships && memberships.length > 0) {
    restaurantId = memberships[0].restaurant_id;
  } else {
    // Trigger should have provisioned this; self-heal if it didn't.
    const { data: restaurant, error: restaurantError } = await admin
      .from("restaurants")
      .insert({ name: restaurantName })
      .select("id")
      .single();
    if (restaurantError) throw new Error(`restaurant insert failed: ${restaurantError.message}`);
    restaurantId = restaurant.id;
    const { error: membershipError } = await admin
      .from("memberships")
      .insert({ user_id: user.id, restaurant_id: restaurantId, role: "owner" });
    if (membershipError) throw new Error(`membership insert failed: ${membershipError.message}`);
  }

  console.log(`seed-two-tenants: ${email} -> restaurant ${restaurantId} (${restaurantName})`);
  return { userId: user.id, restaurantId };
}

/** Check-then-insert a wine by (restaurant_id, name, producer). */
async function ensureWine(restaurantId, wine) {
  const { data: existing, error: findErr } = await admin
    .from("wines")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .eq("name", wine.name)
    .eq("producer", wine.producer)
    .maybeSingle();
  if (findErr) throw new Error(`wines lookup failed: ${findErr.message}`);
  if (existing) return existing.id;

  const { data: inserted, error: insertErr } = await admin
    .from("wines")
    .insert({ restaurant_id: restaurantId, ...wine })
    .select("id")
    .single();
  if (insertErr) throw new Error(`wines insert (${wine.name}) failed: ${insertErr.message}`);
  console.log(`seed-two-tenants: created wine "${wine.name}" (id=${inserted.id})`);
  return inserted.id;
}

/** Check-then-insert a wine list by (restaurant_id, name). */
async function ensureWineList(restaurantId, listAttrs) {
  const { data: existing, error: findErr } = await admin
    .from("wine_lists")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .eq("name", listAttrs.name)
    .maybeSingle();
  if (findErr) throw new Error(`wine_lists lookup failed: ${findErr.message}`);
  if (existing) return existing.id;

  const { data: inserted, error: insertErr } = await admin
    .from("wine_lists")
    .insert({ restaurant_id: restaurantId, ...listAttrs })
    .select("id")
    .single();
  if (insertErr) throw new Error(`wine_lists insert (${listAttrs.name}) failed: ${insertErr.message}`);
  console.log(`seed-two-tenants: created wine list "${listAttrs.name}" (id=${inserted.id})`);
  return inserted.id;
}

/** Check-then-insert a section by (wine_list_id, name). */
async function ensureSection(wineListId, name, position = 0) {
  const { data: existing, error: findErr } = await admin
    .from("wine_list_sections")
    .select("id")
    .eq("wine_list_id", wineListId)
    .eq("name", name)
    .maybeSingle();
  if (findErr) throw new Error(`wine_list_sections lookup failed: ${findErr.message}`);
  if (existing) return existing.id;

  const { data: inserted, error: insertErr } = await admin
    .from("wine_list_sections")
    .insert({ wine_list_id: wineListId, name, position })
    .select("id")
    .single();
  if (insertErr) throw new Error(`wine_list_sections insert (${name}) failed: ${insertErr.message}`);
  console.log(`seed-two-tenants: created section "${name}" (id=${inserted.id})`);
  return inserted.id;
}

/**
 * Check-then-insert a wine_list_item by (section_id, wine_id).
 *
 * C05 (db audit 2026-08-23): wine_list_items.restaurant_id is now a
 * required, FK-enforced column (denormalized from the wine's own
 * restaurant_id) — restaurantId must be passed explicitly and must match
 * wineId's real restaurant, or the insert fails the composite FK.
 */
async function ensureListItem(sectionId, wineId, restaurantId, attrs = {}) {
  const { data: existing, error: findErr } = await admin
    .from("wine_list_items")
    .select("id")
    .eq("section_id", sectionId)
    .eq("wine_id", wineId)
    .maybeSingle();
  if (findErr) throw new Error(`wine_list_items lookup failed: ${findErr.message}`);
  if (existing) return existing.id;

  const { data: inserted, error: insertErr } = await admin
    .from("wine_list_items")
    .insert({ section_id: sectionId, wine_id: wineId, restaurant_id: restaurantId, ...attrs })
    .select("id")
    .single();
  if (insertErr) throw new Error(`wine_list_items insert failed: ${insertErr.message}`);
  console.log(`seed-two-tenants: created list item (id=${inserted.id})`);
  return inserted.id;
}

/** Check-then-insert an inventory_items row for a wine. */
async function ensureInventoryItem(restaurantId, wineId, attrs) {
  const { data: existing, error: findErr } = await admin
    .from("inventory_items")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .eq("wine_id", wineId)
    .maybeSingle();
  if (findErr) throw new Error(`inventory_items lookup failed: ${findErr.message}`);
  if (existing) return existing.id;

  const { data: inserted, error: insertErr } = await admin
    .from("inventory_items")
    .insert({ restaurant_id: restaurantId, wine_id: wineId, ...attrs })
    .select("id")
    .single();
  if (insertErr) throw new Error(`inventory_items insert failed: ${insertErr.message}`);
  console.log(`seed-two-tenants: created inventory_items row (id=${inserted.id})`);
  return inserted.id;
}

/**
 * Upsert a CLOSED open_bottles row (closed_at set) for a wine. This is a
 * direct table write bypassing the record_pour/close_open_bottle RPCs —
 * fine for seed data, and (wine_id, restaurant_id) is a real unique
 * constraint (0016_pour_tracking.sql) so upsert-on-conflict works.
 */
async function ensureClosedOpenBottle(restaurantId, wineId, openedBy) {
  const { data, error } = await admin
    .from("open_bottles")
    .upsert(
      {
        wine_id: wineId,
        restaurant_id: restaurantId,
        remaining_ml: 0,
        opened_at: daysAgo(5),
        closed_at: daysAgo(1),
        opened_by: openedBy,
        preservation_method: "none",
      },
      { onConflict: "wine_id,restaurant_id" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`open_bottles upsert failed: ${error.message}`);
  console.log(`seed-two-tenants: closed open_bottles row for wine ${wineId} (id=${data.id})`);
  return data.id;
}

async function main() {
  console.log(`seed-two-tenants: target ${SUPABASE_URL}`);

  const tenantA = await ensureTenant("ownerA@audit.test", "Alpha Cellars");
  const tenantB = await ensureTenant("ownerB@audit.test", "Beta Bar");

  // --- Tenant A -----------------------------------------------------------
  const wineA1_noLwin = await ensureWine(tenantA.restaurantId, {
    name: "Estate Cabernet Sauvignon",
    producer: "Alpha Cellars",
    vintage: 2019,
    varietal: "Cabernet Sauvignon",
    region: "Napa Valley",
    country: "United States",
    size_ml: 750,
    lwin_id: null,
  });

  const wineA2_published = await ensureWine(tenantA.restaurantId, {
    name: "Reserve Chardonnay",
    producer: "Alpha Cellars",
    vintage: 2021,
    varietal: "Chardonnay",
    region: "Sonoma Coast",
    country: "United States",
    size_ml: 750,
    lwin_id: "1234567",
  });

  const wineA3_inventory = await ensureWine(tenantA.restaurantId, {
    name: "House Red Blend",
    producer: "Alpha Cellars",
    vintage: 2020,
    varietal: "Red Blend",
    region: "Central Coast",
    country: "United States",
    size_ml: 750,
    lwin_id: "2345678",
  });

  const wineA4_openBottle = await ensureWine(tenantA.restaurantId, {
    name: "By-the-Glass Pinot Noir",
    producer: "Alpha Cellars",
    vintage: 2021,
    varietal: "Pinot Noir",
    region: "Willamette Valley",
    country: "United States",
    size_ml: 750,
    lwin_id: "3456789",
  });

  const listA = await ensureWineList(tenantA.restaurantId, {
    name: "Alpha Cellars Wine List",
    template: "classic",
    slug: "alpha-cellars-audit",
    is_published: true,
    last_published_at: daysAgo(2),
  });
  const sectionA = await ensureSection(listA, "Whites", 0);
  const itemA = await ensureListItem(sectionA, wineA2_published, tenantA.restaurantId, {
    position: 0,
    glass_price: 14.0,
    bottle_price: 56.0,
    is_available: true,
  });

  const inventoryA = await ensureInventoryItem(tenantA.restaurantId, wineA3_inventory, {
    quantity: 12,
    unit_cost: 22.5,
    bin_location: "A-12",
    added_via: "manual",
  });

  const openBottleA = await ensureClosedOpenBottle(
    tenantA.restaurantId,
    wineA4_openBottle,
    tenantA.userId,
  );

  // --- Tenant B -------------------------------------------------------------
  const wineB1 = await ensureWine(tenantB.restaurantId, {
    name: "House Red",
    producer: "Beta Bar",
    vintage: 2022,
    varietal: "Zinfandel",
    region: "Lodi",
    country: "United States",
    size_ml: 750,
    lwin_id: "4567890",
  });

  const listB = await ensureWineList(tenantB.restaurantId, {
    name: "Beta Bar Wine List",
    template: "classic",
    slug: null,
    is_published: false,
  });
  const sectionB = await ensureSection(listB, "Reds", 0);

  const result = {
    userA: tenantA.userId,
    userB: tenantB.userId,
    restaurantA: tenantA.restaurantId,
    restaurantB: tenantB.restaurantId,
    wineA_ids: [wineA1_noLwin, wineA2_published, wineA3_inventory, wineA4_openBottle],
    wineA_published_id: wineA2_published,
    wineA_noLwin_id: wineA1_noLwin,
    wineA_inventory_id: wineA3_inventory,
    listA_id: listA,
    sectionA_id: sectionA,
    itemA_id: itemA,
    inventoryA_id: inventoryA,
    openBottleA_id: openBottleA,
    openBottleA_wine_id: wineA4_openBottle,
    wineB_id: wineB1,
    listB_id: listB,
    sectionB_id: sectionB,
  };

  const outPath = path.join(__dirname, "tenant-ids.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

  console.log("");
  console.log("seed-two-tenants: done. tenant-ids.json:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("seed-two-tenants: FAILED —", error.message ?? error);
  process.exit(1);
});
