import { describe, expect, it } from "vitest";
import {
  parseCellarUrlState,
  serializeCellarUrlState,
  type CellarUrlState,
} from "./url-state";

describe("cellar URL state codec", () => {
  it("EV-4.3: parses the frozen contract and ignores unknown parameters", () => {
    const parsed = parseCellarUrlState(
      new URLSearchParams(
        "q=cote&filter=low&producer=Jamet&region=Rhone&country=France&" +
          "varietal=Syrah&vintage_min=2016&vintage_max=2020&format=750&" +
          "group_by=producer&health=hold&" +
          "wine=123e4567-e89b-42d3-a456-426614174000&ignored=yes",
      ),
    );

    expect(parsed).toEqual({
      q: "cote",
      filter: "low",
      producer: "Jamet",
      region: "Rhone",
      country: "France",
      varietal: "Syrah",
      vintageMin: 2016,
      vintageMax: 2020,
      format: 750,
      groupBy: "producer",
      health: "hold",
      wine: "123e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("EV-4.3: invalid known values fall back without retaining unknown state", () => {
    expect(
      parseCellarUrlState(
        new URLSearchParams(
          "filter=broken&vintage_min=nope&format=-1&group_by=country&health=sleepy&wine=not-a-uuid",
        ),
      ),
    ).toEqual({
      q: "",
      filter: "all",
      producer: null,
      region: null,
      country: null,
      varietal: null,
      vintageMin: null,
      vintageMax: null,
      format: null,
      groupBy: null,
      health: null,
      wine: null,
    });
  });

  it("EV-4.3 (property): parse(serialize(state)) equals state", () => {
    const rand = lcg(20260819);
    const values = [null, "Jamet", "Côte & Fils", "Müller"] as const;
    const filters = ["all", "open", "out", "low", "drink-now", "hold"] as const;
    const groups = [null, "producer", "region", "varietal", "vintage"] as const;
    const health = [null, "window_risk", "hold", "dead_stock", "cash_trap", "healthy"] as const;
    for (let run = 0; run < 100; run++) {
      const state: CellarUrlState = {
        q: values[Math.floor(rand() * values.length)] ?? "",
        filter: filters[Math.floor(rand() * filters.length)],
        producer: values[Math.floor(rand() * values.length)],
        region: values[Math.floor(rand() * values.length)],
        country: values[Math.floor(rand() * values.length)],
        varietal: values[Math.floor(rand() * values.length)],
        vintageMin: rand() < 0.5 ? null : 1980 + Math.floor(rand() * 30),
        vintageMax: rand() < 0.5 ? null : 2010 + Math.floor(rand() * 17),
        format: rand() < 0.5 ? null : rand() < 0.5 ? 750 : 1_500,
        groupBy: groups[Math.floor(rand() * groups.length)],
        health: health[Math.floor(rand() * health.length)],
        wine:
          rand() < 0.5
            ? null
            : `123e4567-e89b-42d3-a456-${String(run).padStart(12, "0")}`,
      };
      expect(parseCellarUrlState(serializeCellarUrlState(state)), `run ${run}`).toEqual(state);
    }
  });
});

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
