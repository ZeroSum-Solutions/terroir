import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { ArrowDown, ArrowUp, DollarSign, ScanLine } from "lucide-react";
import Link from "next/link";
import {
  ExportCsvButton,
  type PriceComparisonCsvRow,
} from "./export-csv-button";

export const metadata: Metadata = { title: "Price comparison" };

function formatPrice(n: number) {
  return "$" + n.toFixed(2);
}

/**
 * Short, scannable date for distributor price freshness. The buyer needs
 * "is this quote current?" at a glance, not full ISO precision. Same-year
 * dates collapse to "Apr 15" so the column stays narrow; older dates keep
 * the year ("Mar 3, 2025") so a stale quote is obvious. Returns null on
 * missing/invalid input so callers can omit the line entirely.
 */
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

/**
 * Pick the entry with the most recent invoice_date. When no entries
 * carry a date, fall back to the last entry in the array (preserves the
 * pre-existing behaviour for invoices imported before invoice_date was
 * captured). Returns undefined for an empty list.
 */
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
  // Potential dollar savings if every unit had been bought at the
  // cheapest distributor's price. Used to sort comparable wines so the
  // biggest savings opportunities surface first.
  potentialSavings: number;
};

export default async function PriceComparisonPage() {
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId: rid } = auth;

  // Fetch inventory items with wine + invoice scan details
  const { data: items } = await supabase
    .from("inventory_items")
    .select(
      "unit_cost, quantity, wine_id, wines(id, name, producer, vintage, varietal), invoice_scan_id, invoice_scans(distributor_name, invoice_date)",
    )
    .eq("restaurant_id", rid);

  // Group by wine, then compute comparison data
  const wineMap = new Map<string, WineComparison>();

  for (const item of items ?? []) {
    const wine = item.wines as WineComparison["wine"] | null;
    const scan = item.invoice_scans as {
      distributor_name: string;
      invoice_date: string | null;
    } | null;

    if (!wine || !scan) continue;

    let entry = wineMap.get(wine.id);
    if (!entry) {
      entry = {
        wine,
        prices: [],
        cheapest: 0,
        mostExpensive: 0,
        spread: 0,
        distributorCount: 0,
        potentialSavings: 0,
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

    return {
      ...entry,
      cheapest,
      mostExpensive,
      spread,
      distributorCount,
      potentialSavings,
    };
  });

  // Comparable wines (2+ distributors) sort by potential dollar
  // savings descending so the highest-impact rows surface first; spread
  // % is the tiebreak so two wines with identical savings stay in a
  // stable order. Single-source wines have no comparison signal, so
  // they keep alphabetical order for predictable scanning.
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

  // Flatten the same (wine, latest-per-distributor) shape the tables
  // render into spreadsheet-ready rows. Comparable wines come first so
  // the highest-impact buying decisions appear at the top of the CSV.
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
                </tr>
              </thead>
              <tbody>
                {comparable.map((comp) => {
                  // Deduplicate prices per distributor (show latest per distributor)
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
                        <td
                          className="py-sm align-top"
                          rowSpan={distPrices.length}
                        >
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
                              {comp.wine.vintage
                                ? ` ${comp.wine.vintage}`
                                : ""}
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
                        {price.unitCost === comp.cheapest &&
                          distPrices.length > 1 && (
                            <span className="ml-xs inline-flex items-center text-success">
                              <ArrowDown className="h-3 w-3" strokeWidth={2.5} />
                            </span>
                          )}
                        {price.unitCost === comp.mostExpensive &&
                          distPrices.length > 1 && (
                            <span className="ml-xs inline-flex items-center text-error">
                              <ArrowUp className="h-3 w-3" strokeWidth={2.5} />
                            </span>
                          )}
                      </td>
                      <td className="py-sm text-right font-mono text-ink-muted">
                        {price.quantity}
                      </td>
                      {i === 0 ? (
                        <td
                          className="py-sm text-right align-top"
                          rowSpan={distPrices.length}
                        >
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
                        <td
                          className="py-sm text-right align-top font-mono text-success"
                          rowSpan={distPrices.length}
                        >
                          {comp.potentialSavings > 0
                            ? formatPrice(comp.potentialSavings)
                            : (
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
                          {price.unitCost === comp.cheapest &&
                            distPrices.length > 1 && (
                              <ArrowDown
                                className="ml-xs inline h-3 w-3 text-success"
                                strokeWidth={2.5}
                              />
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
          <div className="rounded-md border border-border bg-surface">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  <th scope="col" className="px-md py-sm text-left font-semibold">Wine</th>
                  <th scope="col" className="px-md py-sm text-left font-semibold">
                    Distributor
                  </th>
                  <th scope="col" className="px-md py-sm text-right font-semibold">
                    Unit cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {singleSource.map((comp) => {
                  // `comp.prices` is sorted ascending by unitCost upstream,
                  // so picking the last element would surface the MOST
                  // EXPENSIVE quote — misleading when a distributor's
                  // price has changed across multiple invoices. Pick the
                  // entry with the most recent invoice_date instead, and
                  // fall back to the last array entry when no dates exist.
                  const latest = pickMostRecent(comp.prices);
                  const latestDate = formatInvoiceDate(
                    latest?.invoiceDate ?? null,
                  );
                  return (
                    <tr
                      key={comp.wine.id}
                      className="border-t border-dashed border-border"
                    >
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
