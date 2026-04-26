"use client";

import { AlertTriangle, RotateCcw, Save } from "lucide-react";
import { useCallback, useState } from "react";
import type { BottleScanResult } from "@/lib/scanner/types";
import {
  TextInput,
  VintageInput,
  MoneyInput,
  QtyStepper,
} from "../components/field-inputs";

interface BottleResultsViewProps {
  result: BottleScanResult;
  onSave: (wine: {
    name: string;
    producer: string;
    vintage: number | null;
    varietal: string;
    region: string;
    country: string | null;
    qty: number;
    unitCost: number;
  }) => void;
  onScanAnother: () => void;
  isSaving: boolean;
}

export function BottleResultsView({
  result,
  onSave,
  onScanAnother,
  isSaving,
}: BottleResultsViewProps) {
  const [name, setName] = useState(result.name);
  const [producer, setProducer] = useState(result.producer);
  const [vintage, setVintage] = useState<number | null>(result.vintage);
  const [varietal, setVarietal] = useState(result.varietal);
  const [region, setRegion] = useState(result.region);
  const [qty, setQty] = useState(1);
  const [unitCost, setUnitCost] = useState(0);

  const lowConfidence = result.confidence < 0.75;

  const handleSave = useCallback(() => {
    if (!name.trim() || !producer.trim()) return;
    onSave({
      name,
      producer,
      vintage,
      varietal,
      region,
      country: result.country,
      qty,
      unitCost,
    });
  }, [name, producer, vintage, varietal, region, result.country, qty, unitCost, onSave]);

  return (
    <section>
      <header className="mb-lg md:mb-xl">
        <h1 className="font-serif text-[22px] text-ink md:text-[28px]">
          Wine identified
        </h1>
        <p className="mt-xs text-[14px] text-ink-muted md:text-[15px]">
          Confirm the details and add quantity and cost.
        </p>
      </header>

      {lowConfidence && (
        <div className="mb-md flex items-start gap-sm rounded-md border border-warning/30 bg-warning-soft/60 px-md py-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" strokeWidth={2} />
          <div className="text-[13px] text-ink">
            <span className="font-medium">Low confidence ({Math.round(result.confidence * 100)}%).</span>{" "}
            The label may have been hard to read. Please review all fields carefully.
          </div>
        </div>
      )}

      <div className="rounded-md border border-border bg-white p-md md:p-lg">
        {/* Confidence badge */}
        <div className="mb-md flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            From label
          </span>
          <span className={`rounded-pill px-sm py-2xs font-mono text-[12px] font-medium ${
            result.confidence >= 0.9
              ? "bg-success-soft text-success"
              : result.confidence >= 0.75
                ? "bg-surface-muted text-ink-muted"
                : "bg-warning-soft text-warning"
          }`}>
            {Math.round(result.confidence * 100)}%
          </span>
        </div>

        {/* Editable fields */}
        <div className="flex flex-col gap-md">
          <div>
            <label className="mb-xs block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              Wine name
            </label>
            <TextInput value={name} onCommit={setName} label="Wine name" />
          </div>

          <div>
            <label className="mb-xs block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              Producer
            </label>
            <TextInput value={producer} onCommit={setProducer} label="Producer" />
          </div>

          <div className="grid grid-cols-2 gap-sm md:grid-cols-3">
            <div>
              <label className="mb-xs block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Vintage
              </label>
              <VintageInput value={vintage} onCommit={setVintage} />
            </div>
            <div>
              <label className="mb-xs block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Varietal
              </label>
              <TextInput value={varietal} onCommit={setVarietal} label="Varietal" />
            </div>
            <div className="col-span-2 md:col-span-1">
              <label className="mb-xs block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Region
              </label>
              <TextInput value={region} onCommit={setRegion} label="Region" />
            </div>
          </div>

          {result.notes && (
            <div className="rounded bg-surface-muted px-md py-sm text-[13px] text-ink-muted">
              {result.notes}
            </div>
          )}
        </div>

        {/* Separator */}
        <div className="my-lg border-t border-dashed border-border" />

        {/* User-provided fields */}
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          You provide
        </div>
        <div className="mt-md grid grid-cols-2 gap-md">
          <div>
            <label className="mb-xs block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              Quantity
            </label>
            <QtyStepper value={qty} onChange={setQty} />
          </div>
          <div>
            <label className="mb-xs block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              Unit cost
            </label>
            <MoneyInput value={unitCost} onCommit={setUnitCost} />
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-md grid grid-cols-2 gap-sm">
        <button
          type="button"
          onClick={onScanAnother}
          className="flex h-12 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted md:h-[38px]"
        >
          <RotateCcw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Scan another
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || !name.trim() || !producer.trim()}
          className="flex h-12 items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-50 md:h-[38px]"
        >
          {isSaving ? (
            <>Saving...</>
          ) : (
            <>
              <Save className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              Save to inventory
            </>
          )}
        </button>
      </div>
    </section>
  );
}
