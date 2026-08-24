// P2 — golden-vector contract test against P1's fixture generator.
//
// docs/plans/2026-08-23-p2-identity-spine.md §5's "critical cross-piece
// fact": P1's fixture generator (scripts/fixtures/generate-partner-cellar.mjs,
// a SEPARATE worktree — terroir-vw-p1 — this P2 worktree cannot edit) has
// its own inline normalizeForDedup() used to prove its spelling-noise
// groups converge. This file imports that function AND P1's own
// generateDataset() DIRECTLY from the sibling worktree and asserts
// agreement with this worktree's normalizeProducerOrCuvee/normalizeVintage
// — not a hand-copied fixture, the actual live function, so a future edit
// to either side that breaks the contract fails this test immediately.
//
// Requires terroir-vw-p1 checked out as a sibling directory
// (../../../../terroir-vw-p1 relative to this file) — true in this dev
// environment (both are worktrees of the same repo under
// /Users/zero/projects/). If that sibling doesn't exist, these tests are
// skipped rather than failing the whole suite (see hasP1Fixture below).
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { normalizeProducerOrCuvee, normalizeVintage, isNvVintageText } from "./normalize";

const p1FixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../terroir-vw-p1/scripts/fixtures/generate-partner-cellar.mjs",
);
const hasP1Fixture = existsSync(p1FixturePath);

type P1Variant = {
  producer: string;
  name: string;
  vintage: number | null;
  sizeMl: number;
  altSpelling?: { producer: string; name: string };
  tags: {
    spellingGroupId: string | null;
    spellingType: string | null;
    adjacentFamily: string | null;
    formatFamily: string | null;
  };
};

type P1DirtyRecord = {
  dirtyCategory: string;
  vintageOverride?: string;
};

type P1Module = {
  SEED: number;
  normalizeForDedup: (s: string) => string;
  generateDataset: (opts?: { seed?: number; extras?: boolean; dirty?: boolean }) => {
    variants: P1Variant[];
    dirtyRecords: P1DirtyRecord[];
  };
};

describe.skipIf(!hasP1Fixture)("golden-vector contract with P1's fixture (terroir-vw-p1)", () => {
  it("loads the sibling worktree's fixture module", async () => {
    const mod = (await import(p1FixturePath)) as P1Module;
    expect(typeof mod.normalizeForDedup).toBe("function");
    expect(typeof mod.generateDataset).toBe("function");
  });

  it("all 40 SPELLING_SEEDS groups: canonical and alt forms normalize identically under BOTH P1's normalizeForDedup and P2's normalizeProducerOrCuvee", async () => {
    const mod = (await import(p1FixturePath)) as P1Module;
    const { variants } = mod.generateDataset({ seed: mod.SEED });
    const spellingGroups = variants.filter((v) => v.tags.spellingGroupId !== null);

    // Sanity: the fixture really does carry all 40 dedicated groups (10
    // per category: accent_stripped, nfc_nfd, punctuation_spacing,
    // producer_reorder) — a silent drop to fewer groups would make the
    // rest of this test vacuously weaker.
    const groupIds = new Set(spellingGroups.map((v) => v.tags.spellingGroupId));
    expect(groupIds.size).toBe(40);

    for (const v of spellingGroups) {
      expect(v.altSpelling).toBeTruthy();
      const alt = v.altSpelling!;

      // P2's own function: canonical and alt forms collapse to the same
      // normalized key.
      expect(normalizeProducerOrCuvee(alt.producer)).toBe(normalizeProducerOrCuvee(v.producer));
      expect(normalizeProducerOrCuvee(alt.name)).toBe(normalizeProducerOrCuvee(v.name));

      // P1's own function, on the SAME inputs: byte-for-byte agreement
      // with P2's outputs — the actual cross-piece contract, not just
      // "both converge internally."
      expect(mod.normalizeForDedup(v.producer)).toBe(normalizeProducerOrCuvee(v.producer));
      expect(mod.normalizeForDedup(v.name)).toBe(normalizeProducerOrCuvee(v.name));
      expect(mod.normalizeForDedup(alt.producer)).toBe(normalizeProducerOrCuvee(alt.producer));
      expect(mod.normalizeForDedup(alt.name)).toBe(normalizeProducerOrCuvee(alt.name));
    }
  });

  it("normalizeVintage: exactly one (the literal \"NV\") of P1's 7 DIRTY_VINTAGE_TEXTS now passes; the other six still fail", async () => {
    const mod = (await import(p1FixturePath)) as P1Module;
    const { dirtyRecords } = mod.generateDataset({ seed: mod.SEED, dirty: true });
    const dirtyVintageTexts = [
      ...new Set(
        dirtyRecords
          .filter((r) => r.dirtyCategory === "bad_vintage_text")
          .map((r) => r.vintageOverride)
          .filter((v): v is string => typeof v === "string"),
      ),
    ];

    // Sanity: the fixture really carries 7 distinct dirty vintage texts.
    expect(dirtyVintageTexts).toHaveLength(7);
    expect(dirtyVintageTexts).toContain("NV");

    const passed = dirtyVintageTexts.filter((text) => {
      try {
        return normalizeVintage(text) === null;
      } catch {
        return false;
      }
    });
    expect(passed).toEqual(["NV"]);

    const failed = dirtyVintageTexts.filter((text) => {
      try {
        normalizeVintage(text);
        return false;
      } catch {
        return true;
      }
    });
    expect(failed.sort()).toEqual(dirtyVintageTexts.filter((t) => t !== "NV").sort());
  });

  it("negative guarantee: adjacent-vintage family members share one normalized (producer,cuvee) key but keep every vintage distinct", async () => {
    const mod = (await import(p1FixturePath)) as P1Module;
    const { variants } = mod.generateDataset({ seed: mod.SEED });
    const families = new Map<string, P1Variant[]>();
    for (const v of variants) {
      if (!v.tags.adjacentFamily) continue;
      const list = families.get(v.tags.adjacentFamily) ?? [];
      list.push(v);
      families.set(v.tags.adjacentFamily, list);
    }
    expect(families.size).toBeGreaterThan(0);

    for (const members of families.values()) {
      const keys = new Set(members.map((m) => `${normalizeProducerOrCuvee(m.producer)}|${normalizeProducerOrCuvee(m.name)}`));
      // Same real producer/cuvée — normalization correctly recognizes them
      // as one identity text-wise...
      expect(keys.size).toBe(1);
      // ...but vintage itself is never touched by normalization and stays
      // fully distinct per member — this, not the text key, is what keeps
      // "two genuinely different wines" (different vintages) from ever
      // colliding into one identity.
      const vintages = new Set(members.map((m) => m.vintage));
      expect(vintages.size).toBe(members.length);
    }
  });

  it("negative guarantee: format-sibling family members share one normalized (producer,cuvee) key but keep every size_ml distinct", async () => {
    const mod = (await import(p1FixturePath)) as P1Module;
    const { variants } = mod.generateDataset({ seed: mod.SEED });
    const families = new Map<string, P1Variant[]>();
    for (const v of variants) {
      if (!v.tags.formatFamily) continue;
      const list = families.get(v.tags.formatFamily) ?? [];
      list.push(v);
      families.set(v.tags.formatFamily, list);
    }
    expect(families.size).toBeGreaterThan(0);

    for (const members of families.values()) {
      const keys = new Set(members.map((m) => `${normalizeProducerOrCuvee(m.producer)}|${normalizeProducerOrCuvee(m.name)}`));
      expect(keys.size).toBe(1);
      const sizes = new Set(members.map((m) => m.sizeMl));
      expect(sizes.size).toBe(members.length);
    }
  });
});

describe("normalizeProducerOrCuvee (unit, no P1 dependency)", () => {
  it("strips accents and folds case", () => {
    expect(normalizeProducerOrCuvee("Château Belair-Vauban")).toBe(normalizeProducerOrCuvee("Chateau Belair-Vauban"));
  });

  it("folds œ/æ ligatures by hand (NFKD alone does not decompose them)", () => {
    expect(normalizeProducerOrCuvee("Cœur d'Alsace")).toBe(normalizeProducerOrCuvee("Coeur d'Alsace"));
  });

  it("is word-order invariant via token sort", () => {
    expect(normalizeProducerOrCuvee("Domaine Jean Grivot")).toBe(normalizeProducerOrCuvee("Jean Grivot Domaine"));
  });

  it("does NOT treat two genuinely different producers as equal", () => {
    expect(normalizeProducerOrCuvee("Domaine Jean Grivot")).not.toBe(normalizeProducerOrCuvee("Domaine Anne Gros"));
  });

  // D3 (round-2 critic finding): a possessive apostrophe and a pair of
  // period-separated initials used to both decay to stray single-character
  // tokens ("brien"+"s" vs "o"+"s"), producing an IDENTICAL sorted token
  // multiset for two plausibly different producers.
  it("does NOT collapse a possessive apostrophe and period-separated initials into the same key (D3)", () => {
    expect(normalizeProducerOrCuvee("O'Brien's Vineyard")).not.toBe(normalizeProducerOrCuvee("O.S. Brien Vineyard"));
  });

  it("still folds a name-internal apostrophe exactly as before (byte-for-byte parity with P1's frozen normalizeForDedup)", () => {
    // Cœur d'Alsace / Coeur d'Alsace is P1's own punctuation_spacing golden
    // vector (generate-partner-cellar.mjs SPELLING_SEEDS). The D3 fix must
    // NOT touch this apostrophe position — only a trailing possessive "'s".
    expect(normalizeProducerOrCuvee("Cœur d'Alsace")).toBe(normalizeProducerOrCuvee("Coeur d'Alsace"));
  });
});

describe("normalizeVintage / isNvVintageText (unit, no P1 dependency)", () => {
  it("returns null for empty/null input", () => {
    expect(normalizeVintage(null)).toBeNull();
    expect(normalizeVintage("")).toBeNull();
    expect(normalizeVintage("   ")).toBeNull();
  });

  it("accepts the closed NV allowlist, case/spacing/punctuation-insensitive", () => {
    for (const text of ["NV", "nv", "N V", "n.v.", "non vintage", "NONVINTAGE", "MV", "multi-vintage"]) {
      expect(isNvVintageText(text)).toBe(true);
      expect(normalizeVintage(text)).toBeNull();
    }
  });

  it("still accepts a valid numeric vintage", () => {
    expect(normalizeVintage("2018")).toBe(2018);
  });

  it("still rejects garbage text that merely resembles NV-adjacent noise", () => {
    for (const text of ["N/A", "unknown", "TBD"]) {
      expect(isNvVintageText(text)).toBe(false);
      expect(() => normalizeVintage(text)).toThrow();
    }
  });

  it("rejects an out-of-range year", () => {
    expect(() => normalizeVintage("1899")).toThrow();
    expect(() => normalizeVintage(String(CURRENT_YEAR_PLUS_TWO()))).toThrow();
  });
});

function CURRENT_YEAR_PLUS_TWO(): number {
  return new Date().getFullYear() + 2;
}

// P2 round-3 (D3-residual — scratchpad db-audit/verify/P2-critic-r2.md):
// the D3 fix (merging a trailing possessive "'s") was verified correct
// for its OWN named case, but the golden-vector test above structurally
// cannot catch drift between P1's frozen normalizeForDedup and P2's
// normalizeProducerOrCuvee on any input outside P1's 40 SPELLING_SEEDS —
// and the round-2 critic proved live that they genuinely disagree on a
// realistic possessive-name corpus absent from that fixture ("O'Brien's
// Vineyard", "d'Arenberg's Estate", "St. James's Gate", "Kings'
// Vineyard's Reserve", plus the U+2019 curly-quote variant). This is a
// SEPARATE, adversarial parity check — not pairs of "these should match
// each other," but "does P1's live function agree with P2's live
// function on the SAME raw string" — and it is written to FAIL on any
// divergence, not to skip or soften one. It is expected to be RED until
// P1's normalizeForDedup adopts the identical possessive-merging rule
// P2 uses (see the exact regex documented above
// normalizeProducerOrCuvee): `.replace(/['’]s(?=\s|$)/g, "s")`,
// inserted immediately after `.toLowerCase()` and before the general
// `.replace(/[^a-z0-9]+/g, " ")` collapse — byte-identical placement and
// pattern to P2's own implementation. This is NOT a live production bug
// today (P1's function never runs in production; only P2's does), but it
// is a real, currently-failing contract-integrity gap this test exists
// to make impossible to miss going forward.
describe.skipIf(!hasP1Fixture)("adversarial P1/P2 normalization parity (round-3, D3-residual)", () => {
  // A flat list of realistic single inputs — not matched pairs — checked
  // for exact output agreement between the two live implementations.
  // Includes the possessive class that currently diverges (trailing
  // possessive, curly-quote possessive, internal + trailing possessive
  // combined, plural-only possessive, multiple possessives in one name)
  // PLUS a re-check of every previously-safe category (accent-stripped,
  // NFC/NFD, punctuation/spacing, producer-reorder, ligature) so this one
  // file is the complete standing parity contract, not just the new gap.
  const ADVERSARIAL_NORMALIZATION_CORPUS = [
    // --- possessives: currently DIVERGENT until P1 syncs (D7) ---
    "O'Brien's Vineyard",
    "O’Brien’s Vineyard", // curly right-single-quote variant
    "St. James's Gate",
    "Kings' Vineyard's Reserve", // multiple possessives in one name
    "Kings' Vineyard", // plural-only possessive (trailing ' with no following s)
    "d'Arenberg's Estate", // internal apostrophe + trailing possessive combined
    "Domaine O'Brien's", // realistic partner-CSV shape per the coordinator's example
    "The Winemakers' Collective",
    "Marks & Spencer's Reserve",
    // --- previously-verified-safe categories: must stay in agreement ---
    "Château Belair-Vauban",
    "Chateau Belair-Vauban",
    "Cœur d'Alsace",
    "Coeur d'Alsace",
    "Domaine Jean Grivot",
    "Jean Grivot Domaine",
    "Señorío de Valdemoro",
    "Domaine René Léveillé",
  ];

  it("P1's live normalizeForDedup and P2's live normalizeProducerOrCuvee agree on every corpus item (must FAIL on any divergence)", async () => {
    const mod = (await import(p1FixturePath)) as P1Module;
    const disagreements: string[] = [];
    for (const raw of ADVERSARIAL_NORMALIZATION_CORPUS) {
      const p1Result = mod.normalizeForDedup(raw);
      const p2Result = normalizeProducerOrCuvee(raw);
      if (p1Result !== p2Result) {
        disagreements.push(`"${raw}" -> P1: "${p1Result}"  P2: "${p2Result}"`);
      }
    }
    expect(disagreements.join("\n")).toBe("");
  });
});
