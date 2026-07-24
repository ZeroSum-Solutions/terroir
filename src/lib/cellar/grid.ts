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
  let afterId: string | null = null;

  while (rows.length < MAX_CELLAR_GRID_ROWS) {
    const limit = Math.min(
      PAGE_SIZE,
      MAX_CELLAR_GRID_ROWS - rows.length,
    );
    const page = await fetchGridPage(
      supabase,
      restaurantId,
      afterId,
      limit,
    );
    rows.push(...page);
    if (page.length < limit) return { rows, truncated: false };
    afterId = page.at(-1)!.id;
  }

  const overflow = await fetchGridPage(
    supabase,
    restaurantId,
    afterId,
    1,
  );
  return { rows, truncated: overflow.length > 0 };
}

async function fetchGridPage(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  afterId: string | null,
  limit: number,
): Promise<GridRow[]> {
  let query = supabase
    .from("inventory_items")
    .select(
      "id, bin_location, quantity, wines(id, name, producer, vintage)",
    )
    .eq("restaurant_id", restaurantId)
    .not("bin_location", "is", null);
  if (afterId !== null) {
    query = query.gt("id", afterId);
  }
  const { data, error } = await query
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as GridRow[];
}

function firstRelation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
