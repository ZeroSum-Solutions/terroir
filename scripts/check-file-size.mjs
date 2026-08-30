#!/usr/bin/env node
/**
 * File-size ratchet.
 *
 * The repo's stated rule is that no module should grow into a monolith. Stating
 * it is not enforcing it: at the time this gate was added, ten files in src/
 * were over 700 lines and one was 3,149, with nothing in CI to notice.
 *
 * This works exactly like scripts/check-design-typography.mjs, deliberately —
 * that pattern is already trusted here. Every file over BUDGET lines is recorded
 * in a fingerprinted baseline. A baselined file may shrink freely but may never
 * grow past its recorded size, and a file not in the baseline may never cross
 * BUDGET at all. So the debt is visible, frozen, and can only be paid down.
 *
 * The baseline can only shrink — `--update` refuses to record growth unless
 * `--allow-growth` is passed, making "just re-baseline it" a deliberate act with
 * a diff someone has to approve.
 *
 * Usage:
 *   node scripts/check-file-size.mjs                    # verify (CI)
 *   node scripts/check-file-size.mjs --update           # re-record after shrinking
 *   node scripts/check-file-size.mjs --update --allow-growth   # deliberate growth
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BASELINE = join(root, "scripts/file-size-baseline.json");
const SCAN_ROOT = join(root, "src");

/** Files at or under this many lines are never reported. */
const BUDGET = 400;

/**
 * Generated or vendored files. These are not hand-maintained, so a line count
 * is not a signal about them and shrinking them is not a goal.
 */
const EXEMPT = new Set([
  "src/types/database.ts", // `supabase gen types` output, CI-drift-checked
  "src/lib/atlas/world-paths.generated.ts", // precomputed SVG paths
]);

const update = process.argv.includes("--update");
const allowGrowth = process.argv.includes("--allow-growth");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** @returns {Record<string, number>} repo-relative path → line count, over budget only */
function collect() {
  const found = {};
  for (const file of walk(SCAN_ROOT)) {
    const rel = relative(root, file);
    if (EXEMPT.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines > BUDGET) found[rel] = lines;
  }
  return found;
}

const total = (record) => Object.values(record).reduce((a, b) => a + b, 0);

const current = collect();

if (update) {
  let prior = {};
  try {
    prior = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    // first run — no baseline yet
  }
  const before = total(prior);
  const after = total(current);
  if (after > before && !allowGrowth && Object.keys(prior).length > 0) {
    console.error(
      `Refusing to grow the baseline: ${before} → ${after} total lines over budget.\n` +
        "The baseline exists to shrink. Split the file, or pass --allow-growth\n" +
        "and explain why in the commit message.",
    );
    process.exit(1);
  }
  const sorted = Object.fromEntries(
    Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + "\n");
  console.log(
    `file-size baseline: ${Object.keys(sorted).length} file(s) over ${BUDGET} lines, ` +
      `${after} total lines recorded (was ${before}).`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(
    "No file-size baseline. Create one with:\n" +
      "  node scripts/check-file-size.mjs --update",
  );
  process.exit(1);
}

const failures = [];
for (const [file, lines] of Object.entries(current)) {
  const allowed = baseline[file];
  if (allowed === undefined) {
    failures.push(
      `${file}: ${lines} lines, over the ${BUDGET}-line budget and not baselined. ` +
        `Split it, or rename it if this is a move.`,
    );
  } else if (lines > allowed) {
    failures.push(
      `${file}: grew ${allowed} → ${lines} lines. Baselined files may shrink, not grow.`,
    );
  }
}

if (failures.length > 0) {
  console.error("File-size ratchet failed:\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    `\nThis gate exists so no module quietly becomes a monolith again.\n` +
      `If you genuinely need the growth, run:\n` +
      `  node scripts/check-file-size.mjs --update --allow-growth\n` +
      `and say why in the commit message.`,
  );
  process.exit(1);
}

const recorded = Object.keys(baseline).length;
const remaining = Object.keys(current).length;
const shrunk = total(baseline) - total(current);
console.log(
  `File size: no new monoliths (${remaining} file(s) over ${BUDGET} lines, ` +
    `of ${recorded} baselined` +
    (shrunk > 0 ? `; ${shrunk} lines paid down` : "") +
    ").",
);
