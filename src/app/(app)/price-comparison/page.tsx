import { createClient } from "@/lib/supabase/server";
import { ArrowDown, ArrowUp, DollarSign, ScanLine } from "lucide-react";
import Link from "next/link";

function formatPrice(n: number) {
  return "$" + n.toFixed(2);
}

type PriceEntry = {
  distributor: string;
  unitCost: number;
  quantity: number;
  invoiceDate: string | null;
};

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
};

export default async function PriceComparisonPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: membership } = await supabase
    .from("memberships")
    .select("restaurant_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) return null;

  const rid = membership.restaurant_id;

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
  const comparisons: WineComparison[] = [...wineMap.values()]
    .map((entry) => {
      const sorted = entry.prices.sort((a, b) => a.unitCost - b.unitCost);
      const cheapest = sorted[0]?.unitCost ?? 0;
      const mostExpensive = sorted[sorted.length - 1]?.unitCost ?? 0;
      const spread = cheapest > 0 ? (mostExpensive - cheapest) / cheapest : 0;
      const distributorCount = new Set(sorted.map((p) => p.distributor)).size;

      return { ...entry, cheapest, mostExpensive, spread, distributorCount };
    })
    .sort((a, b) => {
      const cmp = a.wine.producer.localeCompare(b.wine.producer);
      return cmp !== 0 ? cmp : a.wine.name.localeCompare(b.wine.name);
    });

  // Only wines with 2+ distributors are interesting for comparison
  const comparable = comparisons.filter((c) => c.distributorCount >= 2);
  const singleSource = comparisons.filter((c) => c.distributorCount < 2);

  // Total savings opportunity
  const totalSavings = comparable.reduce((sum, c) => {
    const totalQty = c.prices.reduce((s, p) => s + p.quantity, 0);
    return sum + (c.mostExpensive - c.cheapest) * totalQty;
  }, 0);

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
            href="/scanner"
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
        <h1 className="font-serif text-[28px] text-ink">
          Distributor Pricing
        </h1>
        <p className="mt-xs text-[15px] text-ink-muted">
          Compare prices across suppliers
        </p>
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
                  <th className="pb-sm text-left font-semibold">Wine</th>
                  <th className="pb-sm text-left font-semibold">Distributor</th>
                  <th className="pb-sm text-right font-semibold">Unit cost</th>
                  <th className="pb-sm text-right font-semibold">Qty</th>
                  <th className="pb-sm text-right font-semibold">Spread</th>
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
                          <div className="font-medium text-ink">
                            {comp.wine.producer}
                          </div>
                          <div className="text-ink-muted">
                            {comp.wine.name}
                            {comp.wine.vintage
                              ? ` ${comp.wine.vintage}`
                              : ""}
                          </div>
                        </td>
                      ) : null}
                      <td className="py-sm text-ink">{price.distributor}</td>
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
                    <div>
                      <div className="font-serif text-[16px] font-medium text-ink">
                        {comp.wine.name}
                        {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                      </div>
                      <div className="text-[13px] text-ink-muted">
                        {comp.wine.producer}
                      </div>
                    </div>
                    {comp.spread >= 0.1 && (
                      <span className="inline-flex items-center gap-xs rounded-pill bg-warning-soft px-sm py-xs text-[11px] font-semibold text-warning">
                        {Math.round(comp.spread * 100)}%
                      </span>
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
                        <span className="text-[13px] text-ink">
                          {price.distributor}
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
                  <th className="px-md py-sm text-left font-semibold">Wine</th>
                  <th className="px-md py-sm text-left font-semibold">
                    Distributor
                  </th>
                  <th className="px-md py-sm text-right font-semibold">
                    Unit cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {singleSource.map((comp) => {
                  const latest = comp.prices[comp.prices.length - 1];
                  return (
                    <tr
                      key={comp.wine.id}
                      className="border-t border-dashed border-border"
                    >
                      <td className="px-md py-sm">
                        <span className="font-medium text-ink">
                          {comp.wine.producer}
                        </span>
                        <span className="text-ink-muted">
                          {" "}
                          {comp.wine.name}
                          {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                        </span>
                      </td>
                      <td className="px-md py-sm text-ink-muted">
                        {latest?.distributor ?? "—"}
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
