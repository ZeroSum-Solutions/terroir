import { describe, expect, it } from "vitest";
import { bottlesOnHand, pickRowChip } from "./row-chip";

const YEAR = 2026;

type ChipRow = Parameters<typeof pickRowChip>[0];

function row(partial: Partial<ChipRow> = {}): ChipRow {
  return {
    is_eightysixed: false,
    sealed_count: 4,
    size_ml: 750,
    open_remaining_ml: null,
    drink_window_start: null,
    drink_window_end: null,
    duplicate_wine_ids: [],
    ...partial,
  };
}

describe("pickRowChip — one chip per row, most urgent fact wins", () => {
  it("86'd beats everything", () => {
    expect(
      pickRowChip(row({ is_eightysixed: true, drink_window_end: 2020 }), 3, YEAR),
    ).toEqual({ label: "86'd", tone: "urgent" });
  });

  it("past peak is the filled seal", () => {
    expect(
      pickRowChip(row({ drink_window_start: 2010, drink_window_end: 2020 }), undefined, YEAR),
    ).toEqual({ label: "Past peak", tone: "urgent" });
  });

  it("low stock outranks a closing window", () => {
    expect(
      pickRowChip(
        row({ sealed_count: 1, drink_window_start: 2010, drink_window_end: 2027 }),
        3,
        YEAR,
      ),
    ).toEqual({ label: "Low stock", tone: "attention" });
  });

  it("final year of the window gets its own label", () => {
    expect(
      pickRowChip(row({ drink_window_start: 2010, drink_window_end: 2026 }), undefined, YEAR),
    ).toEqual({ label: "Final year", tone: "attention" });
    expect(
      pickRowChip(row({ drink_window_start: 2010, drink_window_end: 2028 }), undefined, YEAR),
    ).toEqual({ label: "Drink now", tone: "attention" });
  });

  it("duplicate flag shows when nothing is urgent", () => {
    expect(
      pickRowChip(row({ duplicate_wine_ids: ["x"] }), undefined, YEAR),
    ).toEqual({ label: "Duplicate?", tone: "neutral" });
  });

  it("open bottle reads remaining ounces as a neutral fact", () => {
    expect(
      pickRowChip(row({ open_remaining_ml: 600 }), undefined, YEAR),
    ).toEqual({ label: "Open · 20.3 oz", tone: "neutral" });
  });

  it("optimal window earns the gold marker", () => {
    expect(
      pickRowChip(row({ drink_window_start: 2020, drink_window_end: 2035 }), undefined, YEAR),
    ).toEqual({ label: "Peak", tone: "optimal" });
  });

  it("no stock is muted; a quiet sealed hold wine gets no chip at all", () => {
    expect(pickRowChip(row({ sealed_count: 0 }), undefined, YEAR)).toEqual({
      label: "No stock",
      tone: "muted",
    });
    expect(
      pickRowChip(row({ drink_window_start: 2030, drink_window_end: 2040 }), undefined, YEAR),
    ).toBeNull();
  });
});

describe("bottlesOnHand", () => {
  it("counts sealed plus the open bottle", () => {
    expect(bottlesOnHand({ sealed_count: 3, open_remaining_ml: 200 })).toBe(4);
    expect(bottlesOnHand({ sealed_count: 3, open_remaining_ml: 0 })).toBe(3);
    expect(bottlesOnHand({ sealed_count: 0, open_remaining_ml: null })).toBe(0);
  });
});
