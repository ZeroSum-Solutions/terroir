"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import { ReconcileList } from "./reconcile-list";

/**
 * Reconcile mode (Phase 2 IA redesign — .council/specs/2026-04-24-ux-ia-redesign.md
 * §4 "Reconcile mode").
 *
 * Wraps the existing ReconcileList in a full-screen modal/sheet so
 * end-of-shift correction stays in the Cellar surface instead of being
 * its own tab. Owner/manager only — visibility is controlled by the
 * parent CellarShell, which only renders the trigger button when role
 * permits.
 *
 * Mobile: full-screen sheet (covers the bottom-nav). The save bar inside
 * ReconcileList already pins to bottom — works the same as the old
 * /reconcile page.
 *
 * Desktop: full-screen overlay with a centered card (cleaner than a
 * right-rail panel because the list can grow tall and the sticky save
 * bar needs viewport space).
 */
export function ReconcileModal({
  open,
  items,
  varianceThresholdOz,
  onClose,
}: {
  open: boolean;
  items: OpenBottleRow[];
  varianceThresholdOz?: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "reconcile-modal-heading";

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: onClose,
    enabled: open,
  });

  // Lock body scroll while modal is open. The full-screen overlay
  // would otherwise allow the page underneath to scroll on iOS.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="fixed inset-0 z-50 flex flex-col bg-canvas md:items-center md:justify-center md:bg-scrim md:p-lg"
    >
      <div className="flex h-full w-full flex-col overflow-hidden bg-surface md:h-[min(720px,90vh)] md:max-w-[640px] md:rounded-card md:border md:border-hairline">
        <header
          className="flex items-center justify-between border-b border-hairline px-md py-md md:px-lg"
          style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}
        >
          <div>
            <h2
              id={headingId}
              className="font-serif text-[20px] font-medium text-ink md:text-[22px]"
            >
              Reconcile open bottles
            </h2>
            <p className="mt-2xs text-[13px] text-grey">
              End-of-shift correction. Set each open bottle to its actual
              remaining level.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close reconcile mode"
            className="ml-md flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface"
          >
            <X className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-md py-md md:px-lg md:py-lg">
          <ReconcileList initialItems={items} varianceThresholdOz={varianceThresholdOz} />
        </div>
      </div>
    </div>
  );
}
