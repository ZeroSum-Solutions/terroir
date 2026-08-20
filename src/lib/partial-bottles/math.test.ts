import { describe, expect, it } from "vitest";
import {
  aggregateYieldByPreservation,
  theoreticalRemaining,
  variance,
} from "./math";

describe("partial bottle math", () => {
  it("EV-10.1: computes live theoretical remaining as bottle size minus every draining pour", () => {
    expect(theoreticalRemaining(750, [148, 75, 27])).toBe(500);
    expect(theoreticalRemaining(750, [800])).toBe(-50);
  });

  it("EV-10.1 property: appending any non-negative pour never increases theoretical remaining", () => {
    let seed = 0x10_10_01;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let sample = 0; sample < 500; sample += 1) {
      const size = Math.floor(random() * 1_500) + 1;
      const pours = Array.from(
        { length: Math.floor(random() * 20) },
        () => Math.floor(random() * 250),
      );
      const appended = Math.floor(random() * 250);
      expect(theoreticalRemaining(size, [...pours, appended])).toBeLessThanOrEqual(
        theoreticalRemaining(size, pours),
      );
    }
  });

  it("EV-10.2: calculates the same actual-minus-theoretical variance persisted by the generated column", () => {
    expect(variance(90, 110)).toBe(-20);
    expect(variance(130, 110)).toBe(20);
  });

  it("EV-10.3: groups per-bottle yield by preservation method", () => {
    expect(
      aggregateYieldByPreservation([
        {
          bottleId: "b-none",
          wineId: "w-none",
          preservationMethod: "none",
          sizeMl: 750,
          theoreticalRemainingMl: 100,
          actualRemainingMl: 80,
          writtenOffMl: 20,
        },
        {
          bottleId: "b-coravin-1",
          wineId: "w-coravin-1",
          preservationMethod: "coravin",
          sizeMl: 750,
          theoreticalRemainingMl: 150,
          actualRemainingMl: 180,
          writtenOffMl: 0,
        },
        {
          bottleId: "b-coravin-2",
          wineId: "w-coravin-2",
          preservationMethod: "coravin",
          sizeMl: 375,
          theoreticalRemainingMl: 25,
          actualRemainingMl: 15,
          writtenOffMl: 10,
        },
      ]),
    ).toEqual([
      {
        preservationMethod: "coravin",
        bottlesClosed: 2,
        averageVarianceMl: 10,
        theoreticalPouredMl: 950,
        actualPouredMl: 920,
        bottles: [
          expect.objectContaining({ bottleId: "b-coravin-1", theoreticalPouredMl: 600, actualPouredMl: 570 }),
          expect.objectContaining({ bottleId: "b-coravin-2", theoreticalPouredMl: 350, actualPouredMl: 350 }),
        ],
      },
      {
        preservationMethod: "none",
        bottlesClosed: 1,
        averageVarianceMl: -20,
        theoreticalPouredMl: 650,
        actualPouredMl: 650,
        bottles: [
          expect.objectContaining({ bottleId: "b-none", theoreticalPouredMl: 650, actualPouredMl: 650 }),
        ],
      },
    ]);
  });
});
