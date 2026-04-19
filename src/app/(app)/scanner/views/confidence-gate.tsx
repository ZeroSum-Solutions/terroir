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
  const message =
    quality.reason === "too_few_items"
      ? `Only ${quality.totalItems} wine${quality.totalItems === 1 ? "" : "s"} found. The invoice may not have been fully captured.`
      : quality.reason === "both"
        ? `Only ${quality.totalItems} wine${quality.totalItems === 1 ? "" : "s"} found with ${Math.round(quality.avgConfidence * 100)}% average confidence. Many fields may need correction.`
        : `${quality.lowConfidenceItems} of ${quality.totalItems} wines have low confidence (${Math.round(quality.avgConfidence * 100)}% average). Several fields may need correction.`;

  return (
    <section className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-[480px] rounded-md border border-border bg-white p-xl text-center">
        <div className="mx-auto mb-md flex h-14 w-14 items-center justify-center rounded-full bg-warning-soft text-warning">
          <AlertTriangle className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <h2 className="font-serif text-[22px] text-ink">
          This invoice was harder to read
        </h2>
        <p className="mt-sm text-[14px] text-ink-muted">{message}</p>
        <div className="mt-lg grid grid-cols-1 gap-sm md:grid-cols-2 md:gap-md">
          <button
            type="button"
            onClick={onReviewResults}
            className="flex h-11 items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px]"
          >
            Review AI results
          </button>
          <button
            type="button"
            onClick={onManualEntry}
            className="flex h-11 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px]"
          >
            Enter manually
          </button>
        </div>
      </div>
    </section>
  );
}
