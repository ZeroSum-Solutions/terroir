"use client";

import * as Sentry from "@sentry/nextjs";
import { AlertTriangle, ArrowLeft, Download, ExternalLink, Loader2, Save, Trash2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { accuracyColor } from "@/lib/scanner/accuracy-color";
import { csvFilename, downloadCsv, toCsv } from "@/lib/scanner/csv";
import { SCORED_FIELDS } from "@/lib/scanner/scored-fields";
import type { LineItem, LineItemField } from "@/lib/scanner/types";
import { MoneyInput, QtyStepper, TextInput, VintageInput } from "./field-inputs";
import { LineItemCard } from "./line-item-card";

interface ScanReviewProps {
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

function formatMoneyLocal(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ScanReview({
  id,
  distributor,
  invoiceNumber,
  invoiceDate,
  accuracy,
  itemCount,
  createdAt,
  items: initialItems,
  hasImage,
}: ScanReviewProps) {
  const router = useRouter();
  const [items, setItems] = useState<LineItem[]>(initialItems);
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [commitOk, setCommitOk] = useState(false);
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

  useEffect(() => {
    if (!saveMsg) return;
    const tid = window.setTimeout(() => setSaveMsg(null), 2600);
    return () => window.clearTimeout(tid);
  }, [saveMsg]);
  const updateField = useCallback(
    (itemId: string, field: LineItemField, value: string | number | null) => {
      setItems((prev) =>
        prev.map((it) =>
          it.id === itemId ? ({ ...it, [field]: value } as LineItem) : it
        )
      );
      setEdits((prev) => ({ ...prev, [`${itemId}:${field}`]: true }));
    },
    []
  );

  const removeItem = useCallback((itemId: string) => {
    setItems((prev) => prev.filter((it) => it.id !== itemId));
  }, []);
  const handleSave = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/scans/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, edits }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Save failed");
      }
      setSaveMsg("Edits saved.");
      router.refresh();
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  }, [id, items, edits, isSaving, router]);
  const handleCommit = useCallback(async () => {
    if (isCommitting || items.length === 0) return;
    if (!window.confirm(`Commit ${items.length} wines to inventory? This will create inventory records.`)) return;
    setIsCommitting(true);
    try {
      const res = await fetch(`/api/scans/${id}/commit`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Commit failed");
      }
      const result = await res.json();
      setCommitOk(true);
      setSaveMsg(`${result.itemCount} items committed to inventory (${result.wineCount} distinct wines).`);
      router.refresh();
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setIsCommitting(false);
    }
  }, [id, items, isCommitting, router]);
  const { total, bottles, lowC, acc } = useMemo(() => {
    const totalFields = items.length * SCORED_FIELDS.length;
    const edited = Object.keys(edits).length;
    return {
      total: items.reduce((s, it) => s + it.qty * it.unitCost, 0),
      bottles: items.reduce((s, it) => s + it.qty, 0),
      lowC: items.reduce((n, it) => n + (it.lowFields?.length ?? 0), 0),
      acc: totalFields === 0 ? 100 : Math.max(0, Math.round(((totalFields - edited) / totalFields) * 100)),
    };
  }, [items, edits]);

  const isLow = (it: LineItem, field: LineItemField) =>
    (it.lowFields ?? []).includes(field) && !edits[`${it.id}:${field}`];

  const isEdited = (it: LineItem, field: LineItemField) =>
    edits[`${it.id}:${field}`] === true;

  const displayedAccuracy = accuracy ?? acc;

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
            Review scan
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
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Distributor</div>
              <div className="mt-xs text-[14px] font-medium text-ink">{distributor}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Invoice #</div>
              <div className="mt-xs font-mono text-[14px] text-ink">{invoiceNumber ?? "—"}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Date</div>
              <div className="mt-xs font-mono text-[14px] text-ink">{invoiceDate ?? createdAt.slice(0, 10)}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Accuracy</div>
              <div className={`mt-xs font-mono text-[14px] ${displayedAccuracy != null ? accuracyColor(displayedAccuracy) : "text-ink"}`}>
                {displayedAccuracy != null ? `${displayedAccuracy}%` : "—"}
              </div>
            </div>
          </div>
          <div className="mt-md flex flex-wrap items-center gap-md border-t border-dashed border-border pt-md text-[13px] text-ink-muted">
            <span>{itemCount} wines</span>
            <span aria-hidden className="text-ink-subtle">·</span>
            <span>{bottles} bottles</span>
            <span aria-hidden className="text-ink-subtle">·</span>
            <span className="font-mono">${formatMoneyLocal(total)}</span>
            {lowC > 0 && (
              <>
                <span aria-hidden className="text-ink-subtle">·</span>
                <span className="inline-flex items-center gap-xs rounded-pill bg-warning-soft px-sm py-xs text-[11px] font-semibold text-warning">
                  <AlertTriangle className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
                  {lowC} to review
                </span>
              </>
            )}
          </div>
        </div>
        {/* Invoice image */}
        {hasImage && (
          <div className="rounded-md border border-border bg-surface p-md md:sticky md:top-[72px] md:self-start">
            <div className="mb-sm text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Original invoice</div>
            {imageLoading ? (
              <div className="flex h-[200px] items-center justify-center rounded bg-surface-muted">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              </div>
            ) : imageUrl ? (
              <>
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
                    width={0} height={0}
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
              <div className="flex h-[200px] items-center justify-center rounded bg-surface-muted text-[13px] text-ink-muted">Image unavailable</div>
            )}
          </div>
        )}
        {/* Editable line items */}
        <div className={hasImage ? "" : "md:col-span-2"}>
          <div className="mb-md flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Line items</span>
            <span className="text-[12px] text-ink-muted">{Object.keys(edits).length} edits</span>
          </div>

          {/* Desktop editable table */}
          <div className="hidden md:block">
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full border-collapse text-[14px]">
                <thead>
                  <tr className="bg-surface-muted">
                    <th className="px-sm py-sm text-left text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle w-[32%]">Wine</th>
                    <th className="px-sm py-sm text-left text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle w-[14%]">Varietal</th>
                    <th className="px-sm py-sm text-left text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle w-[9%]">Vintage</th>
                    <th className="px-sm py-sm text-left text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle w-[14%]">Region</th>
                    <th className="px-sm py-sm text-center text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle w-[11%]">Qty</th>
                    <th className="px-sm py-sm text-right text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle w-[14%]">Unit cost</th>
                    <th className="px-sm py-sm text-center text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle w-[6%]" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} className="border-t border-border align-middle hover:bg-[#FBFAF6]">
                      <td className="p-sm">
                        <TextInput value={it.name} low={isLow(it, "name")} edited={isEdited(it, "name")} onCommit={(v) => updateField(it.id, "name", v)} className="font-medium" label="Wine name" />
                        <div className="mt-2xs">
                          <TextInput value={it.producer} low={isLow(it, "producer")} edited={isEdited(it, "producer")} onCommit={(v) => updateField(it.id, "producer", v)} className="text-[12px] text-ink-muted" label="Producer" />
                        </div>
                      </td>
                      <td className="p-sm"><TextInput value={it.varietal} low={isLow(it, "varietal")} edited={isEdited(it, "varietal")} onCommit={(v) => updateField(it.id, "varietal", v)} label="Varietal" /></td>
                      <td className="p-sm"><VintageInput value={it.vintage} low={isLow(it, "vintage")} edited={isEdited(it, "vintage")} onCommit={(v) => updateField(it.id, "vintage", v)} /></td>
                      <td className="p-sm"><TextInput value={it.region} low={isLow(it, "region")} edited={isEdited(it, "region")} onCommit={(v) => updateField(it.id, "region", v)} label="Region" /></td>
                      <td className="p-sm"><div className="flex justify-center"><QtyStepper value={it.qty} onChange={(v) => updateField(it.id, "qty", v)} /></div></td>
                      <td className="p-sm"><MoneyInput value={it.unitCost} low={isLow(it, "unitCost")} edited={isEdited(it, "unitCost")} onCommit={(v) => updateField(it.id, "unitCost", v)} /></td>
                      <td className="p-sm text-center">
                        <button type="button" aria-label={`Remove ${it.name}`} onClick={() => removeItem(it.id)} className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-danger">
                          <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {/* Mobile cards */}
          <div className="flex flex-col gap-sm md:hidden">
            {items.map((it) => (
              <LineItemCard
                key={it.id}
                item={it}
                isLow={isLow}
                isEdited={isEdited}
                onUpdate={updateField}
                onRemove={removeItem}
              />
            ))}
          </div>

          {/* Action bar */}
          <div className="sticky bottom-[64px] z-10 mt-md flex flex-col gap-sm rounded-md border border-border bg-white p-md shadow-sm md:static md:bottom-auto md:mt-lg md:flex-row md:items-center md:justify-between md:shadow-none" style={{ marginBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}>
            <div className="text-[13px] text-ink-muted md:text-[14px]">
              <span className="font-medium text-ink">{items.length} wines</span>
              <span className="mx-xs text-ink-subtle">·</span>
              <span>{Object.keys(edits).length} edits</span>
            </div>
            <div className="flex gap-sm">
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="flex h-11 flex-1 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 disabled:opacity-60 md:h-[38px] md:flex-none md:px-md"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" /> : <Save className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
                <span>{isSaving ? "Saving..." : "Save Edits"}</span>
              </button>
              <button
                type="button"
                onClick={handleCommit}
                disabled={isCommitting || commitOk}
                className="flex h-11 flex-1 items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 disabled:opacity-60 md:h-[38px] md:flex-none md:px-md"
              >
                {isCommitting ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" /> : null}
                <span>{isCommitting ? "Committing..." : commitOk ? "Committed ✓" : "Commit to Inventory"}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Toast */}
      {saveMsg && (
        <div role="alert" aria-live="assertive" className="fixed inset-x-md bottom-[88px] z-30 mx-auto max-w-[420px] rounded-md bg-surface-inverse px-md py-sm text-[14px] text-white shadow-lg md:bottom-lg">
          {saveMsg}
        </div>
      )}
    </section>
  );
}
