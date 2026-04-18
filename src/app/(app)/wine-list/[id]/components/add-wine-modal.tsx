"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { useFocusTrap } from "@/lib/use-focus-trap";

type SearchWine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
};

interface AddWineModalProps {
  sectionName: string;
  onAdd: (wineId: string, glassPrice: number | null, bottlePrice: number | null) => void;
  onClose: () => void;
}

export function AddWineModal({ sectionName, onAdd, onClose }: AddWineModalProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchWine[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SearchWine | null>(null);
  const [bottlePrice, setBottlePrice] = useState("");
  const [glassPrice, setGlassPrice] = useState("");
  const [adding, setAdding] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const trapRef = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        const res = await fetch(`/api/wines/search?${params}`);
        if (res.ok) {
          setResults(await res.json());
        }
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleAdd = async () => {
    if (!selected || adding) return;
    setAdding(true);
    const glass = glassPrice ? parseFloat(glassPrice) : null;
    const bottle = bottlePrice ? parseFloat(bottlePrice) : null;
    await onAdd(selected.id, glass, bottle);
    setAdding(false);
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
            Search your inventory or browse all wines.
          </p>
        </div>

        {!selected ? (
          <>
            <div className="border-b border-border px-lg py-sm">
              <div className="relative">
                <Search className="pointer-events-none absolute left-sm top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
                <input
                  autoFocus
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by producer or wine name..."
                  className="h-[38px] w-full rounded-sm border border-border bg-white pl-xl pr-sm text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-xl">
                  <Loader2 className="h-5 w-5 animate-spin text-ink-subtle" />
                </div>
              ) : results.length === 0 ? (
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
