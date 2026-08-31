"use client";

import { X } from "lucide-react";
import type { MatchedWine } from "../scan-bottle-state";

interface CorrectingViewProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searching: boolean;
  searchResults: MatchedWine[];
  searchError: string | null;
  onSelect: (wine: MatchedWine) => void;
  onCancel: () => void;
}

export function CorrectingView({
  searchQuery,
  onSearchChange,
  searching,
  searchResults,
  searchError,
  onSelect,
  onCancel,
}: CorrectingViewProps) {
  return (
    <div className="space-y-md">
      <div className="rounded-card card-surface p-md md:p-lg">
        <label
          htmlFor="correct-search"
          className="mb-xs block text-caption font-medium uppercase tracking-[0.18em] text-grey"
        >
          Search for the correct wine
        </label>
        <input
          id="correct-search"
          type="search"
          inputMode="search"
          autoComplete="off"
          autoFocus
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by producer, name, or vintage..."
          className="w-full rounded-pill border border-rule bg-surface px-md py-sm text-[14px] text-ink placeholder:text-grey focus:border-accent focus-ring"
        />
      </div>

      {searching && (
        <p className="px-md text-[13px] text-grey">Searching...</p>
      )}

      {!searching && searchError && (
        <p role="alert" className="px-md text-body-sm text-risk-ink">
          {searchError}
        </p>
      )}

      {!searching && searchResults.length > 0 && (
        <ul className="divide-y divide-rule rounded-card card-surface">
          {searchResults.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() => onSelect(w)}
                className="flex w-full items-start gap-md px-md py-md text-left hover:bg-wash focus-ring"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-serif text-[17px] font-medium text-ink">
                    {w.producer}
                  </p>
                  <p className="truncate text-[14px] text-grey">
                    {w.name}
                    {w.vintage ? ", " + w.vintage : ""}
                  </p>
                </div>
                <span className="mt-0.5 shrink-0 text-[11px] text-grey">
                  {w.varietal}
                  {w.varietal && w.region ? " . " : ""}
                  {w.region}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!searching &&
        !searchError &&
        searchQuery.length >= 2 &&
        searchResults.length === 0 && (
          <p className="px-md text-[13px] text-grey">
            No wines found for &ldquo;
            {searchQuery}
            &rdquo;.
          </p>
        )}

      <button
        type="button"
        onClick={onCancel}
        className="flex h-[44px] w-full items-center justify-center gap-sm rounded-pill border border-edge bg-surface text-[14px] font-medium text-ink hover:bg-wash focus-ring"
      >
        <X className="h-4 w-4" strokeWidth={2} />
        Cancel
      </button>
    </div>
  );
}
