"use client";

import * as Sentry from "@sentry/nextjs";
import { AlertTriangle, ArrowLeft, ChevronDown, Download, ExternalLink, FileText, Package } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { accuracyColor } from "@/lib/scanner/accuracy-color";
import { csvFilename, downloadCsv, toCsv } from "@/lib/scanner/csv";
import { LOW_CONFIDENCE_ITEM_THRESHOLD } from "@/lib/scanner/scoring";
import type { LineItem } from "@/lib/scanner/types";
import { cn } from "@/lib/utils";

type InventoryItemRow = {
  id: string;
  wine_id: string;
  quantity: number;
  unit_cost: number | null;
  added_at: string;
  wine_name: string;
  wine_producer: string;
  wine_vintage: number | null;
};

interface ScanDetailViewProps {
  id: string;
  distributor: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  accuracy: number | null;
  itemCount: number;
  createdAt: string;
  items: LineItem[];
  hasImage: boolean;
  ocrText: Record<string, unknown> | null;
  inventoryItems: InventoryItemRow[];
}

function formatMoney(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ScanDetailView({
  id,
  distributor,
  invoiceNumber,
  invoiceDate,
  accuracy,
  itemCount,
  createdAt,
  items,
  hasImage,
  ocrText,
  inventoryItems,
}: ScanDetailViewProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(hasImage);
  const [ocrOpen, setOcrOpen] = useState(false);

  useEffect(() => {
    if (!hasImage) return;
    fetch(`/api/scans/${id}/image`)
      .then((r) => r.json())
      .then((data: { url?: string }) => {
        if (data.url) setImageUrl(data.url);
      })
      .catch((err) => {
        console.error("Failed to load invoice image:", err);
        Sentry.captureException(err, {
          tags: { surface: "scanner", phase: "image-load" },
          extra: { scan_id: id },
        });
      })
      .finally(() => setImageLoading(false));
  }, [id, hasImage]);

  const total = items.reduce((s, it) => s + it.qty * it.unitCost, 0);
  const flaggedCount = items.filter(
    (it) => it.confidence < LOW_CONFIDENCE_ITEM_THRESHOLD,
  ).length;

  const handleExportCsv = useCallback(() => {
    if (items.length === 0) return;
    downloadCsv(
      csvFilename({
        distributor,
        invoiceNo: invoiceNumber ?? "",
        invoiceDate: invoiceDate ?? createdAt.slice(0, 10),
        parsedAt: createdAt,
      }),
      toCsv(items),
    );
  }, [items, distributor, invoiceNumber, invoiceDate, createdAt]);

  const hasOcr = ocrText && Object.keys(ocrText).length > 0;

  return (
    <section>
      <header className="mb-lg">
        <Link
          href="/scans"
          className="mb-md inline-flex items-center gap-xs text-[13px] text-grey hover:text-ink focus-ring"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
          Back to scan history
        </Link>
        <div className="flex items-center justify-between gap-md">
          <h1 className="font-serif text-heading-sm text-ink md:text-heading">
            Scan details
          </h1>
          {items.length > 0 && (
            <button
              type="button"
              onClick={handleExportCsv}
              className="flex h-10 items-center justify-center gap-sm rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-ring md:h-[38px]"
              title="Download line items as CSV"
            >
              <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              <span className="hidden sm:inline">Export CSV</span>
              <span className="sm:hidden">CSV</span>
            </button>
          )}
        </div>
      </header>

      <div className="grid gap-md md:grid-cols-2">
        {/* Metadata card */}
        <div className="rounded-card card-surface p-md md:col-span-2">
          <div className="grid grid-cols-2 gap-sm md:grid-cols-4 md:gap-md">
            <div>
              <div className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Distributor
              </div>
              <div className="mt-xs text-[14px] font-medium text-ink">{distributor}</div>
            </div>
            <div>
              <div className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Invoice #
              </div>
              <div className="mt-xs font-mono text-[14px] text-ink">
                {invoiceNumber ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Date
              </div>
              <div className="mt-xs font-mono text-[14px] text-ink">
                {invoiceDate ?? createdAt.slice(0, 10)}
              </div>
            </div>
            <div>
              <div className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Accuracy
              </div>
              <div
                className={`mt-xs font-mono text-[14px] ${
                  accuracy != null ? accuracyColor(accuracy) : "text-ink"
                }`}
              >
                {accuracy != null ? `${accuracy}%` : "—"}
              </div>
            </div>
          </div>
          <div className="mt-md flex flex-wrap items-center gap-md border-t border-dashed border-hairline pt-md text-[13px] text-grey">
            <span>{itemCount} wines</span>
            <span aria-hidden className="text-grey">·</span>
            <span className="font-mono">${formatMoney(total)}</span>
            {flaggedCount > 0 && (
              <>
                <span aria-hidden className="text-grey">·</span>
                <span className="inline-flex items-center gap-xs rounded-pill bg-blush-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-accent">
                  <AlertTriangle
                    className="h-3 w-3"
                    strokeWidth={2.5}
                    aria-hidden="true"
                  />
                  {flaggedCount} to review
                </span>
              </>
            )}
          </div>
        </div>

        {/* OCR Text (if available) */}
        {hasOcr && (
          <div className="rounded-card card-surface md:col-span-2">
            <button
              type="button"
              onClick={() => setOcrOpen(!ocrOpen)}
              className="flex w-full items-center justify-between p-md text-left focus-ring"
            >
              <span className="flex items-center gap-sm text-[13px] font-medium text-ink">
                <FileText className="h-4 w-4 text-grey" strokeWidth={1.75} />
                OCR text
              </span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-grey transition-transform",
                  ocrOpen && "rotate-180",
                )}
                strokeWidth={2}
              />
            </button>
            {ocrOpen && (
              <div className="border-t border-hairline px-md pb-md pt-sm">
                <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-grey">
                  {JSON.stringify(ocrText, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Invoice image */}
        {hasImage && (
          <div className="rounded-card card-surface p-md md:sticky md:top-[72px] md:self-start">
            <div className="mb-sm text-caption font-medium uppercase tracking-[0.18em] text-grey">
              Original invoice
            </div>
            {imageLoading ? (
              <div className="flex h-[200px] items-center justify-center rounded-lg bg-bridge-surface">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              </div>
            ) : imageUrl ? (
              <>
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open full-resolution invoice from ${distributor} in a new tab`}
                  className="block rounded-lg focus-ring"
                >
                  <Image
                    src={imageUrl}
                    alt={`Invoice from ${distributor}`}
                    width={0}
                    height={0}
                    unoptimized
                    className="max-h-[60vh] w-full cursor-zoom-in rounded-lg object-contain md:max-h-[70vh]"
                    style={{ width: "100%", height: "auto", touchAction: "pinch-zoom" }}
                  />
                </a>
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-sm inline-flex items-center gap-xs text-[12px] text-grey hover:text-accent focus-ring"
                >
                  <ExternalLink className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                  Open full size
                </a>
              </>
            ) : (
              <div className="flex h-[200px] items-center justify-center rounded-lg bg-bridge-surface text-[13px] text-grey">
                Image unavailable
              </div>
            )}
          </div>
        )}

        {/* Line items */}
        <div className={hasImage ? "" : "md:col-span-2"}>
          <div className="mb-md text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Line items
          </div>

          {/* Desktop table */}
          <div className="hidden md:block">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-bridge-surface text-caption font-medium uppercase tracking-[0.18em] text-grey">
                  <th scope="col" className="px-sm py-sm text-left font-medium">Wine</th>
                  <th scope="col" className="px-sm py-sm text-left font-medium">Producer</th>
                  <th scope="col" className="px-sm py-sm text-right font-medium">Vintage</th>
                  <th scope="col" className="px-sm py-sm text-left font-medium">Varietal</th>
                  <th scope="col" className="px-sm py-sm text-right font-medium">Qty</th>
                  <th scope="col" className="px-sm py-sm text-right font-medium">Unit cost</th>
                  <th scope="col" className="px-sm py-sm text-right font-medium">Conf.</th>
                  <th scope="col" className="px-sm py-sm text-right font-medium">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const lowConf = it.confidence < LOW_CONFIDENCE_ITEM_THRESHOLD;
                  return (
                  <tr
                    key={it.id}
                    className={`${i > 0 ? "border-t border-hairline" : ""} ${
                      lowConf ? "bg-blush-wash/40" : ""
                    }`}
                  >
                    <td className="px-sm py-sm font-serif text-[17px] font-medium text-ink">
                      <span className="inline-flex items-center gap-xs">
                        {lowConf && (
                          <AlertTriangle
                            className="h-3.5 w-3.5 shrink-0 text-accent"
                            strokeWidth={2.5}
                            aria-label={`Low confidence (${Math.round(it.confidence * 100)}%) — review`}
                          />
                        )}
                        {it.name}
                      </span>
                    </td>
                    <td className="px-sm py-sm text-ink">{it.producer}</td>
                    <td className="px-sm py-sm text-right font-mono text-ink">
                      {it.vintage ?? "NV"}
                    </td>
                    <td className="px-sm py-sm text-ink">{it.varietal}</td>
                    <td className="px-sm py-sm text-right font-mono text-ink">{it.qty}</td>
                    <td className="px-sm py-sm text-right font-mono text-ink">
                      ${formatMoney(it.unitCost)}
                    </td>
                    <td className={`px-sm py-sm text-right font-mono ${accuracyColor(it.confidence * 100)}`}>
                      {Math.round(it.confidence * 100)}%
                    </td>
                    <td className="px-sm py-sm text-right font-mono font-medium text-ink">
                      ${formatMoney(it.qty * it.unitCost)}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              {items.length > 0 && (
                <tfoot>
                  <tr className="border-t border-hairline">
                    <td
                      colSpan={7}
                      className="px-sm py-sm text-right text-caption font-medium uppercase tracking-[0.18em] text-grey"
                    >
                      Total
                    </td>
                    <td className="px-sm py-sm text-right font-mono font-semibold text-ink">
                      ${formatMoney(total)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-sm md:hidden">
            {items.map((it) => {
              const lowConf = it.confidence < LOW_CONFIDENCE_ITEM_THRESHOLD;
              return (
              <div
                key={it.id}
                className={`rounded-card shadow-card border p-md ${
                  lowConf
                    ? "border-accent/30 bg-blush-wash/40"
                    : "border-hairline bg-surface"
                }`}
              >
                <div className="flex items-start gap-xs">
                  {lowConf && (
                    <AlertTriangle
                      className="mt-2xs h-4 w-4 shrink-0 text-accent"
                      strokeWidth={2.5}
                      aria-label={`Low confidence (${Math.round(it.confidence * 100)}%) — review`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-serif text-[17px] font-medium text-ink">{it.name}</div>
                    <div className="mt-2xs text-[13px] text-grey">{it.producer}</div>
                  </div>
                </div>
                <div className="mt-sm flex flex-wrap items-center gap-x-md gap-y-xs text-[12px] text-grey">
                  <span className="font-mono">{it.vintage ?? "NV"}</span>
                  <span>{it.varietal}</span>
                  <span>{it.region}</span>
                </div>
                <div className="mt-sm flex items-center justify-between border-t border-dashed border-hairline pt-sm">
                  <span className="font-mono text-[13px] text-ink">
                    {it.qty} × ${formatMoney(it.unitCost)}
                  </span>
                  <span className={`font-mono text-[12px] ${accuracyColor(it.confidence * 100)}`}>
                    {Math.round(it.confidence * 100)}% conf.
                  </span>
                  <span className="font-mono text-[13px] font-medium text-ink">
                    ${formatMoney(it.qty * it.unitCost)}
                  </span>
                </div>
              </div>
              );
            })}
            {items.length > 0 && (
              <div className="mt-xs flex items-center justify-between border-t border-hairline px-md pt-md">
                <span className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
                  Total
                </span>
                <span className="font-mono text-[14px] font-semibold text-ink">
                  ${formatMoney(total)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Resulting inventory items */}
        {inventoryItems.length > 0 && (
          <div className={hasImage ? "" : "md:col-span-2"}>
            <div className="mb-md text-caption font-medium uppercase tracking-[0.18em] text-grey">
              Inventory created
            </div>

            {/* Desktop table */}
            <div className="hidden md:block">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="bg-bridge-surface text-caption font-medium uppercase tracking-[0.18em] text-grey">
                    <th scope="col" className="px-sm py-sm text-left font-medium">Wine</th>
                    <th scope="col" className="px-sm py-sm text-left font-medium">Producer</th>
                    <th scope="col" className="px-sm py-sm text-right font-medium">Vintage</th>
                    <th scope="col" className="px-sm py-sm text-right font-medium">Qty</th>
                    <th scope="col" className="px-sm py-sm text-right font-medium">Unit cost</th>
                    <th scope="col" className="px-sm py-sm text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {inventoryItems.map((ii, i) => (
                    <tr
                      key={ii.id}
                      className={i > 0 ? "border-t border-hairline" : ""}
                    >
                      <td className="px-sm py-sm font-serif text-[17px] font-medium text-ink">
                        <Link
                          href={`/cellar?wine=${ii.wine_id}`}
                          className="text-ink hover:text-accent focus-ring"
                        >
                          {ii.wine_name}
                        </Link>
                      </td>
                      <td className="px-sm py-sm text-ink">{ii.wine_producer}</td>
                      <td className="px-sm py-sm text-right font-mono text-ink">
                        {ii.wine_vintage ?? "NV"}
                      </td>
                      <td className="px-sm py-sm text-right font-mono tabular text-ink">
                        {ii.quantity}
                      </td>
                      <td className="px-sm py-sm text-right font-mono text-ink">
                        {ii.unit_cost != null ? `$${formatMoney(ii.unit_cost)}` : "—"}
                      </td>
                      <td className="px-sm py-sm text-right font-mono font-medium text-ink">
                        {ii.unit_cost != null
                          ? `$${formatMoney(ii.quantity * ii.unit_cost)}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="flex flex-col gap-sm md:hidden">
              {inventoryItems.map((ii) => (
                <Link
                  key={ii.id}
                  href={`/cellar?wine=${ii.wine_id}`}
                  className="rounded-card card-surface p-md hover:bg-bridge-surface focus-ring"
                >
                  <div className="flex items-start gap-md">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-bridge-surface">
                      <Package className="h-5 w-5 text-grey" strokeWidth={1.5} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[17px] font-medium text-ink">{ii.wine_name}</div>
                      <div className="mt-2xs text-[13px] text-grey">{ii.wine_producer}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-[14px] tabular text-ink">
                        {ii.wine_vintage ?? "NV"}
                      </div>
                    </div>
                  </div>
                  <div className="mt-sm flex items-center justify-between border-t border-dashed border-hairline pt-sm">
                    <span className="font-mono text-[13px] tabular text-ink">
                      {ii.quantity} ×{" "}
                      {ii.unit_cost != null ? `$${formatMoney(ii.unit_cost)}` : "—"}
                    </span>
                    <span className="font-mono text-[13px] font-medium text-ink">
                      {ii.unit_cost != null
                        ? `$${formatMoney(ii.quantity * ii.unit_cost)}`
                        : "—"}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
