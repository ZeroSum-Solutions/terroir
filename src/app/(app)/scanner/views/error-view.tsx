"use client";

import { AlertTriangle, RotateCw } from "lucide-react";

interface ErrorViewProps {
  message: string;
  onRetry: () => void;
  onManual: () => void;
}

export function ErrorView({ message, onRetry, onManual }: ErrorViewProps) {
  return (
    <section className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-[480px] rounded-md border border-border bg-white p-xl text-center">
        <div className="mx-auto mb-md flex h-14 w-14 items-center justify-center rounded-full bg-warning-soft text-warning">
          <AlertTriangle className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <h2 className="font-serif text-[22px] text-ink">Couldn&rsquo;t read the invoice</h2>
        <p className="mt-sm text-[14px] text-ink-muted">{message}</p>
        <div className="mt-lg grid grid-cols-1 gap-sm md:grid-cols-2 md:gap-md">
          <button
            type="button"
            onClick={onRetry}
            className="flex h-11 items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px]"
          >
            <RotateCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            Try again
          </button>
          <button
            type="button"
            onClick={onManual}
            className="flex h-11 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px]"
          >
            Enter manually
          </button>
        </div>
      </div>
    </section>
  );
}
