import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEALTH_THRESHOLDS,
  HEALTH_SEGMENTS,
  classifyCellarHealth,
  type CellarHealthInput,
} from "./classify";

const NOW = new Date("2026-08-19T12:00:00.000Z");

function wine(overrides: Partial<CellarHealthInput> = {}): CellarHealthInput {
  return {
    drinkWindowStart: null,
    drinkWindowEnd: null,
    stockValue: 100,
    lastMovementAt: "2026-08-01T00:00:00.000Z",
    appreciation: null,
    ...overrides,
  };
}

describe("classifyCellarHealth", () => {
  it("EV-2.1: partitions arbitrary stocked wine states into exactly one segment", () => {
    const rand = lcg(20260819);
    const allowed = new Set<string>(HEALTH_SEGMENTS);

    for (let run = 0; run < 1_000; run++) {
      const start = rand() < 0.3 ? null : 1990 + Math.floor(rand() * 70);
      const end = start === null ? null : start + Math.floor(rand() * 31);
      const result = classifyCellarHealth(
        wine({
          drinkWindowStart: start,
          drinkWindowEnd: end,
          stockValue: 1 + rand() * 2_000,
          lastMovementAt:
            rand() < 0.2
              ? null
              : new Date(NOW.getTime() - rand() * 500 * 86_400_000).toISOString(),
          appreciation: rand() < 0.25 ? null : rand() * 0.6 - 0.2,
        }),
        DEFAULT_HEALTH_THRESHOLDS,
        NOW,
      );

      expect(allowed.has(result.segment), `seed run ${run}`).toBe(true);
      expect(HEALTH_SEGMENTS.filter((segment) => segment === result.segment)).toHaveLength(1);
    }
  });

  it("EV-2.2: keeps dead-stock and cash-trap value below 40% on the demo cellar", () => {
    const demo = [
      wine({ stockValue: 450, drinkWindowStart: 2020, drinkWindowEnd: 2032 }),
      wine({ stockValue: 300, drinkWindowStart: 2028, drinkWindowEnd: 2038, appreciation: 0.12 }),
      wine({ stockValue: 150, lastMovementAt: "2025-01-01T00:00:00.000Z" }),
      wine({ stockValue: 100, lastMovementAt: "2025-01-01T00:00:00.000Z", appreciation: 0.2 }),
    ];

    const results = demo.map((input) => ({
      value: input.stockValue,
      segment: classifyCellarHealth(input, DEFAULT_HEALTH_THRESHOLDS, NOW).segment,
    }));
    const total = results.reduce((sum, row) => sum + row.value, 0);
    const flagged = results
      .filter((row) => row.segment === "dead_stock" || row.segment === "cash_trap")
      .reduce((sum, row) => sum + row.value, 0);

    expect(flagged / total).toBeLessThan(0.4);
  });

  it.each([
    [
      "window_risk",
      wine({ drinkWindowStart: 2020, drinkWindowEnd: 2028 }),
    ],
    [
      "hold",
      wine({ drinkWindowStart: 2020, drinkWindowEnd: 2038, appreciation: 0.1 }),
    ],
    [
      "dead_stock",
      wine({ lastMovementAt: "2025-01-01T00:00:00.000Z" }),
    ],
    [
      "cash_trap",
      wine({
        stockValue: 600,
        lastMovementAt: "2025-01-01T00:00:00.000Z",
        appreciation: 0.1,
      }),
    ],
  ] as const)("EV-2.3: %s rows name the rule that fired", (segment, input) => {
    const result = classifyCellarHealth(input, DEFAULT_HEALTH_THRESHOLDS, NOW);

    expect(result.segment).toBe(segment);
    expect(result.reason).toMatch(new RegExp(`^${segment} rule:`));
  });

  it("EV-2.4: changing the appreciation threshold reclassifies a stale wine", () => {
    const input = wine({
      lastMovementAt: "2025-01-01T00:00:00.000Z",
      appreciation: 0.1,
    });

    expect(classifyCellarHealth(input, DEFAULT_HEALTH_THRESHOLDS, NOW).segment).toBe(
      "healthy",
    );
    expect(
      classifyCellarHealth(
        input,
        { ...DEFAULT_HEALTH_THRESHOLDS, appreciationThreshold: 0.2 },
        NOW,
      ).segment,
    ).toBe("dead_stock");
  });
});

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}
