/**
 * Collect wine-bottle photography metadata from the open web into a cache
 * directory. Network only — it touches no database and no storage bucket, and
 * is the read half of a pair whose write half is seed-catalog-imagery.mjs.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `xwines_catalog` holds 100,646 real wines (0131) and, after 0138, a column
 * for a photograph of one. X-Wines itself ships 1,007 label images — 1.0% of
 * the corpus. Every other row renders as a placeholder, including on the wine
 * detail page, which by then knows the wine's grapes, body, acidity, food
 * pairings and community rating. The missing thing is not a schema. It is a
 * supply of pictures.
 *
 * ── WHERE THE PICTURES COME FROM, AND UNDER WHAT ──────────────────────────
 *
 * Two sources survived a survey of the obvious candidates. Both are real,
 * both were measured rather than assumed, and neither is a wine-label
 * dataset — those do not exist at this scale in the open:
 *
 *   openfoodfacts   Open Food Facts is a crowdsourced product database with a
 *                   working search API (search.openfoodfacts.org). Measured
 *                   2026-08-30: 14,791 products under `categories_tags:
 *                   "en:wines"` across 102 countries, 13,008 of them carrying
 *                   a selected front photograph. Photographs are uploaded by
 *                   contributors under CC-BY-SA-3.0. They are phone shots of
 *                   supermarket bottles, not studio work — variable, real,
 *                   and overwhelmingly European (France alone is 7,917).
 *
 *   wikimedia-commons  deepcat:"Wine labels" + deepcat:"Wine bottles",
 *                   ~4,600 files. Small, but the only source here whose
 *                   licence is stated per file and machine-readable, so its
 *                   `extmetadata` licence and artist are carried through.
 *
 * Checked and rejected, so nobody re-checks them: Kaggle (no credentials on
 * this machine — `~/.kaggle/kaggle.json` absent — and its wine datasets are
 * tabular anyway); the Hugging Face hub, whose ~50 "wine" datasets are wine
 * *reviews* and *chemistry* with one object-detection set of shelf photos
 * (Francesco/wine-labels) that identifies no wine; Vivino and Wine-Searcher,
 * which are bot-walled and whose imagery is licensed to them.
 *
 * NOTHING HERE IS A LICENCE CLEARANCE. Every record carries the source's own
 * stated terms verbatim so the question can be answered later; answering it
 * is not this script's job and is not done by running it.
 *
 * ── PAGING, AND WHY IT IS PARTITIONED BY COUNTRY ──────────────────────────
 *
 * Open Food Facts' search is Elasticsearch-backed and refuses to page past
 * 10,000 hits, which is fewer than it has wines. The country facet is used as
 * the partition because it is the one facet that is (a) exhaustively
 * enumerable — repeatedly re-asking with the countries already seen excluded
 * walks the whole tail, which is how the 102 above was arrived at — and (b)
 * always under the cap per partition. Facet counts carry a stated error
 * margin, so the union is de-duplicated by barcode rather than trusted.
 *
 * Usage:
 *   node scripts/local/harvest-wine-imagery.mjs [work_dir]
 *
 * Writes <work_dir>/openfoodfacts.json and <work_dir>/wikimedia-commons.json
 * (default work_dir: .wine-imagery/). Both are re-read, not re-fetched, if
 * they already exist — the fetch is ~20 minutes of polite paging and the
 * seeder is expected to be re-run far more often than the sources change.
 * Delete a file to force its source to be re-harvested.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORK_DIR = process.argv[2] ?? ".wine-imagery";

// Both APIs ask for a contactable User-Agent and throttle anonymous traffic
// harder without one. This is a real address on this machine's account.
const USER_AGENT = "TerroirCatalogImagery/1.0 (devinwigginspt@gmail.com)";

/** Retry on transport errors and 5xx; a 4xx is a bug and is surfaced. */
async function getJson(url, { attempts = 4 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (response.ok) return await response.json();
      if (response.status < 500) {
        console.error(`  http ${response.status} ${url}`);
        return null;
      }
      console.error(`  http ${response.status}, retrying`);
    } catch (error) {
      console.error(`  ${error.message}, retrying`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
  return null;
}

// ──────────────────────────────────────────────────────── Open Food Facts

const OFF_SEARCH = "https://search.openfoodfacts.org/search";
const OFF_FIELDS =
  "code,product_name,brands,countries_tags,categories_tags,image_front_url,quantity";

function offUrl(query, { page = 1, pageSize = 1, facets = null } = {}) {
  const url = new URL(OFF_SEARCH);
  url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(pageSize));
  url.searchParams.set("fields", OFF_FIELDS);
  if (facets) url.searchParams.set("facets", facets);
  return url;
}

/**
 * Enumerate every country tag that has wines.
 *
 * The facet returns its top ten plus an "--other--" bucket, so one call sees
 * ten countries and a number. Excluding the ones already seen and asking
 * again surfaces the next ten, and repeating until "--other--" is empty walks
 * the entire tail — 102 countries in 11 rounds, measured.
 */
async function offCountries() {
  const countries = [];
  const seen = [];
  for (let round = 0; round < 20; round++) {
    const exclusion = seen.length
      ? ` AND NOT countries_tags:(${seen.map((c) => `"${c}"`).join(" OR ")})`
      : "";
    const body = await getJson(
      offUrl(`categories_tags:"en:wines"${exclusion}`, { facets: "countries_tags" }),
    );
    const items = body?.facets?.countries_tags?.items ?? [];
    const named = items.filter((item) => item.key !== "--other--" && item.count > 0);
    if (named.length === 0) break;
    for (const item of named) {
      countries.push(item);
      seen.push(item.key);
    }
    const other = items.find((item) => item.key === "--other--");
    console.log(`  round ${round + 1}: +${named.length} countries, tail ${other?.count ?? 0}`);
    if (!other || other.count === 0) break;
  }
  return countries;
}

async function harvestOpenFoodFacts() {
  console.log("open food facts: enumerating countries");
  const countries = await offCountries();
  const declared = countries.reduce((sum, c) => sum + c.count, 0);
  console.log(`open food facts: ${countries.length} countries, ~${declared} products`);

  const byBarcode = new Map();
  for (const country of countries) {
    const query = `categories_tags:"en:wines" AND countries_tags:"${country.key}"`;
    // 9,800 rather than 10,000: the facet count carries an error margin and
    // asking for a page the engine refuses aborts the whole country.
    const pages = Math.ceil(Math.min(country.count, 9800) / 200);
    for (let page = 1; page <= pages; page++) {
      const body = await getJson(offUrl(query, { page, pageSize: 200 }));
      if (!body?.hits?.length) break;
      for (const hit of body.hits) byBarcode.set(hit.code, hit);
    }
    console.log(`  ${country.key}: ${country.count} -> ${byBarcode.size} unique so far`);
  }
  return [...byBarcode.values()];
}

// ──────────────────────────────────────────────────────── Wikimedia Commons

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

function commonsUrl(params) {
  const url = new URL(COMMONS_API);
  for (const [key, value] of Object.entries({ format: "json", ...params })) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

/** Commons wraps its metadata values in HTML; the DB stores the text. */
function plainText(value) {
  if (!value) return null;
  const text = String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

async function harvestCommons() {
  const titles = new Set();
  // `deepcat:` walks the category tree, which is where the volume is:
  // "Wine labels" holds 48 files directly and 1,695 through its children.
  for (const category of ['deepcat:"Wine labels"', 'deepcat:"Wine bottles"']) {
    let offset = 0;
    for (let page = 0; page < 60; page++) {
      const body = await getJson(
        commonsUrl({
          action: "query",
          list: "search",
          srsearch: category,
          srnamespace: 6,
          srlimit: 100,
          sroffset: offset,
        }),
      );
      for (const hit of body?.query?.search ?? []) titles.add(hit.title);
      if (!body?.continue?.sroffset) break;
      offset = body.continue.sroffset;
    }
    console.log(`  ${category}: ${titles.size} files cumulative`);
  }

  const list = [...titles];
  const files = [];
  for (let index = 0; index < list.length; index += 40) {
    const body = await getJson(
      commonsUrl({
        action: "query",
        titles: list.slice(index, index + 40).join("|"),
        prop: "imageinfo",
        iiprop: "url|extmetadata|mime|size",
        // A 500px-wide thumbnail, not the original: Commons originals run to
        // tens of megabytes and the bucket's own limit (0130) is 10 MB.
        iiurlwidth: 500,
      }),
    );
    for (const page of Object.values(body?.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime ?? "")) continue;
      const meta = info.extmetadata ?? {};
      files.push({
        title: page.title,
        url: info.thumburl ?? info.url,
        descriptionUrl: info.descriptionurl ?? null,
        licence: plainText(meta.LicenseShortName?.value),
        artist: plainText(meta.Artist?.value),
        credit: plainText(meta.Credit?.value),
      });
    }
    if (index % 400 === 0) console.log(`  imageinfo ${index}/${list.length}`);
  }
  return files;
}

// ──────────────────────────────────────────────────────────────────── main

mkdirSync(WORK_DIR, { recursive: true });

const sources = [
  ["openfoodfacts.json", harvestOpenFoodFacts],
  ["wikimedia-commons.json", harvestCommons],
];

for (const [file, harvest] of sources) {
  const path = join(WORK_DIR, file);
  if (existsSync(path)) {
    console.log(`${file}: cached, skipping (delete it to re-harvest)`);
    continue;
  }
  const records = await harvest();
  writeFileSync(path, JSON.stringify(records));
  console.log(`${file}: wrote ${records.length} records`);
}
