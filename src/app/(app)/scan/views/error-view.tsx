"use client";

import { AlertTriangle, Camera, RotateCw } from "lucide-react";

interface ErrorViewProps {
  message: string;
  onRetry: () => void;
  onNewPhoto: () => void;
  hasFile: boolean;
  onManual: () => void;
}

export function ErrorView({ message, onRetry, onNewPhoto, hasFile, onManual }: ErrorViewProps) {
  return (
    <section className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-[480px] rounded-card border border-hairline bg-white p-xl text-center">
        <div className="mx-auto mb-md flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white">
          <AlertTriangle className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <h2 className="font-serif text-[22px] text-ink">Couldn&rsquo;t read the invoice</h2>
        <p className="mt-sm text-[14px] text-grey">{message}</p>
        <div className="mt-lg flex flex-col gap-sm">
          {hasFile && (
            <button
              type="button"
              onClick={onRetry}
              className="flex h-11 items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-white hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-blush-wash focus-visible:ring-offset-2 md:h-[38px]"
            >
              <RotateCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              Retry with same photo
            </button>
          )}
          <div className="grid grid-cols-2 gap-sm">
            <button
              type="button"
              onClick={onNewPhoto}
              className="flex h-11 items-center justify-center gap-sm rounded-pill border border-ink/25 bg-white text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:ring-2 focus-visible:ring-blush-wash focus-visible:ring-offset-2 md:h-[38px]"
            >
              <Camera className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              New photo
            </button>
            <button
              type="button"
              onClick={onManual}
              className="flex h-11 items-center justify-center gap-sm rounded-pill border border-ink/25 bg-white text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:ring-2 focus-visible:ring-blush-wash focus-visible:ring-offset-2 md:h-[38px]"
            >
              Enter manually
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
