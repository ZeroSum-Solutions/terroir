"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { AutoEightysixPanel } from "./auto-eightysix-panel";

/**
 * Auto-86 settings modal (Phase 2 IA redesign — .council/specs/2026-04-24-ux-ia-redesign.md
 * §4 "Auto-86 settings"). Wraps the existing owner-only panel behind
 * the cog icon in the Cellar header.
 *
 * Mobile: bottom sheet (anchored to bottom, slides up).
 * Desktop: centered card.
 */
export function AutoEightysixModal({
  open,
  restaurantId,
  enabled,
  thresholdMl,
  onClose,
}: {
  open: boolean;
  restaurantId: string;
  enabled: boolean;
  thresholdMl: number;
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
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 md:items-center md:p-lg"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full overflow-hidden rounded-t-md border-t border-x border-border bg-surface shadow-lg md:max-w-[520px] md:rounded-md md:border">
        <header className="flex items-center justify-between border-b border-border px-md py-md md:px-lg">
          <h2 id={headingId} className="font-serif text-[18px] text-ink">
            Cellar settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex h-9 w-9 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted"
          >
            <X className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>
        </header>
        <div className="px-md py-md md:px-lg md:py-lg" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}>
          <AutoEightysixPanel
            restaurantId={restaurantId}
            enabled={enabled}
            thresholdMl={thresholdMl}
          />
        </div>
      </div>
    </div>
  );
}
