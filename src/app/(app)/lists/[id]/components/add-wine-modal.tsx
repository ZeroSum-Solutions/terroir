"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";

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
  sectionName: string;
  onAdd: (wineId: string, glassPrice: number | null, bottlePrice: number | null) => void;
  onClose: () => void;
}

export function AddWineModal({ sectionName, onAdd, onClose }: AddWineModalProps) {
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"inventory" | "catalog">("inventory");
  const [results, setResults] = useState<SearchWine[]>([]);
  const [catalogResults, setCatalogResults] = useState<LwinWine[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SearchWine | null>(null);
  const [bottlePrice, setBottlePrice] = useState("");
  const [glassPrice, setGlassPrice] = useState("");
  const [adding, setAdding] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const trapRef = useRef<HTMLDivElement>(null);

  useFocusTrap({ containerRef: trapRef, onEscape: onClose });

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
    if (!selected || adding) return;
    setAdding(true);
    const glass = glassPrice ? parseFloat(glassPrice) : null;
    const bottle = bottlePrice ? parseFloat(bottlePrice) : null;
    await onAdd(selected.id, glass, bottle);
    setAdding(false);
  };

  const handleSelectCatalog = async (lwin: LwinWine) => {
    setLoading(true);
    try {
      const res = await fetch("/api/wines/create-from-lwin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lwin),
      });
      if (!res.ok) return;
      const { id } = await res.json();
      setSelected({
        id,
        name: lwin.display_name,
        producer: lwin.producer ?? "",
        vintage: null,
        varietal: lwin.varietal,
        region: lwin.region,
      });
    } finally {
      setLoading(false);
    }
  };

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
            Add wine to {sectionName}
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
                onClick={() => { setSearchMode("inventory"); setQuery(""); }}
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
                onClick={() => { setSearchMode("catalog"); setQuery(""); }}
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
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by producer or wine name…"
                  aria-label="Search wines"
                  className="h-[38px] w-full rounded-sm border border-border bg-white pl-xl pr-sm text-[14px] text-ink placeholder:text-ink-subtle focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                />
              </div>
            </div>
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
          <div className="px-lg py-md">
            <div className="rounded-sm border border-border bg-surface-muted px-md py-sm">
              <div className="font-serif text-[14px] font-medium text-ink">
                {selected.producer}, {selected.name}
              </div>
              <div className="mt-2xs text-[12px] text-ink-muted">
                {selected.vintage ?? "NV"}
                {selected.region && ` · ${selected.region}`}
              </div>
            </div>

            <div className="mt-md grid grid-cols-2 gap-md">
              <div>
                <label className="mb-xs block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                  Glass price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 font-mono text-[14px] text-ink-subtle">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={glassPrice}
                    onChange={(e) => setGlassPrice(e.target.value)}
                    placeholder="—"
                    className="h-[38px] w-full rounded-sm border border-border bg-white pl-md pr-sm text-right font-mono text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
              </div>
              <div>
                <label className="mb-xs block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                  Bottle price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 font-mono text-[14px] text-ink-subtle">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={bottlePrice}
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
                onClick={() => setSelected(null)}
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
                disabled={adding}
                className="h-[38px] rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {adding ? "Adding..." : "Add to list"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
