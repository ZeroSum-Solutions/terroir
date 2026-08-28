/**
 * Measure LWIN match coverage for a real CSV against a live lwin_catalog,
 * through the repo's OWN production code paths for parsing, validation,
 * and matching (csv-parser, row-validator, buildLwinQueryVariants,
 * matchLwinBulk/match_lwin_bulk).
 *
 * NIT 7 (Sol audit round 3), correcting an earlier claim on this same
 * comment: this does NOT call buildImportPreview (preview-service.ts)
 * itself, and the numbers below are NOT guaranteed to "never drift" from
 * what it would report. Variant ownership (which query variant belongs to
 * which row) and the best-score-per-row reduction are REIMPLEMENTED here
 * (see variantOwners/bestPerRow below), matching buildImportPreview's own
 * construction and tie-break (ascending flat query index, strict `>`) as
 * of this writing — but as a hand-maintained copy, not a shared call, so a
 * future change to that reduction in preview-service.ts would not
 * automatically propagate here. If this harness's numbers and a real
 * preview's ever disagree, check this reduction against buildImportPreview's
 * own first — that is the actual drift risk this script carries, and
 * fully closing it would mean exporting and reusing preview-service.ts's
 * private reduction step, which this script does not currently do.
 *
 * Reports, side by side:
 *   - baseline: one query per row (producer || name in both legs — the
 *     pre-variant behavior)
 *   - variants: best score across buildLwinQueryVariants' query set (the
 *     shipped behavior)
 * bucketed at LWIN_APPLY_MIN_SCORE (the apply bar), plus a sample of
 * best-scoring near-misses for eyeballing precision.
 *
 * This is the checked-in version of the 2026-08-27 offline harness that
 * originally produced the 29.6% → 77.0% figure cited in lwin-matching.ts
 * and the variant-matching PR (Sol audit 2026-08-27 finding 4: claims must
 * be backed by a real, runnable tool, not a one-off number with nothing
 * behind it).
 *
 * NIT (Sol audit round 3) — correcting the word this comment used to use:
 * this script is RERUNNABLE from the repo, not REPRODUCIBLE. Neither the
 * original 1,306-row partner CSV nor a snapshot/hash of the production
 * catalog it was measured against is checked in here (the partner file is
 * a client's real data and was never committed; the catalog is a live,
 * mutable table, not a fixed artifact) — so re-running this script today,
 * even against the same production database, is not guaranteed to
 * reproduce 29.6%/77.0% exactly: the catalog may have grown or changed
 * since, and no other CSV will exercise the identical set of rows the
 * original measurement did. What IS reproducible: the MECHANISM (this
 * tool, run against ANY producer-less CSV and ANY reachable lwin_catalog,
 * reports a real baseline-vs-variant comparison through the actual
 * production code paths) — not the specific historical numbers.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... LWIN_MEASURE_EMAIL=<existing user email> \
 *     npx tsx scripts/measure-lwin-matching.ts <csv-path>
 *
 * Read-only: match_lwin_bulk only SELECTs from lwin_catalog. Point it at
 * local or production by env. EXECUTE on the RPC is granted to
 * `authenticated` only (0076), so the script mints a real session for
 * LWIN_MEASURE_EMAIL (falling back to DEV_BYPASS_EMAIL) via the admin
 * generate-link + verifyOtp flow — the same pattern as e2e/pour-flow's
 * userClient. The service-role key is used only to mint that link.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { decodeCsvBuffer, parseCsv } from "../src/domains/import/csv-parser";
import { mapHeader, validateRow } from "../src/domains/import/row-validator";
import { buildLwinQueryVariants, matchLwinBulk, type LwinMatchQuery } from "../src/domains/import/lwin-matching";
import { LWIN_APPLY_MIN_SCORE } from "../src/domains/import/constants";

async function main() {
  const csvPath = process.argv[2];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const email = process.env.LWIN_MEASURE_EMAIL ?? process.env.DEV_BYPASS_EMAIL;
  if (!csvPath || !url || !serviceKey || !anonKey || !email) {
    console.error(
      "Usage: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... " +
        "SUPABASE_SERVICE_ROLE_KEY=... LWIN_MEASURE_EMAIL=<existing user email> " +
        "npx tsx scripts/measure-lwin-matching.ts <csv-path>",
    );
    process.exit(2);
  }

  const parsed = parseCsv(decodeCsvBuffer(readFileSync(csvPath)));
  if (!parsed.ok) {
    console.error(`CSV parse failed: ${parsed.error.message}`);
    process.exit(1);
  }
  const { columnToField, missingRequired } = mapHeader(parsed.header);
  if (missingRequired.length > 0) {
    console.error(`Missing required headers: ${missingRequired.join(", ")}`);
    process.exit(1);
  }

  const validRows = parsed.rows
    .map((cells, idx) => ({ row: validateRow(cells, columnToField), idx }))
    .filter(({ row }) => row.state === "valid")
    .map(({ row, idx }) => {
      const { producer, name } = row as unknown as { producer: string; name: string };
      return { idx, producer, name };
    });
  console.log(`valid rows: ${validRows.length} of ${parsed.rows.length}`);

  // Mint an authenticated session: EXECUTE on match_lwin_bulk is granted
  // to `authenticated` only, so a bare service-role client gets 42501.
  const admin = createClient<Database>(url, serviceKey, { auth: { persistSession: false } });
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) {
    console.error(`generateLink failed for ${email}: ${linkError.message}`);
    process.exit(1);
  }
  const supabase = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (verifyError) {
    console.error(`verifyOtp failed: ${verifyError.message}`);
    process.exit(1);
  }

  // Local-stack quirk: a container clock a second or two behind the host
  // makes PostgREST reject the just-minted token with PGRST303 "JWT
  // issued at future". Probe once and wait out small skew before the
  // real (chunked, concurrent) run starts.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase.rpc("match_lwin_bulk", {
      p_queries: [{ idx: 0, producer: "probe", name: "probe" }],
      p_threshold: 0.9,
    } as never);
    if (!error) break;
    if (error.code === "PGRST303" && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    console.error(`RPC probe failed: ${error.message}`);
    process.exit(1);
  }

  // Baseline: exactly the pre-variant query shape, one per row.
  const baselineQueries: LwinMatchQuery[] = validRows.map((r, flat) => ({
    idx: flat,
    producer: r.producer || r.name,
    name: r.name,
  }));
  const baselineMatches = await matchLwinBulk(supabase, baselineQueries);

  // Variants: the shipped behavior — best score per row.
  const variantOwners: number[] = [];
  const variantQueries: LwinMatchQuery[] = [];
  validRows.forEach((r, rowPos) => {
    for (const v of buildLwinQueryVariants(r.producer, r.name)) {
      variantOwners.push(rowPos);
      variantQueries.push({ idx: variantQueries.length, ...v });
    }
  });
  const variantMatches = await matchLwinBulk(supabase, variantQueries);
  const bestPerRow = new Map<number, { lwinId: string; score: number }>();
  for (let i = 0; i < variantOwners.length; i++) {
    const m = variantMatches.get(i);
    if (!m) continue;
    const cur = bestPerRow.get(variantOwners[i]);
    if (!cur || m.score > cur.score) bestPerRow.set(variantOwners[i], m);
  }

  const n = validRows.length;
  function bucket(scores: Array<number | undefined>) {
    const atBar = scores.filter((s) => s !== undefined && s >= LWIN_APPLY_MIN_SCORE).length;
    const below = scores.filter((s) => s !== undefined && s < LWIN_APPLY_MIN_SCORE).length;
    return { atBar, below, none: n - atBar - below };
  }
  const base = bucket(validRows.map((_, i) => baselineMatches.get(i)?.score));
  const vari = bucket(validRows.map((_, i) => bestPerRow.get(i)?.score));

  const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
  console.log(`\n                       baseline      variants`);
  console.log(`matched @ ${LWIN_APPLY_MIN_SCORE} apply bar   ${base.atBar} (${pct(base.atBar)})   ${vari.atBar} (${pct(vari.atBar)})`);
  console.log(`candidate below bar    ${base.below} (${pct(base.below)})   ${vari.below} (${pct(vari.below)})`);
  console.log(`no candidate           ${base.none} (${pct(base.none)})   ${vari.none} (${pct(vari.none)})`);

  const nearMisses = validRows
    .map((r, i) => ({ r, m: bestPerRow.get(i) }))
    .filter((x): x is { r: (typeof validRows)[number]; m: { lwinId: string; score: number } } =>
      x.m !== undefined && x.m.score < LWIN_APPLY_MIN_SCORE,
    )
    .sort((a, b) => b.m.score - a.m.score)
    .slice(0, 10);
  if (nearMisses.length > 0) {
    console.log(`\ntop near-misses (best variant score < ${LWIN_APPLY_MIN_SCORE}):`);
    for (const { r, m } of nearMisses) {
      console.log(`  ${m.score.toFixed(3)}  ${r.name}  -> ${m.lwinId}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
