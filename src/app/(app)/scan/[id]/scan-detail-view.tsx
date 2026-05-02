"use client";

import * as Sentry from "@sentry/nextjs";
import { ArrowLeft, Download, ExternalLink } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { accuracyColor } from "@/lib/scanner/accuracy-color";
import { csvFilename, downloadCsv, toCsv } from "@/lib/scanner/csv";
import type { LineItem } from "@/lib/scanner/types";

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
}: ScanDetailViewProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(hasImage);

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

  return (
    <section>
      <header className="mb-lg">
        <Link
          href="/scan"
          className="mb-md inline-flex items-center gap-xs text-[13px] text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
          Back to scanner
        </Link>
        <div className="flex items-center justify-between gap-md">
          <h1 className="font-serif text-[22px] text-ink md:text-[28px]">
            Scan details
          </h1>
          {items.length > 0 && (
            <button
              type="button"
              onClick={handleExportCsv}
              className="flex h-10 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px]"
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
        <div className="rounded-md border border-border bg-surface p-md md:col-span-2">
          <div className="grid grid-cols-2 gap-sm md:grid-cols-4 md:gap-md">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Distributor
              </div>
              <div className="mt-xs text-[14px] font-medium text-ink">{distributor}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Invoice #
              </div>
              <div className="mt-xs font-mono text-[14px] text-ink">
                {invoiceNumber ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Date
              </div>
              <div className="mt-xs font-mono text-[14px] text-ink">
                {invoiceDate ?? createdAt.slice(0, 10)}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
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
          <div className="mt-md flex items-center gap-md border-t border-dashed border-border pt-md text-[13px] text-ink-muted">
            <span>{itemCount} wines</span>
            <span aria-hidden className="text-ink-subtle">·</span>
            <span className="font-mono">${formatMoney(total)}</span>
          </div>
        </div>

        {/* Invoice image */}
        {hasImage && (
          <div className="rounded-md border border-border bg-surface p-md md:sticky md:top-[72px] md:self-start">
            <div className="mb-sm text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              Original invoice
            </div>
            {imageLoading ? (
              <div className="flex h-[200px] items-center justify-center rounded bg-surface-muted">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              </div>
            ) : imageUrl ? (
              <>
                {/* The visible <Image> is capped at 60-70vh so it fits next to
                    the line-items table, but buyers verifying scan accuracy
                    often need to zoom into specific rows on the original.
                    Wrapping the image in a same-tab-friendly anchor opens it
                    at native resolution; the inline "Open full size" affordance
                    below keeps the action keyboard-accessible. */}
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open full-resolution invoice from ${distributor} in a new tab`}
                  className="block rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                >
                  <Image
                    src={imageUrl}
                    alt={`Invoice from ${distributor}`}
                    width={0}
                    height={0}
                    unoptimized
                    className="max-h-[60vh] w-full cursor-zoom-in rounded object-contain md:max-h-[70vh]"
                    style={{ width: "100%", height: "auto", touchAction: "pinch-zoom" }}
                  />
                </a>
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-sm inline-flex items-center gap-xs text-[12px] text-ink-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                >
                  <ExternalLink className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                  Open full size
                </a>
              </>
            ) : (
              <div className="flex h-[200px] items-center justify-center rounded bg-surface-muted text-[13px] text-ink-muted">
                Image unavailable
              </div>
            )}
          </div>
        )}

        {/* Line items */}
        <div className={hasImage ? "" : "md:col-span-2"}>
          <div className="mb-md text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Line items
          </div>

          {/* Desktop table */}
          <div className="hidden md:block">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  <th scope="col" className="pb-sm text-left font-semibold">Wine</th>
                  <th scope="col" className="pb-sm text-left font-semibold">Producer</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Vintage</th>
                  <th scope="col" className="pb-sm text-left font-semibold">Varietal</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Qty</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Unit cost</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr
                    key={it.id}
                    className={i > 0 ? "border-t border-dashed border-border" : ""}
                  >
                    <td className="py-sm font-medium text-ink">{it.name}</td>
                    <td className="py-sm text-ink">{it.producer}</td>
                    <td className="py-sm text-right font-mono text-ink">
                      {it.vintage ?? "NV"}
                    </td>
                    <td className="py-sm text-ink">{it.varietal}</td>
                    <td className="py-sm text-right font-mono text-ink">{it.qty}</td>
                    <td className="py-sm text-right font-mono text-ink">
                      ${formatMoney(it.unitCost)}
                    </td>
                    <td className="py-sm text-right font-mono font-medium text-ink">
                      ${formatMoney(it.qty * it.unitCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {items.length > 0 && (
                <tfoot>
                  <tr className="border-t border-border">
                    <td
                      colSpan={6}
                      className="py-sm pr-sm text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle"
                    >
                      Total
                    </td>
                    <td className="py-sm text-right font-mono font-semibold text-ink">
                      ${formatMoney(total)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-sm md:hidden">
            {items.map((it) => (
              <div
                key={it.id}
                className="rounded-md border border-border bg-white p-md"
              >
                <div className="text-[14px] font-medium text-ink">{it.name}</div>
                <div className="mt-2xs text-[13px] text-ink-muted">{it.producer}</div>
                <div className="mt-sm flex flex-wrap items-center gap-x-md gap-y-xs text-[12px] text-ink-muted">
                  <span className="font-mono">{it.vintage ?? "NV"}</span>
                  <span>{it.varietal}</span>
                  <span>{it.region}</span>
                </div>
                <div className="mt-sm flex items-center justify-between border-t border-dashed border-border pt-sm">
                  <span className="font-mono text-[13px] text-ink">
                    {it.qty} × ${formatMoney(it.unitCost)}
                  </span>
                  <span className="font-mono text-[13px] font-medium text-ink">
                    ${formatMoney(it.qty * it.unitCost)}
                  </span>
                </div>
              </div>
            ))}
            {items.length > 0 && (
              <div className="mt-xs flex items-center justify-between border-t border-border px-md pt-md">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Total
                </span>
                <span className="font-mono text-[14px] font-semibold text-ink">
                  ${formatMoney(total)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
