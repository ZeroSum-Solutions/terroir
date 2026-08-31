/**
 * Load the X-Wines corpus and its label photographs into a LOCAL Supabase.
 *
 * The image plumbing has always worked — `wine-images` is a public bucket
 * (0130), `wines.hero_image_url` renders wherever a bottle is shown, and
 * wine-image-service.ts can upload. What never existed was a SUPPLY: the only
 * writers were "a human taps Add photo" and "a scan succeeded", so every one of
 * the 250 seeded wines had a null image and every thumbnail fell back.
 *
 * X-Wines (https://github.com/rogerioxavier/X-Wines, CC0-1.0, cite MDPI
 * BDCC 7(1):20) ships 100,646 real wines and 1,007 label photographs keyed by
 * WineID. The schema to hold it has been in place since 0131-0134 — catalog
 * table, canonical_wines link, trigram matcher — and was simply never seeded.
 *
 * This does three things:
 *   1. uploads every label JPEG to wine-images/xwines/<wine_id>.jpeg
 *   2. seeds xwines_catalog from the Slim distribution (the labelled subset)
 *   3. re-points the local demo restaurant's wines at real X-Wines wines that
 *      have a label, so the seeded cellar shows real bottles instead of
 *      "Aster House Burgundy Pinot Noir Lot 001", which has no photograph
 *      anywhere because it is not a wine.
 *
 * Step 3 is deliberately local-only. Against a real tenant the same labels are
 * attached the other way round — by matching existing wines into the corpus
 * with match_xwines (0134) — because their wines are real and must not be
 * overwritten.
 *
 * Usage:
 *   node scripts/local/seed-xwines-labels.mjs <slim_wines.csv> <labels_dir> [full_wines.csv]
 *   node scripts/local/seed-xwines-labels.mjs ... --confirm   # actually write
 *
 * Pass the Full 100K CSV as a third argument to seed the whole corpus into
 * xwines_catalog. Only the Slim subset has photographs, so the labelled rows
 * are the ones that get a hero image; the rest is reference breadth for
 * match_xwines (0134) to resolve scans and imports against.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";

const SUPABASE_URL = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:57321";
const SERVICE_KEY = process.env.LOCAL_SUPABASE_SERVICE_KEY;
const BUCKET = "wine-images";

const [csvPath, labelsDir, fullCsvPath] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"));
const CONFIRM = process.argv.includes("--confirm");

if (!csvPath || !labelsDir) {
  console.error("usage: seed-xwines-labels.mjs <slim_wines.csv> <labels_dir> [--confirm]");
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error("LOCAL_SUPABASE_SERVICE_KEY is required (from `npx supabase status`).");
  process.exit(1);
}

// Fails closed. `.env.local` holds production credentials and this script
// rewrites wine identities in place — it must never reach a real tenant.
const host = new URL(SUPABASE_URL).hostname;
if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
  console.error(`refusing to run against non-loopback host: ${host}`);
  process.exit(1);
}

/** X-Wines' six types are exactly Terroir's six colours. */
const COLOUR_BY_TYPE = {
  Red: "red",
  White: "white",
  Sparkling: "sparkling",
  "Rosé": "rose",
  Dessert: "dessert",
  "Dessert/Port": "fortified",
};

/** The CSV embeds Python list literals, e.g. "['Muscat/Moscato']". */
function parseList(raw) {
  if (!raw) return [];
  return [...raw.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}
function parseInts(raw) {
  if (!raw) return [];
  return [...raw.matchAll(/\d{4}/g)].map((m) => Number(m[0]));
}

/** Minimal RFC-4180 reader: the X-Wines CSV quotes fields containing commas. */
function readCsv(path) {
  const text = readFileSync(path, "utf8");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const wines = readCsv(csvPath);
const labelFiles = readdirSync(labelsDir).filter((f) => /\.jpe?g$/i.test(f));
const labelled = new Set(labelFiles.map((f) => basename(f).replace(/\.jpe?g$/i, "")));
const withLabel = wines.filter((w) => labelled.has(w.WineID));

const fullWines = fullCsvPath ? readCsv(fullCsvPath) : [];

console.log(`X-Wines rows:      ${wines.length}`);
if (fullCsvPath) console.log(`full corpus rows:  ${fullWines.length}`);
console.log(`label images:      ${labelFiles.length}`);
console.log(`wines with label:  ${withLabel.length}`);
console.log(`target:            ${SUPABASE_URL}`);
if (!CONFIRM) {
  console.log("\nDRY RUN — pass --confirm to write.");
  process.exit(0);
}

// ---------------------------------------------------------------- 1. images
let uploaded = 0, skipped = 0;
for (const w of withLabel) {
  const file = labelFiles.find((f) => f.replace(/\.jpe?g$/i, "") === w.WineID);
  const path = join(labelsDir, file);
  if (!existsSync(path)) { skipped++; continue; }
  const { error } = await db.storage
    .from(BUCKET)
    .upload(`xwines/${w.WineID}.jpeg`, readFileSync(path), {
      contentType: "image/jpeg",
      upsert: true,
    });
  if (error) { console.error(`  upload ${w.WineID}: ${error.message}`); skipped++; continue; }
  if (++uploaded % 100 === 0) console.log(`  uploaded ${uploaded}/${withLabel.length}`);
}
console.log(`images: ${uploaded} uploaded, ${skipped} skipped`);

const publicUrl = (id) =>
  db.storage.from(BUCKET).getPublicUrl(`xwines/${id}.jpeg`).data.publicUrl;

// --------------------------------------------------------------- 2. catalog
const catalogSource = fullWines.length ? fullWines : withLabel;
const catalogRows = catalogSource.map((w) => ({
  wine_id: Number(w.WineID),
  name: w.WineName,
  type: w.Type,
  elaborate: w.Elaborate || null,
  grapes: parseList(w.Grapes),
  harmonize: parseList(w.Harmonize),
  abv: w.ABV ? Number(w.ABV) : null,
  body: w.Body || null,
  acidity: w.Acidity || null,
  country_code: w.Code || null,
  country: w.Country || null,
  region_id: w.RegionID ? Number(w.RegionID) : null,
  region_name: w.RegionName || null,
  winery_id: w.WineryID ? Number(w.WineryID) : null,
  winery_name: w.WineryName || null,
  website: w.Website || null,
  vintages: parseInts(w.Vintages),
  has_non_vintage: /N\.?V\.?/i.test(w.Vintages ?? ""),
}));

for (let i = 0; i < catalogRows.length; i += 500) {
  const chunk = catalogRows.slice(i, i + 500);
  const { error } = await db.from("xwines_catalog").upsert(chunk, { onConflict: "wine_id" });
  if (error) { console.error(`catalog upsert: ${error.message}`); process.exit(1); }
  if ((i / 500) % 20 === 0) console.log(`  catalog ${i}/${catalogRows.length}`);
}
console.log(`catalog: ${catalogRows.length} rows upserted`);

// ----------------------------------------------------- 3. re-point demo wines
const { data: demoWines, error: readErr } = await db
  .from("wines")
  .select("id, name, producer, vintage, colour")
  .order("id");
if (readErr) { console.error(readErr.message); process.exit(1); }

// Deterministic pairing: sort both sides and walk them together, so re-running
// gives the same wine the same identity instead of reshuffling the cellar.
const pool = [...withLabel].sort((a, b) => Number(a.WineID) - Number(b.WineID));
let updated = 0;
for (const [i, wine] of demoWines.entries()) {
  const x = pool[i % pool.length];
  const vintages = parseInts(x.Vintages).filter((v) => v >= 1990 && v <= 2024);
  const patch = {
    name: x.WineName,
    producer: x.WineryName,
    vintage: vintages.length ? vintages[i % vintages.length] : wine.vintage,
    colour: COLOUR_BY_TYPE[x.Type] ?? wine.colour,
    region: x.RegionName || null,
    country: x.Country || null,
    varietal: parseList(x.Grapes).join(", ") || null,
    hero_image_url: publicUrl(x.WineID),
  };
  const { error } = await db.from("wines").update(patch).eq("id", wine.id);
  if (error) { console.error(`  wine ${wine.id}: ${error.message}`); continue; }
  updated++;
}
console.log(`wines: ${updated}/${demoWines.length} re-pointed at real wines with labels`);
