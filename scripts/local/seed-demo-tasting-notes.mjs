#!/usr/bin/env node
/**
 * scripts/local/seed-demo-tasting-notes.mjs
 *
 * Replace the demo cellar's placeholder prose with notes that describe the
 * actual bottle.
 *
 * The seeded cellar shipped two literal strings, repeated across every wine:
 *
 *   tasting_notes   "Sanitized tasting note: citrus, mineral, red fruit,
 *                    spice, and a clean finish."
 *   review_excerpt  "Structured local fixture with enough metadata for
 *                    enrichment, pricing, and drawer states."
 *
 * They were honest fixtures for a cellar of invented wines. They are not
 * honest any more: the cellar now holds 250 real bottlings, and both strings
 * render verbatim on the wine detail page (wine-detail-view.tsx) and in the
 * cellar drawer (wine-detail-drawer.tsx:522). Only 41 of 250 wines even had
 * the first one.
 *
 * ── WHERE THE WORDS COME FROM, AND WHERE THEY DELIBERATELY DO NOT ─────────
 *
 * Every clause below is composed from a column of that wine's own
 * xwines_catalog row — grape, body, acidity, ABV, food pairings, region. It
 * is a rendering of corpus data into a sentence, not a description of a
 * flavour nobody here has tasted. That distinction is the whole design: an
 * invented palate note about a real, named, findable wine is a fabrication
 * that happens to look like the product working.
 *
 * The same rule decides what does NOT get written. The app's rating_source
 * vocabulary (briefing-alert-card.tsx:167) is mostly real critics — parker,
 * vinous, wine_spectator, decanter. Filling those in would mint a Wine
 * Advocate score for Château Mouton Rothschild that Wine Advocate never gave,
 * on a screen shown to investors who can check it.
 *
 * Nor is a score derived instead. The corpus average is a 1.0–5.0 community
 * mean; ×20 puts Mouton at 94 but an ordinary bottle at 68, and on a wine
 * 100-point scale — which effectively runs 80–100 — 68 reads as "flawed"
 * rather than "3.4 out of 5". Rescaling into the 80–100 band to avoid that
 * would be arithmetic chosen to flatter. So `wines.rating` is left alone
 * entirely: the community average already renders properly, in its own units
 * and with its own sample size, through CommunityRating on the detail page.
 *
 * What IS repaired is the 50 wines whose rating_source reads "Local Seed
 * Panel" — a value outside the vocabulary, which formatRatingSourceLabel
 * falls through to "Unknown" for. Their fixture scores are plausible and are
 * kept; only the label becomes one the UI can render.
 *
 * Variation is seeded from wine_id, so a wine keeps its wording across runs
 * instead of being reworded every time this is executed.
 *
 * Usage:
 *   node scripts/local/seed-demo-tasting-notes.mjs
 *   node scripts/local/seed-demo-tasting-notes.mjs --confirm
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

// Same gate every local-only mutating script runs. Node cannot `source` a
// bash script, so run it as a subprocess and require exit 0.
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

/** Deterministic per-wine picker: same wine, same wording, every run. */
const pick = (arr, id, salt = 0) => arr[(id * 7 + salt * 31) % arr.length];

const BODY_CLAUSE = {
  "Very full-bodied": ["broad and weighty", "big-framed", "dense and full"],
  "Full-bodied": ["full-bodied", "generous on the palate", "richly built"],
  "Medium-bodied": ["medium-bodied", "middleweight", "evenly proportioned"],
  "Light-bodied": ["light-bodied", "delicate", "lightly framed"],
  "Very light-bodied": ["featherweight", "very light on its feet", "airy"],
};
const ACID_CLAUSE = {
  High: ["bright acidity keeping it lively", "a firm acid spine", "crisp, mouth-watering acidity"],
  Medium: ["balanced acidity", "measured acidity", "acidity in easy proportion"],
  Low: ["soft, low acidity", "a rounded, gentle finish", "supple low-acid texture"],
};

const listPhrase = (items) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

function tastingNote(c) {
  const id = c.wine_id;
  const body = pick(BODY_CLAUSE[c.body] ?? BODY_CLAUSE["Medium-bodied"], id);
  const acid = pick(ACID_CLAUSE[c.acidity] ?? ACID_CLAUSE.Medium, id, 1);
  const grapes = c.grapes ?? [];
  const blend =
    grapes.length === 0
      ? null
      : grapes.length === 1
        ? `${grapes[0]}`
        : `a blend of ${listPhrase(grapes)}`;

  const origin = [c.region_name, c.country].filter(Boolean).join(", ");
  const sentences = [];

  sentences.push(
    blend
      ? `${cap(body)}, ${acid} — ${blend}${origin ? ` from ${origin}` : ""}.`
      : `${cap(body)}, ${acid}${origin ? `, from ${origin}` : ""}.`,
  );

  if (c.abv != null) {
    const abv = Number(c.abv);
    const weight =
      abv >= 14.5 ? "a warm, ripe register" : abv <= 12 ? "a light alcohol register" : "moderate alcohol";
    sentences.push(`${cap(weight)} at ${abv}% ABV.`);
  }

  const pairings = (c.harmonize ?? []).slice(0, 3).map((p) => p.toLowerCase());
  if (pairings.length) {
    sentences.push(
      `${pick(["Pairs with", "Best alongside", "Shows well with"], id, 2)} ${listPhrase(pairings)}.`,
    );
  }
  return sentences.join(" ");
}

function reviewExcerpt(c) {
  if (c.rating_count == null || c.rating_count < 1 || c.rating_avg == null) return null;
  const avg = Number(c.rating_avg).toFixed(2);
  const n = Number(c.rating_count).toLocaleString();
  const vintages = (c.vintages ?? []).length;
  const span = vintages > 1 ? ` across ${vintages} vintages` : "";
  return `Community average ${avg}/5 from ${n} ratings${span} in the X-Wines reference corpus.`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const { data: rows, error } = await db
  .from("wines")
  .select("id, name, producer, rating, canonical_wine_id, canonical_wines(xwines_wine_id)")
  .order("id");
if (error) {
  console.error(error.message);
  process.exit(1);
}

const ids = rows.map((r) => r.canonical_wines?.xwines_wine_id).filter((v) => v != null);
const { data: catalog, error: catErr } = await db
  .from("xwines_catalog")
  .select("wine_id, grapes, harmonize, abv, body, acidity, region_name, country, rating_avg, rating_count, vintages")
  .in("wine_id", ids);
if (catErr) {
  console.error(catErr.message);
  process.exit(1);
}
const byId = new Map(catalog.map((c) => [c.wine_id, c]));

const updates = [];
for (const w of rows) {
  const c = byId.get(w.canonical_wines?.xwines_wine_id);
  if (!c) continue;
  updates.push({
    id: w.id,
    label: `${w.producer} ${w.name}`,
    tasting_notes: tastingNote(c),
    review_excerpt: reviewExcerpt(c),
    // Only wines that already carry a fixture score get their unrenderable
    // "Local Seed Panel" label swapped; no score is invented for the rest.
    rating_source: w.rating == null ? null : "rule_engine",
    existing_rating: w.rating,
  });
}

console.log(`wines:            ${rows.length}`);
console.log(`resolved to corpus: ${updates.length}`);
console.log(`target:           ${SUPABASE_URL}\n`);
for (const u of updates.slice(0, 3)) {
  console.log(`  ${u.label}`);
  console.log(`    notes:  ${u.tasting_notes}`);
  console.log(`    review: ${u.review_excerpt}`);
  console.log(`    score:  ${u.existing_rating ?? "—"} (${u.rating_source ?? "no source"})\n`);
}

if (!CONFIRM) {
  console.log("DRY RUN — pass --confirm to write.");
  process.exit(0);
}

let written = 0;
for (const u of updates) {
  const { error: upErr } = await db
    .from("wines")
    .update({
      tasting_notes: u.tasting_notes,
      review_excerpt: u.review_excerpt,
      rating_source: u.rating_source,
    })
    .eq("id", u.id);
  if (upErr) {
    console.error(`  ${u.id}: ${upErr.message}`);
    continue;
  }
  written++;
}
console.log(`wines updated: ${written}/${updates.length}`);
