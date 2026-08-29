#!/usr/bin/env node
/**
 * check-design-token-sync.mjs — DESIGN.md and the CSS token layer must agree.
 *
 * The design system is only a contract if the document and the stylesheet say
 * the same thing. This reads the DESIGN.md frontmatter and `src/app/globals.css`
 * and fails on any token that is missing, renamed, or has drifted in value.
 *
 * It also enforces the one structural rule that has bitten this file before:
 * the `[data-theme="dark"]` block and the `prefers-color-scheme: dark` block
 * must be identical. When they drift, a user who has never touched the theme
 * toggle sees a different room from one who has.
 *
 * Two tokens are deliberately not one-to-one and are checked by rule instead:
 *   `--t-mark`  — Nocturne's is `dark-champagne`; Daylight has no champagne
 *                 and must never be given one, so its mark is claret, which
 *                 is asserted to equal `--t-focus`.
 *   `--t-*`     — anything the CSS carries that DESIGN.md does not name (glass
 *                 solids, window ramp, card highlight) is implementation, not
 *                 contract, and is left alone.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const design = readFileSync(join(root, "DESIGN.md"), "utf8");
const css = readFileSync(join(root, "src/app/globals.css"), "utf8");

const failures = [];
const fail = (m) => failures.push(m);

/* ── DESIGN.md frontmatter ─────────────────────────────────────────── */

function block(name) {
  const m = design.match(new RegExp(`^${name}:\\n((?:[ \\t]+.*\\n)+)`, "m"));
  if (!m) throw new Error(`DESIGN.md: no \`${name}:\` frontmatter block`);
  return m[1];
}

function scalars(name) {
  const out = {};
  for (const line of block(name).split("\n")) {
    const m = line.match(/^\s{2}([a-z0-9-]+):\s*"?([^"\n{]+?)"?\s*$/i);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function maps(name) {
  const out = {};
  for (const line of block(name).split("\n")) {
    const m = line.match(/^\s{2}([a-z0-9-]+):\s*\{(.+)\}\s*$/i);
    if (!m) continue;
    const fields = {};
    for (const pair of m[2].split(/,\s*(?![^{]*\})/)) {
      const kv = pair.match(/^\s*([a-z0-9-]+):\s*"?([^",]+?)"?\s*$/i);
      if (kv) fields[kv[1]] = kv[2];
    }
    out[m[1]] = fields;
  }
  return out;
}

const colors = scalars("colors");
const rounded = scalars("rounded");
const spacing = scalars("spacing");
const type = maps("typography");
const typeFamilies = scalars("typography");

/* ── CSS ───────────────────────────────────────────────────────────── */

function cssBlock(selector) {
  // Anchored to the start of a line: every one of these selectors is also
  // named in the file's own header comment, and indexOf would find that first.
  const at = new RegExp(`^[ \\t]*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
  const m = at.exec(css);
  if (!m) throw new Error(`globals.css: no \`${selector}\` block`);
  const i = m.index;
  const open = css.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}" && --depth === 0) return css.slice(open + 1, j);
  }
  throw new Error(`globals.css: unterminated \`${selector}\``);
}

function vars(text) {
  const out = {};
  for (const m of text.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const light = vars(cssBlock(":root {"));
const dark = vars(cssBlock('[data-theme="dark"]'));
const system = vars(cssBlock(':root:not([data-theme="light"]):not([data-theme="dark"])'));
const theme = vars(cssBlock("@theme inline"));

/* ── 1. The two dark blocks must be identical ──────────────────────── */

for (const key of new Set([...Object.keys(dark), ...Object.keys(system)])) {
  if (dark[key] !== system[key]) {
    fail(
      `dark drift: ${key} is ${dark[key] ?? "(absent)"} under [data-theme="dark"] ` +
        `but ${system[key] ?? "(absent)"} under prefers-color-scheme`,
    );
  }
}

/* ── 2. Colours ────────────────────────────────────────────────────── */

const norm = (v) =>
  (v ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(\d)\.?0+(?=[,)\s]|$)/g, "$1") // 0.10 and 0.1 are the same colour
    .trim();

/**
 * DESIGN.md names a few colours for the role they play; the CSS names them for
 * where they are composed. These are the same token under two names.
 */
const ALIAS = { champagne: "mark", "shadow-card": "glass-shadow" };

/**
 * Runtime values that are consumed directly by CSS or by an inline style
 * (`var(--t-…)`) rather than by a utility. They are implementation, not
 * contract, so they are not required to appear in @theme.
 */
const NOT_UTILITIES = new Set([
  "--t-window-ramp-start",
  "--t-window-marker",
  "--t-card-highlight",
  "--t-glass-solid",
]);

for (const [name, value] of Object.entries(colors)) {
  const isDark = name.startsWith("dark-");
  const bare = isDark ? name.slice(5) : name;
  // `champagne` is the Nocturne name for the mark; it has no Daylight twin.
  const cssName = ALIAS[bare] ?? bare;
  const scope = isDark ? dark : light;
  const where = isDark ? "Nocturne" : "Daylight";
  const actual = scope[`--t-${cssName}`];
  if (actual === undefined) {
    // Not every documented colour is a runtime variable — `glass` and the
    // shadows are composed in CSS. Only complain about ones the CSS declares
    // in the *other* mode, which means a genuine half-migration.
    const twin = (isDark ? light : dark)[`--t-${cssName}`];
    if (twin !== undefined) fail(`${where}: --t-${cssName} is missing (DESIGN.md says ${value})`);
    continue;
  }
  if (norm(actual) !== norm(value)) {
    fail(`${where}: --t-${cssName} is ${actual}, DESIGN.md says ${value}`);
  }
}

// Daylight's mark: claret, because champagne on white is 1.26:1.
if (norm(light["--t-mark"]) !== norm(light["--t-focus"])) {
  fail(
    `Daylight: --t-mark (${light["--t-mark"]}) must equal --t-focus ` +
      `(${light["--t-focus"]}) — Daylight has no champagne and must never be given one`,
  );
}

/* ── 3. Every contract colour is exposed as a Tailwind token ───────── */

for (const key of Object.keys(light)) {
  if (!key.startsWith("--t-") || NOT_UTILITIES.has(key)) continue;
  const bare = key.slice(4);
  const exposed = Object.entries(theme).some(
    ([k, v]) => k === `--color-${bare}` || v === `var(${key})`,
  );
  if (!exposed) fail(`${key} is defined but never mapped into @theme — no utility can reach it`);
}

/* ── 4. Type scale, spacing and radii ──────────────────────────────── */

for (const [role, fields] of Object.entries(type)) {
  if (!fields.size) continue;
  const actual = theme[`--text-${role}`];
  if (actual === undefined) {
    fail(`type: --text-${role} is missing (DESIGN.md says ${fields.size})`);
    continue;
  }
  if (norm(actual) !== norm(fields.size)) {
    fail(`type: --text-${role} is ${actual}, DESIGN.md says ${fields.size}`);
  }
  const line = theme[`--text-${role}--line-height`];
  if (fields.line && norm(line) !== norm(fields.line)) {
    fail(`type: --text-${role}--line-height is ${line ?? "(absent)"}, DESIGN.md says ${fields.line}`);
  }
  const tracking = theme[`--text-${role}--letter-spacing`];
  if (fields.tracking && norm(tracking) !== norm(fields.tracking)) {
    fail(
      `type: --text-${role}--letter-spacing is ${tracking ?? "(absent)"}, ` +
        `DESIGN.md says ${fields.tracking}`,
    );
  }
  // `ledger` lost its tracking on purpose: locking it to 0.04em is why 225
  // plain 12px timestamps were written as literals instead.
  if (!fields.tracking && tracking !== undefined) {
    fail(`type: --text-${role} carries letter-spacing (${tracking}) that DESIGN.md does not`);
  }
}

for (const [name, family] of Object.entries(typeFamilies)) {
  const m = name.match(/^(display|ui|mono|signature)-family$/);
  if (!m) continue;
  const cssVar = { display: "serif", ui: "sans", mono: "mono", signature: "signature" }[m[1]];
  const actual = theme[`--font-${cssVar}`];
  if (actual === undefined) {
    fail(`type: --font-${cssVar} is missing`);
    continue;
  }
  const head = family.split(",")[0].trim();
  if (!actual.includes(head)) {
    fail(`type: --font-${cssVar} does not name ${head} (is: ${actual})`);
  }
}

for (const [name, value] of Object.entries(spacing)) {
  const actual = theme[`--spacing-${name}`];
  if (actual === undefined) fail(`spacing: --spacing-${name} is missing (DESIGN.md says ${value})`);
  else if (norm(actual) !== norm(value)) {
    fail(`spacing: --spacing-${name} is ${actual}, DESIGN.md says ${value}`);
  }
}

for (const [name, value] of Object.entries(rounded)) {
  const actual = theme[`--radius-${name}`];
  if (actual === undefined) fail(`radius: --radius-${name} is missing (DESIGN.md says ${value})`);
  else if (norm(actual.replace(/\s*\/\*.*/, "")) !== norm(value)) {
    fail(`radius: --radius-${name} is ${actual}, DESIGN.md says ${value}`);
  }
}

/* ── 5. Chrome, layers and motion ──────────────────────────────────── */

const rootAll = vars(css.slice(css.indexOf(":root {")));
for (const [name, value] of Object.entries(scalars("chrome"))) {
  const actual = rootAll[`--chrome-${name}`];
  if (norm(actual) !== norm(value)) {
    fail(`chrome: --chrome-${name} is ${actual ?? "(absent)"}, DESIGN.md says ${value}`);
  }
}
for (const [name, value] of Object.entries(scalars("layers"))) {
  const actual = rootAll[`--z-${name}`];
  if (norm(actual) !== norm(value)) {
    fail(`layers: --z-${name} is ${actual ?? "(absent)"}, DESIGN.md says ${value}`);
  }
}
for (const [name, value] of Object.entries(scalars("motion"))) {
  const key = name.startsWith("ease-") ? `--${name}` : `--motion-${name}`;
  const actual = key.startsWith("--ease-") ? theme[key] : rootAll[key];
  if (norm(actual) !== norm(value)) {
    fail(`motion: ${key} is ${actual ?? "(absent)"}, DESIGN.md says ${value}`);
  }
}

/* ── Report ────────────────────────────────────────────────────────── */

if (failures.length) {
  console.error("DESIGN.md ↔ globals.css: OUT OF SYNC\n");
  for (const f of failures) console.error("  ✗ " + f);
  console.error(
    `\n${failures.length} disagreement(s). Change DESIGN.md first, then the CSS —` +
      " the document is the contract.",
  );
  process.exit(1);
}
console.log("DESIGN.md ↔ globals.css: in sync.");
