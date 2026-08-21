"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Calendar } from "lucide-react";
import {
  formatLocalDate,
  isValidCustomRange,
  normalizeInsightsRange,
} from "./date-range";

export { formatLocalDate, isValidCustomRange } from "./date-range";

type RangeOption = "7d" | "30d" | "90d" | "ytd" | "all" | "custom";

const RANGE_OPTIONS: { value: RangeOption; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

function isRangeOption(value: string | null): value is RangeOption {
  return RANGE_OPTIONS.some((option) => option.value === value);
}

function todayStr(): string {
  return formatLocalDate(new Date());
}

function ytdStart(): string {
  return formatLocalDate(new Date(new Date().getFullYear(), 0, 1));
}

export default function DateRangeSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const rangeParam = searchParams.get("range");
  const currentFrom = searchParams.get("from") ?? "";
  const currentTo = searchParams.get("to") ?? "";
  const localToday = todayStr();
  const normalizedRange = normalizeInsightsRange(
    rangeParam ?? undefined,
    currentFrom || undefined,
    currentTo || undefined,
    localToday,
  );
  const currentRange = isRangeOption(normalizedRange.range)
    ? normalizedRange.range
    : "all";
  const normalizedFrom = normalizedRange.from ?? "";
  const normalizedTo = normalizedRange.to ?? "";

  const [showCustom, setShowCustom] = useState(currentRange === "custom");
  const [draftFrom, setDraftFrom] = useState(
    currentRange === "custom" && normalizedFrom ? normalizedFrom : ytdStart(),
  );
  const [draftTo, setDraftTo] = useState(
    currentRange === "custom" && normalizedTo ? normalizedTo : localToday,
  );
  const [previousSearchValues, setPreviousSearchValues] = useState({
    range: rangeParam,
    from: currentFrom,
    to: currentTo,
  });

  if (
    previousSearchValues.range !== rangeParam ||
    previousSearchValues.from !== currentFrom ||
    previousSearchValues.to !== currentTo
  ) {
    setPreviousSearchValues({
      range: rangeParam,
      from: currentFrom,
      to: currentTo,
    });
    setShowCustom(currentRange === "custom");
    setDraftFrom(
      currentRange === "custom" && normalizedFrom ? normalizedFrom : ytdStart(),
    );
    setDraftTo(
      currentRange === "custom" && normalizedTo ? normalizedTo : todayStr(),
    );
  }

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
  const canApplyCustom = isValidCustomRange(
    draftFrom,
    draftTo,
    localToday,
  );

  return (
    <div className="flex flex-wrap items-center gap-xs">
      <div
        className="flex flex-wrap items-center gap-2xs"
        role="radiogroup"
        aria-label="Date range"
      >
        {RANGE_OPTIONS.map(function (opt) {
          const isActive = currentRange === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={function () {
                if (opt.value === "custom") {
                  setShowCustom(true);
                } else {
                  setShowCustom(false);
                  applyRange(opt.value);
                }
              }}
              className={
                "min-h-11 min-w-11 rounded-pill border px-sm py-2xs text-[12px] font-medium transition-colors " +
                (isActive
                  ? "border-ink bg-ink text-beige"
                  : "border-ink/25 text-ink hover:bg-bridge-surface")
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {showCustom && (
        <div className="flex flex-wrap items-center gap-xs">
          <Calendar className="h-4 w-4 shrink-0 text-grey" strokeWidth={1.5} />
          <label className="sr-only" htmlFor="dr-from">
            From
          </label>
          <input
            id="dr-from"
            type="date"
            value={draftFrom}
            onChange={function (e) { setDraftFrom(e.target.value); }}
            max={
              isValidCustomRange(draftTo, draftTo, localToday)
                ? draftTo
                : localToday
            }
            className="min-h-11 w-[130px] rounded-pill border border-ink/25 bg-white px-sm text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent-soft"
          />
          <span className="text-[12px] text-grey">&ndash;</span>
          <label className="sr-only" htmlFor="dr-to">
            To
          </label>
          <input
            id="dr-to"
            type="date"
            value={draftTo}
            onChange={function (e) { setDraftTo(e.target.value); }}
            min={draftFrom || ""}
            max={localToday}
            className="min-h-11 w-[130px] rounded-pill border border-ink/25 bg-white px-sm text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent-soft"
          />
          <button
            onClick={function () {
              if (canApplyCustom) {
                applyRange("custom", draftFrom, draftTo);
              }
            }}
            disabled={!canApplyCustom}
            className="min-h-11 rounded-pill bg-primary px-sm text-[12px] font-medium text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
