#!/usr/bin/env node
/**
 * File-size ratchet.
 *
 * The repo's stated rule is that no module should grow into a monolith. Stating
 * it is not enforcing it: at the time this gate was added, ten files in src/
 * were over 700 lines and one was 3,149, with nothing in CI to notice.
 *
 * This works exactly like scripts/check-design-typography.mjs, deliberately —
 * that pattern is already trusted here. Every file over its budget is recorded
 * in a fingerprinted baseline. A baselined file may shrink freely but may never
 * grow past its recorded size, and a file not in the baseline may never cross
 * its budget at all. So the debt is visible, frozen, and can only be paid down.
 *
 * TWO BUDGETS, because one number was answering two different questions. A
 * 500-line React component is the monolith this gate exists to catch. A
 * 2,000-line table-driven test suite is not the same defect: its length is
 * CASES, and holding it to the source budget taught the wrong lesson — delete
 * coverage to go green. So suites get room and application code keeps the
 * tighter limit, which is also the limit the engineering rules already state.
 *
 * A file counts as a suite by the same suffixes vitest's own `include` uses,
 * and nothing else. A directory rule would be a second, drifting definition of
 * "a test"; a substring rule would hand the larger budget to any source file
 * with "test" in its name.
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
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Application code at or under this many lines is never reported. */
export const SOURCE_BUDGET = 400;

/** A vitest suite at or under this many lines is never reported. */
export const TEST_BUDGET = 1000;

/** The budget that applies to a repo-relative path. */
export function budgetFor(relPath) {
  return relPath.endsWith(".test.ts") || relPath.endsWith(".test.tsx")
    ? TEST_BUDGET
    : SOURCE_BUDGET;
}

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
function collect(root, scanRoot) {
  const found = {};
  for (const file of walk(scanRoot)) {
    const rel = relative(root, file);
    if (EXEMPT.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines > budgetFor(rel)) found[rel] = lines;
  }
  return found;
}

const total = (record) => Object.values(record).reduce((a, b) => a + b, 0);

function runCli() {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const BASELINE = join(root, "scripts/file-size-baseline.json");
  const SCAN_ROOT = join(root, "src");
  const current = collect(root, SCAN_ROOT);
  const budgets = `${SOURCE_BUDGET} source / ${TEST_BUDGET} test`;

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
      `file-size baseline: ${Object.keys(sorted).length} file(s) over budget ` +
        `(${budgets}), ${after} total lines recorded (was ${before}).`,
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
        `${file}: ${lines} lines, over the ${budgetFor(file)}-line budget and ` +
          `not baselined. Split it, or rename it if this is a move.`,
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
    `File size: no new monoliths (${remaining} file(s) over budget ` +
      `(${budgets}), of ${recorded} baselined` +
      (shrunk > 0 ? `; ${shrunk} lines paid down` : "") +
      ").",
  );
}

// Importable: the contract suite in src/test/contracts/ reads the budgets and
// the classifier directly, so running the gate must not be a side effect of
// loading this module. Same guard scripts/verify-feature-ledger.mjs uses.
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli();
}
