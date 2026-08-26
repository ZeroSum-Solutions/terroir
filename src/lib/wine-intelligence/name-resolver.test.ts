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
// spike-1 Python implementation (composed with the œ/æ pre-fold — see
// fixtures/generate.py, the committed generator). The Python implementation
// was validated byte-exact (max |delta| = 0.000000 over 203 pairs) against
// live Postgres 16 pg_trgm — the operator match_lwin (0078) uses — on
// accent-folded/ASCII material. Golden-vector contract test, not an eyeball
// port.

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

  it("foldAccents strips diacritics and expands ligatures without dropping letters", () => {
    expect(foldAccents("Bâtard-Montrachet")).toBe("Batard-Montrachet");
    expect(foldAccents("Peñafiel Grüner")).toBe("Penafiel Gruner");
    expect(foldAccents("Clos de la Cœur")).toBe("Clos de la Coeur");
    expect(similarity("cœur", "coeur")).toBe(1);
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
    // resolves this to Fanti's Brunello at 0.59 (appellation vocabulary
    // dominates the trigram mass) — the exact confident-wrong-answer the
    // abstain-over-misidentify NFR forbids.
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
    const r = resolveWineName("a glass of the Musigny Grand Cru", tiny);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.match.candidate.itemId).toBe("A");
  });

  it("refuses the uncorroborated arm when the transcript carries an unexplained name", () => {
    const tiny: WineCandidate[] = [
      { itemId: "A", displayName: "Musigny Grand Cru", producer: "Leroy" },
      { itemId: "B", displayName: "Cabernet Sauvignon Reserve", producer: "Caymus" },
    ];
    const r = resolveWineName("a glass of the Musigny Grand Cru from Roumier", tiny);
    expect(r.kind).toBe("abstain");
  });
});

describe("audit counterexamples (2026-08-25 GPT-5.6 Sol) — each was a wrong resolution under v3", () => {
  it("a cuvée/style word never acts as producer evidence, and an unstocked attributed producer abstains", () => {
    // producer literally "Reserve": the transcript word "reserve" must not
    // corroborate it, and "from Caymus" with no Caymus row is a contradiction.
    const r = resolveWineName("Cabernet Sauvignon Reserve from Caymus", [
      { itemId: "A", displayName: "Cabernet Sauvignon", producer: "Reserve" },
    ]);
    expect(r.kind).toBe("abstain");
  });

  it("a carrier word never corroborates a producer that happens to spell one", () => {
    const r = resolveWineName("a glass of the Musigny Grand Cru from Roumier", [
      { itemId: "A", displayName: "Musigny Grand Cru", producer: "Glass" },
    ]);
    expect(r.kind).toBe("abstain");
  });

  it("near-namesake attribution abstains even against a single candidate (santi vs Fanti at 0.333)", () => {
    const r = resolveWineName("Brunello di Montalcino from Santi", [
      { itemId: "A", displayName: "Brunello di Montalcino, Vallocchio", producer: "Fanti" },
    ]);
    expect(r.kind).toBe("abstain");
  });

  it("same-producer subset bottlings return a disambiguation list, not the shorter row", () => {
    const r = resolveWineName("Domaine Roumier Musigny", [
      { itemId: "A", displayName: "Musigny", producer: "Domaine Roumier" },
      { itemId: "B", displayName: "Musigny Vieilles Vignes", producer: "Domaine Roumier" },
    ]);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map((c) => c.candidate.itemId).sort()).toEqual(["A", "B"]);
    }
  });

  it("a bare high-frequency grape word resolves nothing against a real inventory", () => {
    expect(resolveWineName("cabernet", inv).kind).toBe("abstain");
  });

  it("safety is monotone under inventory growth (the df filter cannot re-arm a word)", () => {
    const base: WineCandidate[] = [{ itemId: "A", displayName: "Cabernet Sauvignon", producer: "Reserve" }];
    const grown = base.concat(
      Array.from({ length: 98 }, (_, i) => ({
        itemId: `X${i}`,
        displayName: `Zinfandel Lot ${i}`,
        producer: `Prod${i}`,
      })),
    );
    expect(resolveWineName("Cabernet Sauvignon Reserve from Caymus", base).kind).toBe("abstain");
    expect(resolveWineName("Cabernet Sauvignon Reserve from Caymus", grown).kind).toBe("abstain");
  });

  it("a very long transcript is truncated, not scored unbounded", () => {
    const noise = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
    const t0 = Date.now();
    const r = resolveWineName(`${noise} Musigny`, [
      { itemId: "A", displayName: "Musigny Grand Cru", producer: "Leroy" },
    ]);
    expect(Date.now() - t0).toBeLessThan(2000);
    // the wine name sits beyond the truncation window — the resolver must
    // abstain rather than hallucinate from noise
    expect(r.kind).toBe("abstain");
  });

  it("rejects option values that would disable the safety gates", () => {
    const tiny: WineCandidate[] = [{ itemId: "A", displayName: "Musigny", producer: "Leroy" }];
    expect(() => resolveWineName("musigny", tiny, { producerWordThreshold: 0 })).toThrow(RangeError);
    expect(() => resolveWineName("musigny", tiny, { acceptThreshold: Number.NaN })).toThrow(RangeError);
    expect(() => resolveWineName("musigny", tiny, { marginFloor: -1 })).toThrow(RangeError);
    expect(() => resolveWineName("musigny", tiny, { ambiguityMargin: 1 })).toThrow(RangeError);
    expect(() => resolveWineName("musigny", tiny, { residueMatchThreshold: 2 })).toThrow(RangeError);
  });

  it("candidate list of one and empty candidate list both behave", () => {
    expect(resolveWineName("the Musigny", []).kind).toBe("abstain");
    const r = resolveWineName("the Leroy Musigny", [{ itemId: "A", displayName: "Musigny", producer: "Leroy" }]);
    expect(r.kind).toBe("resolved");
  });
});
