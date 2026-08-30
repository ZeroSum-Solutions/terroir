import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { DollarSign, ScanLine } from "lucide-react";
import Link from "next/link";
import { RouteDataEmpty } from "@/components/route-data-state";
import { SortControls } from "./sort-controls";
import {
  ExportCsvButton,
  type PriceComparisonCsvRow,
} from "./export-csv-button";
import { ComparablePriceCards } from "./comparable-price-cards";
import { ComparablePriceTable } from "./comparable-price-table";
import { PriceSummaryCard } from "./price-summary-card";
import { SingleSourcePriceCards } from "./single-source-price-cards";
import { SingleSourcePriceTable } from "./single-source-price-table";
import {
  latestPriceByDistributor,
  pickMostRecent,
  type PriceEntry,
  type WineComparison,
} from "./price-comparison-helpers";

export const metadata: Metadata = { title: "Price comparison" };

type SearchParams = Promise<{
  sort?: string | string[];
  ord?: string | string[];
  limit?: string | string[];
}>;

export default async function PriceComparisonPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const sp = (await searchParams) ?? {};
  const sf = typeof sp.sort === "string" ? sp.sort : null;
  const so =
    sp.ord === "asc" || sp.ord === "desc" ? sp.ord : sf ? "desc" : null;
  const rawLimit = typeof sp.limit === "string" ? Number(sp.limit) : 25;
  const pageLimit = Number.isFinite(rawLimit)
    ? Math.min(500, Math.max(25, Math.floor(rawLimit)))
    : 25;
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId: rid } = auth;

  // Fetch inventory items with wine retail data + invoice scan details
  const { data: items, error: itemsError } = await supabase
    .from("inventory_items")
    .select(
      "unit_cost, quantity, wine_id, wines(id, name, producer, vintage, varietal, retail_median, retail_min, retail_max, enrichment_metadata, overpaid_flag), invoice_scan_id, invoice_scans(distributor_name, invoice_date)",
    )
    .eq("restaurant_id", rid);

  if (itemsError) throw itemsError;

  // BND-138: also fetch wines without inventory items that still have retail data
  const { data: winesWithRetail, error: retailError } = await supabase
    .from("wines")
    .select("id, retail_median, retail_min, retail_max, enrichment_metadata")
    .eq("restaurant_id", rid)
    .not("retail_median", "is", null);

  const retailByWineId = new Map<string, { median: number | null; min: number | null; max: number | null }>();
  for (const w of winesWithRetail ?? []) {
    retailByWineId.set(w.id, { median: w.retail_median, min: w.retail_min, max: w.retail_max });
  }

  // Group by wine, then compute comparison data
  const wineMap = new Map<string, WineComparison>();

  for (const item of items ?? []) {
    const wine = item.wines as {
      id: string; name: string; producer: string; vintage: number | null; varietal: string | null;
      retail_median: number | null; retail_min: number | null; retail_max: number | null;
      enrichment_metadata: Record<string, unknown> | null;
      overpaid_flag: boolean | null;
    } | null;
    const scan = item.invoice_scans as {
      distributor_name: string;
      invoice_date: string | null;
    } | null;

    if (!wine || !scan) continue;

    let entry = wineMap.get(wine.id);
    if (!entry) {
      entry = {
        wine: {
          id: wine.id,
          name: wine.name,
          producer: wine.producer,
          vintage: wine.vintage,
          varietal: wine.varietal,
        },
        prices: [],
        cheapest: 0,
        mostExpensive: 0,
        spread: 0,
        distributorCount: 0,
        potentialSavings: 0,
        lastPaid: 0,
        marketPrice: null,
        variancePct: null,
        flagged: wine.overpaid_flag ?? false,
      };
      wineMap.set(wine.id, entry);
    }

    entry.prices.push({
      distributor: scan.distributor_name,
      unitCost: item.unit_cost,
      quantity: item.quantity,
      invoiceDate: scan.invoice_date,
    });
  }

  // Compute derived fields
  const comparisons: WineComparison[] = [...wineMap.values()].map((entry) => {
    const sorted = entry.prices.sort((a, b) => a.unitCost - b.unitCost);
    const cheapest = sorted[0]?.unitCost ?? 0;
    const mostExpensive = sorted[sorted.length - 1]?.unitCost ?? 0;
    const spread = cheapest > 0 ? (mostExpensive - cheapest) / cheapest : 0;
    const distributorCount = new Set(sorted.map((p) => p.distributor)).size;
    const totalQty = sorted.reduce((s, p) => s + p.quantity, 0);
    const potentialSavings = (mostExpensive - cheapest) * totalQty;

    // BND-138: last-paid = most recent unit_cost by invoice date
    const mostRecent = pickMostRecent(sorted);
    const lastPaid = mostRecent?.unitCost ?? 0;

    // BND-138: market price — retail_median from wines table (populated
    // by enrichment pipeline or external retail data refresh)
    const retail = retailByWineId.get(entry.wine.id);
    const marketPrice = retail?.median ?? null;

    // BND-138: variance = (lastPaid - marketPrice) / marketPrice
    const variancePct =
      marketPrice && marketPrice > 0 ? (lastPaid - marketPrice) / marketPrice : null;

    return {
      ...entry,
      cheapest,
      mostExpensive,
      spread,
      distributorCount,
      potentialSavings,
      lastPaid,
      marketPrice,
      variancePct,
    };
  });

  // Comparable wines (2+ distributors) — default sort by potential dollar savings desc (BND-140)
  const comparable = comparisons
    .filter((c) => c.distributorCount >= 2)
    .sort((a, b) => {
      if (sf === "variance") {
        const va = a.variancePct ?? (so === "asc" ? Infinity : -Infinity);
        const vb = b.variancePct ?? (so === "asc" ? Infinity : -Infinity);
        if (va !== vb) return so === "asc" ? va - vb : vb - va;
      }
      if (b.potentialSavings !== a.potentialSavings) {
        return b.potentialSavings - a.potentialSavings;
      }
      if (b.spread !== a.spread) return b.spread - a.spread;
      const cmp = a.wine.producer.localeCompare(b.wine.producer);
      return cmp !== 0 ? cmp : a.wine.name.localeCompare(b.wine.name);
    });
  const singleSource = comparisons
    .filter((c) => c.distributorCount < 2)
    .sort((a, b) => {
      const cmp = a.wine.producer.localeCompare(b.wine.producer);
      return cmp !== 0 ? cmp : a.wine.name.localeCompare(b.wine.name);
    });
  const visibleComparable = comparable.slice(0, pageLimit);
  const visibleSingleSource = singleSource.slice(
    0,
    Math.max(0, pageLimit - visibleComparable.length),
  );
  const visibleComparisonCount =
    visibleComparable.length + visibleSingleSource.length;
  const maximumVisibleComparisonCount = Math.min(comparisons.length, 500);
  const hasMoreComparisons =
    visibleComparisonCount < maximumVisibleComparisonCount;
  const showMoreParams = new URLSearchParams();
  if (sf) showMoreParams.set("sort", sf);
  if (so) showMoreParams.set("ord", so);
  showMoreParams.set(
    "limit",
    String(Math.min(maximumVisibleComparisonCount, visibleComparisonCount + 25)),
  );

  // Total savings opportunity
  const totalSavings = comparable.reduce(
    (sum, c) => sum + c.potentialSavings,
    0,
  );

  // Build CSV rows
  const csvRows: PriceComparisonCsvRow[] = [];
  for (const comp of [...comparable, ...singleSource]) {
    const distPrices: PriceEntry[] = latestPriceByDistributor(comp.prices);
    for (const price of distPrices) {
      csvRows.push({
        producer: comp.wine.producer,
        wineName: comp.wine.name,
        vintage: comp.wine.vintage,
        distributor: price.distributor,
        unitCost: price.unitCost,
        quantity: price.quantity,
        invoiceDate: price.invoiceDate,
        distributorCount: comp.distributorCount,
        spreadPct: comp.spread * 100,
        potentialSavings: comp.potentialSavings,
        isCheapest:
          distPrices.length > 1 && price.unitCost === comp.cheapest,
      });
    }
  }

  // Empty state
  if (comparisons.length === 0) {
    return (
      <section>
        <header className="mb-xl">
          <h1 className="font-serif text-heading-sm text-ink">
            Distributor Pricing
          </h1>
          <p className="mt-xs text-body text-grey">
            Compare prices across suppliers
          </p>
        </header>
        <RouteDataEmpty
          icon={<DollarSign className="h-6 w-6" strokeWidth={1.5} />}
          title="Scan invoices to compare prices"
          description="Once you scan invoices from multiple distributors, price comparisons will appear here."
          action={
            <Link
              href="/scan"
              className="inline-flex h-11 items-center gap-sm rounded-pill bg-primary px-md text-control font-medium text-seal-ink hover:bg-primary-hover focus-ring"
            >
              <ScanLine className="h-4 w-4" strokeWidth={2} />
              Go to scanner
            </Link>
          }
        />
      </section>
    );
  }

  return (
    <section>
      <header className="mb-xl md:mb-3xl">
        <div className="flex items-start justify-between gap-md">
          <div>
            <h1 className="font-serif text-heading-sm text-ink">
              Distributor Pricing
            </h1>
            <p className="mt-xs text-body text-grey">
              Compare prices across suppliers
            </p>
          </div>
          <ExportCsvButton rows={csvRows} />
        </div>
      </header>

      {retailError && (
        <div
          role="status"
          aria-live="polite"
          className="mb-lg rounded-card card-surface px-md py-sm text-body-sm text-grey"
        >
          Market benchmarks are temporarily unavailable. Distributor pricing
          remains available.
        </div>
      )}

      <PriceSummaryCard comparable={comparable} totalSavings={totalSavings} />

      {/* Comparable wines — multi-distributor */}
      {comparable.length > 0 && (
        <div className="mb-xl md:mb-3xl">
          <div className="mb-md flex items-center justify-between">
            <h2 className="text-body font-semibold text-ink">Price comparisons</h2>
            <SortControls current={{ field: sf, dir: so }} />
          </div>

          <ComparablePriceTable wines={visibleComparable} />
          <ComparablePriceCards wines={visibleComparable} />
        </div>
      )}

      {/* Single-source wines */}
      {singleSource.length > 0 && (
        <div>
          <h2 className="mb-md text-body font-medium text-grey">
            Single source ({singleSource.length})
          </h2>

          <SingleSourcePriceTable wines={visibleSingleSource} />
          <SingleSourcePriceCards wines={visibleSingleSource} />
        </div>
      )}
      {hasMoreComparisons && (
        <Link
          href={`/price-comparison?${showMoreParams.toString()}`}
          className="mt-lg inline-flex min-h-11 w-full items-center justify-center rounded-pill border border-rule bg-surface px-md text-body-sm font-medium text-ink hover:bg-wash focus-ring"
        >
          Show {Math.min(25, comparisons.length - visibleComparisonCount)} more ·{" "}
          {visibleComparisonCount} of {comparisons.length}
        </Link>
      )}
    </section>
  );
}
