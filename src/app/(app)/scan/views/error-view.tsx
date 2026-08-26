"use client";

import { AlertTriangle, Camera, RotateCw } from "lucide-react";
import type { ScanMode } from "@/lib/scanner/types";

interface ErrorViewProps {
  mode: ScanMode;
  message: string;
  onRetry: () => void;
  onNewPhoto: () => void;
  hasFile: boolean;
  onManual: () => void;
}

export function ErrorView({ mode, message, onRetry, onNewPhoto, hasFile, onManual }: ErrorViewProps) {
  const isBottle = mode === "bottle";
  return (
    <section className="flex min-h-[60vh] items-center justify-center">
      <div role="alert" className="w-full max-w-[480px] rounded-card card-surface p-xl text-center">
        <div className="mx-auto mb-md flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white">
          <AlertTriangle className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
        </div>
        <h2 className="font-serif text-[22px] text-ink">
          {isBottle ? "Couldn’t read the label" : "Couldn’t read the invoice"}
        </h2>
        <p className="mt-sm text-[14px] text-grey">{message}</p>
        <div className="mt-lg flex flex-col gap-sm">
          {hasFile && (
            <button
              type="button"
              onClick={onRetry}
              className="flex h-11 items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-white hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <RotateCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              {isBottle ? "Retry label scan" : "Retry invoice scan"}
            </button>
          )}
          <div className={`grid gap-sm ${isBottle ? "grid-cols-1" : "grid-cols-2"}`}>
            <button
              type="button"
              onClick={onNewPhoto}
              className="flex h-11 items-center justify-center gap-sm rounded-pill border border-ink/25 bg-surface text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Camera className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              New photo
            </button>
            {!isBottle && (
              <button
                type="button"
                onClick={onManual}
                className="flex h-11 items-center justify-center gap-sm rounded-pill border border-ink/25 bg-surface text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Enter manually
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
