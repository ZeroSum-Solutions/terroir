import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { ArrowDown, ArrowUp, DollarSign, ScanLine, TrendingDown, TrendingUp } from "lucide-react";
import Link from "next/link";
import { OverpaidFlagButton } from "@/components/overpaid-flag-button";
import { RouteDataEmpty } from "@/components/route-data-state";
import { SortControls } from "./sort-controls";
import {
  ExportCsvButton,
  type PriceComparisonCsvRow,
} from "./export-csv-button";

export const metadata: Metadata = { title: "Price comparison" };

const VARIANCE_HIGHLIGHT_THRESHOLD =
  parseFloat(process.env.PRICE_VARIANCE_HIGHLIGHT_THRESHOLD ?? "0.10") || 0.10;

function formatPrice(n: number) {
  return "$" + n.toFixed(2);
}

function formatPct(n: number) {
  return (n * 100).toFixed(0) + "%";
}

function formatInvoiceDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

type PriceEntry = {
  distributor: string;
  unitCost: number;
  quantity: number;
  invoiceDate: string | null;
};

function pickMostRecent(prices: PriceEntry[]): PriceEntry | undefined {
  if (prices.length === 0) return undefined;
  let best: PriceEntry | undefined;
  for (const p of prices) {
    if (!p.invoiceDate) continue;
    if (!best || (best.invoiceDate && p.invoiceDate > best.invoiceDate)) {
      best = p;
    }
  }
  return best ?? prices[prices.length - 1];
}

type WineComparison = {
  wine: {
    id: string;
    name: string;
    producer: string;
    vintage: number | null;
    varietal: string | null;
  };
  prices: PriceEntry[];
  cheapest: number;
  mostExpensive: number;
  spread: number;
  distributorCount: number;
  potentialSavings: number;
  // BND-138
  lastPaid: number;
  marketPrice: number | null;
  variancePct: number | null;
  flagged: boolean;
};

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
    const byDist = new Map<string, PriceEntry>();
    for (const p of comp.prices) {
      const existing = byDist.get(p.distributor);
      if (
        !existing ||
        (p.invoiceDate &&
          (!existing.invoiceDate || p.invoiceDate > existing.invoiceDate))
      ) {
        byDist.set(p.distributor, p);
      }
    }
    const distPrices = [...byDist.values()].sort(
      (a, b) => a.unitCost - b.unitCost,
    );
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
          <p className="mt-xs text-[15px] text-ink-muted">
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
              className="inline-flex h-11 items-center gap-sm rounded-pill bg-primary px-md text-[14px] font-medium text-white hover:bg-primary-hover"
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
      <header className="mb-lg md:mb-xl">
        <div className="flex items-start justify-between gap-md">
          <div>
            <h1 className="font-serif text-heading-sm text-ink">
              Distributor Pricing
            </h1>
            <p className="mt-xs text-[15px] text-ink-muted">
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
          className="mb-lg rounded-card border border-hairline bg-bridge-surface px-md py-sm text-[13px] text-ink-muted"
        >
          Market benchmarks are temporarily unavailable. Distributor pricing
          remains available.
        </div>
      )}

      {/* Summary card */}
      {comparable.length > 0 && (
        <div className="mb-lg rounded-card border border-hairline bg-canvas p-lg">
          <div className="flex flex-wrap items-baseline gap-lg">
            <div>
              <div className="text-caption font-medium uppercase text-grey">
                Wines with multiple suppliers
              </div>
              <div className="mt-xs font-mono text-[20px] font-medium text-ink">
                {comparable.length}
              </div>
            </div>
            {totalSavings > 0 && (
              <div>
                <div className="text-caption font-medium uppercase text-grey">
                  Potential savings
                </div>
                <div className="mt-xs font-mono text-[20px] font-medium text-sage-ink">
                  {formatPrice(totalSavings)}
                </div>
              </div>
            )}
            {comparable.filter((c) => c.variancePct != null && c.variancePct > 0).length > 0 && (
              <div>
                <div className="text-caption font-medium uppercase text-grey">
                  Overpaid vs market
                </div>
                <div className="mt-xs font-mono text-[20px] font-medium text-primary">
                  {comparable.filter((c) => c.variancePct != null && c.variancePct > 0).length}
                </div>
              </div>
            )}
            {comparable[0] && comparable[0].potentialSavings > 0 && (
              <Link
                href={`/cellar?wine=${comparable[0].wine.id}`}
                aria-label={`View top savings opportunity: ${comparable[0].wine.producer} ${comparable[0].wine.name} in cellar`}
                className="group min-w-0 max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              >
                <div className="text-caption font-medium uppercase text-grey">
                  Top opportunity
                </div>
                <div className="mt-xs font-mono text-[20px] font-medium text-sage-ink group-hover:text-primary">
                  Save {formatPrice(comparable[0].potentialSavings)}
                </div>
                <div className="mt-2xs truncate text-[12px] text-ink-muted group-hover:text-primary">
                  {comparable[0].wine.producer} · {comparable[0].wine.name}
                  {comparable[0].wine.vintage
                    ? ` ${comparable[0].wine.vintage}`
                    : ""}
                </div>
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Comparable wines — multi-distributor */}
      {comparable.length > 0 && (
        <div className="mb-xl">
          <div className="mb-md flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-ink">Price comparisons</h2>
            <SortControls current={{ field: sf, dir: so }} />
          </div>

          {/* Desktop table */}
          <div className="hidden md:block overflow-hidden rounded-card border border-hairline">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-bridge-surface text-caption font-medium uppercase text-grey">
                  <th scope="col" className="px-md py-sm text-left font-medium">Wine</th>
                  <th scope="col" className="px-md py-sm text-left font-medium">Distributor</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Unit cost</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Qty</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Spread</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Savings</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Last paid</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Market</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Variance</th>
                </tr>
              </thead>
              <tbody>
                {visibleComparable.map((comp) => {
                  const byDist = new Map<string, PriceEntry>();
                  for (const p of comp.prices) {
                    const existing = byDist.get(p.distributor);
                    if (
                      !existing ||
                      (p.invoiceDate &&
                        (!existing.invoiceDate ||
                          p.invoiceDate > existing.invoiceDate))
                    ) {
                      byDist.set(p.distributor, p);
                    }
                  }
                  const distPrices = [...byDist.values()].sort(
                    (a, b) => a.unitCost - b.unitCost,
                  );

                  return distPrices.map((price, i) => (
                    <tr
                      key={`${comp.wine.id}-${price.distributor}-${i}`}
                      className={`border-t border-dashed border-hairline ${
                        price.unitCost === comp.cheapest
                          ? "bg-sage-wash/40"
                          : comp.variancePct != null && comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD
                            ? "bg-blush-wash/25"
                            : comp.variancePct != null && comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD
                              ? "bg-sage-wash/15"
                              : ""
                      }`}
                    >
                      {i === 0 ? (
                        <td className="px-md py-sm align-top" rowSpan={distPrices.length}>
                          <div className="flex items-start gap-xs">
                            <Link
                              href={`/cellar?wine=${comp.wine.id}`}
                              aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                              className="group block min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                            >
                              <div className="font-serif text-[17px] font-medium text-ink group-hover:text-primary">
                                {comp.wine.producer}
                              </div>
                              <div className="text-ink-muted group-hover:text-primary">
                                {comp.wine.name}
                                {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                              </div>
                            </Link>
                            <OverpaidFlagButton wineId={comp.wine.id} flagged={comp.flagged} />
                          </div>
                        </td>
                      ) : null}
                      <td className="px-md py-sm text-ink">
                        <div>{price.distributor}</div>
                        {formatInvoiceDate(price.invoiceDate) && (
                          <div className="mt-2xs font-mono text-[11px] text-ink-subtle">
                            {formatInvoiceDate(price.invoiceDate)}
                          </div>
                        )}
                      </td>
                      <td className="px-md py-sm text-right font-mono text-ink">
                        {formatPrice(price.unitCost)}
                        {price.unitCost === comp.cheapest && distPrices.length > 1 && (
                          <span className="ml-xs inline-flex items-center text-sage-ink">
                            <ArrowDown className="h-3 w-3" strokeWidth={2.5} />
                          </span>
                        )}
                        {price.unitCost === comp.mostExpensive && distPrices.length > 1 && (
                          <span className="ml-xs inline-flex items-center text-primary">
                            <ArrowUp className="h-3 w-3" strokeWidth={2.5} />
                          </span>
                        )}
                      </td>
                      <td className="px-md py-sm text-right font-mono text-ink-muted">
                        {price.quantity}
                      </td>
                      {i === 0 ? (
                        <td className="px-md py-sm text-right align-top" rowSpan={distPrices.length}>
                          {comp.spread >= 0.1 ? (
                            <span className="inline-flex items-center gap-xs rounded-pill bg-amber-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-amber">
                              {Math.round(comp.spread * 100)}% spread
                            </span>
                          ) : (
                            <span className="font-mono text-[12px] text-ink-subtle">
                              {Math.round(comp.spread * 100)}%
                            </span>
                          )}
                        </td>
                      ) : null}
                      {i === 0 ? (
                        <td className="px-md py-sm text-right align-top font-mono text-sage-ink" rowSpan={distPrices.length}>
                          {comp.potentialSavings > 0
                            ? formatPrice(comp.potentialSavings)
                            : <span className="text-ink-subtle">—</span>}
                        </td>
                      ) : null}
                      {/* BND-138: Last Paid */}
                      {i === 0 ? (
                        <td className="px-md py-sm text-right align-top font-mono text-ink" rowSpan={distPrices.length}>
                          {comp.lastPaid > 0
                            ? formatPrice(comp.lastPaid)
                            : <span className="text-ink-subtle">—</span>}
                        </td>
                      ) : null}
                      {/* BND-138: Market Price */}
                      {i === 0 ? (
                        <td className="px-md py-sm text-right align-top font-mono text-ink" rowSpan={distPrices.length}>
                          {comp.marketPrice != null
                            ? formatPrice(comp.marketPrice)
                            : <span className="text-ink-subtle">—</span>}
                        </td>
                      ) : null}
                      {/* BND-138: Variance */}
                      {i === 0 ? (
                        <td className="px-md py-sm text-right align-top font-mono" rowSpan={distPrices.length}>
                          {comp.variancePct != null ? (
                            comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD ? (
                              <span className="inline-flex items-center gap-xs rounded-pill bg-blush-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-primary">
                                <TrendingUp className="h-3 w-3" strokeWidth={2.5} />
                                +{formatPct(comp.variancePct)}
                              </span>
                            ) : comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD ? (
                              <span className="inline-flex items-center gap-xs rounded-pill bg-sage-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-sage-ink">
                                <TrendingDown className="h-3 w-3" strokeWidth={2.5} />
                                {formatPct(comp.variancePct)}
                              </span>
                            ) : (
                              <span className="text-ink-subtle">{formatPct(comp.variancePct)}</span>
                            )
                          ) : (
                            <span className="text-ink-subtle">—</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-md md:hidden">
            {visibleComparable.map((comp) => {
              const byDist = new Map<string, PriceEntry>();
              for (const p of comp.prices) {
                const existing = byDist.get(p.distributor);
                if (
                  !existing ||
                  (p.invoiceDate &&
                    (!existing.invoiceDate ||
                      p.invoiceDate > existing.invoiceDate))
                ) {
                  byDist.set(p.distributor, p);
                }
              }
              const distPrices = [...byDist.values()].sort(
                (a, b) => a.unitCost - b.unitCost,
              );

              return (
                <div
                  key={comp.wine.id}
                  className={`rounded-card border bg-canvas p-md ${
                    comp.variancePct != null && comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD
                      ? "border-primary/30 bg-blush-wash/20"
                      : comp.variancePct != null && comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD
                        ? "border-sage/30 bg-sage-wash/10"
                        : "border-hairline"
                  }`}
                >
                  <div className="mb-sm flex items-start justify-between">
                    <div className="flex items-start gap-xs min-w-0 flex-1">
                      <Link
                        href={`/cellar?wine=${comp.wine.id}`}
                        aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                        className="group min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                      >
                        <div className="font-serif text-[17px] font-medium text-ink group-hover:text-primary">
                          {comp.wine.name}
                          {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                        </div>
                        <div className="text-[13px] text-ink-muted group-hover:text-primary">
                          {comp.wine.producer}
                        </div>
                      </Link>
                      <OverpaidFlagButton wineId={comp.wine.id} flagged={comp.flagged} />
                    </div>
                    <div className="flex flex-col items-end gap-xs">
                      {comp.spread >= 0.1 && (
                        <span className="inline-flex items-center gap-xs rounded-pill bg-amber-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-amber">
                          {Math.round(comp.spread * 100)}%
                        </span>
                      )}
                      {comp.potentialSavings > 0 && (
                        <span className="font-mono text-[11px] font-medium text-sage-ink">
                          Save {formatPrice(comp.potentialSavings)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* BND-138: Market comparison row */}
                  <div className="mb-sm flex items-center justify-between rounded-md bg-bridge-surface px-sm py-sm">
                    <span className="text-caption font-medium uppercase text-grey">
                      Last paid
                    </span>
                    <span className="font-mono text-[14px] font-medium text-ink tabular-nums">
                      {comp.lastPaid > 0 ? formatPrice(comp.lastPaid) : "—"}
                    </span>
                    {comp.marketPrice != null && (
                      <>
                        <span className="mx-xs text-ink-subtle">vs</span>
                        <span className="font-mono text-[14px] font-medium text-ink-subtle tabular-nums">
                          {formatPrice(comp.marketPrice)}
                        </span>
                        {comp.variancePct != null && Math.abs(comp.variancePct) > VARIANCE_HIGHLIGHT_THRESHOLD && (
                          <span
                            className={`ml-sm rounded-pill px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide ${
                              comp.variancePct > 0
                                ? "bg-blush-wash text-primary"
                                : "bg-sage-wash text-sage-ink"
                            }`}
                          >
                            {comp.variancePct > 0 ? "+" : ""}
                            {formatPct(comp.variancePct)}
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  <div className="flex flex-col gap-xs">
                    {distPrices.map((price) => (
                      <div
                        key={price.distributor}
                        className={`flex items-center justify-between rounded-pill px-sm py-xs ${
                          price.unitCost === comp.cheapest
                            ? "bg-sage-wash/40"
                            : ""
                        }`}
                      >
                        <span className="min-w-0 text-[13px] text-ink">
                          <span className="block truncate">{price.distributor}</span>
                          {formatInvoiceDate(price.invoiceDate) && (
                            <span className="mt-2xs block font-mono text-[11px] text-ink-subtle">
                              {formatInvoiceDate(price.invoiceDate)}
                            </span>
                          )}
                        </span>
                        <span className="font-mono text-[13px] font-medium text-ink">
                          {formatPrice(price.unitCost)}
                          {price.unitCost === comp.cheapest && distPrices.length > 1 && (
                            <ArrowDown className="ml-xs inline h-3 w-3 text-sage-ink" strokeWidth={2.5} />
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Single-source wines */}
      {singleSource.length > 0 && (
        <div>
          <h2 className="mb-md text-[15px] font-medium text-ink-muted">
            Single source ({singleSource.length})
          </h2>

          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-card border border-hairline bg-canvas md:block">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-bridge-surface text-caption font-medium uppercase text-grey">
                  <th scope="col" className="px-md py-sm text-left font-medium">Wine</th>
                  <th scope="col" className="px-md py-sm text-left font-medium">Distributor</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Unit cost</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Market</th>
                  <th scope="col" className="px-md py-sm text-right font-medium">Variance</th>
                </tr>
              </thead>
              <tbody>
                {visibleSingleSource.map((comp) => {
                  const latest = pickMostRecent(comp.prices);
                  const latestDate = formatInvoiceDate(latest?.invoiceDate ?? null);
                  return (
                    <tr
                      key={comp.wine.id}
                      className={`border-t border-dashed border-hairline ${
                        comp.variancePct != null && comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD
                          ? "bg-blush-wash/25"
                          : comp.variancePct != null && comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD
                            ? "bg-sage-wash/15"
                            : ""
                      }`}
                    >
                      <td className="px-md py-sm">
                        <div className="flex items-start gap-xs">
                          <Link
                            href={`/cellar?wine=${comp.wine.id}`}
                            aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                            className="group inline-block min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                          >
                            <span className="font-serif text-[17px] font-medium text-ink group-hover:text-primary">
                              {comp.wine.producer}
                            </span>
                            <span className="font-serif text-[17px] text-ink-muted group-hover:text-primary">
                              {" "}
                              {comp.wine.name}
                              {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                            </span>
                          </Link>
                          <OverpaidFlagButton wineId={comp.wine.id} flagged={comp.flagged} />
                        </div>
                      </td>
                      <td className="px-md py-sm text-ink-muted">
                        <div>{latest?.distributor ?? "—"}</div>
                        {latestDate && (
                          <div className="mt-2xs font-mono text-[11px] text-ink-subtle">
                            {latestDate}
                          </div>
                        )}
                      </td>
                      <td className="px-md py-sm text-right font-mono text-ink">
                        {latest ? formatPrice(latest.unitCost) : "—"}
                      </td>
                      {/* BND-138: Market Price */}
                      <td className="px-md py-sm text-right font-mono text-ink">
                        {comp.marketPrice != null
                          ? formatPrice(comp.marketPrice)
                          : <span className="text-ink-subtle">—</span>}
                      </td>
                      {/* BND-138: Variance */}
                      <td className="px-md py-sm text-right font-mono">
                        {comp.variancePct != null ? (
                          comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD ? (
                            <span className="inline-flex items-center gap-xs rounded-pill bg-blush-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-primary">
                              +{formatPct(comp.variancePct)}
                            </span>
                          ) : comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD ? (
                            <span className="inline-flex items-center gap-xs rounded-pill bg-sage-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-sage-ink">
                              {formatPct(comp.variancePct)}
                            </span>
                          ) : (
                            <span className="text-ink-subtle">{formatPct(comp.variancePct)}</span>
                          )
                        ) : (
                          <span className="text-ink-subtle">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-sm md:hidden">
            {visibleSingleSource.map((comp) => {
              const latest = pickMostRecent(comp.prices);
              const latestDate = formatInvoiceDate(latest?.invoiceDate ?? null);
              return (
                <div
                  key={comp.wine.id}
                  className={`rounded-card border bg-canvas p-md ${
                    comp.variancePct != null && comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD
                      ? "border-primary/30 bg-blush-wash/20"
                      : comp.variancePct != null && comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD
                        ? "border-sage/30 bg-sage-wash/10"
                        : "border-hairline"
                  }`}
                >
                  <div className="flex items-start justify-between gap-sm">
                    <div className="flex items-start gap-xs min-w-0 flex-1">
                      <Link
                        href={`/cellar?wine=${comp.wine.id}`}
                        aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                        className="group min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                      >
                        <div className="font-serif text-[17px] font-medium text-ink group-hover:text-primary">
                          {comp.wine.name}
                          {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                        </div>
                        <div className="text-[13px] text-ink-muted group-hover:text-primary">
                          {comp.wine.producer}
                        </div>
                      </Link>
                      <OverpaidFlagButton wineId={comp.wine.id} flagged={comp.flagged} />
                    </div>
                    <span className="shrink-0 font-mono text-[14px] font-medium text-ink">
                      {latest ? formatPrice(latest.unitCost) : "—"}
                    </span>
                  </div>
                  {/* BND-138: Market comparison for single-source mobile */}
                  {comp.marketPrice != null && (
                    <div className="mt-sm flex items-center justify-between border-t border-dashed border-hairline pt-sm">
                      <span className="text-caption font-medium uppercase text-grey">
                        Market
                      </span>
                      <div className="flex items-center gap-sm">
                        <span className="font-mono text-[13px] text-ink-subtle tabular-nums">
                          {formatPrice(comp.marketPrice)}
                        </span>
                        {comp.variancePct != null && Math.abs(comp.variancePct) > VARIANCE_HIGHLIGHT_THRESHOLD && (
                          <span
                            className={`rounded-pill px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide ${
                              comp.variancePct > 0
                                ? "bg-blush-wash text-primary"
                                : "bg-sage-wash text-sage-ink"
                            }`}
                          >
                            {comp.variancePct > 0 ? "+" : ""}
                            {formatPct(comp.variancePct)}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="mt-sm flex items-baseline justify-between border-t border-dashed border-hairline pt-sm text-[13px] text-ink-muted">
                    <span className="min-w-0 truncate">
                      {latest?.distributor ?? "—"}
                    </span>
                    {latestDate && (
                      <span className="ml-sm shrink-0 font-mono text-[11px] text-ink-subtle">
                        {latestDate}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {hasMoreComparisons && (
        <Link
          href={`/price-comparison?${showMoreParams.toString()}`}
          className="mt-lg inline-flex min-h-11 w-full items-center justify-center rounded-pill border border-hairline bg-white px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
        >
          Show {Math.min(25, comparisons.length - visibleComparisonCount)} more ·{" "}
          {visibleComparisonCount} of {comparisons.length}
        </Link>
      )}
    </section>
  );
}
