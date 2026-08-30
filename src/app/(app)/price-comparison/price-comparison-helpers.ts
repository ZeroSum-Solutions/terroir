// BND-138: distributor price comparison + market-price variance helpers.

export const VARIANCE_HIGHLIGHT_THRESHOLD =
  parseFloat(process.env.PRICE_VARIANCE_HIGHLIGHT_THRESHOLD ?? "0.10") || 0.10;

export function formatPrice(n: number) {
  return "$" + n.toFixed(2);
}

export function formatPct(n: number) {
  return (n * 100).toFixed(0) + "%";
}

export function formatInvoiceDate(iso: string | null): string | null {
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

export type PriceEntry = {
  distributor: string;
  unitCost: number;
  quantity: number;
  invoiceDate: string | null;
};

export function pickMostRecent(prices: PriceEntry[]): PriceEntry | undefined {
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

/**
 * One entry per distributor — the most recently dated price for that
 * distributor — sorted cheapest first. Used both for the CSV export and
 * for the per-distributor rows in the comparable-wines table/cards.
 */
export function latestPriceByDistributor(prices: PriceEntry[]): PriceEntry[] {
  const byDist = new Map<string, PriceEntry>();
  for (const p of prices) {
    const existing = byDist.get(p.distributor);
    if (
      !existing ||
      (p.invoiceDate &&
        (!existing.invoiceDate || p.invoiceDate > existing.invoiceDate))
    ) {
      byDist.set(p.distributor, p);
    }
  }
  return [...byDist.values()].sort((a, b) => a.unitCost - b.unitCost);
}

export type WineComparison = {
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
