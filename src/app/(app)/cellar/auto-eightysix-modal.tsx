"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { X, Layers } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { AutoEightysixPanel } from "./auto-eightysix-panel";
import { PricingTargetsPanel } from "./pricing-targets-panel";

/**
 * Cellar settings modal — owner-only configuration surface behind the
 * cog icon in the Cellar header.
 *
 * Hosts two panels:
 *   1. Auto-86 from inventory (BND-037b + BND-173 eightysix_strategy)
 *   2. House pricing targets (BND-040 follow-up — pour cost % + bottle
 *      markup ratio that drive every pricing recommendation)
 *
 * Also links to /cellar/config for managing cellar sections (BND-060).
 *
 * Mobile: bottom sheet (anchored to bottom, slides up).
 * Desktop: centered card.
 */
export function AutoEightysixModal({
  open,
  restaurantId,
  enabled,
  thresholdMl,
  eightysixStrategy,
  defaultTargetPourCostPct,
  defaultTargetMarkupRatio,
  onClose,
}: {
  open: boolean;
  restaurantId: string;
  enabled: boolean;
  thresholdMl: number;
  eightysixStrategy: "hide" | "mark";
  defaultTargetPourCostPct: number | null;
  defaultTargetMarkupRatio: number | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "auto86-modal-heading";

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: onClose,
    enabled: open,
  });

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
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- backdrop-click-to-dismiss is a mouse-only convenience; this dialog already has full keyboard access via useFocusTrap (Escape + a visible Close button).
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center bg-scrim md:items-center md:p-lg"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-lg border-t border-x border-hairline bg-surface md:max-h-[80vh] md:max-w-[560px] md:rounded-card md:border">
        <header className="flex shrink-0 items-center justify-between border-b border-hairline px-md py-md md:px-lg">
          <h2 id={headingId} className="font-serif text-[18px] font-medium text-ink">
            Cellar settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex h-9 w-9 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface"
          >
            <X className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>
        </header>
        <div
          className="flex flex-col gap-md overflow-y-auto overscroll-contain px-md py-md md:gap-lg md:px-lg md:py-lg"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
        >
          <PricingTargetsPanel
            restaurantId={restaurantId}
            pourCostPct={defaultTargetPourCostPct}
            markupRatio={defaultTargetMarkupRatio}
          />
          <AutoEightysixPanel
            restaurantId={restaurantId}
            enabled={enabled}
            thresholdMl={thresholdMl}
            eightysixStrategy={eightysixStrategy}
          />
          {/* BND-060: link to cellar section configuration */}
          <Link
            href="/cellar/config"
            onClick={onClose}
            className="flex items-center justify-center gap-xs rounded-pill border border-edge bg-surface py-sm text-[14px] font-medium text-ink transition-colors hover:bg-bridge-surface"
          >
            <Layers className="h-4 w-4" strokeWidth={2} aria-hidden />
            Manage cellar sections
          </Link>
        </div>
      </div>
    </div>
  );
}
