/**
 * Seed the lwin_catalog table from a LWIN CSV file.
 *
 * Usage:
 *   npx tsx scripts/seed-lwin.ts path/to/lwin.csv              # dry run (default)
 *   npx tsx scripts/seed-lwin.ts path/to/lwin.csv --confirm    # actually upsert
 *
 * Expects a CSV with columns (order may vary):
 *   LWIN, Display Name, Producer/Négociant, Varietal, Region, Country, Colour, Type
 *
 * Safeguards (BND-021 / INT-011):
 *   1. Dry run is the default. The script parses the CSV, prints a preview
 *      (row count + first 3 rows + target URL), and exits without touching
 *      the DB. Pass --confirm to actually upsert.
 *   2. Prod host block. Set `PROD_SUPABASE_URL_PATTERN` in env (or
 *      .env.local) to a substring that appears in your production
 *      Supabase URL (e.g. the project subdomain). If the active
 *      SUPABASE_URL contains that substring, the script refuses to run
 *      — even with --confirm — unless you also set ALLOW_PROD_SEED=yes.
 *      The block FAILS CLOSED: with no pattern configured the script
 *      cannot tell production from local, so --confirm is refused rather
 *      than assumed safe.
 *   3. Startup banner shows the target URL and that the service role
 *      key is in use, so the operator can eyeball before confirming.
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
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
const csvPath = args.find((a) => !a.startsWith("--"));

const isProdTarget =
  PROD_URL_PATTERN !== "" && SUPABASE_URL.includes(PROD_URL_PATTERN);

if (isProdTarget && !ALLOW_PROD_SEED) {
  console.error(
    `\nRefusing to run: SUPABASE_URL matches PROD_SUPABASE_URL_PATTERN (${PROD_URL_PATTERN}).`,
  );
  console.error(`Target URL: ${SUPABASE_URL}`);
  console.error("Set ALLOW_PROD_SEED=yes in your env to override.\n");
  process.exit(1);
}

// PROD_SUPABASE_URL_PATTERN being unset is not evidence that the target is
// safe — it is the absence of evidence, and this script's writes are
// destructive upserts over a table every restaurant reads. Dry runs stay open
// (they touch nothing); --confirm does not.
if (PROD_URL_PATTERN === "" && CONFIRM && !ALLOW_PROD_SEED) {
  console.error(
    "\nRefusing to run with --confirm: PROD_SUPABASE_URL_PATTERN is not set, so",
  );
  console.error("this script cannot tell whether the target is production.");
  console.error(`Target URL: ${SUPABASE_URL}`);
  console.error(
    "Set PROD_SUPABASE_URL_PATTERN in .env.local to a substring of your PRODUCTION",
  );
  console.error(
    "Supabase URL (see .env.example), or set ALLOW_PROD_SEED=yes to override.\n",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const BATCH_SIZE = 1000;

type LwinRow = {
  lwin_id: string;
  display_name: string;
  producer: string | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
  colour: string | null;
  type: string | null;
};

function parseHeaderIndices(header: string): Record<string, number> {
  const cols = header.split(",").map((c) => c.trim().toLowerCase().replace(/['"]/g, ""));
  const map: Record<string, number> = {};

  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    if (col.includes("lwin") && !col.includes("name")) map.lwin = i;
    else if (col.includes("display") || col === "name") map.display_name = i;
    else if (col.includes("producer") || col.includes("négociant")) map.producer = i;
    else if (col.includes("varietal") || col.includes("grape")) map.varietal = i;
    else if (col.includes("region")) map.region = i;
    else if (col.includes("country")) map.country = i;
    else if (col.includes("colour") || col.includes("color")) map.colour = i;
    else if (col.includes("type")) map.type = i;
  }

  return map;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

async function main() {
  if (!csvPath) {
    console.error("Usage: npx tsx scripts/seed-lwin.ts path/to/lwin.csv [--confirm]");
    process.exit(1);
  }

  console.log("");
  console.log(`  Target:     ${SUPABASE_URL}`);
  console.log(`  Auth:       service_role key`);
  console.log(`  Mode:       ${CONFIRM ? "LIVE (--confirm)" : "DRY RUN (default)"}`);
  console.log(`  CSV:        ${csvPath}`);
  console.log("");

  const rl = createInterface({
    input: createReadStream(csvPath, "utf8"),
    crlfDelay: Infinity,
  });

  let headerParsed = false;
  let indices: Record<string, number> = {};
  let batch: LwinRow[] = [];
  const sample: LwinRow[] = [];
  let total = 0;
  let inserted = 0;

  for await (const line of rl) {
    if (!headerParsed) {
      indices = parseHeaderIndices(line);
      headerParsed = true;

      if (indices.lwin == null || indices.display_name == null) {
        console.error("Could not find LWIN and Display Name columns in header.");
        console.error("Header:", line);
        process.exit(1);
      }
      continue;
    }

    const fields = parseCsvLine(line);
    const lwinId = fields[indices.lwin];
    const displayName = fields[indices.display_name];

    if (!lwinId || !displayName) continue;

    total++;
    const row: LwinRow = {
      lwin_id: lwinId,
      display_name: displayName,
      producer: fields[indices.producer] || null,
      varietal: fields[indices.varietal] || null,
      region: fields[indices.region] || null,
      country: fields[indices.country] || null,
      colour: fields[indices.colour] || null,
      type: fields[indices.type] || null,
    };
    if (sample.length < 3) sample.push(row);
    batch.push(row);

    if (CONFIRM && batch.length >= BATCH_SIZE) {
      const { error } = await supabase
        .from("lwin_catalog")
        .upsert(batch, { onConflict: "lwin_id" });

      if (error) {
        console.error(`Error at row ${total}:`, error.message);
      } else {
        inserted += batch.length;
        process.stdout.write(`\r  Inserted ${inserted} / ${total} rows...`);
      }
      batch = [];
    } else if (!CONFIRM && batch.length >= BATCH_SIZE) {
      // Dry run — drop the batch without writing. We still want to count.
      batch = [];
    }
  }

  if (CONFIRM && batch.length > 0) {
    const { error } = await supabase
      .from("lwin_catalog")
      .upsert(batch, { onConflict: "lwin_id" });

    if (error) {
      console.error("Error on final batch:", error.message);
    } else {
      inserted += batch.length;
    }
  }

  if (!CONFIRM) {
    console.log(`Parsed ${total} rows. First 3:`);
    for (const r of sample) console.log("  ", r);
    console.log(`\nDRY RUN — no writes. Pass --confirm to execute.`);
  } else {
    console.log(`\nDone. Inserted ${inserted} of ${total} rows into lwin_catalog.`);
  }
}

main().catch(console.error);
