"use client";

import { useEffect, useRef, useState } from "react";
import { CheckSquare, X } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import {
  hasSelectableOptions,
  type CellarFacets,
  type CellarGroupBy,
  type FacetCounts,
} from "@/lib/cellar-facets";
import {
  CELLAR_SORTS,
  CELLAR_SORT_LABELS,
  type CellarSort,
} from "@/lib/cellar-facets/sort";
import type { CellarFacetPatch } from "./cellar-facet-bar";

export type CellarSecondaryFacets = Pick<
  CellarFacets,
  "producer" | "region" | "country" | "varietal" | "vintageMin" | "vintageMax" | "format"
>;

const GROUP_BY_OPTIONS: Array<{ value: CellarGroupBy | null; label: string }> = [
  { value: null, label: "None" },
  { value: "producer", label: "Producer" },
  { value: "region", label: "Region" },
  { value: "varietal", label: "Varietal" },
  { value: "vintage", label: "Vintage" },
];

/**
 * CELLAR-01 — THE filter surface. Every facet the cellar has (Producer,
 * Region, Country, Varietal, Vintage range, Format), plus the sort and the
 * grouping, plus the entry point into select-wines mode. Producer and Region
 * used to stand outside as their own row; sort stood in the control row.
 * Consolidating them is what lets the page keep one row of controls.
 *
 * Selections are staged locally and only take effect on Apply; Reset clears
 * everything while staying open, so the cleared state is visible.
 */
export function CellarFilterSheet({
  facets,
  counts,
  groupBy,
  sort,
  onApply,
  onReset,
  onEnterSelectMode,
  onClose,
}: {
  facets: CellarSecondaryFacets;
  counts: FacetCounts;
  groupBy: CellarGroupBy | null;
  sort: CellarSort | null;
  onApply: (
    patch: CellarFacetPatch,
    groupBy: CellarGroupBy | null,
    sort: CellarSort | null,
  ) => void;
  onReset: () => void;
  /** Absent when this cellar has no sections to assign wines to. */
  onEnterSelectMode?: () => void;
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
  const [draftSort, setDraftSort] = useState<CellarSort | null>(sort);

  useFocusTrap({ containerRef: dialogRef, onEscape: onClose });

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const showProducer = hasSelectableOptions(counts.producer);
  const showRegion = hasSelectableOptions(counts.region);
  const showCountry = hasSelectableOptions(counts.country);
  const showVarietal = hasSelectableOptions(counts.varietal);
  const showVintage = hasSelectableOptions(counts.vintage);
  const showFormat = hasSelectableOptions(counts.format);

  function handleReset() {
    setDraft({
      producer: null,
      region: null,
      country: null,
      varietal: null,
      vintageMin: null,
      vintageMax: null,
      format: null,
    });
    setDraftGroupBy(null);
    setDraftSort(null);
    onReset();
  }

  function handleApply() {
    onApply(draft, draftGroupBy, draftSort);
    onClose();
  }

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop-click-to-dismiss is a mouse-only convenience; the dialog below already has full keyboard access via useFocusTrap (Escape + a visible Close button).
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center bg-scrim md:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-card bg-surface md:max-w-[440px] md:rounded-card md:border md:border-rule"
      >
        <header className="flex items-center justify-between border-b border-rule px-md py-sm">
          <h2 id={headingId} className="font-serif text-[19px] font-medium text-ink">
            Filters
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="flex h-11 w-11 items-center justify-center rounded-pill text-grey hover:bg-wash focus-ring"
          >
            <X className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-md py-md">
          <div className="flex flex-col gap-md">
            {showProducer && (
              <SheetField
                label="Producer"
                value={draft.producer}
                options={counts.producer}
                onChange={(producer) => setDraft((d) => ({ ...d, producer }))}
              />
            )}
            {showRegion && (
              <SheetField
                label="Region"
                value={draft.region}
                options={counts.region}
                onChange={(region) => setDraft((d) => ({ ...d, region }))}
              />
            )}
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
            <div>
              <label className="block">
                <span className="mb-2xs block text-caption font-medium uppercase text-grey">
                  Sort
                </span>
                <select
                  aria-label="Sort wines"
                  value={draftSort ?? ""}
                  onChange={(event) =>
                    setDraftSort((event.target.value || null) as CellarSort | null)
                  }
                  className={fieldSelectClassName}
                >
                  <option value="">Name A–Z</option>
                  {CELLAR_SORTS.map((option) => (
                    <option key={option} value={option}>
                      {CELLAR_SORT_LABELS[option]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {onEnterSelectMode && (
              <button
                type="button"
                onClick={() => {
                  onEnterSelectMode();
                  onClose();
                }}
                className="inline-flex min-h-11 items-center justify-center gap-xs rounded-pill border border-edge bg-surface text-body-sm font-medium text-ink hover:bg-wash focus-ring"
              >
                <CheckSquare className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                Select wines
              </button>
            )}
          </div>
        </div>

        <footer
          className="flex items-center gap-sm border-t border-rule px-md py-sm"
          style={{ paddingBottom: "calc(var(--safe-bottom) + var(--spacing-sm))" }}
        >
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-pill border border-edge text-body-sm font-medium text-ink hover:bg-wash focus-ring"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-pill bg-primary text-body-sm font-medium text-seal-ink hover:bg-primary-hover focus-ring"
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}

const fieldSelectClassName =
  "h-11 w-full rounded-pill border border-edge bg-surface px-sm text-[13px] text-ink hover:bg-wash focus-ring";

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
