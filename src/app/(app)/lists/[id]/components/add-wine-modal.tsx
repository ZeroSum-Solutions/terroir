"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, Search, Sparkles } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { WineThumb } from "@/components/wine-thumb";

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
  colour: string | null;
  hero_image_url: string | null;
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
  onAdd: (wineId: string, glassPrice: number | null, bottlePrice: number | null, sectionIds: string[]) => void;
  onClose: () => void;
}

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
  // BND-040 — pricing suggestion state. Auto-fetched when a wine is
  // selected; user can click "Suggest" to fill the price inputs.
  const [suggestion, setSuggestion] = useState<PricingSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // Surfaces failures from POST /api/wines/create-from-lwin so the user
  // isn't left staring at a spinner that quietly disappears.
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const trapRef = useRef<HTMLDivElement>(null);

  useFocusTrap({ containerRef: trapRef, onEscape: onClose });

  useEffect(() => {
    const scrollY = window.scrollY;
    const bodyStyle = document.body.style;
    const rootStyle = document.documentElement.style;
    const previousBody = {
      overflow: bodyStyle.overflow,
      position: bodyStyle.position,
      top: bodyStyle.top,
      width: bodyStyle.width,
    };
    const previousRootOverflow = rootStyle.overflow;

    rootStyle.overflow = "hidden";
    bodyStyle.overflow = "hidden";
    bodyStyle.position = "fixed";
    bodyStyle.top = `-${scrollY}px`;
    bodyStyle.width = "100%";

    return () => {
      rootStyle.overflow = previousRootOverflow;
      bodyStyle.overflow = previousBody.overflow;
      bodyStyle.position = previousBody.position;
      bodyStyle.top = previousBody.top;
      bodyStyle.width = previousBody.width;
      if (scrollY > 0) window.scrollTo(0, scrollY);
    };
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const backdrop = backdropRef.current;
    const panel = trapRef.current;
    if (!viewport || !backdrop || !panel) return;

    const syncToVisualViewport = () => {
      backdrop.style.top = `${viewport.offsetTop}px`;
      backdrop.style.left = `${viewport.offsetLeft}px`;
      backdrop.style.right = "auto";
      backdrop.style.bottom = "auto";
      backdrop.style.width = `${viewport.width}px`;
      backdrop.style.height = `${viewport.height}px`;
      panel.style.maxHeight = `${viewport.height}px`;
    };

    syncToVisualViewport();
    viewport.addEventListener("resize", syncToVisualViewport);
    viewport.addEventListener("scroll", syncToVisualViewport);
    return () => {
      viewport.removeEventListener("resize", syncToVisualViewport);
      viewport.removeEventListener("scroll", syncToVisualViewport);
    };
  }, []);

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
        if (!res.ok) throw new Error(`Failed (${res.status}).`);
        const data = (await res.json()) as PricingSuggestion;
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
    setSelected(null);
    setSuggestion(null);
    setSuggestError(null);
    setBottlePrice("");
    setGlassPrice("");
    setSelectedSectionIds(new Set([activeSectionId]));
  };

  const applySuggestion = () => {
    if (!suggestion) return;
    if (suggestion.suggestedBottle != null) {
      setBottlePrice(suggestion.suggestedBottle.toString());
    }
    if (suggestion.suggestedGlass != null) {
      setGlassPrice(suggestion.suggestedGlass.toString());
    }
  };

  const toggleSection = (id: string) => {
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
    debounceRef.current = setTimeout(async () => {
      if (searchMode === "catalog" && query.trim().length < 2) {
        setCatalogResults([]);
        return;
      }
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        if (searchMode === "inventory") {
          const res = await fetch(`/api/wines/search?${params}`);
          if (res.ok) setResults(await res.json());
        } else {
          const res = await fetch(`/api/wines/lwin-search?${params}`);
          if (res.ok) setCatalogResults(await res.json());
        }
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, searchMode]);

  const handleAdd = async () => {
    if (!selected || adding || selectedSectionIds.size === 0) return;
    setAdding(true);
    const glass = glassPrice ? parseFloat(glassPrice) : null;
    const bottle = bottlePrice ? parseFloat(bottlePrice) : null;
    await onAdd(selected.id, glass, bottle, Array.from(selectedSectionIds));
    setAdding(false);
  };

  const handleSelectCatalog = async (lwin: LwinWine) => {
    setLoading(true);
    setCatalogError(null);
    try {
      const res = await fetch("/api/wines/create-from-lwin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lwin),
      });
      if (!res.ok) {
        const message = await res
          .json()
          .then((d: { error?: string }) => d?.error)
          .catch(() => null);
        setCatalogError(message ?? `Couldn't import wine (${res.status}).`);
        return;
      }
      const { id } = await res.json();
      setSelected({
        id,
        name: lwin.display_name,
        producer: lwin.producer ?? "",
        vintage: null,
        varietal: lwin.varietal,
        region: lwin.region,
        // A wine created from the catalog moments ago has neither.
        colour: null,
        hero_image_url: null,
      });
    } catch {
      setCatalogError("Couldn't import wine. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const activeSectionName =
    sections.find((s) => s.id === activeSectionId)?.name ?? "section";

  const selectedCount = selectedSectionIds.size;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- backdrop-click-to-dismiss is a mouse-only convenience; this dialog already has full keyboard access via useFocusTrap (Escape + a visible Close button).
    <div
      ref={backdropRef}
      data-add-wine-backdrop
      className="fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center overscroll-contain bg-scrim md:items-center md:p-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-wine-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        data-add-wine-panel
        className="flex max-h-[100dvh] w-full min-w-0 flex-col overflow-hidden rounded-t-[20px] card-surface md:max-h-[calc(100dvh-2rem)] md:max-w-[480px] md:rounded-card"
      >
        <div className="shrink-0 border-b border-rule px-lg py-md">
          <h2 id="add-wine-title" className="font-serif text-[20px] text-ink">
            Add wine to {activeSectionName}
          </h2>
          <p className="mt-xs text-[13px] text-grey">
            Search your inventory or the LWIN catalog.
          </p>
        </div>

        {!selected ? (
          <>
            <div className="flex shrink-0 gap-xs border-b border-rule px-lg">
              <button
                type="button"
                onClick={() => { setSearchMode("inventory"); setQuery(""); setCatalogError(null); }}
                className={`min-h-11 px-sm py-xs text-[13px] font-medium border-b-2 transition-colors ${
                  searchMode === "inventory"
                    ? "border-mark text-mark"
                    : "border-transparent text-grey hover:text-ink"
                }`}
              >
                My inventory
              </button>
              <button
                type="button"
                onClick={() => { setSearchMode("catalog"); setQuery(""); setCatalogError(null); }}
                className={`min-h-11 px-sm py-xs text-[13px] font-medium border-b-2 transition-colors ${
                  searchMode === "catalog"
                    ? "border-mark text-mark"
                    : "border-transparent text-grey hover:text-ink"
                }`}
              >
                LWIN catalog
              </button>
            </div>
            <div className="shrink-0 border-b border-rule px-lg py-sm">
              <div className="relative">
                <Search className="pointer-events-none absolute left-sm top-1/2 h-4 w-4 -translate-y-1/2 text-grey" strokeWidth={2} aria-hidden="true" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCatalogError(null);
                  }}
                  placeholder="Search by producer or wine name…"
                  aria-label="Search wines"
                  className="h-11 w-full rounded-pill border border-rule bg-surface pl-xl pr-sm text-[16px] text-ink placeholder:text-grey focus-visible:border-accent focus-ring md:text-[14px]"
                />
              </div>
            </div>
            {searchMode === "catalog" && catalogError && (
              <div className="border-b border-rule px-lg py-sm">
                <p
                  role="alert"
                  className="rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[12px] text-risk-ink"
                >
                  {catalogError}
                </p>
              </div>
            )}
            <div
              data-add-wine-results
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            >
              {loading ? (
                <div className="flex items-center justify-center py-xl">
                  <Loader2 className="h-5 w-5 animate-spin text-grey" />
                </div>
              ) : searchMode === "inventory" ? (
                results.length === 0 ? (
                  <div className="px-lg py-xl text-center text-[13px] text-grey">
                    {query ? "No wines found." : "No wines in inventory yet. Scan an invoice first."}
                  </div>
                ) : (
                  results.map((wine) => (
                    <button
                      key={wine.id}
                      type="button"
                      onClick={() => setSelected(wine)}
                      className="flex w-full items-center gap-md border-b border-rule/50 px-lg py-sm text-left transition-colors hover:bg-wash"
                    >
                      <WineThumb
                        src={wine.hero_image_url}
                        producer={wine.producer}
                        name={wine.name}
                        colour={wine.colour}
                        size={36}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-serif text-[17px] text-ink">
                          {wine.producer}, {wine.name}
                        </div>
                        <div className="mt-2xs flex items-center gap-xs text-[12px] text-grey">
                          <span className="font-mono text-grey">
                            {wine.vintage ?? "NV"}
                          </span>
                          {wine.region && (
                            <>
                              <span className="text-grey">·</span>
                              <span>{wine.region}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <Plus className="h-4 w-4 shrink-0 text-grey" aria-hidden="true" />
                    </button>
                  ))
                )
              ) : catalogResults.length === 0 ? (
                <div className="px-lg py-xl text-center text-[13px] text-grey">
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
                    className="flex w-full items-center gap-md border-b border-rule/50 px-lg py-sm text-left transition-colors hover:bg-wash"
                  >
                    {/* A catalog row is a reference entry, not a wine in this
                        cellar, so it can never have a picture — but it gets the
                        same stand-in, or one search renders as two
                        differently-shaped lists. */}
                    <WineThumb
                      src={null}
                      producer={wine.producer}
                      name={wine.display_name}
                      colour={null}
                      size={36}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[17px] text-ink">
                        {wine.display_name}
                      </div>
                      <div className="mt-2xs flex items-center gap-xs text-[12px] text-grey">
                        {wine.producer && <span>{wine.producer}</span>}
                        {wine.region && (
                          <>
                            <span className="text-grey">·</span>
                            <span>{wine.region}</span>
                          </>
                        )}
                        {wine.country && (
                          <>
                            <span className="text-grey">·</span>
                            <span>{wine.country}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <Plus className="h-4 w-4 shrink-0 text-grey" aria-hidden="true" />
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 overflow-y-auto overscroll-contain px-lg py-md">
            <div className="rounded-md border border-rule bg-wash px-md py-sm">
              <div className="font-serif text-[17px] font-medium text-ink">
                {selected.producer}, {selected.name}
              </div>
              <div className="mt-2xs text-[12px] text-grey">
                {selected.vintage ?? "NV"}
                {selected.region && ` · ${selected.region}`}
              </div>
            </div>

            {/* BND-165: multi-section selector. Shown after a wine is picked;
                active section is pre-checked, user can select additional sections. */}
            {sections.length > 1 && (
              <div className="mt-md">
                <div className="text-caption font-medium uppercase text-grey">
                  Add to {selectedCount > 1 ? `${selectedCount} sections` : "section"}
                </div>
                <div className="mt-sm flex flex-col gap-2xs">
                  {sections.map((s) => {
                    const checked = selectedSectionIds.has(s.id);
                    return (
                      <label
                        key={s.id}
                        className="flex min-h-11 cursor-pointer items-center gap-sm rounded-pill px-sm py-xs transition-colors hover:bg-wash"
                      >
                        <span
                          className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-xs border-2 transition-colors ${
                            checked
                              ? "border-primary bg-primary"
                              : "border-edge bg-surface"
                          }`}
                        >
                          {checked && (
                            <Check className="h-3 w-3 text-seal-ink" strokeWidth={3} aria-hidden="true" />
                          )}
                        </span>
                        <input
                          type="checkbox"
                          checked={checked}
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
              <div className="mt-md flex items-center gap-xs text-[12px] text-grey">
                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} aria-hidden />
                Computing suggestion…
              </div>
            )}
            {!suggesting && suggestion && suggestion.hasRetailData && (
              <div
                className="mt-md rounded-md bg-wash p-sm"
                style={{ borderLeft: "2px solid var(--color-primary)" }}
              >
                <div className="flex items-baseline justify-between">
                  <div className="text-caption font-medium uppercase text-grey">
                    Suggested prices
                  </div>
                  <button
                    type="button"
                    onClick={applySuggestion}
                    className="inline-flex min-h-11 items-center gap-2xs text-[11px] font-medium text-accent hover:underline"
                  >
                    <Sparkles className="h-3 w-3" strokeWidth={2} aria-hidden />
                    Use these
                  </button>
                </div>
                <div className="mt-xs grid grid-cols-2 gap-sm text-[12px] text-grey">
                  <div>
                    <span className="font-mono text-[16px] font-medium text-ink">
                      {suggestion.suggestedGlass != null
                        ? `$${suggestion.suggestedGlass}`
                        : "—"}
                    </span>
                    <div className="mt-2xs text-[10px] text-grey">
                      glass · target {Math.round(suggestion.targetPourCostPct)}% pour cost
                    </div>
                  </div>
                  <div>
                    <span className="font-mono text-[16px] font-medium text-ink">
                      {suggestion.suggestedBottle != null
                        ? `$${suggestion.suggestedBottle}`
                        : "—"}
                    </span>
                    <div className="mt-2xs text-[10px] text-grey">
                      bottle · target {suggestion.targetMarkupRatio.toFixed(1)}× retail
                    </div>
                  </div>
                </div>
                <div className="mt-xs text-[10px] text-grey">
                  Source: Wine-Searcher · {suggestion.retailRetailerCount ?? 0} retailers ·
                  median ${Math.round(suggestion.retailMedian ?? 0)}
                  {suggestion.categoryBandApplied && " · category band applied"}
                </div>
              </div>
            )}
            {!suggesting && suggestion && !suggestion.hasRetailData && (
              <div className="mt-md rounded-md bg-wash p-sm text-[11px] italic text-grey">
                Pricing data unavailable for this wine. Refresh retail data from
                Insights to enable suggestions.
              </div>
            )}
            {suggestError && (
              <p role="alert" className="mt-sm text-[11px] text-risk-ink">
                {suggestError}
              </p>
            )}

            <div className="mt-md grid grid-cols-2 gap-md">
              <div>
                <label htmlFor="add-wine-glass-price" className="mb-xs block text-caption font-medium uppercase text-grey">
                  Glass price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 font-mono text-[14px] text-grey">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    id="add-wine-glass-price"
                    value={glassPrice}
                    onChange={(e) => setGlassPrice(e.target.value)}
                    placeholder="—"
                    className="h-11 w-full rounded-pill border border-rule bg-surface pl-md pr-sm text-right font-mono text-[16px] text-ink placeholder:text-grey focus:border-accent focus-ring md:text-[14px]"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="add-wine-bottle-price" className="mb-xs block text-caption font-medium uppercase text-grey">
                  Bottle price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 font-mono text-[14px] text-grey">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    id="add-wine-bottle-price"
                    value={bottlePrice}
                    onChange={(e) => setBottlePrice(e.target.value)}
                    placeholder="—"
                    className="h-11 w-full rounded-pill border border-rule bg-surface pl-md pr-sm text-right font-mono text-[16px] text-ink placeholder:text-grey focus:border-accent focus-ring md:text-[14px]"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        <div
          className="shrink-0 border-t border-rule px-lg pt-md"
          style={{ paddingBottom: "calc(var(--safe-bottom) + var(--spacing-lg))" }}
        >
          <div className="flex flex-wrap justify-end gap-sm">
            {selected && (
              <button
                type="button"
                onClick={clearSelection}
                className="min-h-11 rounded-pill border border-rule px-md text-[14px] font-medium text-ink hover:bg-wash focus-ring"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-pill border border-rule px-md text-[14px] font-medium text-ink hover:bg-wash focus-ring"
            >
              Cancel
            </button>
            {selected && (
              <button
                type="button"
                onClick={handleAdd}
                disabled={adding || selectedSectionIds.size === 0}
                className="min-h-11 rounded-pill bg-primary px-md text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-60"
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
