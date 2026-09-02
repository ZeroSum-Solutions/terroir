/**
 * Bottle-label reading eval — the labelled set `models.ts` asked for.
 *
 * Sends corpus label images through the production bottle-scan prompt, schema,
 * effort and cap (the same call /api/scan-bottle makes, minus the route) to one
 * or more OpenRouter models, and scores producer / name / country against the
 * corpus row. Results and method: docs/plans/2026-09-02-bottle-scan-model-eval.md.
 *
 * Usage (local stack up, OPENROUTER_API_KEY in the shell):
 *   npx tsx scripts/eval-bottle-labels.ts                      # 40 images, the 2026-09-02 model list
 *   EVAL_MODELS=google/gemini-3.7-flash EVAL_N=16 npx tsx scripts/eval-bottle-labels.ts
 *   EVAL_DIR=/path/to/degraded npx tsx scripts/eval-bottle-labels.ts   # read <wine_id>.jpeg from a directory
 *   EVAL_EFFORT=medium npx tsx scripts/eval-bottle-labels.ts            # override the profile's effort (incumbent runs)
 *
 * Reads the local Supabase stack only (loopback URL enforced): the labelled rows
 * come from xwines_catalog, which production also holds, but this is a spend
 * tool and never needs a hosted target. Writes eval-bottle-labels.<tag>.json.
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { getAnthropicClient } from "../src/lib/ai/anthropic-client.ts";
import { BOTTLE_SCAN } from "../src/lib/ai/models.ts";
import { ParsedBottleLabelSchema } from "../src/lib/scanner/bottle-schema.ts";
import { BOTTLE_SYSTEM_PROMPT } from "../src/lib/scanner/bottle-system-prompt.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url) || !key) {
  console.error("eval-bottle-labels: needs the LOCAL stack — NEXT_PUBLIC_SUPABASE_URL must be loopback and SUPABASE_SERVICE_ROLE_KEY set.");
  process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error("eval-bottle-labels: OPENROUTER_API_KEY is not set.");
  process.exit(1);
}

const MODELS = (process.env.EVAL_MODELS ?? [
  BOTTLE_SCAN.model,
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-sol",
  "x-ai/grok-4.6",
  "anthropic/claude-opus-5",
].join(",")).split(",").filter((m, i, a) => a.indexOf(m) === i);
const N = Number(process.env.EVAL_N ?? 40);
const TAG = process.env.EVAL_TAG ?? "main";
const EFFORT = (process.env.EVAL_EFFORT as typeof BOTTLE_SCAN.effort | undefined) ?? BOTTLE_SCAN.effort;
const CONCURRENCY = 4;

type Row = { wine_id: number; name: string | null; winery_name: string | null; country: string | null; image_url: string };

const STOP = new Set(["wine", "wines", "winery", "estate", "estates", "domaine", "chateau", "bodega", "bodegas", "vineyard", "vineyards", "cellars", "cellar", "family", "the", "de", "la", "le", "du", "des", "di", "della", "del", "and", "of", "cantina", "tenuta", "weingut", "vina", "vinos"]);
const norm = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const toks = (s: string) => new Set(norm(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t)));
const overlap = (a: string, b: string) => { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let n = 0; for (const t of A) if (B.has(t)) n++; return n / Math.min(A.size, B.size); };
const squash = (s: string) => s.replace(/ /g, "");
/** Containment either way (also with spaces removed: "DeLoach" vs "De Loach"), or ≥ 50 % of the significant tokens shared. */
const hit = (pred: string | null | undefined, truth: string | null) => { const a = norm(pred), b = norm(truth); return Boolean(a && b && (a.includes(b) || b.includes(a) || squash(a).includes(squash(b)) || squash(b).includes(squash(a)) || overlap(a, b) >= 0.5)); };

async function loadRows(): Promise<Row[]> {
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from("xwines_catalog")
    .select("wine_id, name, winery_name, country, image_url")
    .eq("image_kind", "label")
    .not("image_url", "is", null)
    .not("rating_count", "is", null)
    .limit(5000);
  if (error) throw error;
  // Fixed pseudo-random order so reruns see the same sample: sort by an FNV hash of the id.
  const h = (n: number) => { let x = 2166136261; for (const ch of String(n)) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; } return x; };
  return ((data ?? []) as Row[]).sort((a, b) => h(a.wine_id) - h(b.wine_id)).slice(0, N);
}

async function imageBase64(row: Row): Promise<string> {
  if (process.env.EVAL_DIR) return readFileSync(`${process.env.EVAL_DIR}/${row.wine_id}.jpeg`).toString("base64");
  return Buffer.from(await (await fetch(row.image_url)).arrayBuffer()).toString("base64");
}

async function one(model: string, row: Row) {
  const client = getAnthropicClient();
  const t = Date.now();
  try {
    const r = await client.messages.parse({
      model,
      max_tokens: BOTTLE_SCAN.maxTokens,
      output_config: { format: zodOutputFormat(ParsedBottleLabelSchema), effort: EFFORT },
      system: BOTTLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await imageBase64(row) } }, { type: "text", text: "Identify this wine from its bottle label." }] }],
    });
    const c = r.parsed_output?.candidates?.[0];
    const cost = (r.usage as { cost?: number } | undefined)?.cost ?? null;
    return { model, wine_id: row.wine_id, ms: Date.now() - t, cost, ok: Boolean(c), error: null as string | null,
      producerHit: hit(c?.producer, row.winery_name), nameHit: hit(c?.name, row.name) || hit(`${c?.producer ?? ""} ${c?.name ?? ""}`, row.name),
      countryHit: norm(c?.country) === norm(row.country), confidence: c?.confidence ?? null,
      pred: c ? { producer: c.producer, name: c.name, country: c.country } : null, truth: { producer: row.winery_name, name: row.name, country: row.country } };
  } catch (e) {
    const err = e as { constructor?: { name?: string }; status?: number; message?: string };
    return { model, wine_id: row.wine_id, ms: Date.now() - t, cost: null, ok: false, error: `${err.constructor?.name ?? "Error"} ${err.status ?? ""} ${String(err.message).slice(0, 120)}`,
      producerHit: false, nameHit: false, countryHit: false, confidence: null, pred: null, truth: { producer: row.winery_name, name: row.name, country: row.country } };
  }
}

async function main() {
  const rows = await loadRows();
  console.log(`eval-bottle-labels: ${rows.length} images × ${MODELS.length} models (${TAG})`);
  const results: Awaited<ReturnType<typeof one>>[] = [];
  for (const model of MODELS) {
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      results.push(...(await Promise.all(rows.slice(i, i + CONCURRENCY).map((row) => one(model, row)))));
    }
    const rs = results.filter((r) => r.model === model);
    const pct = (k: "ok" | "producerHit" | "nameHit" | "countryHit") => Math.round((100 * rs.filter((r) => r[k]).length) / rs.length);
    const p50 = rs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)];
    const cost = rs.reduce((s, r) => s + (r.cost ?? 0), 0) / rs.length;
    console.log(`${model.padEnd(30)} n=${rs.length} ok=${pct("ok")}% producer=${pct("producerHit")}% name=${pct("nameHit")}% country=${pct("countryHit")}% p50=${p50}ms cost/call=$${cost.toFixed(4)} errors=${rs.filter((r) => r.error).length}`);
    writeFileSync(`eval-bottle-labels.${TAG}.json`, JSON.stringify(results, null, 1));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
