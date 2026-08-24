// P2 round-4 (D8 — scratchpad db-audit/verify/P2-critic-r3.md): regenerates
// src/domains/identity/__fixtures__/normalization-golden-vectors.json — P2's
// OWN committed, frozen snapshot of the normalizeProducerOrCuvee and
// normalizeVintage/isNvVintageText contract with P1's normalizeForDedup.
//
// WHY THIS FILE EXISTS: the live cross-worktree contract tests in
// normalize.test.ts (`await import(p1FixturePath)`) only run when the
// terroir-vw-p1 sibling worktree is present on disk — they silently SKIP
// otherwise, which means they protect nothing in CI, nothing after these
// worktrees are cleaned up, and nothing on any machine that isn't this one.
// This golden file is the fix: a frozen (input, expected) snapshot that
// normalize.test.ts asserts UNCONDITIONALLY, on every machine, forever —
// no sibling path, no skipIf, no environment luck. The live cross-worktree
// check stays too, as an ADDITIONAL guard that catches future drift on
// EITHER side while both worktrees still exist.
//
// THIS IS NOT A ROUTINE REFRESH. Regenerating this file is a DELIBERATE
// CONTRACT CHANGE — it re-freezes what "correct" means for every future
// run of the golden-vector test. Only run this when P1's normalizeForDedup
// (scripts/fixtures/generate-partner-cellar.mjs, terroir-vw-p1) and P2's
// normalizeProducerOrCuvee/normalizeVintage (src/domains/identity/normalize.ts)
// are being changed TOGETHER and have already been confirmed to agree.
// This script REFUSES to write the file if the two sides disagree on any
// vector — specifically so a solo edit on either side can never silently
// re-freeze a broken contract. It also refuses to run at all if the P1
// sibling worktree isn't present, for the same reason: this is a
// cross-piece coordination act, not a P2-only regeneration.
//
// Usage: pnpm exec tsx scripts/generate-identity-golden-vectors.ts
// Requires terroir-vw-p1 checked out as a sibling worktree
// (../terroir-vw-p1 relative to this repo's parent directory).
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProducerOrCuvee, normalizeVintage, isNvVintageText } from "../src/domains/identity/normalize";

const p1FixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../terroir-vw-p1/scripts/fixtures/generate-partner-cellar.mjs",
);

type P1Module = {
  SEED: number;
  normalizeForDedup: (s: string) => string;
  generateDataset: (opts?: { seed?: number; extras?: boolean; dirty?: boolean }) => {
    dirtyRecords: { dirtyCategory: string; vintageOverride?: string }[];
  };
};

// The adversarial producer/cuvee corpus — possessives (the class that
// motivated this file, D3/D7) plus every previously-safe category that
// must keep agreeing. Keep this in sync with the corpus in
// src/domains/identity/normalize.test.ts's live cross-worktree describe
// block; that test iterates this SAME golden file's inputs rather than a
// second hand-maintained list, so there is exactly one source of truth.
const PRODUCER_OR_CUVEE_CORPUS = [
  // --- possessives ---
  "O'Brien's Vineyard",
  "O’Brien’s Vineyard", // curly right-single-quote variant
  "St. James's Gate",
  "Kings' Vineyard's Reserve", // multiple possessives in one name
  "Kings' Vineyard", // plural-only possessive (trailing ' with no following s)
  "d'Arenberg's Estate", // internal apostrophe + trailing possessive combined
  "Domaine O'Brien's", // realistic partner-CSV shape
  "The Winemakers' Collective",
  "Marks & Spencer's Reserve",
  // --- previously-safe categories: must stay in agreement ---
  "Château Belair-Vauban",
  "Chateau Belair-Vauban",
  "Cœur d'Alsace",
  "Coeur d'Alsace",
  "Domaine Jean Grivot",
  "Jean Grivot Domaine",
  "Señorío de Valdemoro",
  "Domaine René Léveillé",
];

async function main() {
  if (!existsSync(p1FixturePath)) {
    console.error(
      "REFUSING TO RUN: terroir-vw-p1 sibling worktree not found at " +
        p1FixturePath +
        ". This generator is a cross-piece coordination act, not a P2-only " +
        "regeneration — it requires both sides present so it can verify " +
        "agreement before freezing anything.",
    );
    process.exit(1);
  }

  const mod = (await import(p1FixturePath)) as P1Module;

  // --- producer/cuvee vectors ---
  const disagreements: string[] = [];
  const producerOrCuveeVectors: { input: string; expected: string }[] = [];
  for (const input of PRODUCER_OR_CUVEE_CORPUS) {
    const p1Result = mod.normalizeForDedup(input);
    const p2Result = normalizeProducerOrCuvee(input);
    if (p1Result !== p2Result) {
      disagreements.push(`"${input}" -> P1: "${p1Result}"  P2: "${p2Result}"`);
      continue;
    }
    producerOrCuveeVectors.push({ input, expected: p2Result });
  }

  if (disagreements.length > 0) {
    console.error("REFUSING TO WRITE: P1 and P2 disagree on the following inputs:");
    console.error(disagreements.join("\n"));
    console.error("\nFix the disagreement on whichever side is wrong, confirm live agreement, then re-run.");
    process.exit(1);
  }

  // --- vintage-text vectors ---
  // Pull P1's actual bad_vintage_text values from its own generated
  // dataset (not hand-copied) — the exact same methodology
  // normalize.test.ts's existing live contract test already uses, so
  // there is one source of truth for "what P1 actually emits," not two.
  const { dirtyRecords } = mod.generateDataset({ seed: mod.SEED, dirty: true });
  const dirtyVintageTexts = [
    ...new Set(
      dirtyRecords
        .filter((r) => r.dirtyCategory === "bad_vintage_text")
        .map((r) => r.vintageOverride)
        .filter((v): v is string => typeof v === "string"),
    ),
  ];

  const vintageTextVectors = dirtyVintageTexts.map((input) => {
    const expectedIsNv = isNvVintageText(input);
    let outcome: "throws" | number | null;
    try {
      outcome = normalizeVintage(input);
    } catch {
      outcome = "throws";
    }
    return { input, expectedIsNv, outcome };
  });

  const goldenFile = {
    _comment:
      "FROZEN CONTRACT SNAPSHOT for P1's normalizeForDedup <-> P2's " +
      "normalizeProducerOrCuvee/normalizeVintage. Do not hand-edit. " +
      "Regenerate ONLY via `pnpm exec tsx scripts/generate-identity-golden-vectors.ts`, " +
      "and ONLY as a deliberate, coordinated contract change between both " +
      "sides — never as a routine refresh to silence a failing test. " +
      "Consumed unconditionally (no skipIf) by " +
      "src/domains/identity/normalize.test.ts.",
    generatedAt: new Date().toISOString(),
    p1Seed: mod.SEED,
    producerOrCuveeVectors,
    vintageTextVectors,
  };

  const outPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/domains/identity/__fixtures__/normalization-golden-vectors.json",
  );
  await writeFile(outPath, JSON.stringify(goldenFile, null, 2) + "\n", "utf8");
  console.log(
    `Wrote ${producerOrCuveeVectors.length} producer/cuvee vectors and ${vintageTextVectors.length} vintage-text vectors to ${outPath}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
