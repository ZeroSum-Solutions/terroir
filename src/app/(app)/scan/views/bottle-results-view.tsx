"use client";

import { AlertTriangle, Check, Pencil, RotateCcw, Save } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import type { BottleCandidate, BottleField, BottleScanResult } from "@/lib/scanner/types";
import {
  TextInput,
  VintageInput,
  MoneyInput,
  QtyStepper,
} from "../components/field-inputs";

interface BottleResultsViewProps {
  result: BottleScanResult;
  /** Object URL of the label photo the user just captured (scanner.tsx
   * holds it until save/start-over) — shown beside the identification so
   * the operator can eyeball the match against their own photo. */
  previewUrl?: string | null;
  onSave: (wine: {
    name: string;
    producer: string;
    vintage: number | null;
    varietal: string;
    region: string;
    country: string | null;
    format: string | null;
    qty: number;
    unitCost: number;
  }) => void;
  onScanAnother: () => void;
  isSaving: boolean;
}

/** Below this, the confidence badge and low-confidence banner switch to "needs review" styling. */
const LOW_CONFIDENCE_THRESHOLD = 0.75;

function confidenceBadgeClass(confidence: number) {
  if (confidence >= 0.9) return "bg-sage-wash text-sage-ink";
  if (confidence >= LOW_CONFIDENCE_THRESHOLD) return "bg-powder-wash text-powder-ink";
  return "bg-blush-wash text-accent";
}

/**
 * Read-only identity field row used before the user chooses to correct
 * details. `emphasis` renders the value in the DESIGN.md wine-name
 * treatment (Cormorant Garamond, 17px, weight 500, never bold, never
 * smaller than 17px) — used for the wine-name row only; every other
 * identity field stays Inter body text.
 */
function InfoRow({
  label,
  value,
  low,
  emphasis,
}: {
  label: string;
  value: string;
  low?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div>
      <div className="mb-2xs flex flex-wrap items-center gap-xs">
        <span className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
          {label}
        </span>
        {low && (
          <span className="inline-flex items-center gap-[3px] rounded-pill bg-blush-wash px-xs py-[1px] text-[10px] font-medium uppercase tracking-wide text-accent">
            <AlertTriangle className="h-3 w-3" strokeWidth={2.25} aria-hidden="true" />
            Needs review
          </span>
        )}
      </div>
      <div
        className={cn(
          "rounded-sm border border-transparent px-sm py-xs text-ink",
          emphasis ? "font-serif text-[17px] font-medium" : "text-[14px]",
          low && "border-l-[3px] border-l-primary bg-blush-wash/60",
        )}
      >
        {value ? value : <span className="text-grey">Not detected</span>}
      </div>
    </div>
  );
}

export function BottleResultsView({
  result,
  previewUrl,
  onSave,
  onScanAnother,
  isSaving,
}: BottleResultsViewProps) {
  const candidates = result.candidates;
  const [activeIndex, setActiveIndex] = useState(0);
  const [stage, setStage] = useState<"review" | "editing">("review");
  const active: BottleCandidate = candidates[activeIndex] ?? candidates[0];

  // Editable identity fields — populated from the active candidate only
  // when the user chooses "Correct details" (handleCorrect below).
  const [name, setName] = useState(active.name);
  const [producer, setProducer] = useState(active.producer);
  const [vintage, setVintage] = useState<number | null>(active.vintage);
  const [varietal, setVarietal] = useState(active.varietal);
  const [region, setRegion] = useState(active.region);
  const [format, setFormat] = useState(active.format ?? "");
  const [qty, setQty] = useState(1);
  const [unitCost, setUnitCost] = useState(0);

  const lowConfidence = active.confidence < LOW_CONFIDENCE_THRESHOLD;
  const isLow = useCallback((field: BottleField) => active.lowFields.includes(field), [active]);

  const handleCorrect = useCallback(() => {
    setName(active.name);
    setProducer(active.producer);
    setVintage(active.vintage);
    setVarietal(active.varietal);
    setRegion(active.region);
    setFormat(active.format ?? "");
    setStage("editing");
  }, [active]);

  const handleConfirm = useCallback(() => {
    if (!active.name.trim() || !active.producer.trim()) return;
    onSave({
      name: active.name,
      producer: active.producer,
      vintage: active.vintage,
      varietal: active.varietal,
      region: active.region,
      country: active.country,
      format: active.format,
      qty,
      unitCost,
    });
  }, [active, qty, unitCost, onSave]);

  const handleSaveCorrected = useCallback(() => {
    if (!name.trim() || !producer.trim()) return;
    onSave({
      name,
      producer,
      vintage,
      varietal,
      region,
      country: active.country,
      format: format.trim() ? format.trim() : null,
      qty,
      unitCost,
    });
  }, [name, producer, vintage, varietal, region, active.country, format, qty, unitCost, onSave]);

  const canCommit =
    stage === "review"
      ? !!active.name.trim() && !!active.producer.trim()
      : !!name.trim() && !!producer.trim();

  return (
    <section>
      <header className="mb-lg md:mb-xl">
        <h1 className="font-serif text-heading-sm text-ink md:text-heading">
          Wine identified
        </h1>
        <p className="mt-xs text-[14px] text-grey md:text-[15px]">
          {stage === "review"
            ? "Confirm the AI match is right, or correct the details yourself."
            : "Update the fields, then save to inventory."}
        </p>
      </header>

      {previewUrl && (
        <div className="mb-md">
          <div className="mb-sm text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Your label photo
          </div>
          {/* Plain <img>: previewUrl is a local object URL, never a remote
              asset — next/image adds nothing here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="Label you captured"
            className="max-h-[38vh] w-full rounded-lg bg-bridge-surface object-contain"
          />
        </div>
      )}

      {lowConfidence && (
        <div className="mb-md flex items-start gap-sm rounded-card border border-accent/20 bg-blush-wash/60 px-md py-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-risk-ink" strokeWidth={2} />
          <div className="text-[13px] text-ink">
            <span className="font-medium">
              Low AI match confidence ({Math.round(active.confidence * 100)}%).
            </span>{" "}
            The label may have been hard to read. Check the flagged fields below
            {candidates.length > 1 ? ", or try another match." : "."}
          </div>
        </div>
      )}

      <div className="rounded-card card-surface p-md md:p-lg">
        {/* Confidence badge — the model's self-assessment, never a measured accuracy. */}
        <div className="mb-md flex items-center justify-between">
          <span className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            AI match confidence
          </span>
          <span className={cn("rounded-pill px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide", confidenceBadgeClass(active.confidence))}>
            <span className="tabular">{Math.round(active.confidence * 100)}%</span>
          </span>
        </div>

        {stage === "review" && candidates.length > 1 && (
          <div className="mb-md">
            <div className="mb-xs text-caption font-medium uppercase tracking-[0.18em] text-grey">
              Other possible matches
            </div>
            <div className="flex flex-wrap gap-xs">
              {candidates.map((candidate, i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={i === activeIndex}
                  onClick={() => setActiveIndex(i)}
                  className={cn(
                    "flex min-h-11 items-center gap-xs rounded-pill border px-sm py-xs text-[13px] font-medium transition-colors focus-ring",
                    i === activeIndex
                      ? "border-ink bg-ink text-on-inverse"
                      : "border-hairline bg-surface text-ink hover:bg-bridge-surface",
                  )}
                >
                  <span className="max-w-[160px] truncate">{candidate.name || "Unnamed match"}</span>
                  <span className="tabular text-[11px] opacity-75">
                    {Math.round(candidate.confidence * 100)}%
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {stage === "review" ? (
          <div className="flex flex-col gap-md">
            <InfoRow label="Wine name" value={active.name} low={isLow("name")} emphasis />
            <InfoRow label="Producer" value={active.producer} low={isLow("producer")} />
            <div className="grid grid-cols-2 gap-sm md:grid-cols-3">
              <InfoRow
                label="Vintage"
                value={active.vintage === null ? "NV" : String(active.vintage)}
                low={isLow("vintage")}
              />
              <InfoRow label="Varietal" value={active.varietal} />
              <div className="col-span-2 md:col-span-1">
                <InfoRow label="Region" value={active.region} low={isLow("region")} />
              </div>
            </div>
            <InfoRow label="Format" value={active.format ?? ""} low={isLow("format")} />

            {active.notes && (
              <div className="rounded-md bg-bridge-surface px-md py-sm text-[13px] text-grey">
                {active.notes}
              </div>
            )}

            <button
              type="button"
              onClick={handleCorrect}
              className="flex h-11 items-center justify-center gap-xs self-start rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-ring"
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Something&rsquo;s off — correct details
            </button>
          </div>
        ) : (
          /* eslint-disable jsx-a11y/label-has-associated-control --
             Each <label> below sits beside a TextInput/VintageInput/
             MoneyInput/QtyStepper, not a bare <input>; those components
             already carry a matching aria-label (or, for QtyStepper, two
             self-describing "Increase/Decrease quantity" buttons) on their
             actual form controls, so the accessible name exists even
             though the visible label lacks a `for`/`id` pairing to it. */
          <div className="flex flex-col gap-md">
            <div>
              <label className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Wine name
              </label>
              <TextInput
                value={name}
                low={isLow("name")}
                onCommit={setName}
                label="Wine name"
                className="font-serif text-[17px] font-medium"
              />
            </div>

            <div>
              <label className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Producer
              </label>
              <TextInput value={producer} low={isLow("producer")} onCommit={setProducer} label="Producer" />
            </div>

            <div className="grid grid-cols-2 gap-sm md:grid-cols-3">
              <div>
                <label className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey">
                  Vintage
                </label>
                <VintageInput value={vintage} low={isLow("vintage")} onCommit={setVintage} />
              </div>
              <div>
                <label className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey">
                  Varietal
                </label>
                <TextInput value={varietal} onCommit={setVarietal} label="Varietal" />
              </div>
              <div className="col-span-2 md:col-span-1">
                <label className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey">
                  Region
                </label>
                <TextInput value={region} low={isLow("region")} onCommit={setRegion} label="Region" />
              </div>
            </div>

            <div>
              <label className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Format
              </label>
              <TextInput value={format} low={isLow("format")} onCommit={setFormat} label="Format" />
            </div>

            {active.notes && (
              <div className="rounded-md bg-bridge-surface px-md py-sm text-[13px] text-grey">
                {active.notes}
              </div>
            )}
          </div>
        )}

        {/* Separator */}
        <div className="my-lg border-t border-dashed border-hairline" />

        {/* User-provided fields */}
        <div className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
          You provide
        </div>
        <div className="mt-md grid grid-cols-2 gap-md">
          <div>
            <label className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey">
              Quantity
            </label>
            <QtyStepper value={qty} onChange={setQty} />
          </div>
          <div>
            <label className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey">
              Unit cost
            </label>
            <MoneyInput value={unitCost} onCommit={setUnitCost} />
          </div>
        </div>
        {/* eslint-enable jsx-a11y/label-has-associated-control */}
      </div>

      {/* Actions */}
      <div className="mt-md grid grid-cols-2 gap-sm">
        <button
          type="button"
          onClick={onScanAnother}
          className="flex h-12 items-center justify-center gap-sm rounded-pill border border-edge bg-surface text-[14px] font-medium text-ink hover:bg-bridge-surface focus-ring md:h-[38px]"
        >
          <RotateCcw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Scan another
        </button>
        <button
          type="button"
          onClick={stage === "review" ? handleConfirm : handleSaveCorrected}
          disabled={isSaving || !canCommit}
          className="flex h-12 items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-50 md:h-[38px]"
        >
          {isSaving ? (
            <>Saving...</>
          ) : stage === "review" ? (
            <>
              <Check className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              Confirm & save
            </>
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
