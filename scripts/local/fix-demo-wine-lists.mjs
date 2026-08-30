#!/usr/bin/env node
/**
 * scripts/local/fix-demo-wine-lists.mjs
 *
 * Make the public menu survive being read by someone who knows wine.
 *
 * Three faults, all of them on the customer-facing page (`/list/[slug]` and
 * its print view), which is the surface a restaurant actually shows guests.
 *
 * ── 1. SECTIONS CONTRADICT THEIR CONTENTS ────────────────────────────────
 *
 * The seeder dealt wines into sections round-robin, so section membership is
 * uncorrelated with colour. "Whites" holds 17 reds and 9 whites; "Rose" holds
 * 16 reds and 4 rosés; "Sparkling" lists a Cabernet Sauvignon. A sommelier
 * sees this in one glance, and an investor demo is exactly where that glance
 * happens.
 *
 * Items are MOVED to the section that matches their wine's colour, rather
 * than the wines being swapped to match the section. Swapping was the first
 * instinct because it preserves the tidy 30-per-section shape, but the cellar
 * cannot support it: the Full Bottle List has a 30-slot Rose section and the
 * whole cellar holds 16 rosés. Forcing it would mean either duplicating rosés
 * or filing non-rosés under Rose again, which is the bug.
 *
 * So the sections come out UNEVEN — many reds, few rosés — and that is
 * correct. Real wine lists look like that.
 *
 * Where a list has no section for a colour it holds (Draft Pairings carries
 * only Sparkling/Whites/Rose; Archived Spring List has no New World or
 * dessert section), the item cannot be moved anywhere honest, so its WINE is
 * swapped for one whose colour the list can actually place — never leaving an
 * item filed under a section that misdescribes it.
 *
 * ── 2. DEVELOPER PLACEHOLDER TEXT IS PUBLISHED TO GUESTS ─────────────────
 *
 * 29 items carry the tasting note "Local fixture note for public menu and
 * print rendering." and 21 carry the blurb "Sanitized menu blurb for
 * editor/public state." Both render verbatim on the published menu.
 *
 * They are replaced with a short line composed from that wine's own
 * xwines_catalog row — grape and pairing — on the same rule as the cellar's
 * tasting notes: corpus data rendered into a sentence, never an invented
 * flavour for a real, named, findable wine.
 *
 * ── 3. THE MENU HAS NO LOGO ──────────────────────────────────────────────
 *
 * `restaurants.logo_url` is NULL, so the public menu renders unbranded. A
 * logo does exist — the brand kit has one — but the public page reads the
 * restaurant column, not the brand kit. Pointing the column at the brand
 * kit's asset is a data fix; making the page fall back to the brand kit would
 * be a code change and is left alone.
 *
 * Also refreshes the 10 seeded invitations, which had all expired (Jun-Jul
 * 2026, and it is now August) so /invite/[token] correctly returned an opaque
 * 404 and could not be demonstrated at all.
 *
 * Usage:
 *   node scripts/local/fix-demo-wine-lists.mjs
 *   node scripts/local/fix-demo-wine-lists.mjs --confirm
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

/** Old World / New World, for splitting reds across the two red sections. */
const OLD_WORLD = new Set([
  "France", "Italy", "Spain", "Portugal", "Germany", "Austria", "Greece",
  "Hungary", "Switzerland", "Croatia", "Slovenia", "Romania", "Bulgaria",
  "Georgia", "Moldova", "Israel", "Lebanon", "Turkey", "Czech Republic",
]);

/** Which section name should hold a wine of this colour. */
function sectionNameFor(wine) {
  switch (wine.colour) {
    case "sparkling": return ["Sparkling"];
    case "white":     return ["Whites"];
    case "rose":      return ["Rose"];
    case "dessert":
    case "fortified": return ["Dessert & Fortified"];
    case "red":
    default:
      return OLD_WORLD.has(wine.country ?? "")
        ? ["Reds - Old World", "Reds - New World"]
        : ["Reds - New World", "Reds - Old World"];
  }
}

const { data: lists } = await db
  .from("wine_lists")
  .select("id, name, is_published, wine_list_sections(id, name, position)");
const { data: items } = await db
  .from("wine_list_items")
  .select("id, section_id, wine_id, position, tasting_note, blurb");
const { data: wines } = await db
  .from("wines")
  .select("id, name, producer, colour, country, canonical_wines(xwines_wine_id)");

const wineById = new Map(wines.map((w) => [w.id, w]));
const sectionById = new Map();
const sectionsByList = new Map();
for (const l of lists) {
  const secs = l.wine_list_sections ?? [];
  sectionsByList.set(l.id, secs);
  for (const s of secs) sectionById.set(s.id, { ...s, listId: l.id, listName: l.name });
}

// ---------------------------------------------------------------- 1. sections
const moves = [];
const swaps = [];
const usedInList = new Map(); // listId -> Set(wine_id), to avoid duplicating a wine on one list
for (const it of items) {
  const sec = sectionById.get(it.section_id);
  const wine = wineById.get(it.wine_id);
  if (!sec || !wine) continue;
  const set = usedInList.get(sec.listId) ?? new Set();
  set.add(it.wine_id);
  usedInList.set(sec.listId, set);
}

for (const it of items) {
  const sec = sectionById.get(it.section_id);
  const wine = wineById.get(it.wine_id);
  if (!sec || !wine) continue;

  const wanted = sectionNameFor(wine);
  const listSections = sectionsByList.get(sec.listId) ?? [];
  const target = wanted
    .map((n) => listSections.find((s) => s.name === n))
    .find(Boolean);

  if (target) {
    if (target.id !== it.section_id) moves.push({ id: it.id, section_id: target.id });
    continue;
  }

  // This list has no honest home for that colour — swap the wine instead.
  const placeable = wines.find((w) => {
    if (usedInList.get(sec.listId)?.has(w.id)) return false;
    return sectionNameFor(w).some((n) => listSections.some((s) => s.name === n && s.id === it.section_id));
  });
  if (placeable) {
    swaps.push({ id: it.id, wine_id: placeable.id, from: `${wine.producer} ${wine.name}`, to: `${placeable.producer} ${placeable.name}` });
    usedInList.get(sec.listId)?.add(placeable.id);
  }
}

// --------------------------------------------------------------- 2. menu prose
const catalogIds = wines.map((w) => w.canonical_wines?.xwines_wine_id).filter((v) => v != null);
const { data: catalog } = await db
  .from("xwines_catalog")
  .select("wine_id, grapes, harmonize, region_name, country")
  .in("wine_id", catalogIds);
const catById = new Map((catalog ?? []).map((c) => [c.wine_id, c]));

const isPlaceholder = (s) =>
  typeof s === "string" && (s.includes("fixture") || s.includes("Sanitized"));

function menuLine(wine) {
  const c = catById.get(wine.canonical_wines?.xwines_wine_id);
  if (!c) return null;
  const grape = (c.grapes ?? [])[0];
  const origin = [c.region_name, c.country].filter(Boolean).join(", ");
  const pairing = (c.harmonize ?? [])[0]?.toLowerCase();
  const parts = [];
  if (grape) parts.push(grape);
  if (origin) parts.push(origin);
  const head = parts.join(" · ");
  return pairing ? `${head}. Good with ${pairing}.` : head || null;
}

const proseFixes = [];
for (const it of items) {
  const wine = wineById.get(it.wine_id);
  if (!wine) continue;
  const patch = {};
  if (isPlaceholder(it.tasting_note)) patch.tasting_note = menuLine(wine);
  if (isPlaceholder(it.blurb)) patch.blurb = menuLine(wine);
  if (Object.keys(patch).length) proseFixes.push({ id: it.id, patch });
}

console.log(`\nsection moves:      ${moves.length}`);
console.log(`wine swaps:         ${swaps.length}  (lists with no section for that colour)`);
console.log(`placeholder prose:  ${proseFixes.length}`);
for (const s of swaps.slice(0, 3)) console.log(`  swap: ${s.from}  ->  ${s.to}`);

if (!CONFIRM) {
  console.log("\nDRY RUN — pass --confirm to write.");
  process.exit(0);
}

let n = 0;
for (const m of moves) {
  const { error } = await db.from("wine_list_items").update({ section_id: m.section_id }).eq("id", m.id);
  if (!error) n++;
}
console.log(`moved:   ${n}/${moves.length}`);

let s = 0;
for (const sw of swaps) {
  const { error } = await db.from("wine_list_items").update({ wine_id: sw.wine_id }).eq("id", sw.id);
  if (!error) s++;
}
console.log(`swapped: ${s}/${swaps.length}`);

let p = 0;
for (const f of proseFixes) {
  const { error } = await db.from("wine_list_items").update(f.patch).eq("id", f.id);
  if (!error) p++;
}
console.log(`prose:   ${p}/${proseFixes.length}`);

// ------------------------------------------------------------------- 3. logo
const { data: kit } = await db
  .from("brand_kits")
  .select("restaurant_id, logo_url")
  .not("logo_url", "is", null)
  .limit(1)
  .maybeSingle();
if (kit?.logo_url) {
  const { error } = await db
    .from("restaurants")
    .update({ logo_url: kit.logo_url })
    .eq("id", kit.restaurant_id);
  console.log(error ? `logo: ${error.message}` : "logo:    set on restaurant from brand kit");
}

// ------------------------------------------------------------- 3b. invitations
const future = new Date(Date.now() + 21 * 864e5).toISOString();
const { data: refreshed, error: invErr } = await db
  .from("invitations")
  .update({ expires_at: future })
  .lt("expires_at", new Date().toISOString())
  .is("accepted_at", null)
  .select("id");
console.log(invErr ? `invites: ${invErr.message}` : `invites: ${refreshed?.length ?? 0} refreshed to ${future.slice(0, 10)}`);
