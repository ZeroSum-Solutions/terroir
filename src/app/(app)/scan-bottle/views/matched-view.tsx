"use client";

import { Check, X } from "lucide-react";
import type { MatchedWine } from "../scan-bottle-state";
import { wineDisplayName } from "@/lib/wine-display-name";

interface MatchedViewProps {
  wine: MatchedWine;
  onCorrect: () => void;
  onConfirm: () => void;
}

export function MatchedView({ wine, onCorrect, onConfirm }: MatchedViewProps) {
  return (
    <div className="space-y-md">
      <div className="rounded-card card-surface p-md md:p-lg">
        <div className="mb-md flex items-start justify-between">
          <span className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Matched wine
          </span>
          <span className="rounded-pill bg-ready-wash px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide text-ready-ink">
            Match found
          </span>
        </div>
        <h2 className="font-serif text-[20px] text-ink md:text-[22px]">
          {wine.producer}
        </h2>
        <p className="mt-xs font-serif text-[18px] text-ink md:text-[20px]">
          {wineDisplayName(wine.producer, wine.name)}
        </p>
        <dl className="mt-md grid grid-cols-2 gap-x-md gap-y-sm text-[13px]">
          {wine.vintage && (
            <>
              <dt className="text-grey">Vintage</dt>
              <dd className="tabular text-ink">{wine.vintage}</dd>
            </>
          )}
          {wine.varietal && (
            <>
              <dt className="text-grey">Varietal</dt>
              <dd className="text-ink">{wine.varietal}</dd>
            </>
          )}
          {wine.region && (
            <>
              <dt className="text-grey">Region</dt>
              <dd className="text-ink">{wine.region}</dd>
            </>
          )}
          {wine.country && (
            <>
              <dt className="text-grey">Country</dt>
              <dd className="text-ink">{wine.country}</dd>
            </>
          )}
        </dl>
      </div>
      <div className="grid grid-cols-2 gap-sm">
        <button
          type="button"
          onClick={onCorrect}
          className="flex h-[44px] items-center justify-center gap-sm rounded-pill border border-edge bg-surface text-[14px] font-medium text-ink hover:bg-wash focus-ring"
        >
          <X className="h-4 w-4" strokeWidth={2} />
          Correct
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex h-[44px] items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
        >
          <Check className="h-4 w-4" strokeWidth={2} />
          Confirm
        </button>
      </div>
    </div>
  );
}
