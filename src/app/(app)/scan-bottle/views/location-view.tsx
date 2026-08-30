"use client";

import { Check, X } from "lucide-react";
import type { MatchedWine } from "../scan-bottle-state";

interface LocationViewProps {
  wine: MatchedWine;
  section: string;
  binLocation: string;
  onSectionChange: (value: string) => void;
  onBinLocationChange: (value: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  onBack: () => void;
  confirming: boolean;
}

export function LocationView({
  wine,
  section,
  binLocation,
  onSectionChange,
  onBinLocationChange,
  onSubmit,
  onBack,
  confirming,
}: LocationViewProps) {
  return (
    <div className="space-y-md">
      <div className="rounded-card card-surface p-md md:p-lg">
        <div className="mb-md flex items-start justify-between">
          <span className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Bottle location
          </span>
          <span className="rounded-pill bg-surface-sunken px-sm py-2xs text-[12px] font-medium text-ink-soft">
            {wine.producer} {wine.name}
            {wine.vintage ? " " + wine.vintage : ""}
          </span>
        </div>
        <form onSubmit={onSubmit} className="space-y-md">
          <div>
            <label
              htmlFor="bottle-section"
              className="mb-xs block text-[13px] font-medium text-ink"
            >
              Section
            </label>
            <input
              id="bottle-section"
              type="text"
              autoComplete="off"
              autoFocus
              value={section}
              onChange={(e) => onSectionChange(e.target.value)}
              placeholder='e.g. "Red Room", "Main Cellar"'
              className="w-full rounded-pill border border-rule bg-surface px-md py-sm text-[14px] text-ink placeholder:text-grey focus:border-accent focus-ring"
            />
          </div>
          <div>
            <label
              htmlFor="bottle-bin"
              className="mb-xs block text-[13px] font-medium text-ink"
            >
              Bin location
            </label>
            <input
              id="bottle-bin"
              type="text"
              autoComplete="off"
              value={binLocation}
              onChange={(e) => onBinLocationChange(e.target.value)}
              placeholder='e.g. "A-12", "Shelf 3, Row 5"'
              className="w-full rounded-pill border border-rule bg-surface px-md py-sm text-[14px] text-ink placeholder:text-grey focus:border-accent focus-ring"
            />
          </div>
          <div className="grid grid-cols-2 gap-sm">
            <button
              type="button"
              onClick={onBack}
              className="flex h-[44px] items-center justify-center gap-sm rounded-pill border border-edge bg-surface text-[14px] font-medium text-ink hover:bg-wash focus-ring"
            >
              <X className="h-4 w-4" strokeWidth={2} />
              Back
            </button>
            <button
              type="submit"
              disabled={!section.trim() || !binLocation.trim() || confirming}
              className="flex h-[44px] items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-50"
            >
              <Check className="h-4 w-4" strokeWidth={2} />
              {confirming ? "Saving..." : "Save location"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
