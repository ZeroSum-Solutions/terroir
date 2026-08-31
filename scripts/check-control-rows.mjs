#!/usr/bin/env node
/**
 * GLOBAL-01 control-row ratchet.
 *
 * The rule, verbatim (Devin, docs/plans/2026-08-30-terroir-product-prd.md
 * §GLOBAL-01): "If you cannot fit all the buttons horizontally in one frame,
 * then there are too many buttons." All tabs, filters, toggles and actions on a
 * page must fit on ONE horizontal row. If they do not fit, the answer is fewer
 * controls, never a second row.
 *
 * A rule that lives only in a doc decays. This works exactly like
 * scripts/check-file-size.mjs, deliberately — that ratchet is already trusted
 * here. BUDGET is 1 row: every route that renders more than one stacked row of
 * page-level controls today is recorded in a baseline, may shrink freely, may
 * never grow, and drops out of the baseline entirely when it reaches one row.
 * A route not in the baseline may never cross the budget at all. `--update`
 * refuses to record growth unless `--allow-growth` is passed, so
 * re-baselining is a deliberate act with a diff someone has to approve.
 *
 * ── WHY /cellar SITS AT 2 AND NOT 1 (2026-08-30) ─────────────────────────
 *
 * /cellar was 4. It is now 2, and 2 is the floor this gate can honestly
 * report: the two remaining rows are the control bar (cellar-control-bar.tsx)
 * and the compact sticky masthead (cellar-shell.tsx). They cannot both be on
 * screen. The masthead mounts only once the IntersectionObserver sentinel
 * placed directly below the control bar has scrolled out from under the app
 * header, so at every scroll position exactly one of them is in the frame.
 *
 * Devin's rule is about a frame, and this file counts source containers, so
 * counting 2 here is the gate's limit, not the page's defect. Forcing a 1
 * would mean dropping search or Filters out of the sticky state (a real
 * regression on a 15k-row list) or making the control bar itself permanently
 * sticky (~60px of standing chrome). Neither is an improvement.
 *
 * e2e/cellar-control-row.test.ts is what actually enforces the rule: both
 * containers carry `data-cellar-control-row`, and the spec asserts that
 * exactly ONE of them intersects the viewport, at the top of the page and
 * deep into a scroll, at 1440px and 390px. Treat that spec as the gate and
 * this ratchet as the thing that stops the count creeping back up.
 *
 * ── ONE ROW IS NOT THE WHOLE RULE (2026-08-30) ───────────────────────────
 *
 * Counting rows — here or in the frame — answers only half of it. The rule
 * says "if you cannot FIT ALL THE BUTTONS horizontally in one frame, then
 * there are too many buttons", and a single row can fail that two ways this
 * file will never see:
 *   • it scrolls sideways. /cellar held TEN controls at 390px, of which three
 *     were on screen and seven sat behind 740px of scroll inside an
 *     `overflow-x-auto`. One row, one source container, and the page's own
 *     `scrollWidth` never grew, because the row absorbed the overflow.
 *   • it wraps. `ListActions` on /lists/[id] was ONE `flex-wrap` container
 *     holding six pills that painted two lines at 390px (three when
 *     published). One element, one counted row, and the eye counts three.
 * e2e/one-row-rule.ts measures both, with `getBoundingClientRect()` against
 * `window.innerWidth`, and is used by e2e/cellar-control-row.test.ts and
 * e2e/mobile-list-editor.test.ts. A row that scrolls or wraps is the same
 * "too many buttons" defect with the evidence hidden — do not read a passing
 * count here, in either gate, as a claim that the controls fit.
 *
 * ── THE HEURISTIC, AND WHAT IT CANNOT SEE ────────────────────────────────
 *
 * There is no honest way for a static reader of JSX to know what paints as a
 * row at 390px. This counts a well-defined proxy instead, chosen to be stable
 * and conservative, because a gate that cries wolf gets deleted within a week
 * and is worse than no gate.
 *
 * WHAT IS COUNTED. A route's files are its page.tsx plus the relative imports
 * reachable from it within IMPORT_DEPTH hops — the page's own composition, not
 * every leaf component in the folder — minus files whose name says they are a
 * modal, card, list row or similar (NOT_PAGE_CHROME). In each file, a CONTROL
 * ROW is an element whose className is a horizontal flex row (`flex`, not
 * `flex-col`, with `items-center` and a `gap-*`) and which has at least
 * MIN_CONTROLS control elements among its own children. Element extent comes
 * from indentation, which is reliable because the repo is Prettier-formatted.
 *
 * WHAT IS SKIPPED, because none of it is page chrome: anything inside a
 * `.map(` callback or an `<li>`/`<tr>`/`<article>` (a repeated row is one row,
 * not N); anything inside a dialog, portal or full-screen overlay; anything
 * inside a card or panel (rounded plus a fill or a border); and anything
 * nested inside a control row already counted — so one row holding three
 * groups counts once, while three stacked sibling rows count three.
 *
 * WHAT IT WILL MISS (all of these under-count, which is the safe direction):
 *   • rows whose classes are assembled by cn() from variables rather than
 *     written as a literal;
 *   • rows rendered by a component more than IMPORT_DEPTH hops from page.tsx,
 *     or by one whose filename reads as a card/modal/row;
 *   • a real toolbar that happens to live inside a bordered container;
 *   • a row that wraps onto two visual lines at 390px via `flex-wrap` — that
 *     is one element and counts once even though the eye sees two rows.
 * WHAT IT WILL OVER-COUNT: a genuinely single row split into two sibling flex
 * containers for layout reasons, and controls that are conditionally rendered,
 * which it counts unconditionally.
 *
 * The number is a proxy, not a measurement. Its job is monotonic: adding a
 * stacked row of controls raises it, removing one lowers it. Read a baseline
 * entry as "this route has control-row debt", not as a pixel claim.
 *
 * Usage:
 *   node scripts/check-control-rows.mjs                     # verify (CI)
 *   node scripts/check-control-rows.mjs --update            # re-record after reducing
 *   node scripts/check-control-rows.mjs --update --allow-growth   # deliberate growth
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// dirname(fileURLToPath(...)) rather than `new URL(".", ...)`: this module is
// also imported by its own vitest suite, whose happy-dom environment replaces
// the global URL and breaks the relative form.
const root = join(dirname(fileURLToPath(import.meta.url.split("?")[0])), "..");
const BASELINE = join(root, "scripts/check-control-rows-baseline.json");
const SCAN_ROOT = join(root, "src/app/(app)");

/** The rule is one row. Routes at or under this are never reported. */
const BUDGET = 1;

/** How far a route's own composition reaches from its page.tsx. */
const IMPORT_DEPTH = 2;

/** A flex row is only a CONTROL row once it holds this many controls. */
const MIN_CONTROLS = 2;

/**
 * Files whose NAME says they are not page chrome. This repo names components
 * for what they are, consistently, so `publish-modal.tsx` and
 * `sortable-section-button.tsx` can be excluded on sight — the controls inside
 * a modal or a list row are that component's, and counting them is how the
 * gate would start failing on changes that added no page control at all.
 */
const NOT_PAGE_CHROME =
  /-(?:modal|dialog|drawer|sheet|card|row|item|button|badge|chip|thumb|tile|menu)\.tsx$/;

/** Prettier's indentation step, used to tell a row's own children from its
 * grandchildren. */
const CHILD_INDENT = 2;

/**
 * Routes the rule does not describe.
 *
 * The print and preview surfaces of a wine list are the CLIENT's artefact
 * rendered for paper and for a customer's phone. They have no app chrome to
 * fit on one row, and judging them by the app's control budget would be
 * judging the wrong thing.
 */
const EXEMPT = new Set(["/lists/[id]/print", "/lists/[id]/preview"]);

const update = process.argv.includes("--update");
const allowGrowth = process.argv.includes("--allow-growth");

// ── row detection ────────────────────────────────────────────────────────

/** Regions whose contents are not page-level chrome. */
const MAP_REGION = /\.map\(/;
const OVERLAY_REGION = /createPortal\(|role="dialog"|fixed inset-0|\bsr-only\b/;
/** A list item, table row or article: whatever is inside it repeats with the
 * collection, so its controls are one row however many times they render. */
const ITEM_REGION = /^\s*<(?:li|tr|article)(?![A-Za-z0-9])/;

/**
 * Control elements, counted inside a candidate row's subtree. Intrinsic
 * controls, plus components whose name says they are one — the suffix list is
 * deliberately narrow, because lucide exports icons called `Filter`, `Menu`
 * and `Search` and counting an icon as a control is how a gate starts lying.
 */
const CONTROL_TAGS =
  /<(?:button|select|a|input|Link)(?![A-Za-z0-9])|<[A-Z][A-Za-z0-9]*(?:Button|Toggle|Select|Tabs|Chips|Pills|Sort|Actions|Control|Picker|Switch|Filters)[A-Za-z0-9]*(?![A-Za-z0-9])/g;

const indentOf = (line) => line.length - line.trimStart().length;

/** Every double-quoted literal on the line, joined — catches both
 * `className="…"` and the leading literal of a `className={cn("…", …)}`. */
function classTokens(line) {
  const literals = line.match(/"[^"\n]*"/g) ?? [];
  return new Set(literals.join(" ").replaceAll('"', " ").split(/\s+/).filter(Boolean));
}

/**
 * A card, panel or list item: rounded, and either filled or outlined. Controls
 * inside one belong to that card, not to the page — a page whose cards each
 * have a two-button footer has one control row, not eight.
 */
function isCard(line) {
  if (!line.includes("className")) return false;
  const tokens = classTokens(line);
  let rounded = false;
  let surface = false;
  for (const token of tokens) {
    if (token.startsWith("rounded")) rounded = true;
    if (token === "border" || token.startsWith("bg-") || token.endsWith("card-surface")) {
      surface = true;
    }
  }
  return rounded && surface;
}

function isHorizontalRow(line) {
  if (!line.includes("className")) return false;
  const tokens = classTokens(line);
  if (!tokens.has("flex")) return false;
  if (tokens.has("flex-col")) return false;
  if (!tokens.has("items-center")) return false;
  for (const token of tokens) if (token.startsWith("gap-")) return true;
  return false;
}

/**
 * The line that opens the element line `i` belongs to.
 *
 * Prettier wraps long opening tags, so `className` — the thing this gate reads
 * — routinely sits on its own line two levels in from its own `<div`. Measuring
 * from there would make every wrapped element look childless.
 */
function elementStart(lines, i) {
  if (lines[i].trimStart().startsWith("<")) return i;
  const indent = indentOf(lines[i]);
  for (let k = i - 1; k >= 0; k -= 1) {
    const trimmed = lines[k].trim();
    if (trimmed === "") continue;
    if (indentOf(lines[k]) < indent && trimmed.startsWith("<")) return k;
    if (indentOf(lines[k]) < indent) return i;
  }
  return i;
}

/**
 * Lines [start, end) of the element opened on `start`, by indentation.
 *
 * Prettier puts the closing `>` of a multi-line opening tag back at the
 * element's own indentation, so that line has to be skipped or every element
 * with wrapped attributes would look childless.
 */
function subtreeEnd(lines, start) {
  const base = indentOf(lines[start]);
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (/^\/?>/.test(trimmed)) continue;
    if (indentOf(lines[i]) <= base) return i;
  }
  return lines.length;
}

/**
 * Controls belonging to THIS row, not to whatever its children render.
 *
 * Only the row's own children count, allowing one extra level of indentation
 * for the `{cond && (` wrappers Prettier introduces. Without that limit every
 * card with a flex header and two links inside reads as a page control row,
 * which is precisely the false alarm that would get this gate switched off.
 */
function countControls(lines, start, end) {
  const limit = indentOf(lines[start]) + CHILD_INDENT * 2;
  let controls = 0;
  for (let i = start; i < end; i += 1) {
    if (i > start && indentOf(lines[i]) > limit) continue;
    controls += (lines[i].match(CONTROL_TAGS) ?? []).length;
    if (controls >= MIN_CONTROLS) return controls;
  }
  return controls;
}

/**
 * @returns {number[]} 1-based line numbers of the outermost, non-repeated,
 * non-overlay control rows in one file. Line numbers rather than a bare count
 * so the heuristic can be inspected — and tested — where it fires.
 */
export function findControlRows(source) {
  const lines = source.split("\n");
  const open = []; // { end, kind } — end is the first line past the region
  const rows = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    while (open.length > 0 && open[open.length - 1].end <= i) open.pop();

    const inside = (kind) => open.some((region) => region.kind === kind);
    // An attribute on its own line belongs to the tag above it; the element's
    // extent is measured from the tag, not from the attribute.
    const start = elementStart(lines, i);
    const end = subtreeEnd(lines, start);
    // A construct that opens and closes on its own line encloses nothing.
    if (end <= i + 1) continue;

    if (isHorizontalRow(line) && countControls(lines, start, end) >= MIN_CONTROLS) {
      const skip =
        inside("row") ||
        inside("map") ||
        inside("overlay") ||
        inside("card") ||
        inside("item");
      if (!skip) rows.push(i + 1);
      open.push({ end, kind: "row" });
    } else if (MAP_REGION.test(line)) {
      open.push({ end, kind: "map" });
    } else if (ITEM_REGION.test(line)) {
      open.push({ end, kind: "item" });
    } else if (OVERLAY_REGION.test(line)) {
      open.push({ end, kind: "overlay" });
    } else if (isCard(line)) {
      open.push({ end, kind: "card" });
    }
  }

  return rows;
}

/** @returns {number} control rows in one file. */
export const countControlRows = (source) => findControlRows(source).length;

// ── route inventory ──────────────────────────────────────────────────────

function walkDirs(dir, out = []) {
  out.push(dir);
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkDirs(full, out);
  }
  return out;
}

const hasPage = (dir) => existsSync(join(dir, "page.tsx"));

/** URL path for a route directory, with route groups stripped as Next does. */
export function routePathFor(dir, scanRoot = SCAN_ROOT) {
  const segments = relative(scanRoot, dir)
    .split(sep)
    .filter((s) => s !== "" && !s.startsWith("("));
  return `/${segments.join("/")}`;
}

function resolveRelativeImport(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** page.tsx plus the relative imports reachable from it within IMPORT_DEPTH. */
export function filesForRoute(routeDir) {
  const entry = join(routeDir, "page.tsx");
  const seen = new Set([entry]);
  let frontier = [entry];
  for (let depth = 0; depth < IMPORT_DEPTH; depth += 1) {
    const next = [];
    for (const file of frontier) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+"(\.[^"]*)"/g)) {
        const resolved = resolveRelativeImport(file, match[1]);
        if (!resolved || seen.has(resolved)) continue;
        if (/\.test\.tsx?$/.test(resolved)) continue;
        seen.add(resolved);
        next.push(resolved);
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** @returns {Record<string, number>} route path → control rows, over budget only */
export function collect(scanRoot = SCAN_ROOT) {
  const found = {};
  for (const dir of walkDirs(scanRoot)) {
    if (!hasPage(dir)) continue;
    const route = routePathFor(dir, scanRoot);
    if (EXEMPT.has(route)) continue;
    let rows = 0;
    for (const file of filesForRoute(dir)) {
      if (NOT_PAGE_CHROME.test(file)) continue;
      rows += countControlRows(readFileSync(file, "utf8"));
    }
    if (rows > BUDGET) found[route] = rows;
  }
  return found;
}

export const total = (record) => Object.values(record).reduce((a, b) => a + b, 0);

// ── CLI ──────────────────────────────────────────────────────────────────

function main() {
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
        `Refusing to grow the baseline: ${before} → ${after} total control rows.\n` +
          "The baseline exists to shrink. Remove controls, or pass --allow-growth\n" +
          "and explain why in the commit message.",
      );
      process.exit(1);
    }
    const sorted = Object.fromEntries(
      Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + "\n");
    console.log(
      `control-rows baseline: ${Object.keys(sorted).length} route(s) over ${BUDGET} row, ` +
        `${after} total rows recorded (was ${before}).`,
    );
    process.exit(0);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    console.error(
      "No control-row baseline. Create one with:\n" +
        "  node scripts/check-control-rows.mjs --update",
    );
    process.exit(1);
  }

  const failures = [];
  for (const [route, rows] of Object.entries(current)) {
    const allowed = baseline[route];
    if (allowed === undefined) {
      failures.push(
        `${route}: ${rows} stacked control rows, over the ${BUDGET}-row budget and ` +
          `not baselined. Consolidate into one row, or into one overflow control.`,
      );
    } else if (rows > allowed) {
      failures.push(
        `${route}: grew ${allowed} → ${rows} control rows. Baselined routes may shrink, not grow.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("Control-row ratchet failed (GLOBAL-01):\n");
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      `\n"If you cannot fit all the buttons horizontally in one frame, then there\n` +
        `are too many buttons." Search is exempt (GLOBAL-02) and lives in the shell.\n` +
        `If the growth is genuinely right, run:\n` +
        `  node scripts/check-control-rows.mjs --update --allow-growth\n` +
        `and say why in the commit message.`,
    );
    process.exit(1);
  }

  const recorded = Object.keys(baseline).length;
  const remaining = Object.keys(current).length;
  const paid = total(baseline) - total(current);
  console.log(
    `Control rows: no route gained a row (${remaining} route(s) over ${BUDGET} row, ` +
      `of ${recorded} baselined` +
      (paid > 0 ? `; ${paid} row(s) paid down` : "") +
      ").",
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
