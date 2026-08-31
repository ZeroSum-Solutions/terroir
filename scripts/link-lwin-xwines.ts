/**
 * WS-IDENT P0 — batch LWIN ↔ X-Wines linkage
 * (docs/plans/2026-08-31-ws-ident-identity-policy.md §2–§3, §5–§6).
 *
 * Usage:
 *   npx tsx scripts/link-lwin-xwines.ts                     # dry run (default): first 300 rows, no writes
 *   npx tsx scripts/link-lwin-xwines.ts --limit=2000        # dry run over more rows
 *   npx tsx scripts/link-lwin-xwines.ts --confirm           # full run: writes links + report
 *   npx tsx scripts/link-lwin-xwines.ts --confirm --resume=<run-id>   # continue an interrupted run
 *
 * What a confirmed run does, in order:
 *   1. Seed pass: exact join on identity-normalized (producer, cuvée) — both
 *      the display-segment honorific form and the bare producer column are
 *      tried. A contested key falls through to the scored pass.
 *   2. Trigram pass: match_xwines top-5 per remaining row; the decision is
 *      decideLinkage() — the xwines-profile.ts floors plus the ambiguity
 *      guard, review margin and tombstone rules. One rule, one implementation.
 *   3. Propagation: canonical_wines rows carrying an lwin7 whose link was
 *      accepted inherit xwines_wine_id (only where currently null — an
 *      existing link is a human's work and is never overwritten here).
 *   4. Coverage report committed to docs/plans/ws-ident-runs/ (§4): every
 *      excluded/abstained count stated — silent truncation is forbidden.
 *
 * Abstention is stored as a first-class row, never inferred from absence. A
 * failed RPC is retried, then ABORTS the run (resumable) rather than being
 * recorded as an abstention it is not.
 *
 * Safeguards mirror scripts/seed-xwines.ts (BND-021 / INT-011): dry run by
 * default; prod host block via PROD_SUPABASE_URL_PATTERN failing CLOSED,
 * overridable only with ALLOW_PROD_SEED=yes; startup banner names the target.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import type { Database } from "../src/types/database";
import {
  LINKAGE_RULE_VERSION,
  XWINES_AMBIGUITY_GAP,
  XWINES_REVIEW_MARGIN,
  buildLwinLinkageQuery,
  decideLinkage,
  tailAccounted,
  type LinkageCandidate,
  type LinkageDecision,
} from "../src/lib/wine-intelligence/xwines-linkage";
import {
  XWINES_NAME_FLOOR,
  XWINES_PRODUCER_FLOOR,
  XWINES_SCORE_FLOOR,
} from "../src/lib/wine-intelligence/xwines-profile";
import {
  buildXwinesExactIndex,
  lookupExact,
  scoreBandLabel,
} from "../src/lib/wine-intelligence/xwines-linkage-run";

config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PROD_URL_PATTERN = process.env.PROD_SUPABASE_URL_PATTERN ?? "";
const ALLOW_PROD_SEED = process.env.ALLOW_PROD_SEED === "yes";

const MATCH_THRESHOLD = 0.3;
const MATCH_LIMIT = 5;
const PAGE = 1000; // PostgREST max_rows
const UPSERT_BATCH = 500;
const CONCURRENCY = 8;

const confirm = process.argv.includes("--confirm");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const dryRunLimit = limitArg ? Number(limitArg.split("=")[1]) : 300;
const resumeArg = process.argv.find((a) => a.startsWith("--resume="));
const resumeRunId = resumeArg ? resumeArg.split("=")[1] : null;

type Db = SupabaseClient<Database>;
type LinkRow = Database["public"]["Tables"]["lwin_xwines_links"]["Insert"];

type Counts = {
  processed: number;
  excludedNoQuery: number; // blank producer or no cuvée text (§6 / nothing to match)
  acceptedExact: number;
  acceptedTrigram: number;
  review: Record<"ambiguous" | "near-floor" | "tombstoned" | "name-mismatch", number>;
  abstained: Record<"no-candidates" | "floor-miss" | "name-mismatch", number>;
  exactContested: number; // exact key claimed by >1 corpus row → scored pass
  histogram: Map<string, number>;
  byCountry: Map<string, { accepted: number; review: number; abstained: number }>;
};

function newCounts(): Counts {
  return {
    processed: 0,
    excludedNoQuery: 0,
    acceptedExact: 0,
    acceptedTrigram: 0,
    review: { ambiguous: 0, "near-floor": 0, tombstoned: 0, "name-mismatch": 0 },
    abstained: { "no-candidates": 0, "floor-miss": 0, "name-mismatch": 0 },
    exactContested: 0,
    histogram: new Map(),
    byCountry: new Map(),
  };
}

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

async function matchWithRetry(
  db: Db,
  producer: string,
  cuvee: string,
): Promise<LinkageCandidate[]> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await db.rpc("match_xwines", {
      p_producer: producer,
      p_name: cuvee,
      p_threshold: MATCH_THRESHOLD,
      p_limit: MATCH_LIMIT,
    });
    if (!error) {
      return (data ?? []).map((c) => ({
        wineId: c.wine_id,
        name: c.name,
        regionName: c.region_name,
        country: c.country,
        score: c.score,
        producerScore: c.producer_score,
        nameScore: c.name_score,
      }));
    }
    lastError = error.message;
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  // Aborting keeps the run honest: an RPC failure is not an abstention, and
  // --resume continues from the rows already decided.
  throw new Error(`match_xwines failed after 3 attempts (${producer} / ${cuvee}): ${lastError}`);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(lanes);
  return results;
}

type LwinRow = { lwin_id: string; display_name: string; producer: string | null; country: string | null };

function tally(counts: Counts, row: LwinRow, link: LinkRow) {
  counts.processed++;
  const country = row.country ?? "(none)";
  const c = counts.byCountry.get(country) ?? { accepted: 0, review: 0, abstained: 0 };
  if (link.status === "accepted") c.accepted++;
  else if (link.status === "review") c.review++;
  else c.abstained++;
  counts.byCountry.set(country, c);
  if (typeof link.score === "number") {
    const band = scoreBandLabel(link.score);
    counts.histogram.set(band, (counts.histogram.get(band) ?? 0) + 1);
  }
}

function decisionToRow(lwinId: string, runId: string, decision: LinkageDecision): LinkRow {
  if (decision.status === "accepted") {
    return {
      lwin_id: lwinId,
      run_id: runId,
      status: "accepted",
      method: "trigram",
      xwines_wine_id: decision.candidate.wineId,
      score: decision.candidate.score,
      producer_score: decision.candidate.producerScore,
      name_score: decision.candidate.nameScore,
      second_score: decision.secondScore,
    };
  }
  if (decision.status === "review") {
    return {
      lwin_id: lwinId,
      run_id: runId,
      status: "review",
      method: "trigram",
      review_reason: decision.reason,
      xwines_wine_id: decision.candidate.wineId,
      score: decision.candidate.score,
      producer_score: decision.candidate.producerScore,
      name_score: decision.candidate.nameScore,
      second_score: decision.secondScore,
    };
  }
  return { lwin_id: lwinId, run_id: runId, status: "abstained" };
}

function renderReport(runId: string, counts: Counts, extra: { totalLwin: number; skippedResumed: number; propagated: number }): string {
  const lines: string[] = [];
  lines.push(`# WS-IDENT linkage run ${runId}`);
  lines.push("");
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Rule: \`${LINKAGE_RULE_VERSION}\``);
  lines.push("");
  lines.push("## Outcomes");
  lines.push("");
  lines.push(`- lwin_catalog rows: ${extra.totalLwin}`);
  lines.push(`- previously decided in this run (resume skip): ${extra.skippedResumed}`);
  lines.push(`- processed this invocation: ${counts.processed}`);
  lines.push(`- abstained, nothing to match (blank producer / no cuvée text): ${counts.excludedNoQuery}`);
  lines.push(`- accepted (exact join): ${counts.acceptedExact}`);
  lines.push(`- accepted (trigram): ${counts.acceptedTrigram}`);
  lines.push(`- review — ambiguous: ${counts.review.ambiguous}, near-floor: ${counts.review["near-floor"]}, name-mismatch: ${counts.review["name-mismatch"]}, tombstoned: ${counts.review.tombstoned}`);
  lines.push(`- abstained — no candidates: ${counts.abstained["no-candidates"]}, floor miss: ${counts.abstained["floor-miss"]}, name-mismatch: ${counts.abstained["name-mismatch"]}`);
  lines.push(`- exact keys contested by >1 corpus row (sent to scored pass): ${counts.exactContested}`);
  lines.push(`- canonical_wines rows propagated: ${extra.propagated}`);
  lines.push("");
  lines.push("## Blended-score histogram (rows carrying a score)");
  lines.push("");
  for (const band of ["<0.65", "0.65–0.75", "0.75–0.85", "0.85–0.95", "0.95–1.00"]) {
    lines.push(`- ${band}: ${counts.histogram.get(band) ?? 0}`);
  }
  lines.push("");
  lines.push("## By country (top 25 by volume)");
  lines.push("");
  lines.push("| Country | Accepted | Review | Abstained |");
  lines.push("|---|---|---|---|");
  const rows = [...counts.byCountry.entries()]
    .sort((a, b) => b[1].accepted + b[1].review + b[1].abstained - (a[1].accepted + a[1].review + a[1].abstained))
    .slice(0, 25);
  for (const [country, c] of rows) {
    lines.push(`| ${country} | ${c.accepted} | ${c.review} | ${c.abstained} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  console.log(`Target: ${SUPABASE_URL}`);
  console.log(`Rule:   ${LINKAGE_RULE_VERSION}`);
  console.log(confirm ? "Mode:   CONFIRMED (writes enabled)" : `Mode:   dry run (first ${dryRunLimit} rows, no writes)`);

  if (confirm) {
    if (!PROD_URL_PATTERN && !ALLOW_PROD_SEED) {
      console.error("PROD_SUPABASE_URL_PATTERN unset - refusing --confirm (fail closed). Set it, or ALLOW_PROD_SEED=yes.");
      process.exit(1);
    }
    if (PROD_URL_PATTERN && new RegExp(PROD_URL_PATTERN).test(SUPABASE_URL) && !ALLOW_PROD_SEED) {
      console.error("Target matches PROD_SUPABASE_URL_PATTERN - refusing without ALLOW_PROD_SEED=yes.");
      process.exit(1);
    }
  }

  const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Run record (confirmed only).
  let runId = "dry-run";
  if (confirm) {
    if (resumeRunId) {
      const { data, error } = await db.from("xwines_link_runs").select("id, rule_version").eq("id", resumeRunId).single();
      if (error || !data) throw new Error(`resume run not found: ${resumeRunId}`);
      if (data.rule_version !== LINKAGE_RULE_VERSION) {
        throw new Error(`resume refused: run rule "${data.rule_version}" != current "${LINKAGE_RULE_VERSION}" - start a new run.`);
      }
      runId = data.id;
    } else {
      const { data, error } = await db
        .from("xwines_link_runs")
        .insert({
          rule_version: LINKAGE_RULE_VERSION,
          params: {
            floors: { score: XWINES_SCORE_FLOOR, producer: XWINES_PRODUCER_FLOOR, name: XWINES_NAME_FLOOR },
            ambiguityGap: XWINES_AMBIGUITY_GAP,
            reviewMargin: XWINES_REVIEW_MARGIN,
            matchThreshold: MATCH_THRESHOLD,
            matchLimit: MATCH_LIMIT,
          },
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`failed to create run: ${error?.message}`);
      runId = data.id;
    }
    console.log(`Run:    ${runId}`);
  }

  console.log("Loading corpora…");
  const xwines = await pageThrough((from, to) =>
    db.from("xwines_catalog").select("wine_id, winery_name, name, region_name, country").order("wine_id").range(from, to),
  );
  const exactIndex = buildXwinesExactIndex(
    xwines.map((r) => ({ wineId: r.wine_id, wineryName: r.winery_name, name: r.name })),
  );
  const xwinesGeo = new Map(xwines.map((r) => [r.wine_id, { regionName: r.region_name, country: r.country }]));
  const lwin = await pageThrough<LwinRow>((from, to) =>
    db.from("lwin_catalog").select("lwin_id, display_name, producer, country").order("lwin_id").range(from, to),
  );
  const tombstoneRows = await pageThrough((from, to) =>
    db.from("lwin_xwines_link_tombstones").select("lwin_id, xwines_wine_id").order("lwin_id").range(from, to),
  );
  const tombstones = new Map<string, Set<number>>();
  for (const t of tombstoneRows) {
    const set = tombstones.get(t.lwin_id) ?? new Set<number>();
    set.add(t.xwines_wine_id);
    tombstones.set(t.lwin_id, set);
  }
  console.log(`Loaded ${lwin.length} LWIN rows, ${xwines.length} corpus rows (${exactIndex.size} exact keys), ${tombstoneRows.length} tombstones.`);

  let alreadyDecided = new Set<string>();
  if (confirm && resumeRunId) {
    const done = await pageThrough((from, to) =>
      db.from("lwin_xwines_links").select("lwin_id").eq("run_id", runId).order("lwin_id").range(from, to),
    );
    alreadyDecided = new Set(done.map((d) => d.lwin_id));
    console.log(`Resuming: ${alreadyDecided.size} rows already decided in this run.`);
  }

  const todo = (confirm ? lwin : lwin.slice(0, dryRunLimit)).filter((r) => !alreadyDecided.has(r.lwin_id));
  const counts = newCounts();
  let buffer: LinkRow[] = [];

  const flush = async () => {
    if (!confirm || buffer.length === 0) return;
    const { error } = await db.from("lwin_xwines_links").upsert(buffer, { onConflict: "lwin_id" });
    if (error) throw new Error(`upsert failed: ${error.message}`);
    buffer = [];
  };

  for (let offset = 0; offset < todo.length; offset += UPSERT_BATCH) {
    const chunk = todo.slice(offset, offset + UPSERT_BATCH);
    const rows = await mapWithConcurrency(
      chunk,
      async (row): Promise<LinkRow> => {
        const query = buildLwinLinkageQuery(row.display_name, row.producer);
        if (query === null) {
          counts.excludedNoQuery++;
          return { lwin_id: row.lwin_id, run_id: runId, status: "abstained" };
        }
        const producerForms = [query.producer, ...(row.producer && row.producer.trim() !== query.producer ? [row.producer.trim()] : [])];
        // Exact pass mirrors the decision rule's tail-accounting: the
        // full-form key (tail named by the corpus) is the strongest claim; a
        // bare-form hit counts only when the tail is geography the corpus row
        // itself carries — otherwise the scored pass decides (and reviews).
        let exact: { wineId: number } | null = null;
        if (query.tail !== null) {
          const full = lookupExact(exactIndex, producerForms, `${query.cuvee} ${query.tail}`);
          if (full !== null && full !== "ambiguous") exact = full;
        }
        if (exact === null) {
          const bare = lookupExact(exactIndex, producerForms, query.cuvee);
          if (bare === "ambiguous") counts.exactContested++;
          else if (bare !== null) {
            const geo = xwinesGeo.get(bare.wineId);
            if (query.tail === null || tailAccounted(query.tail, geo?.regionName ?? null, geo?.country ?? null)) {
              exact = bare;
            }
          }
        }
        if (exact !== null) {
          if (tombstones.get(row.lwin_id)?.has(exact.wineId)) {
            counts.review.tombstoned++;
            return {
              lwin_id: row.lwin_id, run_id: runId, status: "review", method: "exact",
              review_reason: "tombstoned", xwines_wine_id: exact.wineId,
            };
          }
          counts.acceptedExact++;
          return { lwin_id: row.lwin_id, run_id: runId, status: "accepted", method: "exact", xwines_wine_id: exact.wineId };
        }

        const candidates = await matchWithRetry(db, query.producer, query.cuvee);
        const decision = decideLinkage({ cuvee: query.cuvee, tail: query.tail }, candidates, tombstones.get(row.lwin_id));
        if (decision.status === "accepted") counts.acceptedTrigram++;
        else if (decision.status === "review") counts.review[decision.reason]++;
        else counts.abstained[decision.reason]++;
        return decisionToRow(row.lwin_id, runId, decision);
      },
      CONCURRENCY,
    );
    for (let i = 0; i < rows.length; i++) tally(counts, chunk[i], rows[i]);
    buffer.push(...rows);
    await flush();
    const done = Math.min(offset + UPSERT_BATCH, todo.length);
    if (done % 5000 < UPSERT_BATCH || done === todo.length) {
      const reviewTotal = counts.review.ambiguous + counts.review["near-floor"] + counts.review["name-mismatch"] + counts.review.tombstoned;
      const abstainTotal = counts.excludedNoQuery + counts.abstained["no-candidates"] + counts.abstained["floor-miss"] + counts.abstained["name-mismatch"];
      console.log(`  ${done}/${todo.length} decided (accepted ${counts.acceptedExact + counts.acceptedTrigram}, review ${reviewTotal}, abstained ${abstainTotal})`);
    }
  }

  // Propagation: spine rows with an lwin7 inherit an accepted link, only
  // where no link exists yet — an existing xwines_wine_id may be a human's.
  let propagated = 0;
  if (confirm) {
    const canonical = await pageThrough((from, to) =>
      db.from("canonical_wines").select("id, lwin7, xwines_wine_id").not("lwin7", "is", null).order("id").range(from, to),
    );
    const accepted = new Map<string, { wineId: number; score: number | null }>();
    const acceptedLinks = await pageThrough((from, to) =>
      db.from("lwin_xwines_links").select("lwin_id, xwines_wine_id, score").eq("status", "accepted").order("lwin_id").range(from, to),
    );
    for (const l of acceptedLinks) accepted.set(l.lwin_id, { wineId: l.xwines_wine_id!, score: l.score });
    for (const c of canonical) {
      if (c.xwines_wine_id !== null) continue;
      const link = accepted.get(c.lwin7!);
      if (!link) continue;
      const { error } = await db
        .from("canonical_wines")
        .update({ xwines_wine_id: link.wineId, xwines_match_score: link.score })
        .eq("id", c.id);
      if (error) throw new Error(`propagation failed for canonical ${c.id}: ${error.message}`);
      propagated++;
    }
    await db.from("xwines_link_runs").update({ finished_at: new Date().toISOString(), notes: `processed=${counts.processed} propagated=${propagated}` }).eq("id", runId);
  }

  const report = renderReport(runId, counts, {
    totalLwin: lwin.length,
    skippedResumed: alreadyDecided.size,
    propagated,
  });
  if (confirm) {
    const dir = join("docs", "plans", "ws-ident-runs", `${new Date().toISOString().slice(0, 10)}-${runId.slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), report);
    console.log(`\nReport written to ${dir}/report.md`);
  } else {
    console.log(`\n${report}`);
    console.log("Dry run - nothing written. Pass --confirm to execute.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
