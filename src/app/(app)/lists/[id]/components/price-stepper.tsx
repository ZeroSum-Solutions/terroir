"use client";

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * LIST-03 / LIST-04 — the price control on a wine-list row.
 *
 * Two changes from the `PriceInput` it replaces:
 *
 *  1. **A dash is no longer the default.** When the stored price is null the
 *     suggested price is shown instead, marked as a suggestion rather than a
 *     set price. "—" survives only where no suggestion can be computed, which
 *     is the one case where the app genuinely has nothing to offer.
 *  2. **Minus / value / plus, a dollar at a time**, per the PRD. Stepping from
 *     a suggestion commits it: the first tap turns the proposal into a price.
 *
 * The value itself stays click-to-edit, so typing an exact number is still one
 * interaction rather than twelve taps.
 */

export function formatPrice(value: number | null) {
  if (value == null) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function PriceStepper({
  value,
  suggested,
  label,
  muted,
  readOnly,
  onChange,
}: {
  /** The stored price. Null means "not set". */
  value: number | null;
  /** LIST-03 suggestion, already carrying the settings markup rule. */
  suggested?: number | null;
  /** Names this control for assistive tech, e.g. "glass price for Barolo". */
  label: string;
  muted?: boolean;
  /**
   * SD-12 — PATCH /api/wine-list-items/{id} is owner/manager only. A staff
   * member still needs to read the price, so the control collapses to the
   * number rather than disappearing.
   */
  readOnly?: boolean;
  onChange: (value: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const isSuggestion = value == null && suggested != null;
  const effective = value ?? suggested ?? null;

  if (readOnly) {
    return (
      <div
        className={cn(
          "min-h-11 px-2xs py-sm text-right tabular text-control",
          isSuggestion ? "italic text-grey" : muted ? "text-grey" : "text-ink",
        )}
      >
        {formatPrice(effective)}
      </div>
    );
  }

  const commit = () => {
    setEditing(false);
    const parsed = parseFloat(draft);
    if (draft.trim() === "" || draft.trim() === "—") {
      onChange(null);
    } else if (!isNaN(parsed) && parsed >= 0) {
      onChange(Math.round(parsed * 100) / 100);
    }
  };

  const step = (delta: number) => {
    if (effective == null) return;
    onChange(Math.max(0, Math.round(effective) + delta));
  };

  if (editing) {
    return (
      <div className="relative">
        <span className="pointer-events-none absolute left-xs top-1/2 -translate-y-1/2 tabular text-control text-grey">
          $
        </span>
        <input
          autoFocus
          type="text"
          inputMode="decimal"
          aria-label={label}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setEditing(false);
          }}
          className="min-h-11 w-full rounded-md border-2 border-mark bg-surface py-2xs pl-md pr-xs text-right tabular text-control text-ink focus-ring"
        />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-end overflow-hidden rounded-pill border border-edge bg-surface">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          disabled={effective == null}
          onClick={() => step(-1)}
          className="flex h-11 w-11 shrink-0 items-center justify-center text-grey hover:text-ink focus-ring-inset disabled:text-grey/40"
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Edit ${label}`}
          onClick={() => {
            setDraft(effective?.toString() ?? "");
            setEditing(true);
          }}
          className={cn(
            "min-h-11 flex-1 px-2xs text-center tabular text-control transition-colors hover:bg-wash",
            isSuggestion
              ? "italic text-grey"
              : muted
                ? "text-grey"
                : "text-ink",
          )}
          title={
            isSuggestion
              ? "Suggested price — step or type to set it"
              : "Click to edit"
          }
        >
          {formatPrice(effective)}
        </button>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          disabled={effective == null}
          onClick={() => step(1)}
          className="flex h-11 w-11 shrink-0 items-center justify-center text-grey hover:text-ink focus-ring-inset disabled:text-grey/40"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
      {isSuggestion && (
        <div className="mt-2xs text-center text-micro uppercase text-grey">
          Suggested
        </div>
      )}
    </div>
  );
}
