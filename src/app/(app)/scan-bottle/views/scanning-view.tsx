"use client";

import { Keyboard, ScanLine } from "lucide-react";
import type { RefObject } from "react";

interface ScanningViewProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  onEnterCode: () => void;
}

export function ScanningView({ videoRef, onEnterCode }: ScanningViewProps) {
  return (
    <div className="space-y-md">
      <div className="relative overflow-hidden rounded-card border-2 border-rule bg-black">
        <div className="relative pb-[75%]">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-48 w-48 rounded-lg border-2 border-accent/60 md:h-56 md:w-56" />
          </div>
        </div>
        <div className="absolute bottom-md left-1/2 -translate-x-1/2">
          {/* Over live camera video — a fixed dark media scrim, not a
              themed surface (dark-mode ink is champagne). */}
          <span className="inline-flex items-center gap-sm rounded-pill bg-black/70 px-md py-sm text-[13px] font-medium text-white backdrop-blur-sm">
            <ScanLine className="h-4 w-4 animate-pulse" strokeWidth={2} />
            Point camera at QR code
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onEnterCode}
        className="flex h-[44px] w-full items-center justify-center gap-sm rounded-pill border border-edge bg-surface text-[14px] font-medium text-ink hover:bg-wash focus-ring"
      >
        <Keyboard className="h-4 w-4" strokeWidth={2} />
        Enter code manually
      </button>
    </div>
  );
}
