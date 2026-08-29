#!/usr/bin/env node
/**
 * check-design-typography.mjs — the type scale is not a suggestion.
 *
 * The previous scale was bypassed four times out of five: 262 uses of the token
 * scale against roughly 1,050 arbitrary `text-[Npx]` classes across 143 files.
 * The steps have since been fixed (DESIGN.md — "The scale, and why the last one
 * failed"), but a repaired scale that nothing enforces just gets bypassed again.
 *
 * Three violations are tracked:
 *   arbitrary size   `text-[14px]` and friends — the scale has a role for it
 *   inline fontSize  a size written in JS, invisible to every other tool
 *   font-mono        Source Code Pro is for bin codes and identifiers only;
 *                    prices, vintages, counts and percentages are Source Sans 3
 *                    with tabular-nums, which aligns them without making them
 *                    look like machine output
 *
 * This runs off a fingerprinted baseline of the violations that existed the day
 * the scale was repaired. A NEW violation fails; a migrated one drops out of the
 * baseline. The baseline can only shrink — `--update` refuses to record growth
 * unless `--allow-growth` is passed, so "just re-baseline it" is a deliberate,
 * reviewable act rather than a reflex.
 *
 * The fingerprint is a per-file count per violation kind, not a per-occurrence
 * hash. That is a deliberate trade: line numbers churn on every edit, and a
 * hash keyed to them would fail on unrelated changes until nobody trusted it.
 * The consequence is that one `text-[13px]` can be swapped for another in the
 * same file without the gate noticing. It still cannot grow, which is what
 * stops the 80% bypass rate from coming back. Editing the committed JSON by
 * hand also works — that is what review is for.
 *
 *   node scripts/check-design-typography.mjs            # check (CI)
 *   node scripts/check-design-typography.mjs --update   # after migrating
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(root, "scripts/design-typography-baseline.json");
const update = process.argv.includes("--update");
const allowGrowth = process.argv.includes("--allow-growth");

const SIZE = /\btext-\[\s*\d[\d.]*\s*(?:px|rem|em)\s*\]/g;
const INLINE = /\bfontSize\s*:/g;
const MONO = /(?<![\w-])font-mono(?![\w-])/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Counts per file, keyed by violation kind. Order-independent, line-independent. */
function scan() {
  const found = {};
  for (const file of walk(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    const counts = {};
    const sizes = text.match(SIZE) ?? [];
    for (const s of sizes) {
      const key = s.replace(/\s+/g, "");
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const inline = (text.match(INLINE) ?? []).length;
    if (inline) counts["inline:fontSize"] = inline;
    const mono = (text.match(MONO) ?? []).length;
    if (mono) counts["class:font-mono"] = mono;
    if (Object.keys(counts).length) {
      found[relative(root, file).split(sep).join("/")] = counts;
    }
  }
  return found;
}

const found = scan();
const total = (m) =>
  Object.values(m).reduce((n, c) => n + Object.values(c).reduce((a, b) => a + b, 0), 0);

if (update) {
  let prior = {};
  try {
    prior = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    /* first run */
  }
  const before = total(prior);
  const after = total(found);
  if (after > before && !allowGrowth) {
    console.error(
      `Refusing to grow the baseline: ${before} → ${after} violations.\n` +
        "The baseline exists to shrink. Fix the new ones, or pass --allow-growth\n" +
        "and say in the commit message why the scale had to give.",
    );
    process.exit(1);
  }
  const sorted = Object.fromEntries(
    Object.keys(found)
      .sort()
      .map((f) => [f, Object.fromEntries(Object.keys(found[f]).sort().map((k) => [k, found[f][k]]))]),
  );
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`design typography baseline: ${after} violation(s) recorded (was ${before}).`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(
    "No typography baseline. Create one with:\n" +
      "  node scripts/check-design-typography.mjs --update",
  );
  process.exit(1);
}

const regressions = [];
for (const [file, counts] of Object.entries(found)) {
  for (const [kind, n] of Object.entries(counts)) {
    const allowed = baseline[file]?.[kind] ?? 0;
    if (n > allowed) {
      regressions.push(
        `${file}: ${n} × \`${kind}\`, baseline allows ${allowed}. ` +
          (kind === "class:font-mono"
            ? "Source Code Pro is for codes, not numbers — use `tabular` on Source Sans 3."
            : "Use a scale token (micro/caption/ledger/body-sm/control/body/body-lg/…)."),
      );
    }
  }
}

if (regressions.length) {
  console.error("Design typography: NEW violations\n");
  for (const r of regressions) console.error("  ✗ " + r);
  console.error(
    `\n${regressions.length} regression(s). The scale has a role for every size in ` +
      "DESIGN.md — if it genuinely does not, change DESIGN.md first.",
  );
  process.exit(1);
}

const remaining = total(found);
const recorded = total(baseline);
console.log(
  `Design typography: no new violations (${remaining} remain of ${recorded} baselined).` +
    (remaining < recorded
      ? " Baseline can shrink — run with --update."
      : ""),
);
