import { getAuthContext } from "@/lib/auth-context";
import { CellarSetup, CellarGridView } from "./cellar-grid";

type BinData = {
  wines: Array<{
    wineId: string;
    name: string;
    producer: string;
    vintage: number | null;
    quantity: number;
  }>;
  totalBottles: number;
};

type GridData = Record<string, BinData>;

export default async function CellarPage() {
  const auth = await getAuthContext();
  if (!auth) return null;

  const { supabase, restaurantId, restaurantName } = auth;

  const [{ data: config }, { data: inventoryItems }] = await Promise.all([
    supabase
      .from("cellar_config")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .limit(1)
      .single(),
    supabase
      .from("inventory_items")
      .select("bin_location, quantity, wines(id, name, producer, vintage)")
      .eq("restaurant_id", restaurantId)
      .not("bin_location", "is", null),
  ]);

  // Build grid data from inventory items
  const gridData: GridData = {};
  for (const item of inventoryItems ?? []) {
    if (!item.bin_location) continue;
    const bin = item.bin_location.toUpperCase().trim();
    const wine = item.wines as {
      id: string;
      name: string;
      producer: string;
      vintage: number | null;
    } | null;
    if (!wine) continue;

    if (!gridData[bin]) {
      gridData[bin] = { wines: [], totalBottles: 0 };
    }
    gridData[bin].wines.push({
      wineId: wine.id,
      name: wine.name,
      producer: wine.producer,
      vintage: wine.vintage,
      quantity: item.quantity,
    });
    gridData[bin].totalBottles += item.quantity;
  }

  return (
    <section>
      <header className="mb-lg md:mb-xl">
        <h1 className="font-serif text-[28px] text-ink">Cellar</h1>
        <p className="mt-xs text-[15px] text-ink-muted">
          {restaurantName}
          {config && (
            <> &middot; {config.rows} &times; {config.columns} grid</>
          )}
        </p>
      </header>

      {config ? (
        <CellarGridView
          config={{
            id: config.id,
            rows: config.rows,
            columns: config.columns,
            name: config.name,
          }}
          gridData={gridData}
        />
      ) : (
        <CellarSetup restaurantName={restaurantName} />
      )}
    </section>
  );
}
