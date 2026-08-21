export type DistributorMetricScan = {
  distributor_name: string;
  final_line_items: unknown;
};

export type DistributorMetric = {
  name: string;
  scans: number;
  spend: number;
};

function isValidLineItem(
  value: unknown,
): value is { qty: number; unitCost: number } {
  if (typeof value !== "object" || value === null) return false;

  const { qty, unitCost } = value as Record<string, unknown>;
  return (
    typeof qty === "number" &&
    Number.isFinite(qty) &&
    qty >= 0 &&
    typeof unitCost === "number" &&
    Number.isFinite(unitCost) &&
    unitCost >= 0 &&
    Number.isFinite(qty * unitCost)
  );
}

export function summarizeDistributorMetrics(
  scans: DistributorMetricScan[],
): DistributorMetric[] {
  const metrics = new Map<string, DistributorMetric>();

  for (const scan of scans) {
    const metric = metrics.get(scan.distributor_name) ?? {
      name: scan.distributor_name,
      scans: 0,
      spend: 0,
    };
    metric.scans += 1;

    if (Array.isArray(scan.final_line_items)) {
      for (const item of scan.final_line_items) {
        if (isValidLineItem(item)) {
          metric.spend += item.qty * item.unitCost;
        }
      }
    }

    metrics.set(scan.distributor_name, metric);
  }

  return [...metrics.values()].sort(function (a, b) {
    return b.spend - a.spend || a.name.localeCompare(b.name);
  });
}

export function distributorSpendShare(spend: number, totalSpend: number): number {
  return totalSpend > 0 ? spend / totalSpend : 0;
}
