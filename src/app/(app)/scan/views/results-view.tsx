"use client";

import {
  ChevronDown,
  Download,
  FileJson,
  FileText,
  Loader2,
  Save,
  ScanLine,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { SCORED_FIELDS_COUNT } from "@/lib/scanner/scored-fields";
import { cn } from "@/lib/utils";
import type { LineItem, LineItemField, Scan } from "@/lib/scanner/types";
import {
  formatMoney,
  MoneyInput,
  QtyStepper,
  TextInput,
  Th,
  VintageInput,
} from "../components/field-inputs";
import { LineItemCard } from "../components/line-item-card";

interface SummaryRowProps {
  items: number;
  bottles: number;
  total: number;
  lowCount: number;
}

function SummaryRow({ items, bottles, total, lowCount }: SummaryRowProps) {
  const stats: Array<{
    label: string;
    value: React.ReactNode;
    tone?: "warning" | "success";
  }> = [
    { label: "Line items", value: items },
    { label: "Bottles", value: bottles },
    { label: "Invoice total", value: <span className="tabular">${formatMoney(total)}</span> },
    {
      label: "Need review",
      value: (
        <>
          {lowCount}
          <span className="ml-xs text-[12px] font-normal text-ink-muted">fields</span>
        </>
      ),
      tone: lowCount > 0 ? "warning" : "success",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-sm md:grid-cols-4 md:gap-md">
      {stats.map((s) => (
        <div
          key={s.label}
          className="rounded-md border border-border bg-white p-md"
        >
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            {s.label}
          </div>
          <div
            className={cn(
              "mt-xs text-[20px] font-medium",
              s.tone === "warning" && "text-warning",
              s.tone === "success" && "text-success",
              !s.tone && "text-ink",
            )}
          >
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}

interface ResultsViewProps {
  scan: Scan;
  onUpdate: (id: string, field: LineItemField, value: string | number | null) => void;
  onUpdateSource: (field: "distributor" | "invoiceNo" | "invoiceDate", value: string) => void;
  onRemove: (id: string) => void;
  onScanAnother: () => void;
  onExportCsv: () => void;
  onExportAccuracy: () => void;
  onSaveToInventory: () => void;
  isSaving: boolean;
}

export function ResultsView({
  scan,
  onUpdate,
  onUpdateSource,
  onRemove,
  onScanAnother,
  onExportCsv,
  onExportAccuracy,
  onSaveToInventory,
  isSaving,
}: ResultsViewProps) {
  const { items, edits, source, rawText } = scan;
  const [rawTextOpen, setRawTextOpen] = useState(false);

  const { total, bottles, lowCount, accuracy } = useMemo(() => {
    const totalFields = items.length * SCORED_FIELDS_COUNT;
    const edited = Object.keys(edits).length;
    return {
      total: items.reduce((s, it) => s + it.qty * it.unitCost, 0),
      bottles: items.reduce((s, it) => s + it.qty, 0),
      lowCount: items.reduce(
        (n, it) => n + (it.lowFields?.length ?? 0),
        0,
      ),
      accuracy:
        totalFields === 0
          ? 100
          : Math.max(
              0,
              Math.round(((totalFields - edited) / totalFields) * 100),
            ),
    };
  }, [items, edits]);

  const isLow = (item: LineItem, field: LineItemField) =>
    (item.lowFields ?? []).includes(field) && !edits[`${item.id}:${field}`];

  const isEdited = (item: LineItem, field: LineItemField) =>
    edits[`${item.id}:${field}`] === true;

  return (
    <section className={rawText ? "md:flex md:gap-lg" : ""}>
      {/* Mobile: raw text accordion */}
      {rawText && (
        <div className="mb-md md:hidden">
          <button
            type="button"
            onClick={() => setRawTextOpen(!rawTextOpen)}
            className="flex w-full items-center justify-between rounded-md border border-border bg-white p-md text-[13px] font-medium text-ink focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2"
          >
            <span className="flex items-center gap-sm">
              <FileText className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
              Raw invoice text
            </span>
            <ChevronDown
              className={cn("h-4 w-4 text-ink-subtle transition-transform", rawTextOpen && "rotate-180")}
              strokeWidth={2}
            />
          </button>
          {rawTextOpen && (
            <div className="mt-xs rounded-md border border-border bg-surface-muted p-md">
              <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-muted">
                {rawText}
              </pre>
            </div>
          )}
        </div>
      )}

      <div className={rawText ? "md:min-w-0 md:flex-1" : ""}>
      <header className="mb-lg flex flex-col gap-sm md:mb-xl md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-serif text-[22px] text-ink md:text-[28px]">
            Invoice scan results
          </h1>
          <p className="mt-xs text-[14px] text-ink-muted md:text-[15px]">
            Review, correct, and export. Yellow fields need a second look.
          </p>
        </div>
        <div className="flex items-center gap-sm self-start md:self-auto">
          <div className="flex items-center gap-xs rounded-pill bg-success-soft px-sm py-xs text-[12px] font-medium text-success">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            <span>Parsed accuracy</span>
            <span className="tabular">{accuracy}%</span>
          </div>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Clear this scan and all edits?")) {
                onScanAnother();
              }
            }}
            className="flex h-8 items-center gap-xs rounded-sm border border-border-strong px-sm text-[12px] font-medium text-ink-muted hover:bg-surface-muted hover:text-danger focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Clear
          </button>
        </div>
      </header>

      <div className="mb-lg rounded-md border border-border bg-white p-md">
        <div className="flex flex-col gap-sm">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">Supplier</label>
            <div className="mt-xs relative flex w-full items-center rounded-sm border border-border bg-white px-sm py-xs transition-colors focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)]">
              <input
                value={source.distributor}
                onChange={(e) => onUpdateSource("distributor", e.target.value)}
                aria-label="Supplier name"
                className="w-full bg-transparent text-[14px] font-medium text-ink outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-sm">
            <div className="flex-1">
              <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">Invoice #</label>
              <div className="mt-xs relative flex w-full items-center rounded-sm border border-border bg-white px-sm py-xs transition-colors focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)]">
                <input
                  value={source.invoiceNo}
                  onChange={(e) => onUpdateSource("invoiceNo", e.target.value)}
                  aria-label="Invoice number"
                  className="w-full bg-transparent text-[14px] text-ink outline-none"
                />
              </div>
            </div>
            <div className="flex-1">
              <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">Delivery date</label>
              <div className="mt-xs relative flex w-full items-center rounded-sm border border-border bg-white px-sm py-xs transition-colors focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)]">
                <input
                  type="date"
                  value={source.invoiceDate}
                  onChange={(e) => onUpdateSource("invoiceDate", e.target.value)}
                  aria-label="Delivery date"
                  className="w-full bg-transparent text-[14px] text-ink outline-none"
                />
              </div>
            </div>
          </div>
        </div>
        <div className="mt-sm flex justify-between items-center">
          <span className="rounded-sm bg-surface-muted px-sm py-xs text-[11px] uppercase tracking-[0.06em] text-ink-subtle">
            {items.length} items
          </span>
        </div>
      </div>

      <SummaryRow
        items={items.length}
        bottles={bottles}
        total={total}
        lowCount={lowCount}
      />

      {/* Desktop table (md+) */}
      <div className="mt-lg hidden overflow-hidden rounded-md border border-border md:block">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="bg-surface-muted">
              <Th className="w-[32%]">Wine</Th>
              <Th className="w-[14%]">Varietal</Th>
              <Th className="w-[9%]">Vintage</Th>
              <Th className="w-[14%]">Region</Th>
              <Th className="w-[11%] text-center">Qty</Th>
              <Th className="w-[14%] text-right">Unit cost</Th>
              <Th className="w-[6%]" />
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr
                key={it.id}
                className="border-t border-border align-middle hover:bg-[#FBFAF6]"
              >
                <td className="p-sm">
                  <TextInput
                    value={it.name}
                    low={isLow(it, "name")}
                    edited={isEdited(it, "name")}
                    onCommit={(v) => onUpdate(it.id, "name", v)}
                    className="font-medium"
                    label="Wine name"
                  />
                  <div className="mt-2xs">
                    <TextInput
                      value={it.producer}
                      low={isLow(it, "producer")}
                      edited={isEdited(it, "producer")}
                      onCommit={(v) => onUpdate(it.id, "producer", v)}
                      className="text-[12px] text-ink-muted"
                      label="Producer"
                    />
                  </div>
                </td>
                <td className="p-sm">
                  <TextInput
                    value={it.varietal}
                    low={isLow(it, "varietal")}
                    edited={isEdited(it, "varietal")}
                    onCommit={(v) => onUpdate(it.id, "varietal", v)}
                    label="Varietal"
                  />
                </td>
                <td className="p-sm">
                  <VintageInput
                    value={it.vintage}
                    low={isLow(it, "vintage")}
                    edited={isEdited(it, "vintage")}
                    onCommit={(v) => onUpdate(it.id, "vintage", v)}
                  />
                </td>
                <td className="p-sm">
                  <TextInput
                    value={it.region}
                    low={isLow(it, "region")}
                    edited={isEdited(it, "region")}
                    onCommit={(v) => onUpdate(it.id, "region", v)}
                    label="Region"
                  />
                </td>
                <td className="p-sm">
                  <div className="flex justify-center">
                    <QtyStepper
                      value={it.qty}
                      onChange={(v) => onUpdate(it.id, "qty", v)}
                    />
                  </div>
                </td>
                <td className="p-sm">
                  <MoneyInput
                    value={it.unitCost}
                    low={isLow(it, "unitCost")}
                    edited={isEdited(it, "unitCost")}
                    onCommit={(v) => onUpdate(it.id, "unitCost", v)}
                  />
                </td>
                <td className="p-sm text-center">
                  <button
                    type="button"
                    aria-label={`Remove ${it.name}`}
                    onClick={() => onRemove(it.id)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards (< md) */}
      <div className="mt-md flex flex-col gap-sm md:hidden">
        {items.map((it) => (
          <LineItemCard
            key={it.id}
            item={it}
            isLow={isLow}
            isEdited={isEdited}
            onUpdate={onUpdate}
            onRemove={onRemove}
          />
        ))}
      </div>

      {/* Action bar */}
      <div
        className="sticky bottom-[64px] z-10 mt-md flex flex-col gap-sm rounded-md border border-border bg-white p-md shadow-sm md:static md:bottom-auto md:mt-lg md:flex-row md:items-center md:justify-between md:shadow-none"
        style={{ marginBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}
      >
        <div className="text-[13px] text-ink-muted md:text-[14px]">
          <span className="font-medium text-ink">{items.length} wines</span>
          <span className="mx-xs text-ink-subtle">·</span>
          <span>{Object.keys(edits).length} corrections</span>
        </div>
        <div className="grid grid-cols-2 gap-sm md:flex md:gap-md">
          <button
            type="button"
            onClick={onScanAnother}
            className="flex h-11 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px] md:px-md"
          >
            <ScanLine className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            <span className="hidden sm:inline">Scan another</span>
            <span className="sm:hidden">Scan</span>
          </button>
          <div className="flex gap-sm">
            <button
              type="button"
              onClick={onExportCsv}
              className="flex h-11 flex-1 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px] md:flex-none md:px-md"
              title="Export as CSV"
            >
              <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              <span className="hidden md:inline">CSV</span>
            </button>
            <button
              type="button"
              onClick={onExportAccuracy}
              className="flex h-11 flex-1 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px] md:flex-none md:px-md"
              title="Export accuracy JSON (source + items + per-field edits)"
            >
              <FileJson className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              <span className="hidden md:inline">JSON</span>
            </button>
          </div>
          <button
            type="button"
            onClick={onSaveToInventory}
            disabled={isSaving}
            className="col-span-2 flex h-11 items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 disabled:opacity-60 md:h-[38px] md:px-md"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Save className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            )}
            <span>{isSaving ? "Saving..." : "Save to Inventory"}</span>
          </button>
        </div>
      </div>
      </div>

      {/* Desktop: raw text sidebar */}
      {rawText && (
        <aside className="hidden shrink-0 md:block md:w-[320px]">
          <div className="sticky top-[72px] rounded-md border border-border bg-white">
            <div className="flex items-center gap-sm border-b border-border p-md">
              <FileText className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
              <span className="text-[13px] font-medium text-ink">
                Raw invoice text
              </span>
            </div>
            <div className="p-md">
              <pre className="max-h-[calc(100vh-200px)] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-muted">
                {rawText}
              </pre>
            </div>
          </div>
        </aside>
      )}
    </section>
  );
}
