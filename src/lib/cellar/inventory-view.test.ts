import { describe, expect, it } from "vitest";
import {
  applyCellarInventoryView,
  isCellarLowStock,
  isEnteringOrInDrinkWindow,
  isPastDrinkWindow,
  matchesCellarInventoryView,
  type CellarInventoryViewRow,
} from "./inventory-view";

const base: CellarInventoryViewRow = {
  name: "Cuvée des Fleurs",
  producer: "Domaine Test",
  vintage: 2019,
  varietal: "Grenache",
  region: "Provence",
  country: "France",
  colour: "Rosé",
  sealed_count: 2,
  has_inventory_record: true,
  current_unit_cost: 24,
  is_eightysixed: false,
  drink_window_start: 2026,
  drink_window_end: 2030,
};

describe("cellar inventory view", () => {
  it("searches producer, varietal, region, and vintage without accent sensitivity", () => {
    expect(matchesCellarInventoryView(base, { query: "domaine" })).toBe(true);
    expect(matchesCellarInventoryView(base, { query: "grenache" })).toBe(true);
    expect(matchesCellarInventoryView(base, { query: "provence" })).toBe(true);
    expect(matchesCellarInventoryView(base, { query: "2019" })).toBe(true);
    expect(matchesCellarInventoryView(base, { query: "2020" })).toBe(false);
  });

  it("applies exact colour, region or country, and inclusive vintage filters", () => {
    expect(matchesCellarInventoryView(base, { colour: "rose", location: "France", vintageMin: 2018, vintageMax: 2020 })).toBe(true);
    expect(matchesCellarInventoryView(base, { colour: "red" })).toBe(false);
    expect(matchesCellarInventoryView(base, { location: "Italy" })).toBe(false);
    expect(matchesCellarInventoryView(base, { vintageMin: 2020 })).toBe(false);
    expect(matchesCellarInventoryView({ ...base, vintage: null }, { vintageMax: 2020 })).toBe(false);
  });

  it("sorts deterministically by name, price, vintage, and quantity", () => {
    const alpha = { ...base, name: "Alpha", producer: "One", vintage: 2018, current_unit_cost: 18, sealed_count: 1 };
    const beta = { ...base, name: "Beta", producer: "Two", vintage: 2022, current_unit_cost: 30, sealed_count: 4 };
    const unknown = { ...base, name: "Unknown", producer: "Three", vintage: null, current_unit_cost: null, sealed_count: 0 };
    expect(applyCellarInventoryView([beta, unknown, alpha], { sort: "name" }).map((row) => row.name)).toEqual(["Alpha", "Beta", "Unknown"]);
    expect(applyCellarInventoryView([alpha, unknown, beta], { sort: "price" }).map((row) => row.name)).toEqual(["Beta", "Alpha", "Unknown"]);
    expect(applyCellarInventoryView([alpha, unknown, beta], { sort: "vintage" }).map((row) => row.name)).toEqual(["Beta", "Alpha", "Unknown"]);
    expect(applyCellarInventoryView([alpha, unknown, beta], { sort: "quantity" }).map((row) => row.name)).toEqual(["Beta", "Alpha", "Unknown"]);
  });

  it("uses the configured low-stock threshold and includes zero-quantity inventory", () => {
    expect(isCellarLowStock(base, 3)).toBe(true);
    expect(isCellarLowStock({ ...base, sealed_count: 0 }, 3)).toBe(true);
    expect(isCellarLowStock({ ...base, has_inventory_record: false, sealed_count: 0 }, 3)).toBe(false);
    expect(isCellarLowStock({ ...base, sealed_count: 3 }, 3)).toBe(false);
    expect(isCellarLowStock({ ...base, is_eightysixed: true }, 3)).toBe(false);
  });

  it("distinguishes entering/in-window badges from the past-window filter", () => {
    expect(isEnteringOrInDrinkWindow(base, 2025)).toBe(true);
    expect(isEnteringOrInDrinkWindow(base, 2028)).toBe(true);
    expect(isEnteringOrInDrinkWindow(base, 2031)).toBe(false);
    expect(isPastDrinkWindow(base, 2031)).toBe(true);
    expect(isPastDrinkWindow(base, 2030)).toBe(false);
    expect(isPastDrinkWindow({ ...base, is_eightysixed: true }, 2031)).toBe(false);
  });
});
