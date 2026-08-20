export type BinRecord = {
  id: string;
  code: string;
  zone: string | null;
  capacity: number | null;
  priority: number;
};

type InventoryPlacement = {
  wineId: string;
  binId: string | null;
  quantity: number;
};

export type BinViewModel = BinRecord & {
  wineCount: number;
  bottleCount: number;
  occupancy: string;
};

export function buildBinViewModels(
  bins: readonly BinRecord[],
  inventory: readonly InventoryPlacement[],
): BinViewModel[] {
  return bins.map((bin) => {
    const placements = inventory.filter((item) => item.binId === bin.id);
    const wineCount = new Set(placements.map((item) => item.wineId)).size;
    const bottleCount = placements.reduce(
      (total, item) => total + item.quantity,
      0,
    );
    return {
      ...bin,
      wineCount,
      bottleCount,
      occupancy: `${wineCount} ${wineCount === 1 ? "wine" : "wines"} · ${bottleCount} ${bottleCount === 1 ? "bottle" : "bottles"}`,
    };
  });
}
