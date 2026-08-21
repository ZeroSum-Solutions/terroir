import { describe, expect, it } from "vitest";
import {
  formatSignedVarianceOz,
  getReconciliationVariance,
  reconciliationTone,
} from "./variance";

describe("getReconciliationVariance", () => {
  it("reports actual volume above tracked volume as over", () => {
    expect(getReconciliationVariance(130, 110)).toMatchObject({
      deltaMl: 20,
      relation: "over",
      symbol: "↑",
      label: "over expected",
    });
    expect(getReconciliationVariance(130, 110).percentage).toBeCloseTo(18.18, 2);
  });

  it("reports actual volume below tracked volume as under", () => {
    expect(getReconciliationVariance(90, 110)).toMatchObject({
      deltaMl: -20,
      relation: "under",
      symbol: "↓",
      label: "under expected",
    });
  });

  it("reports equal counts as exact", () => {
    expect(getReconciliationVariance(110, 110)).toEqual({
      deltaMl: 0,
      relation: "exact",
      percentage: 0,
      symbol: "=",
      label: "exact",
    });
  });

  it("does not invent a percentage when expected is zero", () => {
    expect(getReconciliationVariance(30, 0)).toMatchObject({
      deltaMl: 30,
      relation: "over",
      percentage: null,
      label: "over expected",
    });
  });

  it("maps relations to their semantic presentation tones", () => {
    expect(reconciliationTone("over")).toBe("positive");
    expect(reconciliationTone("under")).toBe("negative");
    expect(reconciliationTone("exact")).toBe("neutral");
  });

  it("formats signed variance ounces", () => {
    expect(formatSignedVarianceOz(20)).toBe("+0.7 oz");
    expect(formatSignedVarianceOz(-20)).toBe("−0.7 oz");
    expect(formatSignedVarianceOz(0)).toBe("0.0 oz");
  });
});
