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
import { ActionDialog } from "@/components/action-dialog";
import { Field } from "@/components/field";
import { IconButton } from "@/components/icon-button";
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
    { label: "Line items", value: <span className="tabular">{items}</span> },
    { label: "Bottles", value: <span className="tabular">{bottles}</span> },
    { label: "Invoice total", value: <span className="tabular">${formatMoney(total)}</span> },
    {
      label: "Need review",
      value: (
        <>
          <span className="tabular">{lowCount}</span>
          <span className="ml-xs text-[12px] font-normal text-grey">fields</span>
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
          className="rounded-lg border border-hairline bg-white p-md"
        >
          <div className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            {s.label}
          </div>
          <div
            className={cn(
              "mt-xs text-[20px] font-medium",
              s.tone === "warning" && "text-primary",
              s.tone === "success" && "text-sage-ink",
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
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);

  const confirmDiscard = () => {
    setDiscardBusy(true);
    try {
      onScanAnother();
      setDiscardOpen(false);
    } finally {
      setDiscardBusy(false);
    }
  };

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
            className="flex w-full items-center justify-between rounded-lg border border-hairline bg-white p-md text-[13px] font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <span className="flex items-center gap-sm">
              <FileText className="h-4 w-4 text-grey" strokeWidth={1.75} />
              Raw invoice text
            </span>
            <ChevronDown
              className={cn("h-4 w-4 text-grey transition-transform", rawTextOpen && "rotate-180")}
              strokeWidth={2}
            />
          </button>
          {rawTextOpen && (
            <div className="mt-xs rounded-lg border border-hairline bg-bridge-surface p-md">
              <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-grey">
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
          <p className="mt-xs text-[14px] text-grey md:text-[15px]">
            Review, correct, and export. Flagged fields need a second look.
          </p>
        </div>
        <div className="flex items-center gap-sm self-start md:self-auto">
          <div className="flex items-center gap-xs rounded-pill bg-sage-wash px-sm py-xs text-[11px] font-medium uppercase tracking-wide text-sage-ink">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            <span>Parsed accuracy</span>
            <span className="tabular">{accuracy}%</span>
          </div>
          <button
            type="button"
            onClick={() => setDiscardOpen(true)}
            className="flex min-h-11 items-center gap-xs rounded-pill border border-ink/25 px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Clear
          </button>
        </div>
      </header>

      <div className="mb-lg rounded-card border border-hairline bg-white p-md">
        <div className="flex flex-col gap-sm">
          <Field id="scan-supplier" label="Supplier">
            {(a11y) => (
              <div className="relative mt-xs flex w-full items-center rounded-pill border border-hairline bg-white px-md py-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
                <input
                  {...a11y}
                  value={source.distributor}
                  onChange={(e) => onUpdateSource("distributor", e.target.value)}
                  className="min-h-11 w-full bg-transparent text-[14px] font-medium text-ink outline-none"
                />
              </div>
            )}
          </Field>
          <div className="flex items-center gap-sm">
            <Field id="scan-invoice-number" label="Invoice number" className="flex-1">
              {(a11y) => (
                <div className="relative mt-xs flex w-full items-center rounded-pill border border-hairline bg-white px-md py-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
                  <input
                    {...a11y}
                    value={source.invoiceNo}
                    onChange={(e) => onUpdateSource("invoiceNo", e.target.value)}
                    className="min-h-11 w-full bg-transparent text-[14px] text-ink outline-none"
                  />
                </div>
              )}
            </Field>
            <Field id="scan-delivery-date" label="Delivery date" className="flex-1">
              {(a11y) => (
                <div className="relative mt-xs flex w-full items-center rounded-pill border border-hairline bg-white px-md py-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
                  <input
                    {...a11y}
                    type="date"
                    value={source.invoiceDate}
                    onChange={(e) => onUpdateSource("invoiceDate", e.target.value)}
                    className="min-h-11 w-full bg-transparent text-[14px] text-ink outline-none"
                  />
                </div>
              )}
            </Field>
          </div>
        </div>
        <div className="mt-sm flex justify-between items-center">
          <span className="rounded-pill bg-bridge-surface px-sm py-xs text-[11px] uppercase tracking-[0.1em] text-grey">
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
      <div className="mt-lg hidden overflow-hidden rounded-card border border-hairline md:block">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="bg-bridge-surface">
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
                className="border-t border-hairline align-middle hover:bg-bridge-surface"
              >
                <td className="p-sm">
                  <TextInput
                    id={`line-${it.id}-desktop-name`}
                    label="Wine name"
                    srOnlyLabel
                    value={it.name}
                    low={isLow(it, "name")}
                    edited={isEdited(it, "name")}
                    onCommit={(v) => onUpdate(it.id, "name", v)}
                    className="font-serif text-[17px] font-medium"
                  />
                  <div className="mt-2xs">
                    <TextInput
                      id={`line-${it.id}-desktop-producer`}
                      label="Producer"
                      srOnlyLabel
                      value={it.producer}
                      low={isLow(it, "producer")}
                      edited={isEdited(it, "producer")}
                      onCommit={(v) => onUpdate(it.id, "producer", v)}
                      className="text-[12px] text-grey"
                    />
                  </div>
                </td>
                <td className="p-sm">
                  <TextInput
                    id={`line-${it.id}-desktop-varietal`}
                    label="Varietal"
                    srOnlyLabel
                    value={it.varietal}
                    low={isLow(it, "varietal")}
                    edited={isEdited(it, "varietal")}
                    onCommit={(v) => onUpdate(it.id, "varietal", v)}
                  />
                </td>
                <td className="p-sm">
                  <VintageInput
                    id={`line-${it.id}-desktop-vintage`}
                    label="Vintage"
                    srOnlyLabel
                    value={it.vintage}
                    low={isLow(it, "vintage")}
                    edited={isEdited(it, "vintage")}
                    onCommit={(v) => onUpdate(it.id, "vintage", v)}
                  />
                </td>
                <td className="p-sm">
                  <TextInput
                    id={`line-${it.id}-desktop-region`}
                    label="Region"
                    srOnlyLabel
                    value={it.region}
                    low={isLow(it, "region")}
                    edited={isEdited(it, "region")}
                    onCommit={(v) => onUpdate(it.id, "region", v)}
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
                    id={`line-${it.id}-desktop-unit-cost`}
                    label="Unit cost"
                    srOnlyLabel
                    value={it.unitCost}
                    low={isLow(it, "unitCost")}
                    edited={isEdited(it, "unitCost")}
                    onCommit={(v) => onUpdate(it.id, "unitCost", v)}
                  />
                </td>
                <td className="p-sm text-center">
                  <IconButton
                    label={`Remove ${it.name}`}
                    onClick={() => onRemove(it.id)}
                    className="rounded-pill text-grey hover:bg-bridge-surface hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  </IconButton>
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
        className="sticky bottom-[64px] z-10 mt-md flex flex-col gap-sm rounded-card border border-hairline bg-white p-md md:static md:bottom-auto md:mt-lg md:flex-row md:items-center md:justify-between"
        style={{ marginBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}
      >
        <div className="text-[13px] text-grey md:text-[14px]">
          <span className="font-medium text-ink">{items.length} wines</span>
          <span className="mx-xs text-grey">·</span>
          <span>{Object.keys(edits).length} corrections</span>
        </div>
        <div className="grid grid-cols-2 gap-sm md:flex md:gap-md">
          <button
            type="button"
            onClick={() => setDiscardOpen(true)}
            className="flex min-h-11 items-center justify-center gap-sm rounded-pill border border-ink/25 bg-white text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:px-md"
          >
            <ScanLine className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            <span className="hidden sm:inline">Scan another</span>
            <span className="sm:hidden">Scan</span>
          </button>
          <div className="flex gap-sm">
            <button
              type="button"
              onClick={onExportCsv}
              className="flex min-h-11 flex-1 items-center justify-center gap-sm rounded-pill border border-ink/25 bg-white text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:flex-none md:px-md"
              title="Export as CSV"
            >
              <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              <span className="hidden md:inline">CSV</span>
            </button>
            <button
              type="button"
              onClick={onExportAccuracy}
              className="flex min-h-11 flex-1 items-center justify-center gap-sm rounded-pill border border-ink/25 bg-white text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:flex-none md:px-md"
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
            className="col-span-2 flex min-h-11 items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-white hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 md:px-md"
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
          <div className="sticky top-[72px] rounded-card border border-hairline bg-white">
            <div className="flex items-center gap-sm border-b border-hairline p-md">
              <FileText className="h-4 w-4 text-grey" strokeWidth={1.75} />
              <span className="text-[13px] font-medium text-ink">
                Raw invoice text
              </span>
            </div>
            <div className="p-md">
              <pre className="max-h-[calc(100vh-200px)] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-grey">
                {rawText}
              </pre>
            </div>
          </div>
        </aside>
      )}

      <ActionDialog
        open={discardOpen}
        title="Discard scan"
        description="The current scan and all edits will be lost."
        confirmLabel="Discard scan"
        busy={discardBusy}
        onClose={() => setDiscardOpen(false)}
        onConfirm={confirmDiscard}
      />
    </section>
  );
}
