/**
 * Generate a CSV string matching Toast's Bulk Import Template format.
 *
 * Columns: Name, Menu Group, Menu Subgroup, Price, POS Name, SKU, Item Type
 */

import { wineDisplayName } from "@/lib/wine-display-name";

type ToastRow = {
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  bottlePrice: number | null;
};

function escapeField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function generateToastCsv(rows: ToastRow[]): string {
  const headers = [
    "Name",
    "Menu Group",
    "Menu Subgroup",
    "Price",
    "POS Name",
    "SKU",
    "Item Type",
  ];

  const lines = [headers.join(",")];

  for (const row of rows) {
    // BUG-01 — the POS item name is a display name, so it must not repeat a
    // producer a CSV import already left embedded in `wines.name`. POS Name
    // below is deliberately untouched: it never carries the producer, so the
    // whole of `name` is the only identity it has.
    const displayName = [
      row.producer,
      wineDisplayName(row.producer, row.name),
      row.vintage,
    ]
      .filter(Boolean)
      .join(" ");

    const posName = [row.name, row.vintage].filter(Boolean).join(" ");
    const subgroup = row.varietal ?? "";
    const price = row.bottlePrice != null ? row.bottlePrice.toFixed(2) : "";

    lines.push(
      [
        escapeField(displayName),
        "Wine",
        escapeField(subgroup),
        price,
        escapeField(posName),
        "", // SKU — empty
        "Item",
      ].join(","),
    );
  }

  return lines.join("\n");
}
