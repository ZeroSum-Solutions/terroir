import { describe, expect, it } from "vitest";
import {
  bestSpanSimilarity,
  foldAccents,
  resolveWineName,
  similarity,
  type WineCandidate,
} from "./name-resolver";
import parity from "./fixtures/trgm-parity-vectors.json";
import inventory from "./fixtures/voice-eval-inventory.json";

// Contract: similarity/bestSpanSimilarity must be numerically identical to the
// spike-1 Python implementation, which was itself validated byte-exact
// (max |delta| = 0.000000 over 203 pairs) against live Postgres 16 pg_trgm —
// the same operator match_lwin (0078) uses. The vectors were COMPUTED by that
// Python implementation; this is a golden-vector contract test, not an
// eyeball port.

describe("pg_trgm parity (golden vectors from the Postgres-validated impl)", () => {
  it(`matches all ${parity.sim.length} similarity vectors`, () => {
    for (const v of parity.sim) {
      expect(Math.abs(similarity(v.a, v.b) - v.sim), `similarity(${JSON.stringify(v.a)}, ${JSON.stringify(v.b)})`).toBeLessThan(1e-9);
    }
  });

  it(`matches all ${parity.bestSpan.length} best-span vectors from real STT transcripts`, () => {
    for (const v of parity.bestSpan) {
      expect(
        Math.abs(bestSpanSimilarity(v.target, v.transcript) - v.best),
        `bestSpan(${JSON.stringify(v.target)}, ${JSON.stringify(v.transcript)})`,
      ).toBeLessThan(1e-9);
    }
  });
});

describe("accent folding (spike-1 measured hard requirement)", () => {
  // Measured live 2026-08-25: pg similarity('côte-rôtie','cote rotie') = 0.294,
  // BELOW match_lwin's 0.3 threshold. The resolver folds accents on both sides
  // so accented STT output matches the 99.75%-ASCII catalog.
  it("folded accented query matches its ASCII form at 1.0", () => {
    expect(similarity("côte-rôtie", "cote rotie")).toBe(1);
  });

  it("foldAccents strips diacritics without dropping letters", () => {
    expect(foldAccents("Bâtard-Montrachet")).toBe("Batard-Montrachet");
    expect(foldAccents("Peñafiel Grüner")).toBe("Penafiel Gruner");
  });
});

const inv = inventory as WineCandidate[];

describe("resolveWineName decision rule", () => {
  it("resolves a clean in-inventory transcript to the right item", () => {
    const r = resolveWineName("Do we still have the 2018 Gevrey-Chambertin from Domaine Fourrier?", inv);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.match.candidate.itemId).toBe("I000");
  });

  it("abstains on the spike-9 shared-vocabulary failure: out-of-inventory Biondi-Santi Brunello", () => {
    // A perfect transcript for a wine NOT in inventory. The naive baseline
    // resolves this to Fanti's Brunello at 0.53 (appellation vocabulary
    // dominates the trigram mass) — the exact confident-wrong-answer the
    // abstain-over-misidentify NFR forbids. Producer corroboration must
    // refuse it: no span of this transcript corroborates "Fanti".
    const r = resolveWineName("Brunello di Montalcino from Biondi-Santi, 2016", inv);
    expect(r.kind).toBe("abstain");
  });

  it("abstains on an empty transcript", () => {
    expect(resolveWineName("", inv).kind).toBe("abstain");
  });

  it("abstains on non-wine garbage", () => {
    expect(resolveWineName("uh can we get the check please", inv).kind).toBe("abstain");
  });

  it("carries the losing score in the abstain result for UX correction-search", () => {
    const r = resolveWineName("Brunello di Montalcino from Biondi-Santi, 2016", inv);
    if (r.kind === "abstain") {
      expect(r.best).toBeDefined();
      expect(r.best!.score).toBeGreaterThan(0.3);
    }
  });

  it("accepts a cuvée-only request without producer corroboration when nothing is unexplained", () => {
    const tiny: WineCandidate[] = [
      { itemId: "A", displayName: "Musigny Grand Cru", producer: "Leroy" },
      { itemId: "B", displayName: "Cabernet Sauvignon Reserve", producer: "Caymus" },
    ];
    // Producer never spoken, but every non-carrier word of the request is
    // explained by the winning row — the residue-vetoed arm accepts.
    const r = resolveWineName("a glass of the Musigny Grand Cru", tiny);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.match.candidate.itemId).toBe("A");
  });

  it("refuses the uncorroborated arm when the transcript carries an unexplained name", () => {
    const tiny: WineCandidate[] = [
      { itemId: "A", displayName: "Musigny Grand Cru", producer: "Leroy" },
      { itemId: "B", displayName: "Cabernet Sauvignon Reserve", producer: "Caymus" },
    ];
    // Same request naming a producer we don't stock: 'roumier' matches no
    // word of the winning row -> abstain, not a confident wrong answer.
    const r = resolveWineName("a glass of the Musigny Grand Cru from Roumier", tiny);
    expect(r.kind).toBe("abstain");
  });
});
