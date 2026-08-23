"use client";

import { Download } from "lucide-react";
import { useCallback } from "react";
import { downloadCsv } from "@/lib/scanner/csv";

/**
 * One flattened row per (wine, distributor) — the buyer-friendly shape
 * for opening in Sheets/Excel. Aggregate fields (spread, savings, source
 * count) are repeated on each row of the same wine so the spreadsheet
 * stays sortable without reference cells.
 */
export type PriceComparisonCsvRow = {
  producer: string;
  wineName: string;
  vintage: number | null;
  distributor: string;
  unitCost: number;
  quantity: number;
  invoiceDate: string | null;
  distributorCount: number;
  spreadPct: number;
  potentialSavings: number;
  isCheapest: boolean;
};

const HEADERS = [
  "Producer",
  "Wine",
  "Vintage",
  "Distributor",
  "Unit cost (USD)",
  "Quantity",
  "Invoice date",
  "Distributor count",
  "Spread %",
  "Potential savings (USD)",
  "Cheapest",
] as const;

function escape(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: PriceComparisonCsvRow[]): string {
  const lines = rows.map((r) =>
    [
      r.producer,
      r.wineName,
      r.vintage ?? "NV",
      r.distributor,
      r.unitCost.toFixed(2),
      r.quantity,
      r.invoiceDate ?? "",
      r.distributorCount,
      r.spreadPct.toFixed(0),
      r.potentialSavings.toFixed(2),
      r.isCheapest ? "yes" : "no",
    ]
      .map(escape)
      .join(","),
  );
  return [HEADERS.join(","), ...lines].join("\n");
}

export function ExportCsvButton({ rows }: { rows: PriceComparisonCsvRow[] }) {
  const handleClick = useCallback(() => {
    if (rows.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(`terroir-price-comparison-${date}.csv`, toCsv(rows));
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex min-h-11 items-center justify-center gap-sm rounded-pill border border-hairline bg-white px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
      title="Download price comparison as CSV"
    >
      <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      <span className="hidden sm:inline">Export CSV</span>
      <span className="sm:hidden">CSV</span>
    </button>
  );
}
