import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  PRICING_RECOMMENDATION_CLASSES,
  recommendPricing,
  recommendPricingPortfolio,
  type PricingRecommendationInput,
} from "./recommend";

function wine(
  overrides: Partial<PricingRecommendationInput> = {},
): PricingRecommendationInput {
  return {
    wineId: "00000000-0000-4000-8000-000000000001",
    healthSegment: "healthy",
    appreciation: null,
    velocity: 8,
    marginPct: 55,
    dayOfWeekProfile: {},
    ...overrides,
  };
}

describe("recommendPricing", () => {
  it("EV-9.1: every rule emits one allowed class with rationale and evidence", () => {
    const recommendations = [
      wine({ appreciation: 0.2 }),
      wine({ marginPct: 75, dayOfWeekProfile: { Tuesday: 2, Friday: 8 } }),
      wine({ healthSegment: "dead_stock", velocity: 0 }),
      wine(),
    ].map((input) => recommendPricing(input));

    for (const recommendation of recommendations) {
      expect(PRICING_RECOMMENDATION_CLASSES).toContain(recommendation.class);
      expect(recommendation.rationale.trim()).not.toBe("");
      expect(recommendation.evidence).toMatchObject({
        healthSegment: expect.anything(),
        appreciationThreshold: expect.any(Number),
        velocity30d: expect.any(Number),
        marginThresholdPct: expect.any(Number),
      });
    }
    expect(new Set(recommendations.map((row) => row.class))).toEqual(
      new Set(PRICING_RECOMMENDATION_CLASSES),
    );
  });

  it("EV-9.2: the allocated Meursault fixture can never be discounted", () => {
    const allocatedMeursault = wine({
      wineId: "00000000-0000-4000-8000-000000000009",
      healthSegment: "hold",
      appreciation: 0.24,
      velocity: 0,
      marginPct: 81,
      dayOfWeekProfile: { Tuesday: 1, Saturday: 12 },
    });

    const result = recommendPricing(allocatedMeursault);

    expect(result.class).toBe("raise_appreciating");
    expect(result.class).not.toBe("discount_to_move");
  });

  it("EV-9.2: no arbitrary hold or appreciating wine receives discount_to_move", () => {
    const rand = lcg(20260819);
    for (let run = 0; run < 2_000; run++) {
      const appreciating = rand() < 0.5;
      const result = recommendPricing(
        wine({
          healthSegment: appreciating
            ? pick(["healthy", "dead_stock", "cash_trap", "window_risk"], rand)
            : "hold",
          appreciation: appreciating ? 0.08 + rand() * 0.8 : rand() * 0.079,
          velocity: Math.floor(rand() * 40),
          marginPct: rand() * 100,
          dayOfWeekProfile: { Monday: Math.floor(rand() * 20) },
        }),
      );

      expect(result.class, `seed run ${run}`).not.toBe("discount_to_move");
    }
  });

  it("EV-9.3: feature BTG uses the slowest observed day in pour history", () => {
    const result = recommendPricing(
      wine({
        marginPct: 76,
        dayOfWeekProfile: { Monday: 9, Tuesday: 2, Friday: 11 },
      }),
    );

    expect(result.class).toBe("feature_btg");
    expect(result.timing).toBe("Feature BTG Tuesday");
    expect(result.evidence).toMatchObject({ selectedDay: "Tuesday" });
  });

  it("EV-9.4: 1000-wine recommendation batches stay below a 2s P95", () => {
    const fixture = Array.from({ length: 1_000 }, (_, index) =>
      wine({
        wineId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        appreciation: index % 11 === 0 ? 0.18 : null,
        healthSegment: index % 7 === 0 ? "dead_stock" : "healthy",
        velocity: index % 7,
        marginPct: 50 + (index % 35),
        dayOfWeekProfile: { Monday: 8, Tuesday: 2, Friday: 12 },
      }),
    );
    const durations = Array.from({ length: 20 }, () => {
      const started = performance.now();
      expect(recommendPricingPortfolio(fixture)).toHaveLength(1_000);
      return performance.now() - started;
    }).sort((a, b) => a - b);

    expect(durations[Math.ceil(durations.length * 0.95) - 1]).toBeLessThan(2_000);
  });
});

function pick<T>(values: readonly T[], rand: () => number): T {
  return values[Math.floor(rand() * values.length)];
}

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}
