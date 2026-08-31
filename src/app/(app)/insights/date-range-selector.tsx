"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [pendingRange, setPendingRange] = useState<RangeOption | null>(null);
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
    setPendingRange(null);
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

  // The custom editor overlays the band's own caption now that it is anchored
  // rather than stacked, so it needs the two dismissals every overlay in this
  // repo has (settings-dropdown.tsx, overflow-menu.tsx): Escape, and a click
  // outside it. Picking any preset still closes it, as before.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(
    function dismissCustomEditor() {
      if (!showCustom) return;
      function onPointerDown(event: MouseEvent) {
        if (!containerRef.current?.contains(event.target as Node)) setShowCustom(false);
      }
      function onKeyDown(event: KeyboardEvent) {
        if (event.key === "Escape") setShowCustom(false);
      }
      document.addEventListener("mousedown", onPointerDown);
      document.addEventListener("keydown", onKeyDown);
      return function cleanup() {
        document.removeEventListener("mousedown", onPointerDown);
        document.removeEventListener("keydown", onKeyDown);
      };
    },
    [showCustom],
  );

  return (
    // `relative` so the custom editor can hang off the row instead of being a
    // second row inside it — see the comment on the panel below.
    <div ref={containerRef} className="relative">
      <div
        data-date-range-row
        className="flex flex-wrap items-center gap-2xs"
        role="radiogroup"
        aria-label="Date range"
      >
        {RANGE_OPTIONS.map(function (opt) {
          const isActive = (pendingRange ?? currentRange) === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-expanded={opt.value === "custom" ? showCustom : undefined}
              onClick={function () {
                if (opt.value === "custom") {
                  setShowCustom(true);
                } else {
                  setShowCustom(false);
                  setPendingRange(opt.value);
                  applyRange(opt.value);
                }
              }}
              className={
                "min-h-11 min-w-11 rounded-pill border px-sm py-2xs text-[12px] font-medium transition-colors " +
                (isActive
                  ? "border-ink bg-ink text-on-inverse"
                  : "border-edge text-ink hover:bg-wash")
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/*
        GLOBAL-01 — the custom range is a form, and it is not in the row.

        Measured on the running app at 390px (e2e/one-row-rule.test.ts): the six
        preset pills fit one line, 36…350 of 354px. Picking Custom used to add a
        SIBLING `flex-wrap` row holding a 130px from field, a 130px to field and
        Apply — nine controls on three visual lines, at y=674, y=726 and y=778.
        There is no arrangement of those nine that fits 318px of usable band, so
        the answer is not a narrower field: it is that they must not be on
        screen together.

        This is `src/components/overflow-menu.tsx`'s demotion, in the shape a
        form needs — same anchoring (`absolute top-full mt-xs`, card surface,
        overlay z-index), opened by the Custom pill that already existed, so the
        row pays ZERO extra controls for it. Stacked inside the panel the two
        date fields get the full width and a real label each, which they never
        had inline.
      */}
      {showCustom && (
        <div
          data-date-range-custom
          className="absolute left-0 top-full z-[var(--z-overlay)] mt-xs w-[min(320px,100%)] rounded-card card-surface p-md"
        >
          <p className="flex items-center gap-xs text-ledger font-medium text-ink">
            <Calendar className="h-4 w-4 shrink-0 text-grey" strokeWidth={1.5} aria-hidden />
            Custom range
          </p>
          <label className="mt-sm block text-caption font-medium uppercase text-grey" htmlFor="dr-from">
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
            className="mt-2xs h-11 w-full rounded-pill border border-edge bg-surface px-sm text-body-sm text-ink focus-ring"
          />
          <label className="mt-sm block text-caption font-medium uppercase text-grey" htmlFor="dr-to">
            To
          </label>
          <input
            id="dr-to"
            type="date"
            value={draftTo}
            onChange={function (e) { setDraftTo(e.target.value); }}
            min={draftFrom || ""}
            max={localToday}
            className="mt-2xs h-11 w-full rounded-pill border border-edge bg-surface px-sm text-body-sm text-ink focus-ring"
          />
          <button
            onClick={function () {
              if (canApplyCustom) {
                applyRange("custom", draftFrom, draftTo);
              }
            }}
            disabled={!canApplyCustom}
            className="mt-md min-h-11 w-full rounded-pill bg-primary px-sm text-body-sm font-medium text-seal-ink hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
