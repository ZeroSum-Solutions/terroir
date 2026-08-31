/**
 * WS-IDENT QA harness (docs/plans/2026-08-31-ws-ident-identity-policy.md §4).
 *
 * Usage:
 *   npx tsx scripts/qa-lwin-xwines-linkage.ts negative [--n=120] [--seed=42]
 *   npx tsx scripts/qa-lwin-xwines-linkage.ts sample --run=<run-id> [--n=200] [--seed=42] [--out=<dir>]
 *
 * `negative` — the release blocker. Builds ≥100 same-producer/wrong-cuvée
 * pairs from the corpus's own naming (the Aug-29 risk classes: colour
 * triplets and qualifier siblings — Riserva/normale, village vs
 * vineyard-designate), asks the LIVE matcher for candidates as if the true
 * row were absent, and runs the exact decision rule the batch runs. Any
 * ACCEPTED outcome is a failure and the process exits 1. The exact-join pass
 * is not exercised here by construction: it can only fire on a normalized
 * name equal to the query's, and same-name corpus duplicates are excluded
 * from the pair set — the risk this set measures lives entirely in the
 * scored pass.
 *
 * `sample` — generates the 200-link positive review checklist for a
 * completed run, stratified by score band and country, deterministic for a
 * given seed so a re-generated sample reviews the same links. The ≥98%
 * correctness bar is a human judgement recorded on the emitted file.
 *
 * Read-only against the database in both modes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import type { Database } from "../src/types/database";
import { normalizeProducerOrCuvee } from "../src/domains/identity/normalize";
import {
  LINKAGE_RULE_VERSION,
  decideLinkage,
  type LinkageCandidate,
} from "../src/lib/wine-intelligence/xwines-linkage";
import {
  classifySiblingPair,
  scoreBandLabel,
  stratifiedSample,
} from "../src/lib/wine-intelligence/xwines-linkage-run";

config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PAGE = 1000;

const mode = process.argv[2];
const argOf = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const seed = Number(argOf("seed") ?? 42);

const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function pageThrough<T>(
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

type CorpusRow = { wine_id: number; winery_name: string | null; name: string; country: string | null };
type NegativePair = { winery: string; a: CorpusRow; b: CorpusRow; klass: "colour" | "qualifier" };

async function loadCorpus(): Promise<CorpusRow[]> {
  return pageThrough((from, to) =>
    db.from("xwines_catalog").select("wine_id, winery_name, name, country").order("wine_id").range(from, to),
  );
}

function buildNegativePairs(corpus: CorpusRow[], n: number): NegativePair[] {
  const byWinery = new Map<string, CorpusRow[]>();
  for (const row of corpus) {
    if (row.winery_name === null) continue;
    const bucket = byWinery.get(row.winery_name);
    if (bucket) bucket.push(row);
    else byWinery.set(row.winery_name, [row]);
  }
  const pairs: NegativePair[] = [];
  for (const [winery, wines] of [...byWinery.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (wines.length < 2 || wines.length > 12) continue;
    const sorted = [...wines].sort((x, y) => x.wine_id - y.wine_id);
    for (const a of sorted) {
      for (const b of sorted) {
        if (a.wine_id === b.wine_id) continue;
        if (normalizeProducerOrCuvee(a.name) === normalizeProducerOrCuvee(b.name)) continue;
        const klass = classifySiblingPair(a.name, b.name);
        if (klass !== null) pairs.push({ winery, a, b, klass });
      }
    }
  }
  return stratifiedSample(pairs, (p) => p.klass, n, seed);
}

async function runNegative() {
  const n = Number(argOf("n") ?? 120);
  console.log(`Target: ${SUPABASE_URL}`);
  console.log(`Rule:   ${LINKAGE_RULE_VERSION}`);
  console.log("Building the same-producer/wrong-cuvée pair set…");
  const corpus = await loadCorpus();
  const pairs = buildNegativePairs(corpus, n);
  const byClass = { colour: 0, qualifier: 0 };
  for (const p of pairs) byClass[p.klass]++;
  console.log(`Selected ${pairs.length} pairs (colour ${byClass.colour}, qualifier ${byClass.qualifier}).`);
  if (pairs.length < 100) {
    console.error(`FAIL: pair set has ${pairs.length} < 100 pairs — §4 requires at least 100.`);
    process.exit(1);
  }

  const failures: Array<{ pair: NegativePair; accepted: LinkageCandidate }> = [];
  let review = 0;
  let abstained = 0;
  for (let i = 0; i < pairs.length; i++) {
    const { winery, a } = pairs[i];
    const { data, error } = await db.rpc("match_xwines", {
      p_producer: winery,
      p_name: a.name,
      p_threshold: 0.3,
      p_limit: 5,
    });
    if (error) throw new Error(`match_xwines failed: ${error.message}`);
    const queryNameNorm = normalizeProducerOrCuvee(a.name);
    // Simulate "our bottle is A and A is absent from the corpus": drop A's own
    // row and any duplicate corpus entry of the same cuvée name.
    const candidates: LinkageCandidate[] = (data ?? [])
      .filter((c) => c.wine_id !== a.wine_id && normalizeProducerOrCuvee(c.name) !== queryNameNorm)
      .map((c) => ({ wineId: c.wine_id, name: c.name, regionName: c.region_name, country: c.country, score: c.score, producerScore: c.producer_score, nameScore: c.name_score }));
    const decision = decideLinkage({ cuvee: a.name, tail: null }, candidates);
    if (decision.status === "accepted") failures.push({ pair: pairs[i], accepted: decision.candidate });
    else if (decision.status === "review") review++;
    else abstained++;
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${pairs.length}…`);
  }

  console.log("");
  console.log(`Outcomes: accepted ${failures.length}, review ${review}, abstained ${abstained}.`);
  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.length} pair(s) auto-accepted a wrong cuvée — release blocker (§4):`);
    for (const f of failures) {
      const linked = corpus.find((r) => r.wine_id === f.accepted.wineId);
      console.error(
        `  [${f.pair.klass}] ${f.pair.winery} / "${f.pair.a.name}" -> accepted "${linked?.name}" ` +
          `(score ${f.accepted.score.toFixed(3)}, producer ${f.accepted.producerScore.toFixed(3)}, name ${f.accepted.nameScore.toFixed(3)})`,
      );
    }
    process.exit(1);
  }
  console.log("PASS: zero acceptances on the negative-pair set.");
}

async function runSample() {
  const runId = argOf("run");
  const n = Number(argOf("n") ?? 200);
  if (!runId) {
    console.error("sample mode needs --run=<run-id>.");
    process.exit(1);
  }
  const links = await pageThrough((from, to) =>
    db
      .from("lwin_xwines_links")
      .select("lwin_id, xwines_wine_id, method, score, producer_score, name_score, second_score")
      .eq("run_id", runId)
      .eq("status", "accepted")
      .order("lwin_id")
      .range(from, to),
  );
  if (links.length === 0) {
    console.error(`No accepted links for run ${runId}.`);
    process.exit(1);
  }
  const lwinRows = await pageThrough((from, to) =>
    db.from("lwin_catalog").select("lwin_id, display_name, producer, country").order("lwin_id").range(from, to),
  );
  const lwinById = new Map(lwinRows.map((r) => [r.lwin_id, r]));
  const corpus = await loadCorpus();
  const corpusById = new Map(corpus.map((r) => [r.wine_id, r]));

  const stratum = (l: (typeof links)[number]) => {
    const band = l.method === "exact" ? "exact" : scoreBandLabel(l.score ?? 0);
    return `${band}|${lwinById.get(l.lwin_id)?.country ?? "(none)"}`;
  };
  const sample = stratifiedSample(links, stratum, n, seed);

  const lines: string[] = [];
  lines.push(`# WS-IDENT positive sample — run ${runId}`);
  lines.push("");
  lines.push(`${sample.length} of ${links.length} accepted links, stratified by score band × country, seed ${seed}.`);
  lines.push("Review each row; tick the box when the link is CORRECT. The §4 bar is ≥98%");
  lines.push("correct — 5+ wrong rows in a 200-row sample means thresholds tighten and the");
  lines.push("run re-executes. Record wrong pairs as tombstones before re-running.");
  lines.push("");
  for (const link of sample) {
    const lwin = lwinById.get(link.lwin_id);
    const xw = corpusById.get(link.xwines_wine_id!);
    const scores =
      link.method === "exact"
        ? "exact"
        : `s=${link.score?.toFixed(3)} p=${link.producer_score?.toFixed(3)} n=${link.name_score?.toFixed(3)}`;
    lines.push(
      `- [ ] \`${link.lwin_id}\` ${lwin?.producer ?? "?"} — “${lwin?.display_name}” ↔ ` +
        `${xw?.winery_name ?? "?"} — “${xw?.name}” (xw ${link.xwines_wine_id}, ${scores})`,
    );
  }
  lines.push("");

  const outDir = argOf("out") ?? join("docs", "plans", "ws-ident-runs", `${new Date().toISOString().slice(0, 10)}-${runId.slice(0, 8)}`);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "positive-sample.md");
  writeFileSync(outPath, lines.join("\n"));
  console.log(`Wrote ${sample.length}-link review checklist to ${outPath}`);
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (mode === "negative") await runNegative();
  else if (mode === "sample") await runSample();
  else {
    console.error("Usage: qa-lwin-xwines-linkage.ts <negative|sample> [--n=] [--seed=] [--run=] [--out=]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
