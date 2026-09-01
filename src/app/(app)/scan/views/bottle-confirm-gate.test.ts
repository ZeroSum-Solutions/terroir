import { describe, expect, it } from "vitest";
import type { BottleCandidate } from "@/lib/scanner/types";
import { CONFIRM_CONFIDENCE_FLOOR, needsCorrectionBeforeSave } from "./bottle-confirm-gate";

type GateInput = Pick<BottleCandidate, "confidence" | "lowFields">;

function candidate(overrides: Partial<GateInput> = {}): GateInput {
  return {
    confidence: 0.95,
    lowFields: [],
    ...overrides,
  };
}

describe("needsCorrectionBeforeSave", () => {
  it("disables one-tap confirm for an unidentifiable result — 0% confidence, every field flagged", () => {
    expect(
      needsCorrectionBeforeSave(
        candidate({
          confidence: 0,
          lowFields: ["producer", "name", "vintage", "region", "format"],
        }),
      ),
    ).toBe(true);
  });

  it("allows one-tap confirm for a normal, confident result", () => {
    expect(needsCorrectionBeforeSave(candidate({ confidence: 0.95, lowFields: [] }))).toBe(
      false,
    );
  });

  it("allows one-tap confirm for a partial result — some fields flagged, confidence above the floor", () => {
    expect(
      needsCorrectionBeforeSave(candidate({ confidence: 0.55, lowFields: ["vintage"] })),
    ).toBe(false);
  });

  it("disables one-tap confirm below the confidence floor even with no fields flagged", () => {
    expect(
      needsCorrectionBeforeSave(
        candidate({ confidence: CONFIRM_CONFIDENCE_FLOOR - 0.01, lowFields: [] }),
      ),
    ).toBe(true);
  });

  it("allows one-tap confirm exactly at the confidence floor", () => {
    expect(
      needsCorrectionBeforeSave(candidate({ confidence: CONFIRM_CONFIDENCE_FLOOR, lowFields: [] })),
    ).toBe(false);
  });

  it("disables one-tap confirm when every identity field is flagged, even at high confidence", () => {
    expect(
      needsCorrectionBeforeSave(
        candidate({
          confidence: 0.9,
          lowFields: ["producer", "name", "vintage", "region", "format"],
        }),
      ),
    ).toBe(true);
  });

  it("disables one-tap confirm when producer AND wine name are both flagged, whatever else the model trusts", () => {
    // The identity IS producer + name. A candidate that cannot vouch for
    // either is unidentified even if it is sure about the vintage and the
    // bottle size — that was the all-but-one hole in the first cut.
    expect(
      needsCorrectionBeforeSave(
        candidate({
          confidence: 0.8,
          lowFields: ["producer", "name"],
        }),
      ),
    ).toBe(true);
  });

  it("allows one-tap confirm when only attribute fields are flagged and the identity is trusted", () => {
    expect(
      needsCorrectionBeforeSave(
        candidate({
          confidence: 0.8,
          lowFields: ["vintage", "region", "format"],
        }),
      ),
    ).toBe(false);
  });

  it("allows one-tap confirm when only one of producer or name is flagged", () => {
    expect(needsCorrectionBeforeSave(candidate({ confidence: 0.8, lowFields: ["name"] }))).toBe(false);
    expect(needsCorrectionBeforeSave(candidate({ confidence: 0.8, lowFields: ["producer", "vintage"] }))).toBe(false);
  });
});
