import { describe, expect, it } from "vitest";
import { buildCellarBinData } from "./bin-data";

describe("buildCellarBinData", () => {
  it("EV-6.3/EV-6.4: keeps physical placements separate from unplaced stock", () => {
    const result = buildCellarBinData({
      wines: [
        { id: "wine-a", lineageId: "lineage-a", name: "La Côte", producer: "Jamet", colour: "red" },
      ],
      bins: [
        { id: "bin-a", code: "A-01", zone: "Reds", capacity: 12, retiredAt: null },
      ],
      inventoryRows: [
        { wineId: "wine-a", binId: "bin-a", quantity: 2 },
        { wineId: "wine-a", binId: null, quantity: 3 },
      ],
    });

    expect(result["wine-a"]).toEqual({
      placements: [
        { binId: "bin-a", code: "A-01", zone: "Reds", quantity: 2 },
      ],
      unplacedCount: 3,
      suggestedBin: {
        binId: "bin-a",
        code: "A-01",
        zone: "Reds",
        reason: "same_lineage",
      },
    });
    expect(result["wine-a"].placements).not.toContainEqual(
      expect.objectContaining({ code: "Unplaced" }),
    );
  });

  it("does not suggest a bin when a wine has no unplaced stock", () => {
    const result = buildCellarBinData({
      wines: [
        { id: "wine-a", lineageId: null, name: "Chablis", producer: "Raveneau", colour: "white" },
      ],
      bins: [
        { id: "bin-a", code: "W-01", zone: "Whites", capacity: null, retiredAt: null },
      ],
      inventoryRows: [{ wineId: "wine-a", binId: "bin-a", quantity: 1 }],
    });

    expect(result["wine-a"].unplacedCount).toBe(0);
    expect(result["wine-a"].suggestedBin).toBeNull();
  });

  it("does not relabel a non-null unknown bin reference as unplaced", () => {
    const result = buildCellarBinData({
      wines: [
        { id: "wine-a", lineageId: null, name: "Chablis", producer: "Raveneau", colour: "white" },
      ],
      bins: [],
      inventoryRows: [{ wineId: "wine-a", binId: "other-tenant-bin", quantity: 4 }],
    });

    expect(result["wine-a"]).toEqual({
      placements: [],
      unplacedCount: 0,
      suggestedBin: null,
    });
  });
});
