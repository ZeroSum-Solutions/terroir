#!/usr/bin/env node
/**
 * DESIGN.md "brown and cream law" gate.
 *
 * Cantina banned brown in prose and then drifted into it anyway, because a ban
 * nobody can run is a preference.
 *
 * Two surfaces are checked, because checking only the frontmatter is how a
 * Cantina brown (#8B6914) and a Cantina cream (#E3D9CB) survived an entire
 * palette migration inside one component's inline styles:
 *
 *   1. The DESIGN.md frontmatter palette, against the four channel tests in
 *      § "The brown and cream law". Those tests are written for a palette that
 *      is mostly neutrals plus two named hues, and they are exact there.
 *
 *   2. Every colour literal written into src/. Channel tests are the wrong
 *      instrument here — #8B6914 is neither a dark neutral nor a light one, it
 *      is a saturated warm mid-tone — so this surface is judged in HSL, which
 *      is how "brown" and "cream" are actually defined: a warm hue that is
 *      either too dark or too pale to be a colour in its own right.
 *
 * Exit 1 on any violation so CI can hold the line.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const CLARET = new Set(["96122A", "B01230", "D01A3C", "E23B58", "F2879C", "2A0A11", "F7E4E8"]);
const CHAMPAGNE = new Set(["E6DCAE"]);

/**
 * Surfaces that are deliberately not Nocturne:
 *  - printed menus and the standalone HTML export are the CLIENT's artefact,
 *    on paper, with the client's own palette;
 *  - the brand-kit feature exists to ingest arbitrary client colours, and its
 *    fixtures are input data, not Terroir's palette;
 *  - tests carry those same fixtures.
 */
const NOT_THE_APP = [
  "src/lib/wine-list/",
  "src/lib/branding/",
  "src/app/list/",
  "src/app/api/brand-kit/",
  "src/test/",
  "src/app/globals.css", // the token layer itself, checked via DESIGN.md
];

/* ── 1. The frontmatter palette ────────────────────────────────────── */

const front = readFileSync(join(root, "DESIGN.md"), "utf8").split("---")[1];
const tokens = [...front.matchAll(/^\s*([\w-]+):\s*"#([0-9A-Fa-f]{6})"/gm)].map(
  ([, name, hex]) => ({ name, hex: hex.toUpperCase() }),
);
const palette = new Set(tokens.map((t) => t.hex));

const failures = [];
for (const { name, hex } of tokens) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminous = Math.max(r, g, b);

  if (CHAMPAGNE.has(hex)) {
    // Rule 4 — pale and bright, so it can only ever be a mark on a dark ground.
    if (Math.abs(r - g) > 12) failures.push(`${name} #${hex}: champagne needs |r-g| <= 12 (r${r} g${g} b${b}) — this is rotating toward tan`);
    if (luminous < 0xc0) failures.push(`${name} #${hex}: champagne must stay light (max channel >= C0) — a warm mid-tone is how brown starts`);
    continue;
  }
  if (CLARET.has(hex)) {
    // Rule 3 — claret stays pink, never peach.
    if (b <= g) failures.push(`${name} #${hex}: claret must keep b > g (r${r} g${g} b${b})`);
    continue;
  }
  // Rule 1 — neutral darks are cool.
  if (luminous < 0x40 && b < r) {
    failures.push(`${name} #${hex}: dark neutral must keep b >= r (r${r} g${g} b${b}) — this is brown`);
  }
  // Rule 2 — neutral lights are neutral.
  if (luminous > 0xc0 && r - b > 4) {
    failures.push(`${name} #${hex}: light neutral must keep r - b <= 4 (r${r} g${g} b${b}) — this is cream`);
  }
}

/* ── 2. Colour literals in the app's own source ────────────────────── */

function hsl(hex) {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l }; // a true grey has no hue to judge
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = 60 * (((g - b) / d + 6) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return { h, s, l };
}

function warmFault(hex) {
  const { h, s, l } = hsl(hex);
  if (s <= 0.05) return null; // a neutral grey is not a brown
  if (h < 15 || h >= 60) return null; // outside the orange–yellow wedge
  if (l < 0.72 && s > 0.15) return "brown — a warm hue this dark is brown, whatever it is called";
  if (l >= 0.8) return "cream — a warm hue this pale is cream, whatever it is called";
  return null;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

let scanned = 0;
for (const file of walk(join(root, "src"))) {
  const rel = relative(root, file).split("\\").join("/");
  if (NOT_THE_APP.some((prefix) => rel.startsWith(prefix))) continue;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/#([0-9A-Fa-f]{6})\b/g)) {
    const hex = m[1].toUpperCase();
    scanned++;
    // A colour that IS in the palette is fine wherever it appears; the
    // frontmatter check above already judged it.
    if (palette.has(hex) || CHAMPAGNE.has(hex) || CLARET.has(hex)) continue;
    const fault = warmFault(hex);
    if (fault) {
      const line = text.slice(0, m.index).split("\n").length;
      failures.push(`${rel}:${line} #${hex}: ${fault}`);
    }
  }
}

if (failures.length) {
  console.error(`Palette: ${failures.length} violation(s)\n` + failures.map((f) => `  ${f}`).join("\n"));
  process.exit(1);
}
console.log(
  `Palette: ${tokens.length} DESIGN.md tokens + ${scanned} source literal(s), no brown, no cream.`,
);
