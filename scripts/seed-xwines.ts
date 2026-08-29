/**
 * Seed xwines_catalog and xwines_vintage_ratings from the X-Wines Full
 * distribution (CC0-1.0).
 *
 * Usage:
 *   npx tsx scripts/seed-xwines.ts <wines.csv> <ratings.csv>            # dry run (default)
 *   npx tsx scripts/seed-xwines.ts <wines.csv> <ratings.csv> --confirm  # actually upsert
 *
 * Expects the distribution's own files, unmodified:
 *   XWines_Full_100K_wines.csv   WineID,WineName,Type,Elaborate,Grapes,Harmonize,
 *                                ABV,Body,Acidity,Code,Country,RegionID,RegionName,
 *                                WineryID,WineryName,Website,Vintages
 *   XWines_Full_21M_ratings.csv  RatingID,UserID,WineID,Vintage,Rating,Date
 *
 * The ratings file is aggregated HERE rather than imported: 21,013,536 rows
 * would dwarf every other table in this database, and nothing in the product
 * reads an individual stranger's rating. One streaming pass reduces it to a
 * per-wine average/count and a per-(wine, vintage) average/count, which are the
 * two grains 0131 stores. Re-running the script recomputes them from source, so
 * no intermediate artefact has to be trusted or kept.
 *
 * Safeguards mirror scripts/seed-lwin.ts (BND-021 / INT-011):
 *   1. Dry run is the default — parses, aggregates, prints a preview, exits
 *      without touching the DB. Pass --confirm to upsert.
 *   2. Prod host block via PROD_SUPABASE_URL_PATTERN, overridable only with
 *      ALLOW_PROD_SEED=yes.
 *   3. Startup banner names the target URL before anything is written.
 */

import { createReadStream } from "fs";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PROD_URL_PATTERN = process.env.PROD_SUPABASE_URL_PATTERN ?? "";
const ALLOW_PROD_SEED = process.env.ALLOW_PROD_SEED === "yes";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const positional = args.filter((a) => !a.startsWith("--"));
const winesPath = positional[0];
const ratingsPath = positional[1];

if (!winesPath || !ratingsPath) {
  console.error("Usage: seed-xwines.ts <wines.csv> <ratings.csv> [--confirm]");
  process.exit(1);
}

if (PROD_URL_PATTERN !== "" && SUPABASE_URL.includes(PROD_URL_PATTERN) && !ALLOW_PROD_SEED) {
  console.error(
    `\nRefusing to run: SUPABASE_URL matches PROD_SUPABASE_URL_PATTERN (${PROD_URL_PATTERN}).`,
  );
  console.error(`Target URL: ${SUPABASE_URL}`);
  console.error("Set ALLOW_PROD_SEED=yes in your env to override.\n");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const BATCH_SIZE = 1000;

// ── CSV ────────────────────────────────────────────────────────────────────
// Character-level so quoted fields containing commas survive: the corpus stores
// list columns as `"['Pork', 'Rich Fish']"`, which a split(",") would shred.
// Streaming because the ratings file is ~1.1 GB and will not fit in a string.

async function* csvRecords(path: string): AsyncGenerator<string[]> {
  const stream = createReadStream(path, { encoding: "utf8" });
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let quoteJustClosed = false;

  for await (const chunk of stream) {
    for (const ch of chunk as string) {
      if (inQuotes) {
        if (ch === '"') {
          inQuotes = false;
          quoteJustClosed = true;
        } else {
          field += ch;
        }
        continue;
      }
      if (quoteJustClosed && ch === '"') {
        // Escaped quote inside a quoted field ("" → ").
        field += '"';
        inQuotes = true;
        quoteJustClosed = false;
        continue;
      }
      quoteJustClosed = false;
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        record.push(field);
        field = "";
      } else if (ch === "\n") {
        record.push(field.endsWith("\r") ? field.slice(0, -1) : field);
        yield record;
        record = [];
        field = "";
      } else {
        field += ch;
      }
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    yield record;
  }
}

/** Parse the corpus's Python-style list literals: `['a', 'b']`, `[2020, 2019]`. */
function parseListLiteral(raw: string): string[] {
  const body = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (body.trim() === "") return [];
  return body
    .split(",")
    .map((item) => item.trim().replace(/^['"]/, "").replace(/['"]$/, "").trim())
    .filter((item) => item !== "");
}

function nullIfBlank(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function numberOrNull(value: string | undefined): number | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// ── Pass 1: aggregate ratings ──────────────────────────────────────────────

type Aggregates = {
  wineCount: Map<number, number>;
  wineSum: Map<number, number>;
  vintageCount: Map<number, number>;
  vintageSum: Map<number, number>;
  rowsRead: number;
  rowsSkipped: number;
};

// One numeric key per (wine, vintage) keeps a million-entry Map compact.
// Vintages in the corpus are 4-digit years; non-numeric ones (the literal
// 'N.V.') are skipped rather than folded into a year bucket.
const vintageKey = (wineId: number, vintage: number) => wineId * 10000 + vintage;

async function aggregateRatings(path: string): Promise<Aggregates> {
  const agg: Aggregates = {
    wineCount: new Map(),
    wineSum: new Map(),
    vintageCount: new Map(),
    vintageSum: new Map(),
    rowsRead: 0,
    rowsSkipped: 0,
  };

  let header: string[] | null = null;
  let iWine = -1;
  let iVintage = -1;
  let iRating = -1;

  for await (const record of csvRecords(path)) {
    if (header === null) {
      header = record.map((c) => c.trim());
      iWine = header.indexOf("WineID");
      iVintage = header.indexOf("Vintage");
      iRating = header.indexOf("Rating");
      if (iWine < 0 || iVintage < 0 || iRating < 0) {
        throw new Error(
          `Ratings CSV missing required columns (WineID, Vintage, Rating); saw: ${header.join(", ")}`,
        );
      }
      continue;
    }
    if (record.length === 1 && record[0].trim() === "") continue;

    agg.rowsRead += 1;
    const wineId = Number(record[iWine]);
    const rating = Number(record[iRating]);
    if (!Number.isInteger(wineId) || !Number.isFinite(rating)) {
      agg.rowsSkipped += 1;
      continue;
    }

    agg.wineCount.set(wineId, (agg.wineCount.get(wineId) ?? 0) + 1);
    agg.wineSum.set(wineId, (agg.wineSum.get(wineId) ?? 0) + rating);

    const vintage = Number((record[iVintage] ?? "").trim());
    if (Number.isInteger(vintage) && vintage > 0) {
      const key = vintageKey(wineId, vintage);
      agg.vintageCount.set(key, (agg.vintageCount.get(key) ?? 0) + 1);
      agg.vintageSum.set(key, (agg.vintageSum.get(key) ?? 0) + rating);
    }

    if (agg.rowsRead % 2_000_000 === 0) {
      console.log(`  …${agg.rowsRead.toLocaleString()} ratings read`);
    }
  }

  return agg;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

// ── Pass 2: build catalog rows ─────────────────────────────────────────────

type CatalogRow = {
  wine_id: number;
  name: string;
  type: string | null;
  elaborate: string | null;
  grapes: string[];
  harmonize: string[];
  abv: number | null;
  body: string | null;
  acidity: string | null;
  country_code: string | null;
  country: string | null;
  region_id: number | null;
  region_name: string | null;
  winery_id: number | null;
  winery_name: string | null;
  website: string | null;
  vintages: number[];
  has_non_vintage: boolean;
  rating_avg: number | null;
  rating_count: number;
};

async function buildCatalog(path: string, agg: Aggregates): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];
  let header: string[] | null = null;
  let index: Record<string, number> = {};

  for await (const record of csvRecords(path)) {
    if (header === null) {
      header = record.map((c) => c.trim());
      index = Object.fromEntries(header.map((name, i) => [name, i]));
      for (const required of ["WineID", "WineName"]) {
        if (!(required in index)) {
          throw new Error(`Wines CSV missing required column ${required}`);
        }
      }
      continue;
    }
    if (record.length === 1 && record[0].trim() === "") continue;

    const wineId = Number(record[index.WineID]);
    if (!Number.isInteger(wineId)) continue;

    const vintageTokens = parseListLiteral(record[index.Vintages] ?? "");
    const vintages = vintageTokens
      .map((token) => Number(token))
      .filter((year) => Number.isInteger(year) && year > 0);
    const hasNonVintage = vintageTokens.some((token) => !Number.isInteger(Number(token)));

    const count = agg.wineCount.get(wineId) ?? 0;
    const sum = agg.wineSum.get(wineId) ?? 0;

    rows.push({
      wine_id: wineId,
      name: (record[index.WineName] ?? "").trim(),
      type: nullIfBlank(record[index.Type]),
      elaborate: nullIfBlank(record[index.Elaborate]),
      grapes: parseListLiteral(record[index.Grapes] ?? ""),
      harmonize: parseListLiteral(record[index.Harmonize] ?? ""),
      abv: numberOrNull(record[index.ABV]),
      body: nullIfBlank(record[index.Body]),
      acidity: nullIfBlank(record[index.Acidity]),
      country_code: nullIfBlank(record[index.Code]),
      country: nullIfBlank(record[index.Country]),
      region_id: numberOrNull(record[index.RegionID]),
      region_name: nullIfBlank(record[index.RegionName]),
      winery_id: numberOrNull(record[index.WineryID]),
      winery_name: nullIfBlank(record[index.WineryName]),
      website: nullIfBlank(record[index.Website]),
      vintages,
      has_non_vintage: hasNonVintage,
      rating_avg: count > 0 ? round3(sum / count) : null,
      rating_count: count,
    });
  }

  return rows;
}

function buildVintageRatings(agg: Aggregates, knownWineIds: Set<number>) {
  const rows: Array<{
    wine_id: number;
    vintage: number;
    rating_avg: number;
    rating_count: number;
  }> = [];
  for (const [key, count] of agg.vintageCount) {
    const wineId = Math.floor(key / 10000);
    // A rating referencing a wine absent from the catalog would violate 0131's
    // foreign key; drop it here rather than failing the batch it lands in.
    if (!knownWineIds.has(wineId)) continue;
    rows.push({
      wine_id: wineId,
      vintage: key % 10000,
      rating_avg: round3((agg.vintageSum.get(key) ?? 0) / count),
      rating_count: count,
    });
  }
  return rows;
}

// ── Upsert ─────────────────────────────────────────────────────────────────

async function upsertAll<T>(table: string, rows: T[], onConflict: string) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) {
      console.error(`\n${table}: batch at row ${i} failed — ${error.message}`);
      process.exit(1);
    }
    const done = Math.min(i + BATCH_SIZE, rows.length);
    if (done % 20000 === 0 || done === rows.length) {
      console.log(`  ${table}: ${done.toLocaleString()} / ${rows.length.toLocaleString()}`);
    }
  }
}

async function main() {
  console.log(`\nTarget: ${SUPABASE_URL}`);
  console.log(`Mode:   ${CONFIRM ? "CONFIRM (will write)" : "dry run"}\n`);

  console.log(`Aggregating ratings from ${ratingsPath} …`);
  const agg = await aggregateRatings(ratingsPath);
  console.log(
    `  ${agg.rowsRead.toLocaleString()} ratings read` +
      (agg.rowsSkipped > 0 ? `, ${agg.rowsSkipped.toLocaleString()} unparseable and skipped` : "") +
      `, over ${agg.wineCount.size.toLocaleString()} wines\n`,
  );

  console.log(`Reading catalog from ${winesPath} …`);
  const catalog = await buildCatalog(winesPath, agg);
  const knownWineIds = new Set(catalog.map((row) => row.wine_id));
  const vintageRatings = buildVintageRatings(agg, knownWineIds);
  const orphaned = agg.vintageCount.size - vintageRatings.length;

  console.log(`  ${catalog.length.toLocaleString()} catalog rows`);
  console.log(
    `  ${vintageRatings.length.toLocaleString()} (wine, vintage) rating rows` +
      (orphaned > 0 ? `, ${orphaned.toLocaleString()} dropped for referencing an unknown wine` : ""),
  );
  const rated = catalog.filter((row) => row.rating_count > 0).length;
  console.log(`  ${rated.toLocaleString()} catalog rows carry a rating\n`);

  console.log("First 3 catalog rows:");
  for (const row of catalog.slice(0, 3)) {
    console.log(
      `  ${row.wine_id}  ${row.winery_name} — ${row.name} (${row.type}, ${row.body}, ` +
        `acidity ${row.acidity}, ABV ${row.abv}) ★${row.rating_avg} of ${row.rating_count}`,
    );
  }

  if (!CONFIRM) {
    console.log("\nDry run — nothing written. Pass --confirm to upsert.\n");
    return;
  }

  console.log("\nUpserting …");
  await upsertAll("xwines_catalog", catalog, "wine_id");
  await upsertAll("xwines_vintage_ratings", vintageRatings, "wine_id,vintage");
  console.log("\nDone.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
