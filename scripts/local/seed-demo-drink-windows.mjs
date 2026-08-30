#!/usr/bin/env node
/**
 * scripts/local/seed-demo-drink-windows.mjs
 *
 * Give each demo wine a vintage it plausibly still has in the cellar, and a
 * drinking window its style actually implies.
 *
 * ── WHAT BROKE ───────────────────────────────────────────────────────────
 *
 * The original seeder derived every window arithmetically from the vintage it
 * had invented: start = vintage+2, peak = vintage+6, end = vintage+12.
 * seed-xwines-labels.mjs then re-pointed all 250 wines at real X-Wines
 * bottlings and took a real vintage from each one's actual vintage list — and
 * wrote `vintage` WITHOUT touching the three columns derived from it. Only 8
 * of 250 windows still matched their own vintage afterwards.
 *
 * The visible result: 205 of 250 wines past peak and 151 past their window
 * entirely, so /cellar renders a sea of red badges and /insights leads with
 * "WINDOW CLOSING — window ends 2010". A cellar that is 82% dead stock is not
 * a product demo, it is a bug report.
 *
 * ── WHY THE VINTAGE MOVES TOO, AND WHY THAT IS NOT CHEATING ──────────────
 *
 * Recomputing the windows alone does not fix it. The labels seeder picked
 * each vintage by position (`vintages[i % vintages.length]`, filtered to
 * 1990-2024), which is uniform across the wine's history and independent of
 * whether the wine keeps. That is how the cellar ended up holding a 1990
 * Vinho Verde — a wine made to drink inside two years. Under ANY correct
 * window formula that bottle is dead, because it should never have been on
 * the list.
 *
 * So the vintage is re-picked FROM THE SAME SOURCE — the corpus's own
 * `vintages` array for that exact wine, never a year the producer did not
 * make — choosing among them the one that lands the bottle in a sensible
 * place today. Nothing is invented; a real cellar's buyer makes exactly this
 * choice, and the previous code made it by array index.
 *
 * ── THE SPREAD IS PART DELIBERATE, PART STRUCTURAL ───────────────────────
 *
 * Not every wine is put at peak. /insights exists to surface wines that need
 * attention, and a cellar where nothing needs any would render an empty
 * product. Buckets are assigned deterministically by wine_id, so a wine keeps
 * its story across runs and the demo can be rehearsed.
 *
 * The achieved result is ~78% in window, ~22% past, ~0% young, and the gap
 * between that and the buckets is worth knowing rather than tuning away:
 *
 *   Almost nothing can be YOUNG. The corpus's vintage lists mostly stop
 *   around 2021 and it is now 2026, so for a wine to be pre-window today it
 *   needs an ageing potential over about 25 years — only ports and a handful
 *   of very full-bodied reds qualify.
 *
 *   About 17% are past NO MATTER WHAT is chosen. A light white or rosé with
 *   a 3-year window whose newest vintage is 2020 is past in 2026 from every
 *   vintage the producer made. Only ~5% of the past pile is chosen; the rest
 *   is the corpus meeting the calendar, and forcing those bottles in-window
 *   would mean inventing vintages that do not exist.
 *
 * ── AGEING POTENTIAL COMES FROM THE CORPUS ───────────────────────────────
 *
 * Not from taste. Type and body are the two attributes the corpus actually
 * carries that bear on how long a wine keeps, and the bands below are the
 * ordinary trade ranges for them. Rating nudges within a band rather than
 * across one: quality does correlate with ageing, but a highly-rated Vinho
 * Verde is still a wine to drink young.
 *
 * NOTE: cellar_health and pricing_recommendations are COMPUTED from these
 * columns. Re-run them after this:
 *   pnpm exec tsx scripts/seed-local-operational.ts --confirm
 *
 * Usage:
 *   node scripts/local/seed-demo-drink-windows.mjs
 *   node scripts/local/seed-demo-drink-windows.mjs --confirm
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
const THIS_YEAR = new Date().getUTCFullYear();

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

/**
 * Years from vintage to the END of the drinking window, by type and body.
 * Ordinary trade ranges, not a model.
 */
function ageingPotential(type, body, ratingAvg) {
  const full = body === "Full-bodied" || body === "Very full-bodied";
  const light = body === "Light-bodied" || body === "Very light-bodied";

  let years;
  switch (type) {
    case "Sparkling":
      years = full ? 12 : 6;
      break;
    case "White":
      years = full ? 10 : light ? 3 : 6;
      break;
    case "Rosé":
      years = 3;
      break;
    case "Dessert":
      years = 20;
      break;
    case "Dessert/Port":
      years = 30;
      break;
    case "Red":
    default:
      years = full ? 18 : light ? 6 : 11;
      break;
  }

  // Quality nudges WITHIN the band, never across it: +/-25% at the extremes
  // of the corpus's 1-5 scale. A great Vinho Verde is still drunk young.
  if (ratingAvg != null) {
    const r = Number(ratingAvg);
    years = Math.round(years * (1 + (r - 3.7) * 0.15));
  }
  return Math.max(2, years);
}

/** Deterministic per-wine bucket, stable across runs. */
function bucketFor(wineId) {
  const n = wineId % 20;
  if (n < 17) return "in";     // drinking well now
  if (n < 19) return "young";  // not ready yet, where a vintage allows it
  return "past";               // deliberately over the hill
}

/**
 * Choose, from the vintages this wine actually has, the one that puts it in
 * the intended state today. Falls back to the closest available year rather
 * than inventing one.
 */
function stateFor(vintage, potential) {
  const start = vintage + Math.max(1, Math.round(potential * 0.2));
  const end = vintage + potential;
  return THIS_YEAR < start ? "young" : THIS_YEAR > end ? "past" : "in";
}

function chooseVintage(vintages, potential, bucket) {
  const usable = (vintages ?? [])
    .filter((v) => Number.isFinite(v) && v >= 1900 && v <= THIS_YEAR)
    .sort((a, b) => a - b);
  if (usable.length === 0) return null;

  // Score by the state each candidate actually PRODUCES rather than by
  // distance to an ideal year. Picking the year closest to a target age
  // silently misses when the producer skipped it — and because most corpus
  // vintage lists stop around 2021, "closest" for a young target lands years
  // short and the wine comes out mid-window anyway.
  const matching = usable.filter((v) => stateFor(v, potential) === bucket);
  if (matching.length > 0) {
    // Newest match for "in"/"young" (a cellar buys the current drinking
    // vintage); oldest for "past", which is what dead stock looks like.
    return bucket === "past" ? matching[0] : matching[matching.length - 1];
  }

  // No vintage can produce the intended state — usually "young", because the
  // corpus's coverage ends years before today. Prefer landing in-window over
  // landing past: a wine that cannot be shown young should not become dead
  // stock as a consolation.
  const inWindow = usable.filter((v) => stateFor(v, potential) === "in");
  if (inWindow.length > 0) return inWindow[inWindow.length - 1];
  return usable[usable.length - 1];
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const { data: wines, error } = await db
  .from("wines")
  .select("id, name, producer, vintage, wine_variant_id, canonical_wines(xwines_wine_id)")
  .order("id");
if (error) {
  console.error(error.message);
  process.exit(1);
}

const ids = wines.map((w) => w.canonical_wines?.xwines_wine_id).filter((v) => v != null);
const { data: catalog, error: catErr } = await db
  .from("xwines_catalog")
  .select("wine_id, type, body, vintages, rating_avg")
  .in("wine_id", ids);
if (catErr) {
  console.error(catErr.message);
  process.exit(1);
}
const byId = new Map(catalog.map((c) => [c.wine_id, c]));

const plan = [];
for (const w of wines) {
  const c = byId.get(w.canonical_wines?.xwines_wine_id);
  if (!c) continue;

  const potential = ageingPotential(c.type, c.body, c.rating_avg);
  const bucket = bucketFor(c.wine_id);
  const vintage = chooseVintage(c.vintages, potential, bucket) ?? w.vintage;
  if (vintage == null) continue;

  const start = vintage + Math.max(1, Math.round(potential * 0.2));
  const peak = vintage + Math.max(2, Math.round(potential * 0.55));
  const end = vintage + potential;

  plan.push({
    id: w.id,
    wine_variant_id: w.wine_variant_id,
    label: `${w.producer} ${w.name}`,
    bucket,
    vintage,
    drink_window_start: start,
    peak_year: peak,
    drink_window_end: end,
    state: THIS_YEAR < start ? "young" : THIS_YEAR > end ? "past" : "in window",
  });
}

const tally = plan.reduce((acc, p) => ({ ...acc, [p.state]: (acc[p.state] ?? 0) + 1 }), {});
console.log(`\nwines planned: ${plan.length}`);
console.log(`resulting spread (today = ${THIS_YEAR}):`);
for (const [k, v] of Object.entries(tally)) {
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(3)}  (${Math.round((v / plan.length) * 100)}%)`);
}
console.log("\nsamples:");
for (const p of plan.slice(0, 4)) {
  console.log(`  ${p.label}`);
  console.log(`    ${p.vintage} · window ${p.drink_window_start}-${p.drink_window_end} · peak ${p.peak_year} · ${p.state}`);
}

if (!CONFIRM) {
  console.log("\nDRY RUN — pass --confirm to write.");
  process.exit(0);
}

let written = 0;
for (const p of plan) {
  const { error: upErr } = await db
    .from("wines")
    .update({
      vintage: p.vintage,
      drink_window_start: p.drink_window_start,
      peak_year: p.peak_year,
      drink_window_end: p.drink_window_end,
    })
    .eq("id", p.id);
  if (upErr) {
    console.error(`  ${p.id}: ${upErr.message}`);
    continue;
  }
  written++;
}

// wine_variants carries the vintage too — it is the (canonical wine, vintage,
// size) grain identity resolution reads — so leaving it behind would recreate
// exactly the drift this script exists to repair, one table over.
let variants = 0;
for (const p of plan) {
  if (p.wine_variant_id == null) continue;
  const { error: vErr } = await db
    .from("wine_variants")
    .update({ vintage: p.vintage })
    .eq("id", p.wine_variant_id);
  if (vErr) {
    console.error(`  variant ${p.wine_variant_id}: ${vErr.message}`);
    continue;
  }
  variants++;
}

console.log(`\nwines updated:    ${written}/${plan.length}`);
console.log(`variants updated: ${variants}/${plan.length}`);
console.log("now re-run: pnpm exec tsx scripts/seed-local-operational.ts --confirm");
