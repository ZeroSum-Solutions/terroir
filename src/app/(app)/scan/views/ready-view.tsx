"use client";

import { Camera, FileUp, ImageIcon, Wine } from "lucide-react";
import { Check, ListOrdered, ScanLine } from "lucide-react";
import { useRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { RecentScan, ScanMode } from "@/lib/scanner/types";
import { formatMoney } from "../components/field-inputs";

interface RecentScansListProps {
  scans: RecentScan[];
}

function RecentScansList({ scans }: RecentScansListProps) {
  if (scans.length === 0) return null;
  return (
    <section className="mt-2xl">
      <h3 className="mb-md text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
        Recent scans
      </h3>
      <div className="grid grid-cols-1 gap-sm md:grid-cols-3 md:gap-md">
        {scans.map((s) => (
          <Link
            key={s.id}
            href={`/scan/${s.id}`}
            className="block rounded-md border border-border bg-white p-md transition-all hover:border-accent/40 hover:shadow-sm"
          >
            <div className="mb-sm flex items-center justify-between">
              <span className="tabular text-[12px] text-ink-muted">{s.parsedAt}</span>
              <div className="flex items-center gap-xs">
                {s.hasImage && (
                  <ImageIcon className="h-3 w-3 text-ink-subtle" strokeWidth={2} aria-label="Has invoice image" />
                )}
                <span className="tabular text-[12px] text-success">{s.accuracy}%</span>
              </div>
            </div>
            <div className="mb-xs text-[14px] font-medium text-ink">
              {s.distributor}
            </div>
            <div className="flex items-center gap-xs text-[13px] text-ink-muted">
              <span>{s.items} wines</span>
              <span aria-hidden className="text-ink-subtle">·</span>
              <span className="tabular">${formatMoney(s.total)}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

interface ReadyViewProps {
  onStart: (file: File) => void;
  mode: ScanMode;
  onModeChange: (mode: ScanMode) => void;
  recentScans: RecentScan[];
  savedResult: { itemCount: number; wineCount: number } | null;
  onDismissSaved: () => void;
}

export function ReadyView({
  onStart,
  mode,
  onModeChange,
  recentScans,
  savedResult,
  onDismissSaved,
}: ReadyViewProps) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isBottle = mode === "bottle";

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    onStart(file);
  };

  return (
    <section>
      {/* Mode toggle */}
      <div className="mb-lg flex items-center justify-center">
        <div className="inline-flex rounded-sm border border-border bg-surface-muted p-0.5">
          <button
            type="button"
            onClick={() => onModeChange("invoice")}
            className={cn(
              "flex items-center gap-xs rounded-sm px-md py-sm text-[13px] font-medium transition-colors",
              !isBottle
                ? "bg-white text-ink shadow-sm"
                : "text-ink-muted hover:text-ink",
            )}
          >
            <ScanLine className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Invoice
          </button>
          <button
            type="button"
            onClick={() => onModeChange("bottle")}
            className={cn(
              "flex items-center gap-xs rounded-sm px-md py-sm text-[13px] font-medium transition-colors",
              isBottle
                ? "bg-white text-ink shadow-sm"
                : "text-ink-muted hover:text-ink",
            )}
          >
            <Wine className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Bottle
          </button>
        </div>
      </div>

      <header className="mb-lg md:mb-xl">
        <h1 className="font-serif text-[22px] text-ink md:text-[28px]">
          {isBottle ? "Scan a bottle label" : "Scan an invoice"}
        </h1>
        <p className="mt-xs text-[14px] text-ink-muted md:text-[15px]">
          {isBottle
            ? "Photograph a wine label. We'll identify the wine in a few seconds."
            : "Photograph a wine invoice with your phone. Parsed in about 20 seconds."}
        </p>
      </header>

      {savedResult && (
        <div className="mb-lg flex items-center justify-between rounded-md border border-success/30 bg-success-soft px-md py-sm">
          <div className="flex items-center gap-sm">
            <Check className="h-4 w-4 text-success" strokeWidth={2.5} aria-hidden="true" />
            <span className="text-[14px] text-ink">
              Saved {savedResult.itemCount} {savedResult.itemCount === 1 ? "item" : "items"} to inventory ({savedResult.wineCount} distinct {savedResult.wineCount === 1 ? "wine" : "wines"})
            </span>
          </div>
          <div className="flex items-center gap-sm">
            <Link
              href="/lists"
              onClick={onDismissSaved}
              className="flex items-center gap-xs rounded-sm px-sm py-xs text-[13px] font-medium text-accent hover:bg-accent-soft"
            >
              <ListOrdered className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Add to wine list
            </Link>
            <button
              type="button"
              onClick={onDismissSaved}
              className="text-[13px] text-ink-muted hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => cameraRef.current?.click()}
        className="flex w-full flex-col items-center justify-center rounded-md border-2 border-dashed border-border-strong bg-surface-muted px-lg py-2xl text-center transition-colors hover:border-accent hover:bg-accent-soft/40 focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:py-3xl"
      >
        <span className="mb-md flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white md:h-16 md:w-16">
          <Camera className="h-6 w-6 md:h-7 md:w-7" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <h2 className="font-serif text-[20px] text-ink md:text-[22px]">
          {isBottle ? "Tap to photograph label" : "Tap to photograph"}
        </h2>
        <p className="mt-xs text-[13px] text-ink-muted">
          {isBottle ? "JPG or PNG · up to 20MB" : "JPG, PNG, or PDF · up to 20MB"}
        </p>
      </button>

      <div className="mt-md grid grid-cols-2 gap-sm md:mt-lg md:gap-md">
        <button
          type="button"
          onClick={() => cameraRef.current?.click()}
          className="flex h-12 items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px]"
        >
          <Camera className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Take photo
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-12 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px]"
        >
          <FileUp className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Upload file
        </button>
      </div>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <input
        ref={fileRef}
        type="file"
        accept={isBottle ? "image/jpeg,image/png" : "image/*,application/pdf"}
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
      />

      {!isBottle && <RecentScansList scans={recentScans} />}
    </section>
  );
}
