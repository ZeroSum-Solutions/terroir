"use client";

// SCAN-09 — the search bar the Scan page did not have.
//
// Devin, field walk: "There should be a search bar where I can type in any
// wine, search for it, get the information I want, and be able to add that
// to my inventory… That simple search feature is nowhere on this page,
// which I think is a very large miss." Confirmed: scan/page.tsx,
// scanner.tsx and all six scan/views/*.tsx contained no search box.
//
// NOT the global search. A fourth workstream is adding a global navigation
// search to the app header (src/app/(app)/global-search.tsx). That one
// navigates; this one is a working surface — its whole reason to exist is
// the "Add to inventory" control on each result, which a navigation search
// must not have. They are deliberately different shapes: this is an inline
// panel on one page, not an overlay. If the two ever converge on the same
// component, the shared piece belongs in src/components/.
//
// "Or buy it" (the other half of Devin's sentence) is OUT OF SCOPE: there
// is no commerce anywhere in this product — no cart, no checkout, no
// merchant integration — and inventing one here would be a product
// decision, not an implementation.
//
// Backends are all pre-existing; nothing here is a new endpoint:
//   GET  /api/wines/search              — this cellar's own wines
//   GET  /api/wines/lwin-search         — the 211k-row LWIN catalogue
//   POST /api/inventory/save-bottle-scan — find-or-create wine + stock row

import { Check, Loader2, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { readApiError } from "@/lib/api/client-error";
import { cn } from "@/lib/utils";
import {
  RECENT_SEARCH_LIMIT,
  addRecentSearch,
  readRecentSearches,
} from "@/lib/wine-search-recents";

export type SearchScope = "cellar" | "catalogue";

type CellarWine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
};

type CatalogueWine = {
  lwin_id: string;
  display_name: string;
  producer: string | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
};

type Result = {
  key: string;
  title: string;
  producer: string;
  /** name/producer/vintage/region — "the information I want". */
  detail: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
  /** Set for a cellar hit, so the row can link to the wine it already is. */
  wineId: string | null;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 300;

function describe(parts: Array<string | number | null | undefined>): string {
  return parts.filter((part) => part !== null && part !== undefined && part !== "").join(" · ");
}

function toCellarResult(wine: CellarWine): Result {
  return {
    key: `cellar:${wine.id}`,
    title: wine.name,
    producer: wine.producer,
    detail: describe([wine.producer, wine.vintage, wine.varietal, wine.region]),
    vintage: wine.vintage,
    varietal: wine.varietal,
    region: wine.region,
    country: null,
    wineId: wine.id,
  };
}

function toCatalogueResult(wine: CatalogueWine): Result {
  return {
    key: `lwin:${wine.lwin_id}`,
    title: wine.display_name,
    producer: wine.producer ?? "",
    detail: describe([wine.producer, wine.varietal, wine.region, wine.country]),
    // The LWIN catalogue is vintage-less: a row is a cuvée, not a bottling.
    vintage: null,
    varietal: wine.varietal,
    region: wine.region,
    country: wine.country,
    wineId: null,
  };
}

export function WineSearchPanel() {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("cellar");
  const [results, setResults] = useState<Result[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [addedKey, setAddedKey] = useState<string | null>(null);
  const requestId = useRef(0);

  // Deferred into a promise continuation rather than called straight from
  // the effect body: localStorage is a client-only read, and
  // `react-hooks/set-state-in-effect` (rightly) rejects a synchronous
  // setState in an effect. Same pattern import-client.tsx already uses for
  // its spreadsheet hand-off.
  useEffect(() => {
    void Promise.resolve().then(() => setRecents(readRecentSearches()));
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    const id = ++requestId.current;
    // Every setState below lives inside this timer callback, never in the
    // effect body — including the "query got too short again" reset, which
    // is why that branch is here rather than an early return above.
    const timer = setTimeout(async () => {
      if (trimmed.length < MIN_QUERY) {
        setResults(null);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const path =
          scope === "cellar"
            ? `/api/wines/search?q=${encodeURIComponent(trimmed)}`
            : `/api/wines/lwin-search?q=${encodeURIComponent(trimmed)}`;
        const res = await fetch(path);
        if (!res.ok) throw new Error(`Search failed (${res.status})`);
        const body = await res.json();
        // A slower earlier request must never overwrite a newer one's
        // results — the reason this is an id and not a boolean.
        if (id !== requestId.current) return;
        setResults(
          scope === "cellar"
            ? (body as CellarWine[]).map(toCellarResult)
            : (body as CatalogueWine[]).map(toCatalogueResult),
        );
        setRecents(addRecentSearch(trimmed));
      } catch (e) {
        if (id !== requestId.current) return;
        setError(e instanceof Error ? e.message : "Search failed.");
        setResults([]);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, scope]);

  const addToInventory = useCallback(async (result: Result) => {
    setAddingKey(result.key);
    setError(null);
    try {
      const res = await fetch("/api/inventory/save-bottle-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wine: {
            name: result.title,
            // save-bottle-scan requires a non-empty producer. A great many
            // rows in this cellar have a blank one (the CSV re-import), and
            // the catalogue's producer is nullable — "Unknown" is what
            // /api/wines/create-from-lwin already writes in the same spot.
            producer: result.producer.trim() || "Unknown",
            vintage: result.vintage,
            varietal: result.varietal ?? "",
            region: result.region ?? "",
            country: result.country,
            qty: 1,
            unitCost: 0,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(readApiError(body, `Could not add (${res.status})`).message);
      }
      setAddedKey(result.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add to inventory.");
    } finally {
      setAddingKey(null);
    }
  }, []);

  const trimmed = query.trim();
  const showRecents = trimmed.length < MIN_QUERY && recents.length > 0;
  // Render-gated on the CURRENT query, so a previous query's results can
  // never flash while the debounce that clears them is still pending.
  const visibleResults = trimmed.length < MIN_QUERY ? null : results;

  return (
    <section aria-labelledby="wine-search-heading" className="mb-lg rounded-card card-surface p-md">
      <h2 id="wine-search-heading" className="sr-only">
        Search for a wine
      </h2>

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-md top-1/2 h-4 w-4 -translate-y-1/2 text-grey"
          strokeWidth={2}
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search any wine — producer, name, or region"
          aria-label="Search any wine"
          className="h-11 w-full rounded-pill border border-edge bg-surface pl-[38px] pr-[38px] text-control text-ink outline-none placeholder:text-grey focus-visible:border-accent focus-ring"
        />
        {query !== "" && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-sm top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-pill text-grey hover:text-ink focus-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>

      <div role="radiogroup" aria-label="Where to search" className="mt-sm flex gap-xs">
        {(
          [
            ["cellar", "My cellar"],
            ["catalogue", "Wine catalogue"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={scope === value}
            onClick={() => setScope(value)}
            className={cn(
              "inline-flex min-h-11 items-center rounded-pill border px-md text-ledger font-medium transition-colors focus-ring",
              scope === value
                ? "border-ink bg-ink text-on-inverse"
                : "border-edge bg-surface text-grey hover:bg-wash",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {showRecents && (
        <div className="mt-md">
          <p className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Recent searches
          </p>
          <div className="mt-xs flex flex-wrap gap-xs">
            {recents.slice(0, RECENT_SEARCH_LIMIT).map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => setQuery(term)}
                className="inline-flex min-h-11 items-center rounded-pill border border-rule bg-wash px-md text-ledger text-ink-soft hover:bg-surface-raised focus-ring"
              >
                {term}
              </button>
            ))}
          </div>
        </div>
      )}

      {trimmed.length < MIN_QUERY && !showRecents && (
        <p className="mt-sm text-body-sm text-grey">
          Type at least {MIN_QUERY} characters to search your cellar or the wine catalogue, then
          add a bottle straight to inventory.
        </p>
      )}

      {loading && (
        <p role="status" className="mt-md flex items-center gap-xs text-body-sm text-grey">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Searching…
        </p>
      )}

      {error && (
        <p role="alert" className="mt-md text-body-sm text-risk-ink">
          {error}
        </p>
      )}

      {!loading && visibleResults !== null && visibleResults.length === 0 && !error && (
        <p className="mt-md text-body-sm text-grey">
          {scope === "cellar"
            ? "Nothing in your cellar matches that. Try the wine catalogue."
            : "No catalogue match. Photograph the label instead — the scanner reads bottles the catalogue has never heard of."}
        </p>
      )}

      {!loading && visibleResults !== null && visibleResults.length > 0 && (
        <ul className="mt-md flex flex-col gap-xs">
          {visibleResults.map((result) => (
            <li
              key={result.key}
              className="flex items-center gap-sm rounded-md border border-rule bg-surface p-sm"
            >
              <div className="min-w-0 flex-1">
                {result.wineId ? (
                  <Link
                    href={`/cellar/${result.wineId}`}
                    className="block truncate text-control font-medium text-ink hover:text-accent focus-ring"
                  >
                    {result.title}
                  </Link>
                ) : (
                  <span className="block truncate text-control font-medium text-ink">
                    {result.title}
                  </span>
                )}
                {result.detail && (
                  <span className="mt-2xs block truncate text-ledger text-grey">
                    {result.detail}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void addToInventory(result)}
                disabled={addingKey === result.key || addedKey === result.key}
                aria-label={`Add ${result.title} to inventory`}
                className="flex h-11 shrink-0 items-center justify-center gap-xs rounded-pill border border-edge bg-surface px-md text-ledger font-medium text-ink hover:bg-wash focus-ring disabled:opacity-60"
              >
                {addingKey === result.key ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : addedKey === result.key ? (
                  <Check className="h-4 w-4 text-ready-ink" strokeWidth={2} aria-hidden="true" />
                ) : (
                  <Plus className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                )}
                <span className="hidden sm:inline">
                  {addedKey === result.key ? "Added" : "Add bottle"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
