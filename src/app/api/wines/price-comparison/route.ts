import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // Fetch inventory items with wine + invoice scan details
  const { data: items, error } = await supabase
    .from("inventory_items")
    .select(
      "unit_cost, quantity, wine_id, wines(id, name, producer, vintage, varietal), invoice_scan_id, invoice_scans(distributor_name, invoice_date)",
    )
    .eq("restaurant_id", restaurantId);

  if (error) {
    console.error("price-comparison query failed:", error);
    return NextResponse.json(
      { error: "Failed to fetch price data." },
      { status: 500 },
    );
  }

  // Group by wine, then by distributor
  const wineMap = new Map<
    string,
    {
      wine: { id: string; name: string; producer: string; vintage: number | null; varietal: string | null };
      prices: Array<{
        distributor: string;
        unitCost: number;
        quantity: number;
        invoiceDate: string | null;
      }>;
    }
  >();

  for (const item of items ?? []) {
    const wine = item.wines as {
      id: string;
      name: string;
      producer: string;
      vintage: number | null;
      varietal: string | null;
    } | null;
    const scan = item.invoice_scans as {
      distributor_name: string;
      invoice_date: string | null;
    } | null;

    if (!wine || !scan) continue;

    let entry = wineMap.get(wine.id);
    if (!entry) {
      entry = { wine, prices: [] };
      wineMap.set(wine.id, entry);
    }

    entry.prices.push({
      distributor: scan.distributor_name,
      unitCost: item.unit_cost,
      quantity: item.quantity,
      invoiceDate: scan.invoice_date,
    });
  }

  // Convert to array, sort by producer then name
  const result = [...wineMap.values()]
    .map((entry) => {
      const sorted = entry.prices.sort((a, b) => a.unitCost - b.unitCost);
      const cheapest = sorted[0]?.unitCost ?? 0;
      const mostExpensive = sorted[sorted.length - 1]?.unitCost ?? 0;
      const spread =
        cheapest > 0 ? (mostExpensive - cheapest) / cheapest : 0;
      const distributorCount = new Set(sorted.map((p) => p.distributor)).size;

      return {
        ...entry,
        cheapest,
        mostExpensive,
        spread,
        distributorCount,
      };
    })
    .sort((a, b) => {
      const cmp = a.wine.producer.localeCompare(b.wine.producer);
      return cmp !== 0 ? cmp : a.wine.name.localeCompare(b.wine.name);
    });

  return NextResponse.json(result);
}
