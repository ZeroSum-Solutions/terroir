import type { LineItem, ScanSource } from "./types";

const HEADERS = [
  "Wine",
  "Producer",
  "Vintage",
  "Varietal",
  "Region",
  "Quantity",
  "Unit cost (USD)",
  "Line total (USD)",
  "Confidence",
] as const;

function escape(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(items: LineItem[]): string {
  const rows = items.map((it) =>
    [
      it.name,
      it.producer,
      it.vintage ?? "NV",
      it.varietal,
      it.region,
      it.qty,
      it.unitCost.toFixed(2),
      (it.qty * it.unitCost).toFixed(2),
      it.confidence.toFixed(2),
    ]
      .map(escape)
      .join(","),
  );
  return [HEADERS.join(","), ...rows].join("\n");
}

export function csvFilename(source: ScanSource): string {
  const date = source.parsedAt.slice(0, 10);
  const slug = source.distributor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `terroir-${date}-${slug}.csv`;
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
