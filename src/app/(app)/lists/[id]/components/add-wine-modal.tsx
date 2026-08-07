"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, Search, Sparkles } from "lucide-react";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
} from "@/lib/api/idempotency-client";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";

const lwinImportCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence("terroir:lwin-import"),
});

// BND-040 — pricing suggestion response shape from
// /api/wines/[id]/pricing-suggestion. Mirrors the route's JSON.
type PricingSuggestion = {
  wineId: string;
  suggestedBottle: number | null;
  suggestedGlass: number | null;
  glassPourMl: number;
  targetMarkupRatio: number;
  targetPourCostPct: number;
  retailMedian: number | null;
  retailMin: number | null;
  retailMax: number | null;
  retailRetailerCount: number | null;
  retailRefreshedAt: string | null;
  categoryBandApplied: boolean;
  hasRetailData: boolean;
};

type SearchWine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
};

type LwinWine = {
  lwin_id: string;
  display_name: string;
  producer: string | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
};

interface AddWineModalProps {
  sections: { id: string; name: string }[];
  activeSectionId: string;
  onAdd: (
    wineId: string,
    glassPrice: number | null,
    bottlePrice: number | null,
    sectionIds: string[],
  ) => Promise<{
    failedSectionIds: string[];
    retryRequired: boolean;
  }>;
  onClose: () => void;
}

type RetryPayload = {
  wineId: string;
  glassPrice: number | null;
  bottlePrice: number | null;
  sectionIds: string[];
};

export function AddWineModal({ sections, activeSectionId, onAdd, onClose }: AddWineModalProps) {
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"inventory" | "catalog">("inventory");
  const [results, setResults] = useState<SearchWine[]>([]);
  const [catalogResults, setCatalogResults] = useState<LwinWine[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SearchWine | null>(null);
  // BND-165: multi-section select. activeSectionId is pre-checked.
  const [selectedSectionIds, setSelectedSectionIds] = useState<Set<string>>(
    new Set([activeSectionId]),
  );
  const [bottlePrice, setBottlePrice] = useState("");
  const [glassPrice, setGlassPrice] = useState("");
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const importBusyRef = useRef(false);
  const [retryPayload, setRetryPayload] = useState<RetryPayload | null>(null);
  // BND-040 — pricing suggestion state. Auto-fetched when a wine is
  // selected; user can click "Suggest" to fill the price inputs.
  const [suggestion, setSuggestion] = useState<PricingSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // Surfaces failures from POST /api/wines/create-from-lwin so the user
  // isn't left staring at a spinner that quietly disappears.
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const trapRef = useRef<HTMLDivElement>(null);

  useFocusTrap({ containerRef: trapRef, onEscape: onClose });

  // BND-040 — fetch pricing suggestion when a wine is selected. Cheap
  // (cached retail data only, no API quota burn). State is reset by the
  // event handlers that clear `selected` (handleSelectCatalog, Back
  // button, handleAdd) — not in an effect — to avoid the setState-in-
  // effect lint pattern.
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    (async () => {
      setSuggesting(true);
      setSuggestError(null);
      try {
        const res = await fetch(
          `/api/wines/${selectedId}/pricing-suggestion?glassPourMl=148`,
        );
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            readApiError(
              payload,
              `Suggestion failed (${res.status}).`,
            ).message,
          );
        }
        const data = payload as PricingSuggestion;
        if (!cancelled) setSuggestion(data);
      } catch (err) {
        if (!cancelled) {
          setSuggestError(err instanceof Error ? err.message : "Suggestion failed.");
        }
      } finally {
        if (!cancelled) setSuggesting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  /** Clear suggestion + price drafts when the user goes Back to search. */
  const clearSelection = () => {
    if (retryPayload) return;
    setSelected(null);
    setSuggestion(null);
    setSuggestError(null);
    setBottlePrice("");
    setGlassPrice("");
    setSelectedSectionIds(new Set([activeSectionId]));
  };

  const applySuggestion = () => {
    if (!suggestion || retryPayload) return;
    if (suggestion.suggestedBottle != null) {
      setBottlePrice(suggestion.suggestedBottle.toString());
    }
    if (suggestion.suggestedGlass != null) {
      setGlassPrice(suggestion.suggestedGlass.toString());
    }
  };

  const toggleSection = (id: string) => {
    if (retryPayload) return;
    setSelectedSectionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        // Don't allow deselecting the last section
        if (next.size <= 1) return prev;
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const controller = new AbortController();
    debounceRef.current = setTimeout(async () => {
      if (searchMode === "catalog" && query.trim().length < 2) {
        setCatalogResults([]);
        return;
      }
      setLoading(true);
      setSearchError(null);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        if (searchMode === "inventory") {
          const res = await fetch(`/api/wines/search?${params}`, {
            signal: controller.signal,
          });
          const payload = await res.json().catch(() => null);
          if (controller.signal.aborted) return;
          if (!res.ok) {
            setResults([]);
            setSearchError(
              readApiError(
                payload,
                `Inventory search failed (${res.status}).`,
              ).message,
            );
            return;
          }
          setResults(payload as SearchWine[]);
        } else {
          const res = await fetch(`/api/wines/lwin-search?${params}`, {
            signal: controller.signal,
          });
          const payload = await res.json().catch(() => null);
          if (controller.signal.aborted) return;
          if (!res.ok) {
            setCatalogResults([]);
            setSearchError(
              readApiError(
                payload,
                `Catalog search failed (${res.status}).`,
              ).message,
            );
            return;
          }
          setCatalogResults(payload as LwinWine[]);
        }
      } catch {
        if (controller.signal.aborted) return;
        setSearchError("Search failed. Check your connection and try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      controller.abort();
    };
  }, [query, searchMode]);

  const handleAdd = async () => {
    if (
      !selected ||
      addingRef.current ||
      (!retryPayload && selectedSectionIds.size === 0)
    ) {
      return;
    }
    addingRef.current = true;
    setAdding(true);
    const payload = retryPayload ?? {
      wineId: selected.id,
      glassPrice: glassPrice ? parseFloat(glassPrice) : null,
      bottlePrice: bottlePrice ? parseFloat(bottlePrice) : null,
      sectionIds: Array.from(selectedSectionIds),
    };
    try {
      const result = await onAdd(
        payload.wineId,
        payload.glassPrice,
        payload.bottlePrice,
        payload.sectionIds,
      );
      if (result.failedSectionIds.length > 0) {
        setSelectedSectionIds(new Set(result.failedSectionIds));
        setRetryPayload(
          result.retryRequired
            ? { ...payload, sectionIds: result.failedSectionIds }
            : null,
        );
      } else {
        setRetryPayload(null);
      }
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };

  const handleSelectCatalog = async (lwin: LwinWine) => {
    if (importBusyRef.current) return;
    importBusyRef.current = true;
    setLoading(true);
    setSearchError(null);
    try {
      const { response, data } = await lwinImportCommands.json<unknown>({
        slot: `lwin:${lwin.lwin_id}`,
        url: "/api/wines/create-from-lwin",
        method: "POST",
        json: { lwin_id: lwin.lwin_id },
      });
      if (!response.ok) {
        setSearchError(
          readApiError(
            data,
            `Couldn't import wine (${response.status}).`,
          ).message,
        );
        return;
      }
      const { id } = data as { id: string };
      setSelected({
        id,
        name: lwin.display_name,
        producer: lwin.producer ?? "",
        vintage: null,
        varietal: lwin.varietal,
        region: lwin.region,
      });
    } catch {
      setSearchError("Couldn't import wine. Check your connection and try again.");
    } finally {
      importBusyRef.current = false;
      setLoading(false);
    }
  };

  const activeSectionName =
    sections.find((s) => s.id === activeSectionId)?.name ?? "section";

  const selectedCount = selectedSectionIds.size;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 md:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-wine-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={trapRef} className="flex max-h-[85vh] w-full flex-col rounded-t-lg border border-border bg-surface shadow-lg md:max-w-[480px] md:rounded-md">
        <div className="border-b border-border px-lg py-md">
          <h2 id="add-wine-title" className="font-serif text-[20px] text-ink">
            Add wine to {activeSectionName}
          </h2>
          <p className="mt-xs text-[13px] text-ink-muted">
            Search your inventory or the LWIN catalog.
          </p>
        </div>

        {!selected ? (
          <>
            <div className="flex gap-xs border-b border-border px-lg">
              <button
                type="button"
                onClick={() => { setSearchMode("inventory"); setQuery(""); setSearchError(null); }}
                className={`px-sm py-xs text-[13px] font-medium border-b-2 transition-colors ${
                  searchMode === "inventory"
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                My inventory
              </button>
              <button
                type="button"
                onClick={() => { setSearchMode("catalog"); setQuery(""); setSearchError(null); }}
                className={`px-sm py-xs text-[13px] font-medium border-b-2 transition-colors ${
                  searchMode === "catalog"
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                LWIN catalog
              </button>
            </div>
            <div className="border-b border-border px-lg py-sm">
              <div className="relative">
                <Search className="pointer-events-none absolute left-sm top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" strokeWidth={2} aria-hidden="true" />
                <input
                  autoFocus
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSearchError(null);
                  }}
                  placeholder="Search by producer or wine name…"
                  aria-label="Search wines"
                  className="h-[38px] w-full rounded-sm border border-border bg-white pl-xl pr-sm text-[14px] text-ink placeholder:text-ink-subtle focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                />
              </div>
            </div>
            {searchError && (
              <div className="border-b border-border px-lg py-sm">
                <p
                  role="alert"
                  className="rounded-sm border border-danger/30 bg-danger-soft px-sm py-xs text-[12px] text-danger"
                >
                  {searchError}
                </p>
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-xl">
                  <Loader2 className="h-5 w-5 animate-spin text-ink-subtle" />
                </div>
              ) : searchMode === "inventory" ? (
                results.length === 0 ? (
                  <div className="px-lg py-xl text-center text-[13px] text-ink-muted">
                    {query ? "No wines found." : "No wines in inventory yet. Scan an invoice first."}
                  </div>
                ) : (
                  results.map((wine) => (
                    <button
                      key={wine.id}
                      type="button"
                      onClick={() => setSelected(wine)}
                      className="flex w-full items-center gap-md border-b border-border/50 px-lg py-sm text-left transition-colors hover:bg-surface-muted"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-serif text-[14px] text-ink">
                          {wine.producer}, {wine.name}
                        </div>
                        <div className="mt-2xs flex items-center gap-xs text-[12px] text-ink-muted">
                          <span className="font-mono text-ink-subtle">
                            {wine.vintage ?? "NV"}
                          </span>
                          {wine.region && (
                            <>
                              <span className="text-ink-subtle">·</span>
                              <span>{wine.region}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <Plus className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                    </button>
                  ))
                )
              ) : catalogResults.length === 0 ? (
                <div className="px-lg py-xl text-center text-[13px] text-ink-muted">
                  {query.length < 2
                    ? "Type at least 2 characters to search the LWIN catalog."
                    : "No matches in LWIN catalog."}
                </div>
              ) : (
                catalogResults.map((wine) => (
                  <button
                    key={wine.lwin_id}
                    type="button"
                    onClick={() => handleSelectCatalog(wine)}
                    className="flex w-full items-center gap-md border-b border-border/50 px-lg py-sm text-left transition-colors hover:bg-surface-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[14px] text-ink">
                        {wine.display_name}
                      </div>
                      <div className="mt-2xs flex items-center gap-xs text-[12px] text-ink-muted">
                        {wine.producer && <span>{wine.producer}</span>}
                        {wine.region && (
                          <>
                            <span className="text-ink-subtle">·</span>
                            <span>{wine.region}</span>
                          </>
                        )}
                        {wine.country && (
                          <>
                            <span className="text-ink-subtle">·</span>
                            <span>{wine.country}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <Plus className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="px-lg py-md overflow-y-auto">
            <div className="rounded-sm border border-border bg-surface-muted px-md py-sm">
              <div className="font-serif text-[14px] font-medium text-ink">
                {selected.producer}, {selected.name}
              </div>
              <div className="mt-2xs text-[12px] text-ink-muted">
                {selected.vintage ?? "NV"}
                {selected.region && ` · ${selected.region}`}
              </div>
            </div>

            {/* BND-165: multi-section selector. Shown after a wine is picked;
                active section is pre-checked, user can select additional sections. */}
            {sections.length > 1 && (
              <div className="mt-md">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                  Add to {selectedCount > 1 ? `${selectedCount} sections` : "section"}
                </div>
                <div className="mt-sm flex flex-col gap-2xs">
                  {sections.map((s) => {
                    const checked = selectedSectionIds.has(s.id);
                    return (
                      <label
                        key={s.id}
                        className="flex cursor-pointer items-center gap-sm rounded-sm px-sm py-xs transition-colors hover:bg-surface-muted"
                      >
                        <span
                          className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-xs border-2 transition-colors ${
                            checked
                              ? "border-accent bg-accent"
                              : "border-border bg-white"
                          }`}
                        >
                          {checked && (
                            <Check className="h-3 w-3 text-white" strokeWidth={3} aria-hidden="true" />
                          )}
                        </span>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={retryPayload !== null}
                          onChange={() => toggleSection(s.id)}
                          className="sr-only"
                          aria-label={`Add to ${s.name}`}
                        />
                        <span className="text-[14px] font-medium text-ink">
                          {s.name}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* BND-040 — Pricing suggestion panel. Renders when retail data
                is available; falls back to a brief unavailable note otherwise.
                One tap to fill both inputs; user can override anything. */}
            {suggesting && (
              <div className="mt-md flex items-center gap-xs text-[12px] text-ink-muted">
                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} aria-hidden />
                Computing suggestion…
              </div>
            )}
            {!suggesting && suggestion && suggestion.hasRetailData && (
              <div
                className="mt-md rounded-sm bg-bg-secondary p-sm"
                style={{ borderLeft: "2px solid var(--color-accent)" }}
              >
                <div className="flex items-baseline justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                    Suggested prices
                  </div>
                  <button
                    type="button"
                    onClick={applySuggestion}
                    disabled={retryPayload !== null}
                    className="inline-flex items-center gap-2xs text-[11px] font-medium text-accent hover:underline"
                  >
                    <Sparkles className="h-3 w-3" strokeWidth={2} aria-hidden />
                    Use these
                  </button>
                </div>
                <div className="mt-xs grid grid-cols-2 gap-sm text-[12px] text-ink-muted">
                  <div>
                    <span className="font-mono text-[16px] font-medium text-ink">
                      {suggestion.suggestedGlass != null
                        ? `$${suggestion.suggestedGlass}`
                        : "—"}
                    </span>
                    <div className="mt-2xs text-[10px] text-ink-subtle">
                      glass · target {Math.round(suggestion.targetPourCostPct)}% pour cost
                    </div>
                  </div>
                  <div>
                    <span className="font-mono text-[16px] font-medium text-ink">
                      {suggestion.suggestedBottle != null
                        ? `$${suggestion.suggestedBottle}`
                        : "—"}
                    </span>
                    <div className="mt-2xs text-[10px] text-ink-subtle">
                      bottle · target {suggestion.targetMarkupRatio.toFixed(1)}× retail
                    </div>
                  </div>
                </div>
                <div className="mt-xs text-[10px] text-ink-subtle">
                  Source: Wine-Searcher · {suggestion.retailRetailerCount ?? 0} retailers ·
                  median ${Math.round(suggestion.retailMedian ?? 0)}
                  {suggestion.categoryBandApplied && " · category band applied"}
                </div>
              </div>
            )}
            {!suggesting && suggestion && !suggestion.hasRetailData && (
              <div className="mt-md rounded-sm bg-bg-secondary p-sm text-[11px] italic text-ink-muted">
                Pricing data unavailable for this wine. Refresh retail data from
                Insights to enable suggestions.
              </div>
            )}
            {suggestError && (
              <p role="alert" className="mt-sm text-[11px] text-error">
                {suggestError}
              </p>
            )}

            <div className="mt-md grid grid-cols-2 gap-md">
              <div>
                <label htmlFor="add-wine-glass-price" className="mb-xs block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                  Glass price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 font-mono text-[14px] text-ink-subtle">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    id="add-wine-glass-price"
                    value={glassPrice}
                    disabled={adding || retryPayload !== null}
                    onChange={(e) => setGlassPrice(e.target.value)}
                    placeholder="—"
                    className="h-[38px] w-full rounded-sm border border-border bg-white pl-md pr-sm text-right font-mono text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="add-wine-bottle-price" className="mb-xs block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                  Bottle price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 font-mono text-[14px] text-ink-subtle">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    id="add-wine-bottle-price"
                    value={bottlePrice}
                    disabled={adding || retryPayload !== null}
                    onChange={(e) => setBottlePrice(e.target.value)}
                    placeholder="—"
                    className="h-[38px] w-full rounded-sm border border-border bg-white pl-md pr-sm text-right font-mono text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-border px-lg py-md">
          <div className="flex justify-end gap-sm">
            {selected && (
              <button
                type="button"
                onClick={clearSelection}
                disabled={retryPayload !== null}
                className="h-[38px] rounded-sm border border-border-strong px-md text-[14px] font-medium text-ink hover:bg-surface-muted"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="h-[38px] rounded-sm border border-border-strong px-md text-[14px] font-medium text-ink hover:bg-surface-muted"
            >
              Cancel
            </button>
            {selected && (
              <button
                type="button"
                onClick={handleAdd}
                disabled={adding || selectedSectionIds.size === 0}
                className="h-[38px] rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {adding ? "Adding..." : `Add to ${selectedCount > 1 ? `${selectedCount} sections` : "list"}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
