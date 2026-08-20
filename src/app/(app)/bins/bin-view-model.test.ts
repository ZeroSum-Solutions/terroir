import { describe, expect, it } from "vitest";
import { buildBinViewModels } from "./bin-view-model";

describe("buildBinViewModels", () => {
  it("counts distinct wines and bottles without creating an unplaced pseudo-bin", () => {
    const bins = [
      {
        id: "bin-a",
        code: "A-01",
        zone: "North wall",
        capacity: 24,
        priority: 2,
      },
    ];
    const inventory = [
      { wineId: "wine-1", binId: "bin-a", quantity: 3 },
      { wineId: "wine-1", binId: "bin-a", quantity: 2 },
      { wineId: "wine-2", binId: "bin-a", quantity: 1 },
      { wineId: "wine-3", binId: null, quantity: 4 },
    ];

    expect(buildBinViewModels(bins, inventory)).toEqual([
      {
        ...bins[0],
        wineCount: 2,
        bottleCount: 6,
        occupancy: "2 wines · 6 bottles",
      },
    ]);
  });
});
