"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Calendar } from "lucide-react";

type RangeOption = "7d" | "30d" | "90d" | "ytd" | "all" | "custom";

const RANGE_OPTIONS: { value: RangeOption; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
];

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function ytdStart(): string {
  const d = new Date();
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export default function DateRangeSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentRange = (searchParams.get("range") as RangeOption | null) ?? "all";
  const currentFrom = searchParams.get("from") ?? "";
  const currentTo = searchParams.get("to") ?? "";

  const [showCustom, setShowCustom] = useState(currentRange === "custom");
  const [draftFrom, setDraftFrom] = useState(
    currentFrom || ytdStart(),
  );
  const [draftTo, setDraftTo] = useState(currentTo || todayStr());

  const applyRange = useCallback(
    (range: RangeOption, from?: string, to?: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("range", range);
      if (range === "custom" && from && to) {
        params.set("from", from);
        params.set("to", to);
      } else {
        params.delete("from");
        params.delete("to");
      }
      router.push("/insights?" + params.toString(), { scroll: false });
    },
    [router, searchParams],
  );

  return (
    <div className="flex flex-wrap items-center gap-sm">
      <div
        className="flex rounded-sm border border-border overflow-hidden"
        role="radiogroup"
        aria-label="Date range"
      >
        {RANGE_OPTIONS.map(function (opt) {
          const isActive =
            (currentRange === opt.value && opt.value !== "custom") ||
            (currentRange === "custom" && opt.value === "custom");
          return (
            <button
              key={opt.value}
              role="radio"
              aria-checked={isActive && !showCustom}
              onClick={function () {
                if (opt.value === "custom") {
                  setShowCustom(!showCustom);
                } else {
                  setShowCustom(false);
                  applyRange(opt.value);
                }
              }}
              className={
                "px-sm py-2xs text-[12px] font-medium transition-colors " +
                (isActive
                  ? "bg-accent text-white"
                  : "text-ink-muted hover:bg-surface-muted")
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {showCustom && (
        <div className="flex items-center gap-xs">
          <Calendar className="h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.5} />
          <label className="sr-only" htmlFor="dr-from">
            From
          </label>
          <input
            id="dr-from"
            type="date"
            value={draftFrom}
            onChange={function (e) { setDraftFrom(e.target.value); }}
            max={draftTo || todayStr()}
            className="h-[28px] w-[130px] rounded-sm border border-border bg-white px-xs text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent-soft"
          />
          <span className="text-[12px] text-ink-muted">&ndash;</span>
          <label className="sr-only" htmlFor="dr-to">
            To
          </label>
          <input
            id="dr-to"
            type="date"
            value={draftTo}
            onChange={function (e) { setDraftTo(e.target.value); }}
            min={draftFrom || ""}
            max={todayStr()}
            className="h-[28px] w-[130px] rounded-sm border border-border bg-white px-xs text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent-soft"
          />
          <button
            onClick={function () { applyRange("custom", draftFrom, draftTo); }}
            disabled={!draftFrom || !draftTo}
            className="h-[28px] rounded-sm bg-accent px-sm text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
