"use client";

import { AlertTriangle } from "lucide-react";
import type { ScanQuality } from "@/lib/scanner/types";

interface ConfidenceGateViewProps {
  quality: ScanQuality;
  onReviewResults: () => void;
  onManualEntry: () => void;
}

export function ConfidenceGateView({
  quality,
  onReviewResults,
  onManualEntry,
}: ConfidenceGateViewProps) {
  const isArithmeticMismatch = quality.reason === "arithmetic_mismatch";

  const message = isArithmeticMismatch
    ? "Some of the numbers on this invoice don't add up — a quantity, unit cost, or total looks inconsistent. Review the flagged wines before saving."
    : quality.reason === "too_few_items"
      ? `Only ${quality.totalItems} wine${quality.totalItems === 1 ? "" : "s"} found. The invoice may not have been fully captured.`
      : quality.reason === "both"
        ? `Only ${quality.totalItems} wine${quality.totalItems === 1 ? "" : "s"} found with ${Math.round(quality.avgConfidence * 100)}% average confidence. Many fields may need correction.`
        : `${quality.lowConfidenceItems} of ${quality.totalItems} wines have low confidence (${Math.round(quality.avgConfidence * 100)}% average). Several fields may need correction.`;

  const heading = isArithmeticMismatch
    ? "This invoice needs a second look"
    : "This invoice was harder to read";

  return (
    <section className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-[480px] rounded-card border border-hairline bg-white p-xl text-center">
        <div className="mx-auto mb-md flex h-14 w-14 items-center justify-center rounded-full bg-blush-wash text-primary">
          <AlertTriangle className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <h2 className="font-serif text-[22px] text-ink">
          {heading}
        </h2>
        <p className="mt-sm text-[14px] text-grey">{message}</p>
        <div className="mt-lg grid grid-cols-1 gap-sm md:grid-cols-2 md:gap-md">
          <button
            type="button"
            onClick={onReviewResults}
            className="flex h-11 items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-white hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:h-[38px]"
          >
            Review AI results
          </button>
          <button
            type="button"
            onClick={onManualEntry}
            className="flex h-11 items-center justify-center gap-sm rounded-pill border border-ink/25 bg-white text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:h-[38px]"
          >
            Enter manually
          </button>
        </div>
      </div>
    </section>
  );
}
