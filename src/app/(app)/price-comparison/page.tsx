import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { ArrowDown, ArrowUp, DollarSign, ScanLine, TrendingDown, TrendingUp } from "lucide-react";
import Link from "next/link";
import {
  ExportCsvButton,
  type PriceComparisonCsvRow,
} from "./export-csv-button";

export const metadata: Metadata = { title: "Price comparison" };

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
};

export default async function PriceComparisonPage() {
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId: rid } = auth;

  // Fetch inventory items with wine retail data + invoice scan details
  const { data: items } = await supabase
    .from("inventory_items")
    .select(
      "unit_cost, quantity, wine_id, wines(id, name, producer, vintage, varietal, retail_median, retail_min, retail_max, enrichment_metadata), invoice_scan_id, invoice_scans(distributor_name, invoice_date)",
    )
    .eq("restaurant_id", rid);

  // BND-138: also fetch wines without inventory items that still have retail data
  const { data: winesWithRetail } = await supabase
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

  // Comparable wines (2+ distributors) sort by potential dollar savings desc
  const comparable = comparisons
    .filter((c) => c.distributorCount >= 2)
    .sort((a, b) => {
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
          <h1 className="font-serif text-[28px] text-ink">
            Distributor Pricing
          </h1>
          <p className="mt-xs text-[15px] text-ink-muted">
            Compare prices across suppliers
          </p>
        </header>
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border-strong bg-surface-muted px-lg py-3xl text-center">
          <DollarSign
            className="mb-md h-10 w-10 text-ink-subtle"
            strokeWidth={1.5}
          />
          <p className="text-[15px] font-medium text-ink">
            Scan invoices to compare prices
          </p>
          <p className="mt-xs text-[13px] text-ink-muted">
            Once you scan invoices from multiple distributors, price comparisons
            will appear here.
          </p>
          <Link
            href="/scan"
            className="mt-lg flex h-[38px] items-center gap-sm rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover"
          >
            <ScanLine className="h-4 w-4" strokeWidth={2} />
            Go to scanner
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section>
      <header className="mb-lg md:mb-xl">
        <div className="flex items-start justify-between gap-md">
          <div>
            <h1 className="font-serif text-[28px] text-ink">
              Distributor Pricing
            </h1>
            <p className="mt-xs text-[15px] text-ink-muted">
              Compare prices across suppliers
            </p>
          </div>
          <ExportCsvButton rows={csvRows} />
        </div>
      </header>

      {/* Summary card */}
      {comparable.length > 0 && (
        <div className="mb-lg rounded-md border border-border bg-surface p-lg">
          <div className="flex flex-wrap items-baseline gap-lg">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Wines with multiple suppliers
              </div>
              <div className="mt-xs font-mono text-[20px] font-medium text-ink">
                {comparable.length}
              </div>
            </div>
            {totalSavings > 0 && (
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Potential savings
                </div>
                <div className="mt-xs font-mono text-[20px] font-medium text-success">
                  {formatPrice(totalSavings)}
                </div>
              </div>
            )}
            {comparable.filter((c) => c.variancePct != null && c.variancePct > 0).length > 0 && (
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Overpaid vs market
                </div>
                <div className="mt-xs font-mono text-[20px] font-medium text-warning">
                  {comparable.filter((c) => c.variancePct != null && c.variancePct > 0).length}
                </div>
              </div>
            )}
            {comparable[0] && comparable[0].potentialSavings > 0 && (
              <Link
                href={`/cellar?wine=${comparable[0].wine.id}`}
                aria-label={`View top savings opportunity: ${comparable[0].wine.producer} ${comparable[0].wine.name} in cellar`}
                className="group min-w-0 max-w-full rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Top opportunity
                </div>
                <div className="mt-xs font-mono text-[20px] font-medium text-success group-hover:text-accent">
                  Save {formatPrice(comparable[0].potentialSavings)}
                </div>
                <div className="mt-2xs truncate text-[12px] text-ink-muted group-hover:text-accent">
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
          <h2 className="mb-md text-[15px] font-semibold text-ink">
            Price comparisons
          </h2>

          {/* Desktop table */}
          <div className="hidden md:block">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  <th scope="col" className="pb-sm text-left font-semibold">Wine</th>
                  <th scope="col" className="pb-sm text-left font-semibold">Distributor</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Unit cost</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Qty</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Spread</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Savings</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Last paid</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Market</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Variance</th>
                </tr>
              </thead>
              <tbody>
                {comparable.map((comp) => {
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
                      className={`border-t border-dashed border-border ${
                        price.unitCost === comp.cheapest
                          ? "bg-success-soft/40"
                          : ""
                      }`}
                    >
                      {i === 0 ? (
                        <td className="py-sm align-top" rowSpan={distPrices.length}>
                          <Link
                            href={`/cellar?wine=${comp.wine.id}`}
                            aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                            className="group block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                          >
                            <div className="font-medium text-ink group-hover:text-accent">
                              {comp.wine.producer}
                            </div>
                            <div className="text-ink-muted group-hover:text-accent">
                              {comp.wine.name}
                              {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                            </div>
                          </Link>
                        </td>
                      ) : null}
                      <td className="py-sm text-ink">
                        <div>{price.distributor}</div>
                        {formatInvoiceDate(price.invoiceDate) && (
                          <div className="mt-2xs font-mono text-[11px] text-ink-subtle">
                            {formatInvoiceDate(price.invoiceDate)}
                          </div>
                        )}
                      </td>
                      <td className="py-sm text-right font-mono text-ink">
                        {formatPrice(price.unitCost)}
                        {price.unitCost === comp.cheapest && distPrices.length > 1 && (
                          <span className="ml-xs inline-flex items-center text-success">
                            <ArrowDown className="h-3 w-3" strokeWidth={2.5} />
                          </span>
                        )}
                        {price.unitCost === comp.mostExpensive && distPrices.length > 1 && (
                          <span className="ml-xs inline-flex items-center text-error">
                            <ArrowUp className="h-3 w-3" strokeWidth={2.5} />
                          </span>
                        )}
                      </td>
                      <td className="py-sm text-right font-mono text-ink-muted">
                        {price.quantity}
                      </td>
                      {i === 0 ? (
                        <td className="py-sm text-right align-top" rowSpan={distPrices.length}>
                          {comp.spread >= 0.1 ? (
                            <span className="inline-flex items-center gap-xs rounded-pill bg-warning-soft px-sm py-xs text-[11px] font-semibold text-warning">
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
                        <td className="py-sm text-right align-top font-mono text-success" rowSpan={distPrices.length}>
                          {comp.potentialSavings > 0
                            ? formatPrice(comp.potentialSavings)
                            : <span className="text-ink-subtle">—</span>}
                        </td>
                      ) : null}
                      {/* BND-138: Last Paid */}
                      {i === 0 ? (
                        <td className="py-sm text-right align-top font-mono text-ink" rowSpan={distPrices.length}>
                          {comp.lastPaid > 0
                            ? formatPrice(comp.lastPaid)
                            : <span className="text-ink-subtle">—</span>}
                        </td>
                      ) : null}
                      {/* BND-138: Market Price */}
                      {i === 0 ? (
                        <td className="py-sm text-right align-top font-mono text-ink" rowSpan={distPrices.length}>
                          {comp.marketPrice != null
                            ? formatPrice(comp.marketPrice)
                            : <span className="text-ink-subtle">—</span>}
                        </td>
                      ) : null}
                      {/* BND-138: Variance */}
                      {i === 0 ? (
                        <td className="py-sm text-right align-top font-mono" rowSpan={distPrices.length}>
                          {comp.variancePct != null ? (
                            comp.variancePct > 0.05 ? (
                              <span className="inline-flex items-center gap-xs rounded-pill bg-warning-soft px-sm py-xs text-[11px] font-semibold text-warning">
                                <TrendingUp className="h-3 w-3" strokeWidth={2.5} />
                                +{formatPct(comp.variancePct)}
                              </span>
                            ) : comp.variancePct < -0.05 ? (
                              <span className="inline-flex items-center gap-xs rounded-pill bg-success-soft px-sm py-xs text-[11px] font-semibold text-success">
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
            {comparable.map((comp) => {
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
                  className="rounded-md border border-border bg-surface p-md"
                >
                  <div className="mb-sm flex items-start justify-between">
                    <Link
                      href={`/cellar?wine=${comp.wine.id}`}
                      aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                      className="group min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                    >
                      <div className="font-serif text-[16px] font-medium text-ink group-hover:text-accent">
                        {comp.wine.name}
                        {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                      </div>
                      <div className="text-[13px] text-ink-muted group-hover:text-accent">
                        {comp.wine.producer}
                      </div>
                    </Link>
                    <div className="flex flex-col items-end gap-xs">
                      {comp.spread >= 0.1 && (
                        <span className="inline-flex items-center gap-xs rounded-pill bg-warning-soft px-sm py-xs text-[11px] font-semibold text-warning">
                          {Math.round(comp.spread * 100)}%
                        </span>
                      )}
                      {comp.potentialSavings > 0 && (
                        <span className="font-mono text-[11px] font-medium text-success">
                          Save {formatPrice(comp.potentialSavings)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* BND-138: Market comparison row */}
                  <div className="mb-sm flex items-center justify-between rounded-sm bg-surface-muted px-sm py-sm">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
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
                        {comp.variancePct != null && Math.abs(comp.variancePct) > 0.05 && (
                          <span
                            className={`ml-sm rounded-pill px-sm py-2xs text-[11px] font-semibold ${
                              comp.variancePct > 0
                                ? "bg-warning-soft text-warning"
                                : "bg-success-soft text-success"
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
                        className={`flex items-center justify-between rounded-sm px-sm py-xs ${
                          price.unitCost === comp.cheapest
                            ? "bg-success-soft/40"
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
                            <ArrowDown className="ml-xs inline h-3 w-3 text-success" strokeWidth={2.5} />
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
          <h2 className="mb-md text-[15px] font-semibold text-ink-muted">
            Single source ({singleSource.length})
          </h2>

          {/* Desktop table */}
          <div className="hidden rounded-md border border-border bg-surface md:block">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  <th scope="col" className="px-md py-sm text-left font-semibold">Wine</th>
                  <th scope="col" className="px-md py-sm text-left font-semibold">Distributor</th>
                  <th scope="col" className="px-md py-sm text-right font-semibold">Unit cost</th>
                  <th scope="col" className="px-md py-sm text-right font-semibold">Market</th>
                  <th scope="col" className="px-md py-sm text-right font-semibold">Variance</th>
                </tr>
              </thead>
              <tbody>
                {singleSource.map((comp) => {
                  const latest = pickMostRecent(comp.prices);
                  const latestDate = formatInvoiceDate(latest?.invoiceDate ?? null);
                  return (
                    <tr key={comp.wine.id} className="border-t border-dashed border-border">
                      <td className="px-md py-sm">
                        <Link
                          href={`/cellar?wine=${comp.wine.id}`}
                          aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                          className="group inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                        >
                          <span className="font-medium text-ink group-hover:text-accent">
                            {comp.wine.producer}
                          </span>
                          <span className="text-ink-muted group-hover:text-accent">
                            {" "}
                            {comp.wine.name}
                            {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                          </span>
                        </Link>
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
                          comp.variancePct > 0.05 ? (
                            <span className="inline-flex items-center gap-xs rounded-pill bg-warning-soft px-sm py-xs text-[11px] font-semibold text-warning">
                              +{formatPct(comp.variancePct)}
                            </span>
                          ) : comp.variancePct < -0.05 ? (
                            <span className="inline-flex items-center gap-xs rounded-pill bg-success-soft px-sm py-xs text-[11px] font-semibold text-success">
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
            {singleSource.map((comp) => {
              const latest = pickMostRecent(comp.prices);
              const latestDate = formatInvoiceDate(latest?.invoiceDate ?? null);
              return (
                <div
                  key={comp.wine.id}
                  className="rounded-md border border-border bg-surface p-md"
                >
                  <div className="flex items-start justify-between gap-sm">
                    <Link
                      href={`/cellar?wine=${comp.wine.id}`}
                      aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                      className="group min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                    >
                      <div className="font-serif text-[16px] font-medium text-ink group-hover:text-accent">
                        {comp.wine.name}
                        {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                      </div>
                      <div className="text-[13px] text-ink-muted group-hover:text-accent">
                        {comp.wine.producer}
                      </div>
                    </Link>
                    <span className="shrink-0 font-mono text-[14px] font-medium text-ink">
                      {latest ? formatPrice(latest.unitCost) : "—"}
                    </span>
                  </div>
                  {/* BND-138: Market comparison for single-source mobile */}
                  {comp.marketPrice != null && (
                    <div className="mt-sm flex items-center justify-between border-t border-dashed border-border pt-sm">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                        Market
                      </span>
                      <div className="flex items-center gap-sm">
                        <span className="font-mono text-[13px] text-ink-subtle tabular-nums">
                          {formatPrice(comp.marketPrice)}
                        </span>
                        {comp.variancePct != null && Math.abs(comp.variancePct) > 0.05 && (
                          <span
                            className={`rounded-pill px-sm py-2xs text-[11px] font-semibold ${
                              comp.variancePct > 0
                                ? "bg-warning-soft text-warning"
                                : "bg-success-soft text-success"
                            }`}
                          >
                            {comp.variancePct > 0 ? "+" : ""}
                            {formatPct(comp.variancePct)}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="mt-sm flex items-baseline justify-between border-t border-dashed border-border pt-sm text-[13px] text-ink-muted">
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
    </section>
  );
}
