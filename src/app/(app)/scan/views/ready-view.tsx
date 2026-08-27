"use client";

import { ArrowRight, Camera, FileUp, ImageIcon, Wine } from "lucide-react";
import { Check, ListOrdered, ScanLine } from "lucide-react";
import { useRef, type RefObject } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { TimeAgo } from "@/components/time-ago";
import { accuracyColor } from "@/lib/scanner/accuracy-color";
import { markScanStage } from "@/lib/scanner/scan-timing";
import type { RecentScan, ScanMode } from "@/lib/scanner/types";
import { formatMoney } from "../components/field-inputs";

interface RecentScansListProps {
  scans: RecentScan[];
}

function RecentScansList({ scans }: RecentScansListProps) {
  if (scans.length === 0) return null;
  return (
    <section className="mt-2xl">
      <div className="mb-md flex items-center justify-between"><h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">Recent scans</h3><Link href="/scans" className="inline-flex min-h-11 items-center gap-xs text-[11px] font-medium text-grey hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">View all<ArrowRight className="h-3 w-3" strokeWidth={2} /></Link></div>
      <div className="grid grid-cols-1 gap-sm md:grid-cols-3 md:gap-md">
        {scans.map((s) => (
          <Link
            key={s.id}
            href={`/scan/${s.id}`}
            className="block min-h-11 rounded-lg card-surface p-md transition-colors hover:border-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <div className="mb-sm flex items-center justify-between">
              <TimeAgo iso={s.parsedAt} className="tabular text-[12px] text-ink-muted" />
              <div className="flex items-center gap-xs">
                {s.hasImage && (
                  <ImageIcon className="h-3 w-3 text-ink-subtle" strokeWidth={2} aria-label="Has invoice image" />
                )}
                <span className={cn("tabular text-[12px]", accuracyColor(s.accuracy))}>{s.accuracy}%</span>
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
  onStart: (files: File[]) => void;
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

  // M1-1: client-side "capture" stage starts here — the moment the user
  // taps to open the camera/file picker.
  const beginCapture = (inputRef: RefObject<HTMLInputElement | null>) => {
    markScanStage("capture", "start");
    inputRef.current?.click();
  };

  const handleFiles = (input: HTMLInputElement) => {
    const fileArr = input.files ? Array.from(input.files) : [];
    // Reset so re-selecting the exact same file (e.g. retaking a photo
    // after "New photo") reliably fires `change` again — some mobile
    // browsers/webviews otherwise treat an unchanged input as a no-op.
    input.value = "";
    if (fileArr.length === 0) return;
    // M1-1: client-side "capture" stage ends here (started at the
    // take-photo/upload-file button click below); reported once a scan id
    // exists, in scanner.tsx's startScan.
    markScanStage("capture", "end");
    onStart(fileArr);
  };

  return (
    <section>
      {/* Mode toggle */}
      <div className="mb-lg flex items-center justify-center">
        <div className="inline-flex rounded-pill border border-hairline bg-bridge-surface p-0.5">
          <button
            type="button"
            onClick={() => onModeChange("invoice")}
            aria-pressed={!isBottle}
            className={cn(
              "flex min-h-11 items-center gap-xs rounded-pill px-md py-sm text-[13px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              !isBottle
                ? "bg-ink text-beige"
                : "text-grey hover:text-ink",
            )}
          >
            <ScanLine className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Invoice
          </button>
          <button
            type="button"
            onClick={() => onModeChange("bottle")}
            aria-pressed={isBottle}
            className={cn(
              "flex min-h-11 items-center gap-xs rounded-pill px-md py-sm text-[13px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              isBottle
                ? "bg-ink text-beige"
                : "text-grey hover:text-ink",
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
        <p className="mt-xs text-[14px] text-grey md:text-[15px]">
          {isBottle
            ? "Photograph a wine label. We'll identify the wine in a few seconds."
            : "Parsed into inventory in about 20 seconds."}
        </p>
      </header>

      {savedResult && (
        <div className="mb-lg flex items-center justify-between rounded-card border border-hairline bg-sage-wash px-md py-sm">
          <div className="flex items-center gap-sm">
            <Check className="h-4 w-4 text-sage-ink" strokeWidth={2.5} aria-hidden="true" />
            <span role="status" aria-live="polite" className="text-[14px] text-ink">
              Saved {savedResult.itemCount} {savedResult.itemCount === 1 ? "item" : "items"} to inventory ({savedResult.wineCount} distinct {savedResult.wineCount === 1 ? "wine" : "wines"})
            </span>
          </div>
          <div className="flex items-center gap-sm">
            <Link
              href="/lists"
              onClick={onDismissSaved}
              className="flex min-h-11 items-center gap-xs rounded-pill px-sm py-xs text-[13px] font-medium text-accent hover:bg-blush-wash focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <ListOrdered className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Add to wine list
            </Link>
            <button
              type="button"
              onClick={onDismissSaved}
              className="min-h-11 text-[13px] text-grey hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => beginCapture(cameraRef)}
        className="flex min-h-11 w-full flex-col items-center justify-center rounded-card border-2 border-dashed border-beige-deep bg-bridge-surface px-lg py-2xl text-center transition-colors hover:border-accent hover:bg-blush-wash/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:py-3xl"
      >
        <span className="mb-md flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white md:h-16 md:w-16">
          <Camera className="h-6 w-6 md:h-7 md:w-7" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <h2 className="font-serif text-[20px] text-ink md:text-[22px]">
          {isBottle ? "Tap to photograph label" : "Tap to photograph"}
        </h2>
        {/* The zone is a camera target — advertising PDF formats on it was
            dishonest (a camera can't capture a PDF); file specs live on the
            upload affordance below (Kimi audit 2026-08-26). */}
        <p className="mt-xs text-[13px] text-grey">
          {isBottle
            ? "One label per photo"
            : "You'll review parsed lines before they reach the cellar"}
        </p>
      </button>

      {/* One camera entrance (the zone above) + one upload entrance — the
          old "Take photo" button duplicated the zone exactly. */}
      <div className="mt-md md:mt-lg">
        <button
          type="button"
          onClick={() => beginCapture(fileRef)}
          className="flex h-12 w-full items-center justify-center gap-sm rounded-pill border border-ink/25 bg-surface text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <FileUp className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Upload file
        </button>
        <p className="mt-xs text-center text-[12px] text-grey">
          {isBottle
            ? "JPG or PNG · up to 20MB"
            : "JPG, PNG, or PDF · up to 10MB · multi-page invoices welcome"}
        </p>
      </div>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => handleFiles(e.currentTarget)}
      />
      <input
        ref={fileRef}
        type="file"
        accept={isBottle ? "image/jpeg,image/png" : "image/*,application/pdf"}
        // A multi-page invoice can genuinely be scanned as several files
        // in one batch (BND-081 / TER-CF-032); a bottle scan identifies
        // one wine from one label photo, so there's nothing to batch.
        multiple={!isBottle}
        className="sr-only"
        onChange={(e) => handleFiles(e.currentTarget)}
      />

      {!isBottle && <RecentScansList scans={recentScans} />}
    </section>
  );
}
