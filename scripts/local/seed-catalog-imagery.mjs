/**
 * Attach real bottle photography to the X-Wines reference corpus, LOCAL only.
 *
 * Reads the caches harvest-wine-imagery.mjs writes, copies every usable
 * picture into the `wine-images` bucket, and fills the four columns 0138 added
 * to `xwines_catalog` — image_url, image_kind, image_source, image_credit.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────
 *
 * 1,007 of the corpus's 100,646 wines have a photograph. The other 99.0% are
 * a grey placeholder on a page that already knows their grapes, body, acidity
 * and food pairings. There is no open dataset of 100,646 wine labels, so the
 * choice is not "find one" — it is to be precise about which of three
 * genuinely different things each picture is, and to say so in the row.
 *
 * ── THE THREE KINDS, AND THE FLOORS THAT SEPARATE THEM ────────────────────
 *
 * 'label' — this wine's own label. Two routes reach it:
 *     · X-Wines ships 1,007 label JPEGs keyed by WineID (CC0-1.0). The
 *       identity is the corpus's own, so no matching is involved.
 *     · A product photo whose brand clears the PRODUCER floor against a
 *       winery AND whose product name clears the NAME floor against that
 *       winery's cuvée. Both floors are xwines-profile.ts's, unchanged and
 *       deliberately: 0.80 and 0.64 were measured on this corpus (see that
 *       file's header for the derivation and the 199,076-pair grid behind
 *       0.64), and a second, looser set of numbers for the same question
 *       would mean the page's taste facts and its picture disagreed about
 *       what counts as the same wine.
 *
 * 'producer' — a real bottle from this producer, a different cuvée. The
 *     producer floor cleared, the name floor did not. A house's bottles share
 *     a livery, so this is worth showing and is NOT this label.
 *
 * 'representative' — a real photograph of a real wine bottle of the same type
 *     and country from an unrelated producer. It carries no claim about the
 *     wine beyond "red, Italian". It exists so the corpus renders as wine
 *     rather than as 90,000 grey rectangles, and every surface that shows one
 *     is required by 0138's column comment to caption it as such.
 *
 * Nothing is ever promoted upward. A Commons file whose title contains the
 * winery's name is recorded as 'producer' even when it plainly IS a label
 * photograph ("Château Lanessan 75 detail"), because the title proves the
 * house and not the bottling. Understating is safe; overstating is the bug.
 *
 * ── MATCHING, PER SOURCE, AND WHY THEY DIFFER ─────────────────────────────
 *
 * Open Food Facts carries a structured `brands` field, so it goes through the
 * same trigram comparison the app uses — similarity(lower(winery_name),
 * lower(brand)) against the lower() GIN indexes 0133 built for exactly this.
 * Measured on the 2026-08-30 harvest: 6,854 of 13,008 photographed products
 * carry a brand, 2,376 of those clear 0.80 against a winery, and those
 * wineries hold 8,878 corpus rows.
 *
 * Wikimedia Commons carries no brand field at all — the producer, when it is
 * present, is inside the FILE NAME. Trigram is the wrong instrument there:
 * "Château Climens 49 detail.JPG" scores ~0.55 against "Château Climens"
 * because the surplus words dilute it, and lowering the floor to catch it
 * would admit everything. So Commons is matched by exact containment instead:
 * the file name is normalised (accents folded, punctuation dropped) and every
 * 2-to-6-word window is looked up in a hash of normalised winery names. A hit
 * is an exact name, not a near one, which is a STRICTER claim than 0.80
 * trigram — hence no floor to state. Measured: 346 of 4,495 files.
 *
 * ── PROVENANCE. READ THIS BEFORE SHIPPING ANY OF IT ───────────────────────
 *
 *   xwines            CC0-1.0. No attribution required. (X-Wines, de Azambuja
 *                     et al., MDPI BDCC 7(1):20.)
 *   openfoodfacts     Product photographs uploaded by contributors, stated as
 *                     CC-BY-SA-3.0. Attribution IS required and SHARE-ALIKE
 *                     attaches. Recorded per row in image_credit.
 *   wikimedia-commons Per-file licence, carried verbatim from the file's own
 *                     extmetadata into image_credit — CC BY-SA 4.0/3.0/2.0,
 *                     CC BY, CC0 and public domain all appear in the set.
 *
 * This script records what each source says. It does not clear anything for
 * any use, and running it is not a licensing decision.
 *
 * Usage:
 *   node scripts/local/seed-catalog-imagery.mjs [work_dir]            # dry run
 *   node scripts/local/seed-catalog-imagery.mjs [work_dir] --confirm  # write
 *
 * Idempotent: every run clears the four columns for rows it previously wrote
 * and re-derives them, so re-harvesting a source and re-running converges
 * rather than accumulating. Storage uploads are upserts keyed by source and
 * source id, so the bucket does not grow on a re-run either.
 */

import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

const SUPABASE_URL = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:57321";
const SERVICE_KEY =
  process.env.LOCAL_SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL =
  process.env.LOCAL_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:57322/postgres";
const BUCKET = "wine-images";
const PUBLIC_BASE = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;

// Deliberately the same two numbers xwines-profile.ts exports as
// XWINES_PRODUCER_FLOOR and XWINES_NAME_FLOOR. They are duplicated rather than
// imported because this is a plain .mjs script with no TypeScript pipeline; if
// either moves there, it moves here, and the reason not to invent a second set
// is in this file's header.
const PRODUCER_FLOOR = 0.8;
const NAME_FLOOR = 0.64;

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const WORK_DIR = args.find((a) => !a.startsWith("--")) ?? ".wine-imagery";

if (!SERVICE_KEY) {
  console.error("LOCAL_SUPABASE_SERVICE_KEY is required (from `npx supabase status`).");
  process.exit(1);
}

// Node cannot `source` a bash script, so the one gate every local-only
// mutating script runs is spawned instead — same guard, same single source of
// truth for which host:port is THIS repo's stack (scripts/local/seed-local.mjs
// does the same). It is given the URL this script will actually write to, not
// whatever the ambient shell happens to hold.
try {
  execFileSync("bash", [join(HERE, "assert-local-db.sh")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL },
  });
} catch {
  console.error("seed-catalog-imagery: aborting — assert-local-db.sh refused the target.");
  process.exit(1);
}

// ── Source normalisation ───────────────────────────────────────────────────

/** X-Wines' six `type` values, keyed by the Open Food Facts category that
 *  implies them. Ordered most-specific-first: a Port is tagged both
 *  en:port-wines and en:red-wines and must not be read as a table red. */
const OFF_TYPE_BY_CATEGORY = [
  ["en:port-wines", "Dessert/Port"],
  ["en:fortified-wines", "Dessert/Port"],
  ["en:dessert-wines", "Dessert"],
  ["en:sweet-wines", "Dessert"],
  ["en:champagnes", "Sparkling"],
  ["en:sparkling-wines", "Sparkling"],
  ["en:rose-wines", "Rosé"],
  ["en:white-wines", "White"],
  ["en:red-wines", "Red"],
];

/** Only countries the corpus actually names, spelled the corpus's way — an
 *  Open Food Facts country that xwines_catalog never uses would silently
 *  partition the representative pool into a bucket nothing can draw from. */
const OFF_COUNTRY_BY_TAG = new Map(
  Object.entries({
    "en:france": "France",
    "en:italy": "Italy",
    "en:spain": "Spain",
    "en:portugal": "Portugal",
    "en:germany": "Germany",
    "en:united-states": "United States",
    "en:australia": "Australia",
    "en:chile": "Chile",
    "en:argentina": "Argentina",
    "en:south-africa": "South Africa",
    "en:austria": "Austria",
    "en:brazil": "Brazil",
    "en:new-zealand": "New Zealand",
    "en:canada": "Canada",
    "en:switzerland": "Switzerland",
    "en:greece": "Greece",
    "en:hungary": "Hungary",
    "en:romania": "Romania",
    "en:israel": "Israel",
    "en:uruguay": "Uruguay",
    "en:mexico": "Mexico",
    "en:moldova": "Moldova",
    "en:bulgaria": "Bulgaria",
    "en:croatia": "Croatia",
    "en:slovenia": "Slovenia",
    "en:georgia": "Georgia",
    "en:lebanon": "Lebanon",
    "en:china": "China",
    "en:turkey": "Turkey",
    "en:united-kingdom": "United Kingdom",
  }),
);

/** Tabs and newlines would break the COPY the matcher is fed through, and
 *  the search API returns HTML entities in product names. */
function oneLine(value) {
  return (value ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

/** Accent-folded, punctuation-free words — the key space both sides of the
 *  Commons containment match are compared in. */
function normalise(value) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function loadOpenFoodFacts() {
  const path = join(WORK_DIR, "openfoodfacts.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"))
    .filter((product) => product.image_front_url)
    .map((product) => {
      const categories = product.categories_tags ?? [];
      return {
        key: `openfoodfacts/${product.code}`,
        source: "openfoodfacts",
        remoteUrl: product.image_front_url,
        brand: oneLine((product.brands ?? []).join(" ")),
        productName: oneLine(product.product_name),
        type: OFF_TYPE_BY_CATEGORY.find(([tag]) => categories.includes(tag))?.[1] ?? "",
        country:
          (product.countries_tags ?? []).map((t) => OFF_COUNTRY_BY_TAG.get(t)).find(Boolean) ?? "",
        credit: `Open Food Facts contributors, CC-BY-SA-3.0 (${product.code})`,
        wineryId: "",
      };
    });
}

/**
 * Commons files whose name contains a winery's name exactly.
 *
 * Windows are tried longest-first so "Château Grand Corbin-Despagne" is
 * preferred over the "Château Grand" that also exists, and single-word names
 * are excluded outright: a corpus with wineries literally called "Ventoux" or
 * "Bordeaux" would otherwise claim every photograph of the appellation.
 */
function loadCommons(wineryByName) {
  const path = join(WORK_DIR, "wikimedia-commons.json");
  if (!existsSync(path)) return [];
  const records = [];
  for (const file of JSON.parse(readFileSync(path, "utf8"))) {
    const title = file.title.replace(/^File:/, "").replace(/\.[A-Za-z0-9]+$/, "");
    const words = normalise(title).split(" ").filter(Boolean);
    let match = null;
    for (let size = 6; size >= 2 && !match; size--) {
      for (let start = 0; start + size <= words.length; start++) {
        const window = words.slice(start, start + size).join(" ");
        const winery = wineryByName.get(window);
        if (winery) {
          match = winery;
          break;
        }
      }
    }
    if (!match) continue;
    records.push({
      key: `wikimedia-commons/${normalise(title).replace(/ /g, "-").slice(0, 96)}`,
      source: "wikimedia-commons",
      remoteUrl: file.url,
      brand: "",
      // Deliberately empty: a Commons file name is not a cuvée name, so it
      // must never reach the NAME floor and be promoted to 'label'.
      productName: "",
      type: "",
      country: "",
      credit: [file.artist, file.licence, "via Wikimedia Commons"].filter(Boolean).join(" · "),
      wineryId: String(match.wineryId),
    });
  }
  return records;
}

function psql(sql) {
  return execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ── Plan ───────────────────────────────────────────────────────────────────

const wineryRows = psql(
  "\\pset tuples_only on\n\\pset format unaligned\n\\pset fieldsep '\\t'\n" +
    "select distinct winery_id, winery_name from public.xwines_catalog " +
    "where winery_name is not null;",
);
const wineryByName = new Map();
for (const line of wineryRows.split("\n")) {
  const [wineryId, wineryName] = line.split("\t");
  if (!wineryId || !wineryName) continue;
  const key = normalise(wineryName);
  if (key.split(" ").length < 2 || key.length < 8) continue;
  if (!wineryByName.has(key)) wineryByName.set(key, { wineryId, wineryName });
}

const records = [...loadOpenFoodFacts(), ...loadCommons(wineryByName)];
if (records.length === 0) {
  console.error(`no cached sources in ${WORK_DIR} — run harvest-wine-imagery.mjs first.`);
  process.exit(1);
}

const bySource = records.reduce((counts, r) => {
  counts[r.source] = (counts[r.source] ?? 0) + 1;
  return counts;
}, {});
console.log(`work dir:          ${WORK_DIR}`);
console.log(`target:            ${SUPABASE_URL}`);
console.log(`winery name index: ${wineryByName.size}`);
for (const [source, count] of Object.entries(bySource)) {
  console.log(`  ${source.padEnd(18)} ${count} images to transfer`);
}
if (!CONFIRM) {
  console.log("\nDRY RUN — pass --confirm to write.");
  process.exit(0);
}

// ── Transfer ───────────────────────────────────────────────────────────────

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const EXTENSION_BY_TYPE = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
// Below this a "photograph" is a placeholder pixel or a truncated body, and
// storing it would put a broken image on a wine page rather than no image.
const MIN_IMAGE_BYTES = 2048;

// Objects already in the bucket, keyed the way `record.key` is. Transferring
// 13,000 images takes the better part of an hour, and a run that dies at
// 9,000 must not start over: anything already stored is reused instead of
// refetched, so a resumed run only does the part the first one did not.
const storedPaths = new Map();
for (const line of psql(
  "\\pset tuples_only on\n\\pset format unaligned\n" +
    `select name from storage.objects where bucket_id = '${BUCKET}' and name like 'catalog/%';`,
).split("\n")) {
  const path = line.trim();
  if (path === "") continue;
  storedPaths.set(path.replace(/^catalog\//, "").replace(/\.[a-z]+$/, ""), path);
}
if (storedPaths.size > 0) console.log(`already in the bucket: ${storedPaths.size}`);

/** One image, end to end. Returns the stored row or null; never throws, since
 *  one dead URL among thousands must not abandon the run. */
async function transfer(record) {
  const alreadyStored = storedPaths.get(record.key);
  if (alreadyStored !== undefined) {
    return {
      ...record,
      imageUrl: db.storage.from(BUCKET).getPublicUrl(alreadyStored).data.publicUrl,
    };
  }
  try {
    const response = await fetch(record.remoteUrl, {
      headers: { "User-Agent": "TerroirCatalogImagery/1.0 (devinwigginspt@gmail.com)" },
    });
    if (!response.ok) return null;
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    const extension = EXTENSION_BY_TYPE[contentType];
    if (!extension) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength < MIN_IMAGE_BYTES) return null;

    const path = `catalog/${record.key}.${extension}`;
    const { error } = await db.storage
      .from(BUCKET)
      .upload(path, body, { contentType, upsert: true });
    if (error) return null;
    return {
      ...record,
      imageUrl: db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl,
    };
  } catch {
    return null;
  }
}

const CONCURRENCY = 24;
const stored = [];
let done = 0;
let failed = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async (_unused, worker) => {
    for (let index = worker; index < records.length; index += CONCURRENCY) {
      const row = await transfer(records[index]);
      if (row) stored.push(row);
      else failed++;
      if (++done % 1000 === 0) console.log(`  transferred ${done}/${records.length}`);
    }
  }),
);
console.log(`images: ${stored.length} stored, ${failed} skipped`);

// ── Match and write ────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "catalog-imagery-"));
const manifest = join(scratch, "images.tsv");
writeFileSync(
  manifest,
  stored
    .map((r) =>
      [r.key, r.source, r.imageUrl, r.brand, r.productName, r.type, r.country, r.credit, r.wineryId]
        .join("\t"),
    )
    .join("\n") + "\n",
);

// Written as one psql script rather than through supabase-js because every
// step is a set operation over 100,646 rows against the trigram indexes: the
// same work through PostgREST is ~200 round trips per pass and cannot use
// `similarity()` at all.
//
// The manifest path is interpolated into the text rather than passed as a psql
// variable: `\copy` is the one meta-command psql does NOT run variable
// substitution over, and `:'manifest'` reaches it there as a literal filename.
const SQL = `
\\set ON_ERROR_STOP on
begin;

create temp table img (
  key text primary key, source text not null, image_url text not null,
  brand text, product_name text, wine_type text, country text,
  credit text, winery_id integer
) on commit drop;
\\copy img from '${manifest}' with (format csv, delimiter E'\\t', quote E'\\b', null '')

-- Idempotence. Only rows this script wrote are cleared; a hand-set image with
-- some other source token would survive, and there are none today.
update public.xwines_catalog
   set image_url = null, image_kind = null, image_source = null, image_credit = null
 where image_source in ('xwines', 'openfoodfacts', 'wikimedia-commons');

-- 1. X-Wines' own labels, keyed by WineID. Driven off storage.objects rather
--    than a hardcoded list so a partially-seeded bucket yields exactly the
--    rows whose file is actually there — a URL to a missing object renders as
--    a broken image, which is worse than the placeholder it replaced.
update public.xwines_catalog c
   set image_url = '${PUBLIC_BASE}' || o.name,
       image_kind = 'label', image_source = 'xwines', image_credit = null
  from storage.objects o
 where o.bucket_id = '${BUCKET}'
   and o.name = 'xwines/' || c.wine_id::text || '.jpeg';

-- 2. Every stored image that resolves to a winery: Open Food Facts through
--    the producer floor, Commons through the containment match it arrived
--    with. Both land in one table so the assignment below is source-blind.
set pg_trgm.similarity_threshold = ${PRODUCER_FLOOR};
create temp table img_winery on commit drop as
  select i.key, i.source, i.image_url, i.product_name, i.credit,
         m.winery_id, m.producer_score
    from img i
    join lateral (
      select c.winery_id,
             similarity(lower(c.winery_name), lower(i.brand)) as producer_score
        from public.xwines_catalog c
       where c.winery_name is not null
         and lower(c.winery_name) % lower(i.brand)
       order by similarity(lower(c.winery_name), lower(i.brand)) desc, c.winery_id
       limit 1
    ) m on true
   where i.winery_id is null and coalesce(i.brand, '') <> '' and length(i.brand) >= 4
  union all
  select i.key, i.source, i.image_url, i.product_name, i.credit, i.winery_id, 1.0
    from img i
   where i.winery_id is not null;
create index on img_winery (winery_id);

-- 3. 'label': the winery matched AND the cuvee clears xwines-profile.ts's
--    name floor. Ties break on key so a re-run picks the same picture.
create temp table assignment on commit drop as
  select wine_id, kind, image_url, source, credit from (
    select distinct on (c.wine_id)
           c.wine_id, 'label'::text as kind, w.image_url, w.source, w.credit,
           w.key, similarity(lower(c.name), lower(w.product_name)) as name_score
      from img_winery w
      join public.xwines_catalog c on c.winery_id = w.winery_id
     where coalesce(w.product_name, '') <> ''
       and similarity(lower(c.name), lower(w.product_name)) >= ${NAME_FLOOR}
     order by c.wine_id, name_score desc, w.key
  ) best;

-- 4. 'producer': right house, unproven bottling. Every other row of a matched
--    winery, best producer score first.
insert into assignment
  select wine_id, kind, image_url, source, credit from (
    select distinct on (c.wine_id)
           c.wine_id, 'producer'::text as kind, w.image_url, w.source, w.credit,
           w.key, w.producer_score
      from img_winery w
      join public.xwines_catalog c on c.winery_id = w.winery_id
     where not exists (select 1 from assignment a where a.wine_id = c.wine_id)
     order by c.wine_id, w.producer_score desc, w.key
  ) best;

update public.xwines_catalog c
   set image_url = a.image_url, image_kind = a.kind,
       image_source = a.source, image_credit = a.credit
  from assignment a
 where a.wine_id = c.wine_id and c.image_url is null;

-- 5. 'representative': a real bottle of the right type, preferring the right
--    country. Only Open Food Facts feeds this pool — it is the one source
--    whose every record is a photographed retail bottle carrying a type. The
--    Commons set is two thirds vineyards and cellar doors and would put a
--    hillside on a wine page.
--
--    The pick is wine_id modulo partition size against a key-ordered row
--    number: deterministic, so a wine keeps the same bottle across runs, and
--    it spreads the pool evenly instead of everything landing on one photo.
create temp table pool on commit drop as
  select key, source, image_url, credit,
         nullif(wine_type, '') as wine_type, nullif(country, '') as country
    from img
   where source = 'openfoodfacts' and nullif(wine_type, '') is not null;

create temp table pool_type_country on commit drop as
  select p.*, (row_number() over w) - 1 as rn, count(*) over w as n
    from pool p where p.country is not null
  window w as (partition by p.wine_type, p.country order by p.key);

create temp table pool_type on commit drop as
  select p.*, (row_number() over w) - 1 as rn, count(*) over w as n
    from pool p
  window w as (partition by p.wine_type order by p.key);

update public.xwines_catalog c
   set image_url = p.image_url, image_kind = 'representative',
       image_source = p.source, image_credit = p.credit
  from pool_type_country p
 where c.image_url is null
   and p.wine_type = c.type and p.country = c.country
   and p.rn = (c.wine_id % p.n);

update public.xwines_catalog c
   set image_url = p.image_url, image_kind = 'representative',
       image_source = p.source, image_credit = p.credit
  from pool_type p
 where c.image_url is null
   and p.wine_type = c.type
   and p.rn = (c.wine_id % p.n);

commit;

\\echo
\\echo 'coverage by kind and source:'
select coalesce(image_kind, '(none)') as kind, image_source, count(*)
  from public.xwines_catalog group by 1, 2 order by 3 desc;
select count(*) as catalog_rows, count(image_url) as with_image,
       round(100.0 * count(image_url) / count(*), 1) as pct
  from public.xwines_catalog;
`;

console.log(psql(SQL));
rmSync(scratch, { recursive: true, force: true });
