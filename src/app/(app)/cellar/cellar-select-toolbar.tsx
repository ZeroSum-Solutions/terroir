"use client";

import { Layers, ChevronDown, X } from "lucide-react";

type CellarSection = { id: string; name: string };

/**
 * CELLAR-01 — the bulk-assign toolbar for select-wines mode (BND-064).
 *
 * It used to sit under a standing "Select wines" button that was a fourth row
 * of controls on its own. The mode is now entered from the filter surface, so
 * this only ever renders while the mode is active — a toolbar, not a row of
 * page chrome.
 */
export function CellarSelectToolbar({
  sections,
  totalCount,
  selectedCount,
  assignTarget,
  busy,
  onSelectAll,
  onDeselectAll,
  onAssignTargetChange,
  onConfirm,
  onExit,
}: {
  sections: CellarSection[];
  totalCount: number;
  selectedCount: number;
  /** `"__open__"` means the section menu is open but nothing is chosen yet. */
  assignTarget: string | null;
  busy: boolean;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onAssignTargetChange: (target: string | null) => void;
  onConfirm: () => void;
  onExit: () => void;
}) {
  return (
    <div className="mb-sm flex items-center gap-xs">
      <div className="flex w-full flex-wrap items-center gap-xs">
        <button
          type="button"
          onClick={onSelectAll}
          className="inline-flex min-h-11 items-center rounded-pill border border-edge bg-surface px-sm text-ledger font-medium text-ink hover:bg-wash"
        >
          Select all ({totalCount})
        </button>
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={onDeselectAll}
            className="inline-flex min-h-11 items-center rounded-pill border border-edge bg-surface px-sm text-ledger font-medium text-grey hover:bg-wash"
          >
            Clear
          </button>
        )}
        {selectedCount > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => onAssignTargetChange(assignTarget ? null : "__open__")}
              className="inline-flex min-h-11 items-center gap-xs rounded-pill bg-primary px-sm text-ledger font-medium text-seal-ink hover:bg-primary-hover"
            >
              <Layers className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              Assign {selectedCount} to section
              <ChevronDown className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
            {assignTarget === "__open__" && (
              <div className="absolute top-full left-0 mt-1 z-[var(--z-overlay)] w-56 rounded-lg card-surface py-xs">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => onAssignTargetChange(section.name)}
                    className="block min-h-11 w-full px-sm py-xs text-left text-body-sm text-ink hover:bg-wash"
                  >
                    {section.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {assignTarget && assignTarget !== "__open__" && (
          <div className="flex items-center gap-xs">
            <span className="text-ledger text-grey">
              Assign to <strong>{assignTarget}</strong>?
            </span>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="inline-flex min-h-11 items-center rounded-pill bg-primary px-sm text-ledger font-medium text-seal-ink hover:bg-primary-hover disabled:opacity-60"
            >
              {busy ? "…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => onAssignTargetChange(null)}
              disabled={busy}
              aria-label="Cancel assignment"
              className="inline-flex h-11 w-11 items-center justify-center rounded-pill border border-edge bg-surface text-grey hover:bg-wash disabled:opacity-60"
            >
              <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onExit}
          className="ml-auto inline-flex min-h-11 items-center rounded-pill border border-edge bg-surface px-sm text-ledger font-medium text-grey hover:bg-wash"
        >
          Done
        </button>
      </div>
    </div>
  );
}
