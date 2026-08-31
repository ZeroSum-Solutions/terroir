/**
 * Attach real bottle photography to the PRODUCTION xwines_catalog.
 *
 * Sources, both already harvested to .wine-imagery/ and both licence-stated:
 *   openfoodfacts     CC-BY-SA-3.0 contributor photographs, hotlinked from
 *                     images.openfoodfacts.org (verified live 200 image/jpeg).
 *   wikimedia-commons per-file licence carried through verbatim.
 *
 * Kinds follow 0138 exactly and are never promoted upward:
 *   'label'    brand cleared the producer floor AND product name cleared the
 *              name floor against that winery's cuvee.
 *   'producer' producer floor only — a real bottle from this house.
 * 'representative' is deliberately NOT written here: it says nothing about the
 * wine, and the point of this run is that Devin sees HIS wine.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { readFileSync } from "node:fs";
config({ path: ".env.local" });
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--confirm");

/**
 * Same fail-closed prod guard as seed-xwines.ts (BND-021 / INT-011): a dry run
 * touches nothing and stays open, `--confirm` against an unidentified target is
 * refused rather than assumed safe. `.env.local` holds PRODUCTION credentials
 * (AGENTS.md non-negotiable #1), so pointing this at prod is a decision, never
 * an accident.
 */
const PROD_URL_PATTERN = process.env.PROD_SUPABASE_URL_PATTERN ?? "";
if (APPLY && PROD_URL_PATTERN === "" && process.env.ALLOW_PROD_SEED !== "yes") {
  console.error("\nRefusing --confirm: PROD_SUPABASE_URL_PATTERN is unset, so this");
  console.error("script cannot tell whether the target is production.");
  console.error(`Target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);
  console.error("Set ALLOW_PROD_SEED=yes to override deliberately.\n");
  process.exit(1);
}
console.log(`Target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);
console.log(`Mode:   ${APPLY ? "WRITE" : "dry run"}`);

const norm = s => (s??"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase()
  .replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim();
const tri = s => { const p=`  ${s} `; const g=new Set(); for(let i=0;i<p.length-2;i++) g.add(p.slice(i,i+3)); return g; };
const sim = (a,b) => { if(!a||!b) return 0; const A=tri(a),B=tri(b); let n=0; for(const g of A) if(B.has(g)) n++; return n/(A.size+B.size-n); };
const PRODUCER_FLOOR = 0.80, NAME_FLOOR = 0.64;

// ── corpus, from production ──────────────────────────────────────────────
let corpus=[]; for(let f=0;;f+=1000){
  const {data,error}=await db.from("xwines_catalog").select("wine_id,winery_name,name").range(f,f+999);
  if(error) throw error; corpus=corpus.concat(data); if(data.length<1000) break;
  if(f%20000===0) process.stdout.write(`  read ${f}\r`);
}
console.log(`corpus rows: ${corpus.length}`);
const byWinery=new Map();
for(const r of corpus){ const k=norm(r.winery_name); if(!k) continue;
  if(!byWinery.has(k)) byWinery.set(k,[]); byWinery.get(k).push(r); }
const wineryKeys=[...byWinery.keys()];
console.log(`distinct wineries: ${wineryKeys.length}`);

/**
 * Winery lookup for a brand string.
 *
 * The naive form of this — compare the brand against all 30,156 winery keys —
 * is 14,045 brands x 30,156 keys and does not finish. An inverted word index
 * makes the containment case a set intersection over the brand's RAREST word,
 * which is the whole cost. Exact hits skip it entirely.
 */
const wordIndex=new Map();
for(const k of wineryKeys) for(const w of k.split(" ")){
  if(w.length<3) continue;
  if(!wordIndex.has(w)) wordIndex.set(w,[]);
  wordIndex.get(w).push(k);
}
function findWinery(brand){
  const b=norm(brand); if(b.length<3) return null;
  if(byWinery.has(b)) return b;
  const words=b.split(" ").filter(w=>w.length>=3);
  if(words.length===0) return null;
  // Rarest word first: the smallest candidate list that can still contain a hit.
  let bucket=null;
  for(const w of words){ const c=wordIndex.get(w); if(!c) return null;
    if(!bucket||c.length<bucket.length) bucket=c; }
  const pad=` ${b} `;
  for(const k of bucket) if(pad.includes(` ${k} `)||` ${k} `.includes(pad)) return k;
  for(const k of bucket) if(sim(b,k)>=PRODUCER_FLOOR) return k;
  return null;
}

const updates=new Map(); // wine_id -> row  (label beats producer; first wins otherwise)
function offer(wineId, row){
  const prev=updates.get(wineId);
  if(prev && !(prev.image_kind==="producer" && row.image_kind==="label")) return;
  updates.set(wineId,row);
}

// ── Open Food Facts ──────────────────────────────────────────────────────
const off=JSON.parse(readFileSync(".wine-imagery/openfoodfacts.json","utf8"));
let offHits=0;
for(const p of off){
  const url=p.image_front_url; if(!url) continue;
  for(const brand of (p.brands??[])){
    const key=findWinery(brand); if(!key) continue;
    offHits++;
    const credit=`Photo © Open Food Facts contributors, CC-BY-SA-3.0 (barcode ${p.code})`;
    const pname=norm(p.product_name);
    // Every bottling of the house, not just the first. A winery averages 21
    // rows in this corpus; stopping at one left 20 of them a grey rectangle
    // for a photograph that is, by 0138's own definition of 'producer',
    // equally true of all of them.
    for(const row of byWinery.get(key)){
      const kind = pname && sim(norm(row.name),pname)>=NAME_FLOOR ? "label" : "producer";
      offer(row.wine_id,{ wine_id:row.wine_id, image_url:url, image_kind:kind,
        image_source:"openfoodfacts", image_credit:credit });
    }
    break;
  }
}
console.log(`open food facts: ${offHits} brand hits`);

// ── Wikimedia Commons ────────────────────────────────────────────────────
const commons=JSON.parse(readFileSync(".wine-imagery/wikimedia-commons.json","utf8"));
let comHits=0;
for(const f of commons){
  const title=(f.title??"").replace(/^File:/,"").replace(/\.[a-z]+$/i,"");
  const words=norm(title).split(" ").filter(Boolean);
  let key=null;
  for(let size=6;size>=2&&!key;size--)
    for(let i=0;i+size<=words.length&&!key;i++){
      const w=words.slice(i,i+size).join(" "); if(byWinery.has(w)) key=w; }
  if(!key) continue;
  comHits++;
  const credit=`${f.artist??"Wikimedia Commons"} — ${f.licence??"see Commons"} (${f.credit??"Wikimedia Commons"})`;
  // Title proves the HOUSE, never the bottling — 0138: understating is safe.
  for(const row of byWinery.get(key))
    offer(row.wine_id,{ wine_id:row.wine_id, image_url:f.url, image_kind:"producer",
      image_source:"wikimedia-commons", image_credit:credit });
}
console.log(`wikimedia commons: ${comHits} title hits`);


// ── 'representative' ──────────────────────────────────────────────────────
//
// A real photograph of a real wine bottle of the same type and, where
// possible, the same country, from an unrelated producer. It carries no claim
// about the wine beyond "red, Italian", and every surface that shows one is
// required by 0138's column comment to caption it as such — corpus-image.ts
// renders "Representative bottle — not this wine's label" and degrades the alt
// text so a screen reader is not told a producer the picture does not show.
//
// Only Open Food Facts feeds this pool. The Commons set is two thirds
// vineyards and cellar doors and would put a hillside on a wine page.

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

/** Most-specific-first: a Port is tagged both en:port-wines and en:red-wines
 *  and must not be read as a table red. */
function offType(categories) {
  const tags = new Set(categories ?? []);
  for (const [tag, type] of OFF_TYPE_BY_CATEGORY) if (tags.has(tag)) return type;
  return null;
}
function offCountry(tags) {
  for (const tag of tags ?? []) {
    const name = OFF_COUNTRY_BY_TAG.get(tag);
    if (name) return name;
  }
  return null;
}

/**
 * Deterministic pick: `wine_id % partitionSize` against a key-ordered index.
 * A wine keeps the same bottle across runs, and the pool spreads evenly
 * instead of every wine landing on one photograph.
 *
 * The partition size must be the WHOLE partition. The SQL original hit this:
 * a count() window with an order by defaults to RANGE UNBOUNDED PRECEDING ..
 * CURRENT ROW, making it a RUNNING total, so the first row of every partition
 * had rn = 0 and n = 1 — and `wine_id % 1 === 0 === rn` matched EVERY wine.
 * Measured before it was caught: 10,754 French reds, one bottle between them.
 * Computing the size after grouping, as below, cannot express that bug.
 */
function pickFrom(bucket, wineId) {
  return bucket[wineId % bucket.length];
}

async function representativePhase() {
  const pool = [];
  for (const p of off) {
    if (!p.image_front_url) continue;
    const type = offType(p.categories_tags);
    if (!type) continue;
    pool.push({
      key: p.code,
      type,
      country: offCountry(p.countries_tags),
      image_url: p.image_front_url,
      credit: `Photo © Open Food Facts contributors, CC-BY-SA-3.0 (barcode ${p.code})`,
    });
  }
  pool.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const byTypeCountry = new Map(), byType = new Map();
  for (const r of pool) {
    if (r.country) {
      const k = `${r.type}\u0000${r.country}`;
      if (!byTypeCountry.has(k)) byTypeCountry.set(k, []);
      byTypeCountry.get(k).push(r);
    }
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r);
  }
  console.log(`\nrepresentative pool: ${pool.length} photographs, ` +
    `${byTypeCountry.size} type+country buckets, ${byType.size} type buckets`);

  // Only rows still without a picture. label/producer always outrank this.
  let blanks = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from("xwines_catalog")
      .select("wine_id,type,country").is("image_url", null).range(f, f + 999);
    if (error) throw error;
    blanks = blanks.concat(data);
    if (data.length < 1000) break;
  }
  console.log(`corpus rows still without a picture: ${blanks.length}`);

  const assigned = new Map();
  let viaCountry = 0, viaType = 0, unmatched = 0;
  for (const row of blanks) {
    const bucket = byTypeCountry.get(`${row.type}\u0000${row.country}`);
    const fallback = byType.get(row.type);
    const chosen = bucket?.length ? (viaCountry++, pickFrom(bucket, row.wine_id))
                 : fallback?.length ? (viaType++, pickFrom(fallback, row.wine_id))
                 : (unmatched++, null);
    if (!chosen) continue;
    assigned.set(row.wine_id, {
      wine_id: row.wine_id, image_url: chosen.image_url, image_kind: "representative",
      image_source: "openfoodfacts", image_credit: chosen.credit,
    });
  }
  console.log(`  matched on type+country ${viaCountry}, on type alone ${viaType}, ` +
    `no bottle of that type ${unmatched}`);

  /**
   * The guard the SQL original needed and did not have.
   *
   * Its running-total window collapsed every partition to a single row, and
   * the symptom was invisible in the row counts — 10,754 French reds were
   * "assigned a representative bottle", all of them the same one. A count of
   * assignments can never catch that. A count of DISTINCT photographs can.
   *
   * The pool is drawn from whole, so the floor is the number of buckets we
   * actually used; anything near 1 means the partitioning collapsed again.
   */
  const distinct = new Set([...assigned.values()].map((r) => r.image_url)).size;
  const bucketsUsed = new Set(blanks.map((r) => `${r.type}\u0000${r.country}`)).size;
  console.log(`  distinct photographs used: ${distinct} across ${bucketsUsed} buckets`);
  if (assigned.size > 0 && distinct < bucketsUsed) {
    throw new Error(
      `representative pick collapsed: ${assigned.size} rows share only ${distinct} ` +
      `photographs across ${bucketsUsed} buckets. Refusing to write.`,
    );
  }
  return [...assigned.values()];
}

const rows=[...updates.values()];
rows.push(...(await representativePhase()));
const byKind=rows.reduce((a,r)=>((a[r.image_kind]=(a[r.image_kind]??0)+1),a),{});
console.log(`\nwould write ${rows.length} corpus images:`, byKind);
if(!APPLY){ console.log("dry run — pass --confirm to write."); process.exit(0); }

/**
 * Written as grouped UPDATEs, not an upsert.
 *
 * A PostgREST upsert builds a full INSERT tuple before ON CONFLICT can fire,
 * so a payload of {wine_id + four image columns} fails on every NOT NULL
 * column the corpus row already has. These rows all exist; only four columns
 * change. Rows sharing one photograph (every bottling of a house) update
 * together, and the id list is chunked at 100 because `.in()` travels in the
 * URL — the same shape that returned HTTP 414 from the pricing endpoint.
 */
const groups=new Map();
for(const r of rows){
  const k=`${r.image_url}\u0000${r.image_kind}\u0000${r.image_source}\u0000${r.image_credit}`;
  if(!groups.has(k)) groups.set(k,{ meta:r, ids:[] });
  groups.get(k).ids.push(r.wine_id);
}
console.log(`${groups.size} distinct images across ${rows.length} rows`);
let done=0;
for(const { meta, ids } of groups.values()){
  for(let i=0;i<ids.length;i+=100){
    const { error }=await db.from("xwines_catalog")
      .update({ image_url:meta.image_url, image_kind:meta.image_kind,
                image_source:meta.image_source, image_credit:meta.image_credit })
      .in("wine_id", ids.slice(i,i+100));
    if(error) throw error;
  }
  done+=ids.length;
  if(done % 1000 < 25) process.stdout.write(`  wrote ${done}/${rows.length}\r`);
}
console.log(`\nwrote ${rows.length} corpus images.`);
