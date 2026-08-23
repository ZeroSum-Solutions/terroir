"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import {
  hasSelectableOptions,
  type CellarFacets,
  type CellarGroupBy,
  type FacetCounts,
} from "@/lib/cellar-facets";
import type { CellarFacetPatch } from "./cellar-facet-bar";

export type CellarSecondaryFacets = Pick<
  CellarFacets,
  "country" | "varietal" | "vintageMin" | "vintageMax" | "format"
>;

const GROUP_BY_OPTIONS: Array<{ value: CellarGroupBy | null; label: string }> = [
  { value: null, label: "None" },
  { value: "producer", label: "Producer" },
  { value: "region", label: "Region" },
  { value: "varietal", label: "Varietal" },
  { value: "vintage", label: "Vintage" },
];

/**
 * M2-15 §2.4 — the secondary filters (Country, Varietal, Vintage range,
 * Format, Group by) live behind one "Filters" action instead of sprawling
 * across the mobile layout as 8 standing dropdowns. Selections are staged
 * locally and only take effect on Apply; Reset clears everything — both
 * this sheet's own fields and the compact row's Producer/Region — while
 * staying open so the cleared state is visible.
 */
export function CellarFilterSheet({
  facets,
  counts,
  groupBy,
  onApply,
  onReset,
  onClose,
}: {
  facets: CellarSecondaryFacets;
  counts: FacetCounts;
  groupBy: CellarGroupBy | null;
  onApply: (patch: CellarFacetPatch, groupBy: CellarGroupBy | null) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "cellar-filter-sheet-heading";
  // The parent only mounts this component while the sheet is open, so the
  // draft naturally starts from the current committed state each time it
  // opens — no reset-on-open effect needed (React docs: prefer a fresh
  // mount over synchronizing state with an effect).
  const [draft, setDraft] = useState<CellarSecondaryFacets>(facets);
  const [draftGroupBy, setDraftGroupBy] = useState<CellarGroupBy | null>(groupBy);

  useFocusTrap({ containerRef: dialogRef, onEscape: onClose });

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const showCountry = hasSelectableOptions(counts.country);
  const showVarietal = hasSelectableOptions(counts.varietal);
  const showVintage = hasSelectableOptions(counts.vintage);
  const showFormat = hasSelectableOptions(counts.format);

  function handleReset() {
    setDraft({
      country: null,
      varietal: null,
      vintageMin: null,
      vintageMax: null,
      format: null,
    });
    setDraftGroupBy(null);
    onReset();
  }

  function handleApply() {
    onApply(draft, draftGroupBy);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 md:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-card bg-canvas md:max-w-[440px] md:rounded-card md:border md:border-hairline"
      >
        <header className="flex items-center justify-between border-b border-hairline px-md py-sm">
          <h2 id={headingId} className="font-serif text-[19px] font-medium text-ink">
            Filters
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="flex h-11 w-11 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
          >
            <X className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-md py-md">
          <div className="flex flex-col gap-md">
            {showCountry && (
              <SheetField
                label="Country"
                value={draft.country}
                options={counts.country}
                onChange={(country) => setDraft((d) => ({ ...d, country }))}
              />
            )}
            {showVarietal && (
              <SheetField
                label="Varietal"
                value={draft.varietal}
                options={counts.varietal}
                onChange={(varietal) => setDraft((d) => ({ ...d, varietal }))}
              />
            )}
            {showVintage && (
              <div>
                <span className="mb-2xs block text-[11px] font-medium uppercase tracking-wide text-grey">
                  Vintage
                </span>
                <div className="flex items-center gap-sm">
                  <SheetNumberField
                    label="Vintage from"
                    placeholder="From"
                    value={draft.vintageMin}
                    options={counts.vintage}
                    onChange={(vintageMin) => setDraft((d) => ({ ...d, vintageMin }))}
                  />
                  <span className="text-grey">–</span>
                  <SheetNumberField
                    label="Vintage to"
                    placeholder="To"
                    value={draft.vintageMax}
                    options={counts.vintage}
                    onChange={(vintageMax) => setDraft((d) => ({ ...d, vintageMax }))}
                  />
                </div>
              </div>
            )}
            {showFormat && (
              <SheetNumberField
                label="Format"
                value={draft.format}
                options={counts.format}
                formatLabel={(option) => `${option.label} ml (${option.count})`}
                onChange={(format) => setDraft((d) => ({ ...d, format }))}
              />
            )}
            <div>
              <label className="block">
                <span className="mb-2xs block text-[11px] font-medium uppercase tracking-wide text-grey">
                  Group by
                </span>
                <select
                  aria-label="Group by"
                  value={draftGroupBy ?? ""}
                  onChange={(event) =>
                    setDraftGroupBy((event.target.value || null) as CellarGroupBy | null)
                  }
                  className={fieldSelectClassName}
                >
                  {GROUP_BY_OPTIONS.map((option) => (
                    <option key={option.label} value={option.value ?? ""}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>

        <footer className="flex items-center gap-sm border-t border-hairline px-md py-sm">
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-pill border border-ink/20 text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-pill bg-primary text-[13px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}

const fieldSelectClassName =
  "h-11 w-full rounded-pill border border-ink/20 bg-white px-sm text-[13px] text-ink outline-none hover:bg-bridge-surface focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/15";

function SheetField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  options: FacetCounts["country"];
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="block">
      <span className="mb-2xs block text-[11px] font-medium uppercase tracking-wide text-grey">
        {label}
      </span>
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className={fieldSelectClassName}
      >
        <option value="">All {label.toLocaleLowerCase()}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.isUnknown}>
            {option.label} ({option.count})
          </option>
        ))}
      </select>
    </label>
  );
}

function SheetNumberField({
  label,
  placeholder,
  value,
  options,
  onChange,
  formatLabel = (option) => `${option.label} (${option.count})`,
}: {
  label: string;
  placeholder?: string;
  value: number | null | undefined;
  options: FacetCounts["vintage"];
  onChange: (value: number | null) => void;
  formatLabel?: (option: FacetCounts["vintage"][number]) => string;
}) {
  return (
    <label className="block flex-1">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        className={fieldSelectClassName}
      >
        <option value="">{placeholder ?? label}</option>
        {options
          .filter((option) => !option.isUnknown)
          .map((option) => (
            <option key={option.value} value={option.value}>
              {formatLabel(option)}
            </option>
          ))}
      </select>
    </label>
  );
}
