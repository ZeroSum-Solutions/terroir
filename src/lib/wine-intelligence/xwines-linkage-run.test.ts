// Pure helpers for the WS-IDENT batch run (scripts/link-lwin-xwines.ts) and
// its QA harness — the seed-pass exact join (identity policy §2 step 1), the
// coverage report's score bands (§4), and the deterministic stratified sample
// behind the 200-link positive review (§4). They live in src so they are
// tested; the script is orchestration around them.
import { describe, expect, it } from "vitest";
import {
  buildXwinesExactIndex,
  classifySiblingPair,
  exactKey,
  lookupExact,
  scoreBandLabel,
  stratifiedSample,
} from "./xwines-linkage-run";

describe("exactKey", () => {
  it("normalizes both sides so formatting differences join", () => {
    expect(exactKey("Château Margaux", "Margaux")).toBe(exactKey("chateau margaux", "MARGAUX"));
  });

  it("returns null when either side normalizes to nothing", () => {
    expect(exactKey("", "Margaux")).toBeNull();
    expect(exactKey("Margaux", "—")).toBeNull();
  });
});

describe("buildXwinesExactIndex / lookupExact", () => {
  const index = buildXwinesExactIndex([
    { wineId: 1, wineryName: "Penfolds", name: "Koonunga Hill" },
    { wineId: 2, wineryName: "E. Guigal", name: "Côtes-du-Rhône Rouge" },
    { wineId: 3, wineryName: "Twin Estate", name: "Reserva" },
    { wineId: 4, wineryName: "Twin Estate", name: "Reserva" },
    { wineId: 5, wineryName: null, name: "Orphan Cuvee" },
  ]);

  it("resolves a unique normalized (producer, cuvée) to its corpus row", () => {
    expect(lookupExact(index, ["Penfolds"], "Koonunga Hill")).toEqual({ wineId: 1 });
  });

  it("tries producer candidates in order and takes the first that hits", () => {
    expect(lookupExact(index, ["Domaine E. Guigal", "E. Guigal"], "Cotes-du-Rhone Rouge")).toEqual({
      wineId: 2,
    });
  });

  it("reports a key claimed by two corpus rows as ambiguous, never picks one", () => {
    expect(lookupExact(index, ["Twin Estate"], "Reserva")).toBe("ambiguous");
  });

  it("returns null on no hit and skips blank-producer corpus rows", () => {
    expect(lookupExact(index, ["Nobody"], "Koonunga Hill")).toBeNull();
    expect(lookupExact(index, [""], "Orphan Cuvee")).toBeNull();
  });
});

describe("scoreBandLabel", () => {
  it("buckets on the floor-aligned band edges", () => {
    expect(scoreBandLabel(0.64)).toBe("<0.65");
    expect(scoreBandLabel(0.65)).toBe("0.65–0.75");
    expect(scoreBandLabel(0.7499)).toBe("0.65–0.75");
    expect(scoreBandLabel(0.75)).toBe("0.75–0.85");
    expect(scoreBandLabel(0.85)).toBe("0.85–0.95");
    expect(scoreBandLabel(0.95)).toBe("0.95–1.00");
    expect(scoreBandLabel(1)).toBe("0.95–1.00");
  });
});

describe("stratifiedSample", () => {
  const items = [
    ...Array.from({ length: 80 }, (_, i) => ({ id: `fr-${i}`, stratum: "France" })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `it-${i}`, stratum: "Italy" })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `de-${i}`, stratum: "Germany" })),
  ];

  it("is deterministic for a given seed — a re-run reviews the same sample", () => {
    const a = stratifiedSample(items, (x) => x.stratum, 20, 42);
    const b = stratifiedSample(items, (x) => x.stratum, 20, 42);
    expect(a).toEqual(b);
  });

  it("returns exactly n items with every stratum represented", () => {
    const sample = stratifiedSample(items, (x) => x.stratum, 20, 42);
    expect(sample).toHaveLength(20);
    const strata = new Set(sample.map((x) => x.stratum));
    expect(strata).toEqual(new Set(["France", "Italy", "Germany"]));
  });

  it("allocates roughly proportionally — the dominant stratum dominates the sample", () => {
    const sample = stratifiedSample(items, (x) => x.stratum, 20, 42);
    const france = sample.filter((x) => x.stratum === "France").length;
    expect(france).toBeGreaterThanOrEqual(12);
    expect(france).toBeLessThanOrEqual(18);
  });

  it("returns everything when n exceeds the population", () => {
    const small = items.slice(0, 3);
    const sample = stratifiedSample(small, (x) => x.stratum, 20, 42);
    expect(sample).toHaveLength(3);
  });
});

describe("classifySiblingPair", () => {
  it("classifies colour siblings — same cuvée, different colour token", () => {
    expect(classifySiblingPair("Côtes-du-Rhône Rouge", "Côtes-du-Rhône Rosé")).toBe("colour");
    expect(classifySiblingPair("Rioja Tinto", "Rioja Blanco")).toBe("colour");
  });

  it("classifies a colourless name against its coloured sibling as colour", () => {
    expect(classifySiblingPair("Côtes-du-Rhône", "Côtes-du-Rhône Rosé")).toBe("colour");
  });

  it("classifies qualifier siblings — one name a strict token superset of the other", () => {
    expect(classifySiblingPair("Reserva", "Reserva Especial")).toBe("qualifier");
    expect(classifySiblingPair("Barolo Riserva", "Barolo")).toBe("qualifier");
    expect(classifySiblingPair("Chambolle-Musigny", "Chambolle-Musigny Les Amoureuses")).toBe("qualifier");
  });

  it("returns null for unrelated sibling names", () => {
    expect(classifySiblingPair("Koonunga Hill", "Grange")).toBeNull();
    expect(classifySiblingPair("Reserva", "Reserva")).toBeNull();
  });
});
