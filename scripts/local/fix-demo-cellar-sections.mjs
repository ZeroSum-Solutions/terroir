#!/usr/bin/env node
/**
 * scripts/local/fix-demo-cellar-sections.mjs
 *
 * File every inventory item of the demo cellar under the section that
 * matches its wine's colour, so `/cellar` stops opening on "Sparkling"
 * holding a red and "Whites" holding a tawny port.
 *
 * The base seeder dealt items into `inventory_items.section` round-robin
 * (`sections[i % sections.length]`), and `/cellar` groups by that column
 * (BND-063). Measured 2026-09-01 on LOCAL SEED - Osteria Scala: "Sparkling"
 * held 35 reds and 8 sparklings; "Whites" 27 reds and 16 whites; every
 * section was ~30% right. fix-demo-wine-lists.mjs fixed the same fault on
 * the wine lists and left the cellar alone; this is the cellar half, on the
 * same rule (scripts/local/wine-sections.mjs).
 *
 * Items are MOVED; wines and quantities are never touched. A section the
 * tenant's cellar config does not declare is never written — the item stays
 * where it is and is counted as unplaceable, visibly.
 *
 * Idempotent: a second run moves nothing.
 *
 * Usage:
 *   node scripts/local/fix-demo-cellar-sections.mjs              # dry run
 *   node scripts/local/fix-demo-cellar-sections.mjs --confirm
 *   node scripts/local/fix-demo-cellar-sections.mjs --restaurant="LOCAL SEED - Osteria Scala"
 */

import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sectionNameFor } from "./wine-sections.mjs";

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

// cellar_config.labels.sections is stored as plain strings by the seeders
// and as {id, name} by the config editor — the same two shapes
// src/app/(app)/cellar/sections.ts normalises.
const { data: config } = await db
  .from("cellar_config")
  .select("labels")
  .eq("restaurant_id", restaurant.id)
  .maybeSingle();
const rawSections = Array.isArray(config?.labels?.sections) ? config.labels.sections : [];
const configured = new Set(
  rawSections.map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean),
);
if (configured.size === 0) {
  console.error("The cellar config declares no sections; nothing can be filed. Aborting.");
  process.exit(1);
}

const { data: items, error: itemsError } = await db
  .from("inventory_items")
  .select("id, wine_id, section")
  .eq("restaurant_id", restaurant.id);
if (itemsError) throw itemsError;
const { data: wines, error: winesError } = await db
  .from("wines")
  .select("id, colour, country")
  .eq("restaurant_id", restaurant.id);
if (winesError) throw winesError;
const wineById = new Map(wines.map((w) => [w.id, w]));

const moves = new Map(); // target section -> item ids
let unchanged = 0;
let unplaceable = 0;
const matrix = (rows) => {
  const m = new Map();
  for (const r of rows) {
    const key = r.section ?? "(none)";
    const colour = wineById.get(r.wine_id)?.colour ?? "(unknown)";
    if (!m.has(key)) m.set(key, new Map());
    m.get(key).set(colour, (m.get(key).get(colour) ?? 0) + 1);
  }
  return m;
};
const printMatrix = (title, m) => {
  console.log(`\n${title}`);
  for (const [section, colours] of [...m.entries()].sort()) {
    const cells = [...colours.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`);
    console.log(`  ${section.padEnd(22)} ${cells.join(" · ")}`);
  }
};

const after = [];
for (const item of items) {
  const wine = wineById.get(item.wine_id);
  const target = wine ? sectionNameFor(wine).find((name) => configured.has(name)) : undefined;
  if (!target) {
    unplaceable += 1;
    after.push(item);
    continue;
  }
  if (item.section === target) {
    unchanged += 1;
    after.push(item);
    continue;
  }
  if (!moves.has(target)) moves.set(target, []);
  moves.get(target).push(item.id);
  after.push({ ...item, section: target });
}
const moveCount = [...moves.values()].reduce((n, ids) => n + ids.length, 0);

console.log(`Restaurant: ${restaurant.name}`);
console.log(`Configured sections: ${[...configured].join(" | ")}`);
console.log(`Items: ${items.length} · to move: ${moveCount} · already right: ${unchanged} · unplaceable: ${unplaceable}`);
printMatrix("Before (section: colour counts)", matrix(items));
printMatrix("After", matrix(after));

if (!CONFIRM) {
  console.log("\nDry run — nothing written. Pass --confirm to move them.");
  process.exit(0);
}

for (const [section, ids] of moves) {
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await db
      .from("inventory_items")
      .update({ section })
      .in("id", ids.slice(i, i + 200));
    if (error) throw error;
  }
  console.log(`  moved ${ids.length} → ${section}`);
}

const { data: check } = await db
  .from("inventory_items")
  .select("id, wine_id, section")
  .eq("restaurant_id", restaurant.id);
printMatrix("Verified (re-read)", matrix(check ?? []));
