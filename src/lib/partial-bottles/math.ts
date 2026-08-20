export const PRESERVATION_METHODS = [
  "coravin",
  "argon",
  "vacuum",
  "none",
] as const;

export type PreservationMethod = (typeof PRESERVATION_METHODS)[number];

export function theoreticalRemaining(sizeMl: number, poursMl: readonly number[]) {
  return poursMl.reduce((remaining, poured) => remaining - poured, sizeMl);
}

export function variance(actualRemainingMl: number, theoreticalRemainingMl: number) {
  return actualRemainingMl - theoreticalRemainingMl;
}

export type BottleYieldInput = {
  bottleId: string;
  wineId: string;
  preservationMethod: PreservationMethod;
  sizeMl: number;
  theoreticalRemainingMl: number;
  actualRemainingMl: number;
  writtenOffMl: number;
};

export type BottleYield = {
  bottleId: string;
  wineId: string;
  preservationMethod: PreservationMethod;
  varianceMl: number;
  theoreticalPouredMl: number;
  actualPouredMl: number;
};

export type YieldGroup = {
  preservationMethod: PreservationMethod;
  bottlesClosed: number;
  averageVarianceMl: number;
  theoreticalPouredMl: number;
  actualPouredMl: number;
  bottles: BottleYield[];
};

function bottleYield(input: BottleYieldInput): BottleYield {
  return {
    bottleId: input.bottleId,
    wineId: input.wineId,
    preservationMethod: input.preservationMethod,
    varianceMl: variance(input.actualRemainingMl, input.theoreticalRemainingMl),
    theoreticalPouredMl: input.sizeMl - input.theoreticalRemainingMl,
    actualPouredMl:
      input.sizeMl - input.actualRemainingMl - input.writtenOffMl,
  };
}

export function aggregateYieldByPreservation(
  inputs: readonly BottleYieldInput[],
): YieldGroup[] {
  const grouped = new Map<PreservationMethod, BottleYield[]>();
  for (const input of inputs) {
    const bottles = grouped.get(input.preservationMethod) ?? [];
    grouped.set(input.preservationMethod, [...bottles, bottleYield(input)]);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([preservationMethod, bottles]) => ({
      preservationMethod,
      bottlesClosed: bottles.length,
      averageVarianceMl:
        bottles.reduce((sum, bottle) => sum + bottle.varianceMl, 0) /
        bottles.length,
      theoreticalPouredMl: bottles.reduce(
        (sum, bottle) => sum + bottle.theoreticalPouredMl,
        0,
      ),
      actualPouredMl: bottles.reduce(
        (sum, bottle) => sum + bottle.actualPouredMl,
        0,
      ),
      bottles,
    }));
}
