"use client";

import { Camera, Check, List, MapPin } from "lucide-react";
import type { MatchedWine } from "../scan-bottle-state";

interface ConfirmedViewProps {
  wine: MatchedWine;
  section: string;
  binLocation: string;
  sessionCount: number;
  onScanAgain: () => void;
  onEndSession: () => void;
}

export function ConfirmedView({
  wine,
  section,
  binLocation,
  sessionCount,
  onScanAgain,
  onEndSession,
}: ConfirmedViewProps) {
  return (
    <div className="space-y-md">
      <div className="flex flex-col items-center gap-lg rounded-card shadow-card border border-rule bg-ready-wash/40 px-lg py-2xl text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ready-ink">
          <Check className="h-7 w-7 text-ready-wash" strokeWidth={2.5} />
        </div>
        <div>
          <h2 className="font-serif text-[22px] text-ink">
            Bottle confirmed
          </h2>
          <p className="mt-xs font-serif text-[17px] font-medium text-ink">
            {wine.producer} {wine.name}
            {wine.vintage ? " (" + wine.vintage + ")" : ""}
          </p>
          {(section || binLocation) && (
            <p className="mt-sm inline-flex items-center gap-xs text-[12px] text-grey">
              <MapPin className="h-3 w-3" strokeWidth={2} />
              {section && <span>{section}</span>}
              {section && binLocation && <span>&middot;</span>}
              {binLocation && <span>{binLocation}</span>}
            </p>
          )}
        </div>
        <div className="flex w-full flex-col gap-sm">
          <button
            type="button"
            onClick={onScanAgain}
            className="flex h-[44px] items-center justify-center gap-sm rounded-pill bg-primary px-xl text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
          >
            <Camera className="h-4 w-4" strokeWidth={2} />
            Scan another bottle
          </button>
          {sessionCount >= 1 && (
            <button
              type="button"
              onClick={onEndSession}
              className="flex h-[44px] items-center justify-center gap-sm rounded-pill border border-edge bg-surface text-[14px] font-medium text-ink hover:bg-wash focus-ring"
            >
              <List className="h-4 w-4" strokeWidth={2} />
              End session (<span className="tabular">{sessionCount}</span> scanned)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
