/**
 * Seed the lwin_catalog table from a LWIN CSV file.
 *
 * Usage:
 *   npx tsx scripts/seed-lwin.ts path/to/lwin.csv
 *
 * Expects a CSV with columns (order may vary):
 *   LWIN, Display Name, Producer/Négociant, Varietal, Region, Country, Colour, Type
 *
 * The script reads the CSV, parses it, and inserts rows in batches of 1000
 * using the Supabase service role key (from .env.local).
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
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
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: npx tsx scripts/seed-lwin.ts path/to/lwin.csv");
    process.exit(1);
  }

  console.log(`Reading LWIN CSV from: ${csvPath}`);

  const rl = createInterface({
    input: createReadStream(csvPath, "utf8"),
    crlfDelay: Infinity,
  });

  let headerParsed = false;
  let indices: Record<string, number> = {};
  let batch: LwinRow[] = [];
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
    batch.push({
      lwin_id: lwinId,
      display_name: displayName,
      producer: fields[indices.producer] || null,
      varietal: fields[indices.varietal] || null,
      region: fields[indices.region] || null,
      country: fields[indices.country] || null,
      colour: fields[indices.colour] || null,
      type: fields[indices.type] || null,
    });

    if (batch.length >= BATCH_SIZE) {
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
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const { error } = await supabase
      .from("lwin_catalog")
      .upsert(batch, { onConflict: "lwin_id" });

    if (error) {
      console.error("Error on final batch:", error.message);
    } else {
      inserted += batch.length;
    }
  }

  console.log(`\nDone. Inserted ${inserted} of ${total} rows into lwin_catalog.`);
}

main().catch(console.error);
