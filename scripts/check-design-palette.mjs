#!/usr/bin/env node
/**
 * DESIGN.md "brown and cream law" gate.
 *
 * Cantina banned brown in prose and then drifted into it anyway, because a
 * ban nobody can run is a preference. These are the three tests from
 * DESIGN.md § "The brown and cream law", applied to the frontmatter palette.
 *
 * Exit 1 on any violation so CI can hold the line.
 */
import { readFileSync } from "node:fs";

const CLARET = new Set(["96122A", "B01230", "D01A3C", "E23B58", "F2879C", "2A0A11", "F7E4E8"]);
const CHAMPAGNE = new Set(["E6DCAE"]);

const front = readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8").split("---")[1];
const tokens = [...front.matchAll(/^\s*([\w-]+):\s*"#([0-9A-Fa-f]{6})"/gm)].map(
  ([, name, hex]) => ({ name, hex: hex.toUpperCase() }),
);

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

if (failures.length) {
  console.error(`DESIGN.md palette: ${failures.length} violation(s)\n` + failures.map((f) => `  ${f}`).join("\n"));
  process.exit(1);
}
console.log(`DESIGN.md palette: ${tokens.length} tokens, no brown, no cream.`);
