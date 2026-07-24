import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

const PAGE_SIZE = 1000;
const MAX_COMPARISON_ROWS = 10_000;

type Price = {
  distributor: string;
  unitCost: number;
  quantity: number;
  invoiceDate: string | null;
  addedAt: string;
};

type Wine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
};

type InventoryRow = {
  unit_cost: number;
  quantity: number;
  currency: string | null;
  added_at: string;
  wines: Wine | Wine[] | null;
  invoice_scans:
    | { distributor_name: string; invoice_date: string | null }
    | Array<{ distributor_name: string; invoice_date: string | null }>
    | null;
};

export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const items = await fetchComparisonRows(supabase, restaurantId);

    const wineMap = new Map<
      string,
      {
        wine: Wine;
        pricesByDistributor: Map<string, Price>;
      }
    >();

    for (const item of items) {
      if (
        item.unit_cost <= 0 ||
        (item.currency != null && item.currency.toUpperCase() !== "USD")
      ) {
        continue;
      }
      const wine = firstRelation(item.wines);
      const scan = firstRelation(item.invoice_scans);
      if (!wine || !scan?.distributor_name) continue;

      let entry = wineMap.get(wine.id);
      if (!entry) {
        entry = { wine, pricesByDistributor: new Map() };
        wineMap.set(wine.id, entry);
      }

      const candidate: Price = {
        distributor: scan.distributor_name,
        unitCost: item.unit_cost,
        quantity: item.quantity,
        invoiceDate: scan.invoice_date,
        addedAt: item.added_at,
      };
      const current = entry.pricesByDistributor.get(candidate.distributor);
      if (!current || isNewer(candidate, current)) {
        entry.pricesByDistributor.set(candidate.distributor, candidate);
      }
    }

    const result = [...wineMap.values()]
      .map(({ wine, pricesByDistributor }) => {
        const prices = [...pricesByDistributor.values()]
          .map(({ addedAt: _addedAt, ...price }) => price)
          .sort((a, b) => a.unitCost - b.unitCost);
        const cheapest = prices[0]?.unitCost ?? 0;
        const mostExpensive = prices[prices.length - 1]?.unitCost ?? 0;
        const spread =
          cheapest > 0 ? (mostExpensive - cheapest) / cheapest : 0;

        return {
          wine,
          prices,
          cheapest,
          mostExpensive,
          spread,
          distributorCount: prices.length,
        };
      })
      .sort((a, b) => {
        const comparison = a.wine.producer.localeCompare(b.wine.producer);
        return comparison !== 0
          ? comparison
          : a.wine.name.localeCompare(b.wine.name);
      });

    return NextResponse.json(result);
  });
}

async function fetchComparisonRows(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
): Promise<InventoryRow[]> {
  const items: InventoryRow[] = [];

  for (let offset = 0; offset < MAX_COMPARISON_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("inventory_items")
      .select(
        "unit_cost, quantity, currency, added_at, wines(id, name, producer, vintage, varietal), invoice_scans(distributor_name, invoice_date)",
      )
      .eq("restaurant_id", restaurantId)
      .eq("added_via", "invoice_scan")
      .gt("unit_cost", 0)
      .or("currency.is.null,currency.eq.USD")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;

    const page = (data ?? []) as InventoryRow[];
    items.push(...page);
    if (page.length < PAGE_SIZE) return items;
  }

  throw new Error(
    `Price comparison exceeds the ${MAX_COMPARISON_ROWS}-row request limit.`,
  );
}

function firstRelation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function isNewer(candidate: Price, current: Price): boolean {
  const candidateDate = candidate.invoiceDate ?? candidate.addedAt;
  const currentDate = current.invoiceDate ?? current.addedAt;
  if (candidateDate !== currentDate) return candidateDate > currentDate;
  return candidate.addedAt > current.addedAt;
}
