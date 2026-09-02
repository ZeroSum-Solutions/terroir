/**
 * Make the hosted DEMO tenant demonstrable: corpus links (and so label
 * images), colours, cellar sections, tasting excerpts, and no scan stuck in
 * "processing".
 *
 * Measured 2026-09-02 on production before this ran: 42 wines, 0 corpus
 * links, 0 images, colour empty on every row, every inventory row without a
 * section, 5 of 42 with a tasting excerpt, one invoice scan "processing"
 * since it was created.
 *
 * Usage (hosted target — loads .env.local DELIBERATELY, same guard as
 * seed-catalog-imagery-hosted.mjs / link-lwin-xwines.ts):
 *   npx tsx scripts/polish-demo-tenant-hosted.ts              # dry run: prints every decision, writes nothing
 *   ALLOW_PROD_SEED=yes npx tsx scripts/polish-demo-tenant-hosted.ts --confirm
 *
 * Rules, all "only where empty" so a human's work is never overwritten:
 *   link     canonical_wines.xwines_wine_id where null. Candidates are every
 *            corpus row whose winery shares the producer's rarest word;
 *            the producer matches on folded trigram ≥ 0.80 or whole-word
 *            containment ("Schramsberg" in "Schramsberg Vineyards"). The
 *            cuvée is accepted deterministically when name similarity ≥ 0.64
 *            or every significant word of the cellar name appears in the
 *            candidate with the runner-up ≥ 0.15 behind; otherwise a model
 *            adjudicates the producer's own rows (same cuvée or none), and
 *            every model pick is printed with its reason for a human to read
 *            before --confirm.
 *   colour   wines.colour where null: from the linked corpus type, else from
 *            a varietal table; unknown stays null and is listed.
 *   section  cellar_config.labels.sections (when empty) = the seed's names;
 *            inventory_items.section where null = sectionNameFor(wine).
 *   excerpt  wines.review_excerpt where null and not manually overridden,
 *            from the batched enrichment model (drink windows untouched).
 *   scan     invoice_scans stuck in "processing" > 1 h → failed / unexpected_error.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { getAnthropicClient } from "../src/lib/ai/anthropic-client.ts";
import { enrichWinesWithClaudeBatch } from "../src/lib/wine-intelligence/enrich-claude.ts";
import { SECTION_NAMES, sectionNameFor } from "./local/wine-sections.mjs";

config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const APPLY = process.argv.includes("--confirm");
if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing"); process.exit(1); }
if (APPLY && !process.env.PROD_SUPABASE_URL_PATTERN && process.env.ALLOW_PROD_SEED !== "yes") {
  console.error("Refusing --confirm without ALLOW_PROD_SEED=yes: this targets a hosted project deliberately."); process.exit(1);
}
console.log(`Target: ${url}\nMode:   ${APPLY ? "WRITE" : "dry run"}`);
const db = createClient(url, key);

const norm = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const tri = (s: string) => { const p = `  ${s} `; const g = new Set<string>(); for (let i = 0; i < p.length - 2; i++) g.add(p.slice(i, i + 3)); return g; };
const sim = (a: string, b: string) => { if (!a || !b) return 0; const A = tri(a), B = tri(b); let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n); };
const STOP = new Set(["the", "de", "la", "le", "du", "des", "di", "della", "del", "and", "of", "wine", "wines", "winery", "estate", "vineyard", "vineyards", "domaine", "chateau", "rouge", "red", "white", "blanc"]);
const words = (s: string) => norm(s).split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
const PRODUCER_FLOOR = 0.8, NAME_FLOOR = 0.64, MARGIN = 0.15;

const TYPE_COLOUR: Record<string, string> = { red: "red", white: "white", rose: "rose", rosé: "rose", sparkling: "sparkling", dessert: "dessert", "dessert/port": "fortified", fortified: "fortified" };
const VARIETAL_COLOUR: Array<[RegExp, string]> = [
  [/malbec|cabernet|merlot|syrah|shiraz|pinot noir|nebbiolo|sangiovese|tempranillo|grenache|zinfandel|corvina|mourv|carmen|nerello|gamay|barbera|primitivo|carignan|blend rouge/i, "red"],
  [/chardonnay|sauvignon blanc|riesling|gr[uü]ner|pinot gri|friulano|garganega|vermentino|ribolla|chenin|albari|viognier|semillon|muscat|branco|blanc/i, "white"],
];
const colourFor = (type: string | null, varietal: string | null, name: string): string | null => {
  if (type && TYPE_COLOUR[type.toLowerCase()]) return TYPE_COLOUR[type.toLowerCase()];
  if (/ros[eé]/i.test(name) || /ros[eé]/i.test(varietal ?? "")) return "rose";
  if (/brut|blanc de blancs|franciacorta|champagne|cr[ée]mant|cava|sparkling/i.test(name)) return "sparkling";
  if (/sauternes|late harvest|vin de constance|auslese|beerenauslese|ice ?wine|eiswein|passito|recioto/i.test(name)) return "dessert";
  for (const [re, c] of VARIETAL_COLOUR) if (re.test(varietal ?? "")) return c;
  return null;
};

type Wine = { id: string; producer: string; name: string; vintage: number | null; varietal: string | null; region: string | null; country: string | null; colour: string | null; review_excerpt: string | null; manual_overrides: Record<string, unknown> | null; canonical_wine_id: string | null; canonical_wines: { id: string; xwines_wine_id: number | null } | { id: string; xwines_wine_id: number | null }[] | null };
type Cand = { wine_id: number; name: string; winery_name: string; type: string | null; score: number; producer_score: number; name_score: number };

async function main() {
  const { data: demo, error: rErr } = await db.from("restaurants").select("id, name").ilike("name", "DEMO%").single();
  if (rErr || !demo) throw rErr ?? new Error("no DEMO tenant");
  console.log(`Tenant: ${demo.name} [${demo.id}]`);
  const { data: wineRows, error: wErr } = await db.from("wines").select("id, producer, name, vintage, varietal, region, country, colour, review_excerpt, manual_overrides, canonical_wine_id, canonical_wines(id, xwines_wine_id)").eq("restaurant_id", demo.id).order("name");
  if (wErr) throw wErr;
  const wines = (wineRows ?? []) as unknown as Wine[];
  const canonicalOf = (w: Wine) => (Array.isArray(w.canonical_wines) ? w.canonical_wines[0] : w.canonical_wines) ?? null;

  // ── 1. corpus links ──────────────────────────────────────────────────────
  const producerMatches = (cellar: string, winery: string) => {
    const a = words(cellar).join(" "), b = words(winery).join(" ");
    if (!a || !b) return false;
    if (sim(a, b) >= PRODUCER_FLOOR) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= 5 && ` ${long} `.includes(` ${short} `);
  };
  const rarestWord = (producer: string) => words(producer).sort((x, y) => x.length - y.length).at(-1) ?? norm(producer);
  // 0 means "none": a nullable integer becomes an anyOf in JSON Schema, which
  // the Gemini endpoints reject (OpenRouter then answers 200 with an error
  // body and the SDK parser throws on the missing content).
  const Pick = z.object({ wine_id: z.number().int().describe("The matching catalogue wine_id, or 0 if none is the same cuvée."), reason: z.string() });
  const adjudicate = async (w: Wine, cands: Cand[]): Promise<{ id: number | null; reason: string }> => {
    let r;
    try {
      r = await getAnthropicClient().messages.parse({
      model: "google/gemini-3.7-flash", max_tokens: 2000,
      output_config: { format: zodOutputFormat(Pick) },
      system: "You match a restaurant's cellar wine to a wine catalogue row. Pick the catalogue row only if it is the SAME cuvée from the SAME producer (a different bottling, vineyard, tier or colour from the same house is NOT a match). If none is clearly the same wine, answer wine_id 0. Vintage is not in the catalogue and does not matter.",
      messages: [{ role: "user", content: `Cellar wine: ${w.producer} / ${w.name} (${w.varietal ?? "?"}, ${w.region ?? "?"}, ${w.country ?? "?"}).\nCatalogue rows:\n${cands.map((c) => `- [${c.wine_id}] ${c.winery_name} / ${c.name} (${c.type ?? "?"})`).join("\n")}` }],
    });
    } catch (e) {
      return { id: null, reason: `adjudication failed: ${String((e as Error).message).slice(0, 80)}` };
    }
    const out = r.parsed_output;
    return { id: out?.wine_id ? out.wine_id : null, reason: out?.reason ?? "" };
  };
  const links: Array<{ wine: Wine; cand: Cand; why: string }> = [];
  const abstained: Array<{ wine: Wine; why: string }> = [];
  const typeById = new Map<string, string | null>();
  for (const w of wines) {
    const canon = canonicalOf(w);
    if (!canon) { abstained.push({ wine: w, why: "no canonical row" }); continue; }
    if (canon.xwines_wine_id != null) { abstained.push({ wine: w, why: `already linked → ${canon.xwines_wine_id}` }); continue; }
    if (/^test /i.test(w.producer)) { abstained.push({ wine: w, why: "test row" }); continue; }
    const { data: rows, error } = await db.from("xwines_catalog").select("wine_id, name, winery_name, type").ilike("winery_name", `%${rarestWord(w.producer)}%`).limit(80);
    if (error) throw error;
    const scored = ((rows ?? []) as Cand[]).filter((c) => producerMatches(w.producer, c.winery_name))
      .map((c) => ({ ...c, ns: sim(norm(w.name), norm(c.name)), contains: words(w.name).length > 0 && words(w.name).every((t) => norm(c.name).includes(t)) }))
      .sort((a, b) => b.ns - a.ns);
    if (scored.length === 0) { abstained.push({ wine: w, why: "no corpus row for this producer" }); continue; }
    const [top, second] = scored;
    const margin = top.ns - (second?.ns ?? 0);
    let chosen: (typeof top) | null = null; let why = "";
    if (top.ns >= NAME_FLOOR) { chosen = top; why = `name ${top.ns.toFixed(2)}`; }
    else if (top.contains && margin >= MARGIN) { chosen = top; why = `contains all words, margin ${margin.toFixed(2)}`; }
    else {
      const pick = await adjudicate(w, scored.slice(0, 12));
      const hit = pick.id != null ? scored.find((c) => c.wine_id === pick.id) : undefined;
      if (hit) { chosen = hit; why = `MODEL: ${pick.reason}`; }
      else abstained.push({ wine: w, why: `no same cuvée among ${scored.length} ${w.producer} rows (best "${top.name}" ${top.ns.toFixed(2)}; model: ${pick.reason || "none"})` });
    }
    if (chosen) { links.push({ wine: w, cand: chosen, why }); typeById.set(w.id, chosen.type); }
  }
  console.log(`\n== links: ${links.length} accepted, ${abstained.length} abstained`);
  for (const l of links) console.log(`  LINK  ${l.wine.producer} / ${l.wine.name}  →  [${l.cand.wine_id}] ${l.cand.winery_name} / ${l.cand.name} (${l.cand.type})  · ${l.why}`);
  for (const a of abstained) console.log(`  SKIP  ${a.wine.producer} / ${a.wine.name}  · ${a.why}`);

  // ── 2. colour ────────────────────────────────────────────────────────────
  const colourPlan = wines.filter((w) => !w.colour).map((w) => ({ w, colour: colourFor(typeById.get(w.id) ?? null, w.varietal, w.name) }));
  console.log(`\n== colour: ${colourPlan.filter((p) => p.colour).length} to set, ${colourPlan.filter((p) => !p.colour).length} unknown`);
  for (const p of colourPlan) console.log(`  ${p.colour ? "SET " : "??  "} ${p.w.producer} / ${p.w.name} → ${p.colour ?? "unknown"}`);

  // ── 3. sections ──────────────────────────────────────────────────────────
  const { data: cfg } = await db.from("cellar_config").select("restaurant_id, labels").eq("restaurant_id", demo.id).maybeSingle();
  const labels = (cfg?.labels ?? {}) as Record<string, unknown>;
  const sectionsEmpty = !Array.isArray(labels.sections) || labels.sections.length === 0;
  const { data: inv } = await db.from("inventory_items").select("id, wine_id, section").eq("restaurant_id", demo.id);
  const colourById = new Map(wines.map((w) => [w.id, w.colour ?? colourPlan.find((p) => p.w.id === w.id)?.colour ?? null]));
  const sectionPlan = (inv ?? []).filter((i) => !i.section).map((i) => { const w = wines.find((x) => x.id === i.wine_id); const s = w ? sectionNameFor({ colour: colourById.get(w.id), country: w.country })[0] : null; return { i, s }; });
  console.log(`\n== sections: config ${sectionsEmpty ? "EMPTY → set " + SECTION_NAMES.length + " names" : "already set"}; ${sectionPlan.filter((p) => p.s).length} inventory rows to file, ${sectionPlan.filter((p) => !p.s).length} without a colour`);

  // ── 4. excerpts ──────────────────────────────────────────────────────────
  const needExcerpt = wines.filter((w) => !w.review_excerpt && !(w.manual_overrides && "review_excerpt" in w.manual_overrides) && !/^test /i.test(w.producer));
  console.log(`\n== excerpts: ${needExcerpt.length} wines without a tasting excerpt`);

  // ── 5. stuck scans ───────────────────────────────────────────────────────
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: stuck } = await db.from("invoice_scans").select("id, created_at").eq("restaurant_id", demo.id).eq("status", "processing").lt("created_at", cutoff);
  console.log(`\n== stuck scans: ${(stuck ?? []).length}`);
  for (const s of stuck ?? []) console.log(`  ${s.id} processing since ${s.created_at}`);

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --confirm (and ALLOW_PROD_SEED=yes) to apply."); process.exit(0); }

  // ── apply ────────────────────────────────────────────────────────────────
  let n = 0;
  for (const l of links) { const canon = canonicalOf(l.wine)!; const { error } = await db.from("canonical_wines").update({ xwines_wine_id: l.cand.wine_id }).eq("id", canon.id).is("xwines_wine_id", null); if (error) throw error; n++; }
  console.log(`linked ${n}`);
  n = 0;
  for (const p of colourPlan) if (p.colour) { const { error } = await db.from("wines").update({ colour: p.colour }).eq("id", p.w.id).is("colour", null); if (error) throw error; n++; }
  console.log(`coloured ${n}`);
  if (sectionsEmpty) {
    const next = { ...labels, sections: SECTION_NAMES };
    const { error } = cfg
      ? await db.from("cellar_config").update({ labels: next }).eq("restaurant_id", demo.id)
      : await db.from("cellar_config").insert({ restaurant_id: demo.id, labels: next });
    if (error) throw error;
    console.log(`section names set`);
  }
  n = 0;
  for (const p of sectionPlan) if (p.s) { const { error } = await db.from("inventory_items").update({ section: p.s }).eq("id", p.i.id).is("section", null); if (error) throw error; n++; }
  console.log(`filed ${n} inventory rows`);
  if (needExcerpt.length > 0) {
    const results = await enrichWinesWithClaudeBatch(needExcerpt.map((w) => ({ producer: w.producer, name: w.name, vintage: w.vintage, varietal: w.varietal, region: w.region, country: w.country })));
    n = 0;
    for (let i = 0; i < needExcerpt.length; i++) { const r = results[i]; if (!r?.reviewExcerpt) continue; const { error } = await db.from("wines").update({ review_excerpt: r.reviewExcerpt.slice(0, 200) }).eq("id", needExcerpt[i].id).is("review_excerpt", null); if (error) throw error; n++; }
    console.log(`excerpts written ${n} of ${needExcerpt.length}`);
  }
  for (const s of stuck ?? []) { const { error } = await db.from("invoice_scans").update({ status: "failed", status_reason: "unexpected_error" }).eq("id", s.id).eq("status", "processing"); if (error) throw error; console.log(`scan ${s.id} → failed`); }
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
