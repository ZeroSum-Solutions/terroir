#!/usr/bin/env node
/**
 * check-design-contrast.mjs — the contrast law, made runnable.
 *
 * DESIGN.md claims every pair in the system is measured rather than judged by
 * eye. A claim nobody can run is a preference, so this computes the actual
 * WCAG 2.2 relative-luminance ratios from the DESIGN.md frontmatter and exits
 * 1 on any pair that misses its floor.
 *
 * Floors (DESIGN.md — "The contrast law"):
 *   text          4.5:1  against every ground it can sit on
 *   fill          3:1    against every ground (a shape you cannot find)
 *   boundary      3:1    load-bearing only (`edge`), never decorative (`rule`)
 *   focus         3:1    and solid — alpha cannot be guaranteed
 *
 * Deliberately NOT checked: `rule` / `dark-rule`. WCAG 1.4.11 exempts purely
 * decorative boundaries, and forcing 3:1 there would require 0.37 alpha on
 * #07080A, which is scaffolding rather than a hairline.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "DESIGN.md"), "utf8");

function parseColors(text) {
  const block = text.match(/^colors:\n((?:[ \t]+.*\n)+)/m);
  if (!block) throw new Error("DESIGN.md: no `colors:` frontmatter block");
  const out = {};
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s+([a-z0-9-]+):\s*"([^"]+)"/i);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const HEX = /^#([0-9a-f]{6})$/i;
function channel(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const m = HEX.exec(hex);
  if (!m) throw new Error(`not a solid hex: ${hex}`);
  const n = parseInt(m[1], 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const c = parseColors(src);
const failures = [];
const checked = [];

function need(floor, fgName, bgName, why) {
  const fg = c[fgName];
  const bg = c[bgName];
  if (!fg || !bg) {
    failures.push(`missing token in pair ${fgName} on ${bgName}`);
    return;
  }
  if (!HEX.test(fg) || !HEX.test(bg)) return; // alpha tokens are unmeasurable by design
  const r = ratio(fg, bg);
  checked.push(r);
  if (r + 1e-9 < floor) {
    failures.push(
      `${fgName} (${fg}) on ${bgName} (${bg}) = ${r.toFixed(2)}:1, needs ${floor}:1 — ${why}`,
    );
  }
}

for (const p of ["", "dark-"]) {
  const room = p ? "Nocturne" : "Daylight";
  const grounds = ["canvas", "surface", "surface-raised", "surface-sunken", "wash"].map(
    (g) => p + g,
  );

  // Text must clear 4.5:1 on every ground it can land on — including
  // surface-raised, because that is where a hovered row sits.
  for (const ink of ["ink", "ink-soft", "grey", "accent"]) {
    for (const g of grounds) need(4.5, p + ink, g, `${room} body text`);
  }

  // The claret fill has to be findable as a shape before its label matters.
  for (const g of grounds) need(3, p + "primary", g, `${room} claret fill`);
  for (const g of grounds) need(3, p + "primary-hover", g, `${room} claret hover fill`);
  need(4.5, p + "seal-ink", p + "primary", `${room} label on a filled seal`);

  // Load-bearing boundaries and the focus indicator.
  for (const g of grounds) need(3, p + "edge", g, `${room} control boundary`);
  for (const g of grounds) need(3, p + "focus", g, `${room} focus indicator`);

  // Status inks on their own washes.
  for (const s of ["ready", "hold", "peak", "risk"]) {
    need(4.5, `${p}${s}-ink`, `${p}${s}-wash`, `${room} ${s} status`);
  }
}

if (failures.length) {
  console.error("DESIGN.md contrast: FAIL\n");
  for (const f of failures) console.error("  ✗ " + f);
  console.error(`\n${failures.length} failing pair(s) of ${checked.length + failures.length}.`);
  process.exit(1);
}
console.log(
  `DESIGN.md contrast: ${checked.length} pairs measured, all clear ` +
    `(worst ${Math.min(...checked).toFixed(2)}:1).`,
);
