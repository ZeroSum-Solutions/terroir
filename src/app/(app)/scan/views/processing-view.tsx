"use client";

import { Check, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScanMode } from "@/lib/scanner/types";

const INVOICE_STEPS = [
  "Reading invoice",
  "Identifying wines",
  "Structuring line items",
] as const;

const BOTTLE_STEPS = [
  "Analyzing label",
  "Identifying wine",
] as const;

interface ProcessingViewProps {
  progress: number;
  stepIndex: number;
  mode?: ScanMode;
}

export function ProcessingView({ progress, stepIndex, mode = "invoice" }: ProcessingViewProps) {
  const capped = progress >= 90;
  const isBottle = mode === "bottle";
  const steps = isBottle ? BOTTLE_STEPS : INVOICE_STEPS;
  return (
    <section className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-[420px] rounded-card border border-hairline bg-white p-xl text-center">
        <div className="mx-auto mb-md flex h-16 w-16 items-center justify-center rounded-full bg-blush-wash text-primary">
          <Sparkles className="h-7 w-7" strokeWidth={1.5} />
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

        <div className="relative mt-md h-1.5 overflow-hidden rounded-pill bg-beige">
          <div
            className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-100 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-xs flex items-center justify-between text-[11px] tabular text-grey">
          <span>{progress}%</span>
          <span>Claude Sonnet 4.6</span>
        </div>

        <ul className="mt-lg flex flex-col gap-sm text-left">
          {steps.map((label, i) => {
            const done = i < stepIndex;
            const active = i === stepIndex;
            return (
              <li
                key={label}
                className={cn(
                  "flex items-center gap-sm text-[14px]",
                  done && "text-ink",
                  active && "text-primary",
                  !done && !active && "text-grey",
                )}
              >
                {done ? (
                  <Check className="h-4 w-4" strokeWidth={2.25} />
                ) : active ? (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                ) : (
                  <span className="block h-3.5 w-3.5 rounded-full border-2 border-current opacity-40" />
                )}
                {label}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
