"use client";

import { cn } from "@/lib/utils";

/** Tiny stat chip used inside the drawer stock grid. */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="flex flex-col items-center gap-2xs">
      <span className="text-caption font-medium uppercase text-grey">
        {label}
      </span>
      <span
        className={cn(
          "text-[14px] font-semibold leading-none",
          // Wax & Counter: urgency speaks burgundy/gold via `accent`;
          // "Available" is the quiet default, not a celebration.
          tone === "warn" && "text-risk-ink",
          tone === "ok" && "text-ink",
          !tone && "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}
