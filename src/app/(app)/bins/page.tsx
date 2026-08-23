import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import type { BottleInventoryRow } from "@/lib/bins";
import { BinManager } from "./bin-manager";
import { buildBinViewModels } from "./bin-view-model";

export const metadata: Metadata = { title: "Bins" };

type JoinedWine = {
  id: string;
  lineage_id: string | null;
  name: string;
  producer: string;
  colour: string | null;
};

type JoinedInventory = {
  wine_id: string;
  quantity: number;
  wines: JoinedWine | JoinedWine[] | null;
};

type JoinedBin = {
  id: string;
  code: string;
  zone: string | null;
  capacity: number | null;
  priority: number;
  inventory_items: JoinedInventory[];
};

export default async function BinsPage() {
  const auth = (await getAuthContext())!;
  const { supabase, restaurantId, restaurantName, userRole } = auth;
  const [binResult, unplacedResult] = await Promise.all([
    supabase
      .from("bins")
      .select("id, code, zone, capacity, priority, inventory_items(wine_id, quantity, wines(id, lineage_id, name, producer, colour))")
      .eq("restaurant_id", restaurantId)
      .eq("inventory_items.restaurant_id", restaurantId)
      .is("retired_at", null)
      .order("priority", { ascending: false })
      .order("code", { ascending: true }),
    supabase
      .from("inventory_items")
      .select("quantity")
      .eq("restaurant_id", restaurantId)
      .is("bin_id", null),
  ]);
  if (binResult.error) throw binResult.error;
  if (unplacedResult.error) throw unplacedResult.error;

  const bins = (binResult.data ?? []) as unknown as JoinedBin[];
  const inventory = flattenInventory(bins);
  const viewModels = buildBinViewModels(
    bins.map(({ id, code, zone, capacity, priority }) => ({ id, code, zone, capacity, priority })),
    inventory,
  );
  const unplacedCount = (unplacedResult.data ?? []).reduce(
    (total, item) => total + item.quantity,
    0,
  );

  return (
    <section>
      <header className="mb-lg md:mb-xl">
        <p className="text-caption font-medium uppercase text-grey">{restaurantName}</p>
        <h1 className="mt-xs font-serif text-heading-sm text-ink">Bins</h1>
      </header>
      <BinManager
        bins={viewModels}
        inventory={inventory}
        canManage={userRole === "owner" || userRole === "manager"}
        unplacedCount={unplacedCount}
      />
    </section>
  );
}

function flattenInventory(bins: readonly JoinedBin[]): BottleInventoryRow[] {
  return bins.flatMap((bin) =>
    bin.inventory_items.flatMap((item) => {
      const wine = Array.isArray(item.wines) ? item.wines[0] : item.wines;
      if (!wine) return [];
      return [{
        wineId: wine.id,
        lineageId: wine.lineage_id,
        name: wine.name,
        producer: wine.producer,
        colour: wine.colour,
        binId: bin.id,
        binCode: bin.code,
        binZone: bin.zone,
        quantity: item.quantity,
      }];
    }),
  );
}
