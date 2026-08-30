"use client";

import { Camera, Search } from "lucide-react";

interface ManualViewProps {
  manualCode: string;
  onManualCodeChange: (value: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  onUseCamera: () => void;
}

export function ManualView({ manualCode, onManualCodeChange, onSubmit, onUseCamera }: ManualViewProps) {
  return (
    <div className="space-y-md">
      <form onSubmit={onSubmit} className="space-y-md">
        <div className="rounded-card card-surface p-md md:p-lg">
          <label
            htmlFor="manual-code"
            className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey"
          >
            Wine ID or QR code
          </label>
          <input
            id="manual-code"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoFocus
            value={manualCode}
            onChange={(e) => onManualCodeChange(e.target.value)}
            placeholder="Enter the code from the bottle label"
            className="w-full rounded-pill border border-rule bg-surface px-md py-sm font-mono text-[14px] text-ink placeholder:text-grey focus:border-accent focus-ring"
          />
          <p className="mt-xs text-[12px] text-grey">
            The code is printed below the QR code on the bottle label.
          </p>
        </div>
        <button
          type="submit"
          disabled={!manualCode.trim()}
          className="flex h-[44px] w-full items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-50"
        >
          <Search className="h-4 w-4" strokeWidth={2} />
          Look up wine
        </button>
      </form>
      <button
        type="button"
        onClick={onUseCamera}
        className="flex h-[44px] w-full items-center justify-center gap-sm rounded-pill border border-edge bg-surface text-[14px] font-medium text-ink hover:bg-wash focus-ring"
      >
        <Camera className="h-4 w-4" strokeWidth={2} />
        Use camera instead
      </button>
    </div>
  );
}
