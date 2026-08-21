"use client";

import { Check, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScanMode } from "@/lib/scanner/types";

export type ScanStage = "upload" | "extract" | "identify" | "review";
type ScanStep = { stage: ScanStage; label: string };

const INVOICE_STEPS: readonly ScanStep[] = [
  { stage: "upload", label: "Uploading invoice" },
  { stage: "extract", label: "Extracting invoice details" },
  { stage: "review", label: "Preparing your review" },
] as const;

const BOTTLE_STEPS: readonly ScanStep[] = [
  { stage: "upload", label: "Uploading label photo" },
  { stage: "identify", label: "Identifying the wine" },
  { stage: "review", label: "Preparing your review" },
] as const;

export function stageForProgress(mode: ScanMode, progress: number): ScanStage {
  if (progress < 30) return "upload";
  if (progress < 70) return mode === "bottle" ? "identify" : "extract";
  return "review";
}

interface ProcessingViewProps {
  progress: number;
  stage: ScanStage;
  mode: ScanMode;
  onCancel: () => void;
}

export function ProcessingView({ progress, stage, mode, onCancel }: ProcessingViewProps) {
  const capped = progress >= 90;
  const isBottle = mode === "bottle";
  const steps = isBottle ? BOTTLE_STEPS : INVOICE_STEPS;
  const activeStep = steps.find((step) => step.stage === stage) ?? steps[0];
  const activeIndex = steps.indexOf(activeStep);
  return (
    <section className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-[420px] rounded-card border border-hairline bg-white p-xl text-center">
        <div className="mx-auto mb-md flex h-16 w-16 items-center justify-center rounded-full bg-blush-wash text-primary">
          <Sparkles className="h-7 w-7" strokeWidth={1.5} aria-hidden="true" />
        </div>
        <h2 className="font-serif text-[22px] text-ink">
          {isBottle ? "Reading the label" : "Reading your invoice"}
        </h2>
        <p className="mt-xs text-[14px] text-grey">
          {capped
            ? isBottle
              ? "Still working — this should finish shortly."
              : "Still working — large invoices can take up to 90 seconds."
            : isBottle
              ? "Usually 5-10 seconds."
              : "Usually 20-30 seconds."}
        </p>

        <div
          className="relative mt-md h-1.5 overflow-hidden rounded-pill bg-beige"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-valuetext={`${activeStep.label}, estimated ${progress}% complete`}
        >
          <div
            className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-100 ease-out"
            style={{ width: `${progress}%` }}
            aria-hidden="true"
          />
        </div>
        <div className="mt-xs flex items-center justify-between text-[11px] tabular text-grey">
          <span>Estimated progress: {progress}%</span>
          <span>{isBottle ? "Reading label details" : "Reading invoice details"}</span>
        </div>

        <span className="sr-only" aria-live="polite">
          {activeStep.label}
        </span>

        <ul className="mt-lg flex flex-col gap-sm text-left">
          {steps.map((step, i) => {
            const done = i < activeIndex;
            const active = step.stage === stage;
            return (
              <li
                key={step.stage}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex items-center gap-sm text-[14px]",
                  done && "text-ink",
                  active && "text-primary",
                  !done && !active && "text-grey",
                )}
              >
                {done ? (
                  <Check className="h-4 w-4" strokeWidth={2.25} aria-hidden="true" />
                ) : active ? (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
                ) : (
                  <span className="block h-3.5 w-3.5 rounded-full border-2 border-current opacity-40" aria-hidden="true" />
                )}
                {step.label}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={onCancel}
          className="mt-lg h-11 rounded-pill border border-ink/25 bg-white px-lg text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:ring-2 focus-visible:ring-blush-wash focus-visible:ring-offset-2"
        >
          Cancel scan
        </button>
      </div>
    </section>
  );
}
