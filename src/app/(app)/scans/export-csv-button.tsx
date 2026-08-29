"use client";

import { Download } from "lucide-react";
import { useCallback } from "react";
import { downloadCsv } from "@/lib/scanner/csv";

export type ScanHistoryCsvRow = {
  invoice_date: string | null;
  created_at: string;
  distributor_name: string;
  invoice_number: string | null;
  item_count: number;
  status: string;
  accuracy_score: number | null;
};

const HEADERS = [
  "Invoice date",
  "Scanned at",
  "Supplier",
  "Invoice number",
  "Items",
  "Status",
  "Accuracy percent",
] as const;

function escapeField(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: ScanHistoryCsvRow[]): string {
  const lines = rows.map((r) =>
    [
      r.invoice_date ?? "",
      r.created_at,
      r.distributor_name,
      r.invoice_number ?? "",
      r.item_count,
      r.status,
      r.accuracy_score != null ? Math.round(r.accuracy_score * 100) : "",
    ]
      .map(escapeField)
      .join(","),
  );
  return [HEADERS.join(","), ...lines].join("\n");
}

export function ExportCsvButton({ rows }: { rows: ScanHistoryCsvRow[] }) {
  const handleClick = useCallback(() => {
    if (rows.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(`terroir-scan-history-${date}.csv`, toCsv(rows));
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex min-h-11 items-center justify-center gap-xs rounded-pill border border-edge bg-surface px-md text-[12px] font-medium text-ink hover:bg-bridge-surface focus-ring"
      title="Download this page of scan history as CSV"
    >
      <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      <span className="hidden sm:inline">Export CSV</span>
      <span className="sm:hidden">CSV</span>
    </button>
  );
}
