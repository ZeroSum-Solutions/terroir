import { describe, expect, it } from "vitest";
import { sortCellarRows, type CellarSort } from "./sort";

type Row = Parameters<typeof sortCellarRows>[0][number] & { id: string };

function row(partial: Partial<Row> & { id: string }): Row {
  return {
    producer: "Producer",
    name: "Wine",
    vintage: null,
    drink_window_end: null,
    sealed_count: 0,
    open_remaining_ml: null,
    ...partial,
  };
}

const ROWS: Row[] = [
  row({ id: "a", producer: "Zind", name: "Riesling", vintage: 2018, drink_window_end: 2030, sealed_count: 2 }),
  row({ id: "b", producer: "Aster", name: "Pinot", vintage: 1998, drink_window_end: 2026, sealed_count: 6 }),
  row({ id: "c", producer: "Mura", name: "Merlot", vintage: null, drink_window_end: null, sealed_count: 0, open_remaining_ml: 400 }),
  row({ id: "d", producer: "Aster", name: "Chardonnay", vintage: 2020, drink_window_end: 2024, sealed_count: 6 }),
];

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("sortCellarRows", () => {
  it("returns the input array untouched for null sort (server order)", () => {
    expect(sortCellarRows(ROWS, null)).toBe(ROWS);
  });

  it("never mutates the input", () => {
    const before = ids(ROWS);
    sortCellarRows(ROWS, "producer");
    expect(ids(ROWS)).toEqual(before);
  });

  it("producer sorts A–Z, then name, newest vintage first", () => {
    expect(ids(sortCellarRows(ROWS, "producer"))).toEqual(["d", "b", "c", "a"]);
  });

  it("vintage-asc puts oldest first and null vintages last", () => {
    expect(ids(sortCellarRows(ROWS, "vintage-asc"))).toEqual(["b", "a", "d", "c"]);
  });

  it("vintage-desc puts newest first and null vintages last", () => {
    expect(ids(sortCellarRows(ROWS, "vintage-desc"))).toEqual(["d", "a", "b", "c"]);
  });

  it("window puts the soonest-closing window first, unknown windows last", () => {
    expect(ids(sortCellarRows(ROWS, "window"))).toEqual(["d", "b", "a", "c"]);
  });

  it("qty-desc counts the open bottle as on hand", () => {
    // c has 0 sealed + 1 open = 1 bottle, so it beats nothing but ties
    // break by producer/name.
    expect(ids(sortCellarRows(ROWS, "qty-desc"))).toEqual(["d", "b", "a", "c"]);
  });

  it("every declared sort is total over rows with missing data", () => {
    const sorts: CellarSort[] = ["producer", "vintage-asc", "vintage-desc", "window", "qty-desc"];
    for (const sort of sorts) {
      expect(sortCellarRows(ROWS, sort)).toHaveLength(ROWS.length);
    }
  });
});
