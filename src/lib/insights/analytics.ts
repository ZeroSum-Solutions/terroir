export type ScanCorrectionInput = {
  item_count: number | null;
  edits: unknown;
};

export type LineItemCorrectionSummary = {
  total: number;
  autoAccepted: number;
  corrected: number;
  accuracyPct: number;
};

function correctedLineItemCount(scan: ScanCorrectionInput): number {
  const itemCount = Math.max(0, scan.item_count ?? 0);
  if (
    !scan.edits ||
    typeof scan.edits !== "object" ||
    Array.isArray(scan.edits)
  ) {
    return 0;
  }

  const correctedIds = new Set<string>();
  for (const [key, value] of Object.entries(scan.edits)) {
    const separator = key.lastIndexOf(":");
    if (value !== true || separator <= 0) continue;
    correctedIds.add(key.slice(0, separator));
  }

  return Math.min(itemCount, correctedIds.size);
}

export function summarizeLineItemCorrections(
  scans: ScanCorrectionInput[],
): LineItemCorrectionSummary {
  let total = 0;
  let corrected = 0;

  for (const scan of scans) {
    total += Math.max(0, scan.item_count ?? 0);
    corrected += correctedLineItemCount(scan);
  }

  const autoAccepted = Math.max(0, total - corrected);
  return {
    total,
    autoAccepted,
    corrected,
    accuracyPct: total > 0 ? Math.round((autoAccepted / total) * 100) : 0,
  };
}

export function marketPriceShiftPct(
  currentMarketPrice: number | null,
  previousMarketPrice: number | null,
): number | null {
  if (
    currentMarketPrice == null ||
    currentMarketPrice <= 0 ||
    previousMarketPrice == null ||
    previousMarketPrice <= 0
  ) {
    return null;
  }

  return (currentMarketPrice - previousMarketPrice) / previousMarketPrice;
}
