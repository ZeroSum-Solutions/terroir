"use client";

import { AlertTriangle, Camera, Keyboard } from "lucide-react";

interface ErrorViewProps {
  error: string | null;
  payload: string | null;
  onTryAgain: () => void;
  onManualEntry: () => void;
}

export function ErrorView({ error, payload, onTryAgain, onManualEntry }: ErrorViewProps) {
  return (
    <div className="space-y-md">
      <div className="flex flex-col items-center gap-md rounded-card card-surface px-lg py-2xl text-center">
        <div className="rounded-full bg-primary p-lg">
          <AlertTriangle
            className="h-8 w-8 text-white"
            strokeWidth={1.5}
          />
        </div>
        <div>
          <h2 className="font-serif text-[22px] text-ink">
            Lookup failed
          </h2>
          <p className="mt-xs text-[13px] text-grey">{error}</p>
          {payload && (
            <p className="mt-sm font-mono text-[12px] text-grey">
              Code: {payload}
            </p>
          )}
        </div>
        <div className="flex w-full flex-col gap-sm">
          <button
            type="button"
            onClick={onTryAgain}
            className="flex h-[44px] w-full items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
          >
            <Camera className="h-4 w-4" strokeWidth={2} />
            Try again
          </button>
          {!payload && (
            <button
              type="button"
              onClick={onManualEntry}
              className="flex h-[44px] w-full items-center justify-center gap-sm rounded-pill border border-edge bg-surface text-[14px] font-medium text-ink hover:bg-wash focus-ring"
            >
              <Keyboard className="h-4 w-4" strokeWidth={2} />
              Enter code manually
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
