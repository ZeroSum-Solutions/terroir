import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const PAGE_SIZE = 1000;
export const MAX_CELLAR_GRID_ROWS = 10_000;

type GridWine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
};

type GridRow = {
  id: string;
  bin_location: string | null;
  quantity: number;
  wines: GridWine | GridWine[] | null;
};

export type CellarGridWine = {
  wineId: string;
  name: string;
  producer: string;
  vintage: number | null;
  quantity: number;
};

export type CellarGrid = Record<
  string,
  { wines: CellarGridWine[]; totalBottles: number }
>;

export type CellarGridSnapshot = {
  grid: CellarGrid;
  truncated: boolean;
};

export async function loadCellarGrid(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
): Promise<CellarGrid> {
  const snapshot = await loadCellarGridSnapshot(supabase, restaurantId);
  if (snapshot.truncated) {
    throw new Error(
      `Cellar grid exceeds the ${MAX_CELLAR_GRID_ROWS}-row limit.`,
    );
  }
  return snapshot.grid;
}

export async function loadCellarGridSnapshot(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
): Promise<CellarGridSnapshot> {
  const { rows, truncated } = await fetchGridRows(supabase, restaurantId);
  return { grid: projectCellarGrid(rows), truncated };
}

export function projectCellarGrid(rows: GridRow[]): CellarGrid {
  const bins = new Map<
    string,
    {
      winesById: Map<string, CellarGridWine>;
      totalBottles: number;
    }
  >();

  for (const item of rows) {
    const bin = item.bin_location?.toUpperCase().trim();
    const wine = firstRelation(item.wines);
    if (!bin || !wine || item.quantity <= 0) continue;

    let entry = bins.get(bin);
    if (!entry) {
      entry = { winesById: new Map(), totalBottles: 0 };
      bins.set(bin, entry);
    }
    const current = entry.winesById.get(wine.id);
    if (current) {
      current.quantity += item.quantity;
    } else {
      entry.winesById.set(wine.id, {
        wineId: wine.id,
        name: wine.name,
        producer: wine.producer,
        vintage: wine.vintage,
        quantity: item.quantity,
      });
    }
    entry.totalBottles += item.quantity;
  }

  const grid: CellarGrid = {};
  for (const bin of [...bins.keys()].sort()) {
    const entry = bins.get(bin)!;
    grid[bin] = {
      wines: [...entry.winesById.values()].sort((a, b) => {
        const producer = a.producer.localeCompare(b.producer);
        if (producer !== 0) return producer;
        const name = a.name.localeCompare(b.name);
        return name !== 0 ? name : a.wineId.localeCompare(b.wineId);
      }),
      totalBottles: entry.totalBottles,
    };
  }
  return grid;
}

async function fetchGridRows(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
): Promise<{ rows: GridRow[]; truncated: boolean }> {
  const rows: GridRow[] = [];

  for (let offset = 0; offset < MAX_CELLAR_GRID_ROWS; offset += PAGE_SIZE) {
    const page = await fetchGridPage(
      supabase,
      restaurantId,
      offset,
      Math.min(offset + PAGE_SIZE - 1, MAX_CELLAR_GRID_ROWS - 1),
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, truncated: false };
  }

  const overflow = await fetchGridPage(
    supabase,
    restaurantId,
    MAX_CELLAR_GRID_ROWS,
    MAX_CELLAR_GRID_ROWS,
  );
  return { rows, truncated: overflow.length > 0 };
}

async function fetchGridPage(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  from: number,
  to: number,
): Promise<GridRow[]> {
  const { data, error } = await supabase
    .from("inventory_items")
    .select(
      "id, bin_location, quantity, wines(id, name, producer, vintage)",
    )
    .eq("restaurant_id", restaurantId)
    .not("bin_location", "is", null)
    .order("id", { ascending: true })
    .range(from, to);
  if (error) throw error;
  return (data ?? []) as GridRow[];
}

function firstRelation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
