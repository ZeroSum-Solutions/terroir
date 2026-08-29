import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCellarQueryFilter, type CellarQueryRow } from "./query-filter";

function wine(overrides: Partial<CellarQueryRow> = {}): CellarQueryRow {
  return {
    name: "Reserva",
    producer: "Bodegas Muga",
    varietal: "Tempranillo",
    region: "Rioja",
    is_eightysixed: false,
    sealed_count: 6,
    size_ml: 750,
    open_remaining_ml: null,
    drink_window_start: 2020,
    drink_window_end: 2030,
    ...overrides,
  };
}

describe("applyCellarQueryFilter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns everything for the default filter and an empty query", () => {
    const rows = [wine(), wine({ name: "Gran Reserva" })];
    expect(applyCellarQueryFilter(rows, "", "all")).toHaveLength(2);
  });

  it("matches the query against name, producer, varietal and region", () => {
    const rows = [
      wine({ name: "Reserva" }),
      wine({ name: "Brut", producer: "Billecart" }),
      wine({ name: "Estate", varietal: "Syrah" }),
      wine({ name: "Cru", region: "Barolo" }),
      wine({ name: "Nothing", producer: "X", varietal: null, region: null }),
    ];
    expect(applyCellarQueryFilter(rows, "reserva", "all")).toHaveLength(1);
    expect(applyCellarQueryFilter(rows, "billecart", "all")).toHaveLength(1);
    expect(applyCellarQueryFilter(rows, "syrah", "all")).toHaveLength(1);
    expect(applyCellarQueryFilter(rows, "barolo", "all")).toHaveLength(1);
    expect(applyCellarQueryFilter(rows, "  RESERVA  ", "all")).toHaveLength(1);
  });

  it("tolerates a null varietal or region rather than throwing", () => {
    const rows = [wine({ varietal: null, region: null })];
    expect(applyCellarQueryFilter(rows, "muga", "all")).toHaveLength(1);
  });

  it("open: keeps only wines with liquid left in an open bottle", () => {
    const rows = [
      wine({ name: "open", open_remaining_ml: 400 }),
      wine({ name: "drained", open_remaining_ml: 0 }),
      wine({ name: "sealed", open_remaining_ml: null }),
    ];
    expect(applyCellarQueryFilter(rows, "", "open").map((r) => r.name)).toEqual(["open"]);
  });

  it("out: keeps only 86'd wines", () => {
    const rows = [wine({ name: "on" }), wine({ name: "off", is_eightysixed: true })];
    expect(applyCellarQueryFilter(rows, "", "out").map((r) => r.name)).toEqual(["off"]);
  });

  it("low: counts an open bottle's remainder toward the two-bottle line", () => {
    const rows = [
      wine({ name: "one sealed", sealed_count: 1 }),
      wine({ name: "one plus a half", sealed_count: 1, open_remaining_ml: 375 }),
      wine({ name: "two sealed", sealed_count: 2 }),
    ];
    // 750 < 1500 and 1125 < 1500 are low; 1500 is not.
    expect(applyCellarQueryFilter(rows, "", "low").map((r) => r.name)).toEqual([
      "one sealed",
      "one plus a half",
    ]);
  });

  it("low: a wine with no bottle size is never low rather than always low", () => {
    const rows = [wine({ name: "sizeless", size_ml: null, sealed_count: 0 })];
    expect(applyCellarQueryFilter(rows, "", "low")).toEqual([]);
  });

  it("low, drink-now and hold all exclude 86'd wines", () => {
    const dead = { is_eightysixed: true } as const;
    expect(applyCellarQueryFilter([wine({ sealed_count: 1, ...dead })], "", "low")).toEqual([]);
    expect(
      applyCellarQueryFilter([wine({ drink_window_end: 2026, ...dead })], "", "drink-now"),
    ).toEqual([]);
    expect(
      applyCellarQueryFilter([wine({ drink_window_start: 2030, ...dead })], "", "hold"),
    ).toEqual([]);
  });

  it("drink-now: keeps wines inside the closing threshold", () => {
    const rows = [
      wine({ name: "closing", drink_window_end: 2027 }),
      wine({ name: "years left", drink_window_end: 2040 }),
      wine({ name: "unknown", drink_window_end: null }),
    ];
    expect(applyCellarQueryFilter(rows, "", "drink-now").map((r) => r.name)).toEqual([
      "closing",
    ]);
  });

  it("hold: keeps wines whose window has not opened", () => {
    const rows = [
      wine({ name: "holding", drink_window_start: 2030 }),
      wine({ name: "open now", drink_window_start: 2020 }),
      wine({ name: "unknown", drink_window_start: null }),
    ];
    expect(applyCellarQueryFilter(rows, "", "hold").map((r) => r.name)).toEqual(["holding"]);
  });

  it("applies the chip filter and the query together, not either/or", () => {
    const rows = [
      wine({ name: "Reserva", is_eightysixed: true }),
      wine({ name: "Crianza", is_eightysixed: true }),
      wine({ name: "Reserva", is_eightysixed: false }),
    ];
    const result = applyCellarQueryFilter(rows, "reserva", "out");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "Reserva", is_eightysixed: true });
  });

  it("does not mutate the input array", () => {
    const rows = [wine({ name: "a" }), wine({ name: "b", is_eightysixed: true })];
    const before = [...rows];
    applyCellarQueryFilter(rows, "", "out");
    expect(rows).toEqual(before);
  });
});

describe("off-site", () => {
  it("matches nothing, as it did before the predicate was extracted", () => {
    expect(applyCellarQueryFilter([wine(), wine({ name: "b" })], "", "off-site")).toEqual([]);
  });
});
