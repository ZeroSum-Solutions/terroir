"use client";

// P1 slice 2a — the unified search palette (program plan D3/D4).
//
// Successor to global-search.tsx (GLOBAL-02), which it replaced at feature
// parity in the same slice: the header keeps exactly one text field, `/`
// still focuses it (yielding to routes with their own search), the keyboard
// and combobox a11y contract carries over, and the portal/anchor mechanics
// are inherited unchanged — the header's `.glass` backdrop-filter still makes
// it the containing block for fixed descendants, so the panel still portals
// to <body>.
//
// What is NEW is the data spine: this field asks GET /api/search — the
// unified tier-1 endpoint over cellar + LWIN + X-Wines — and renders cellar
// and catalogue as visually separate sections, cellar first (D3 #1: a
// discoverable wine must never look pullable). Catalogue rows carry a
// provenance badge; a pair the P0 linkage accepted renders once. The single
// "My cellar" chip narrows scope (D4: one chip, no radiogroup). Recents are
// carried over from the scan panel's day via src/lib/wine-search-recents.
//
// Catalogue rows (slice 2b): a click opens /catalogue/[source]/[id] — the
// detail view that renders identity plus any linked X-Wines features, with
// unknowns visibly unknown. The inline Add button (POST
// /api/wines/create-from-lwin) stays beside LWIN-backed rows as the shortcut.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { requestAssistant } from "../assistant-open";
import { addRecentSearch, readRecentSearches } from "@/lib/wine-search-recents";
import { PaletteResultsPanel, type AddState, type CompanionHint, type UnifiedResult } from "./palette-results";

const MIN_QUERY = 2;
const DEBOUNCE_MS = 200;
const NO_COMPANION: CompanionHint = { suggested: false, reasons: [] };

export function SearchPalette({ className }: { className?: string }) {
  const router = useRouter();
  const rootRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const optionId = useId();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "cellar">("all");
  const [results, setResults] = useState<UnifiedResult[] | null>(null);
  const [companion, setCompanion] = useState<CompanionHint>(NO_COMPANION);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recents, setRecents] = useState<string[]>([]);
  const [addStates, setAddStates] = useState<ReadonlyMap<string, AddState>>(new Map());
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  // Debounced lookup driven from handlers, not an effect on `query` — the
  // effect form clears state synchronously per keystroke (the cascading-render
  // pattern react-hooks rejects). Abort keeps a slow earlier response from
  // overwriting a faster later one. Both inherited from global-search.tsx.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const lookup = useCallback((text: string, scopeNow: "all" | "cellar") => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const trimmed = text.trim();
    if (trimmed.length < MIN_QUERY) {
      setResults(null);
      setCompanion(NO_COMPANION);
      setPending(false);
      return;
    }
    setPending(true);
    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const params = new URLSearchParams({ q: trimmed });
        if (scopeNow === "cellar") params.set("scope", "cellar");
        const res = await fetch(`/api/search?${params}`, { signal: controller.signal });
        const body = res.ok
          ? ((await res.json()) as { results: UnifiedResult[]; companion?: CompanionHint })
          : { results: [] };
        setResults(body.results);
        setCompanion(body.companion ?? NO_COMPANION);
        setAddStates(new Map());
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setCompanion(NO_COMPANION);
        }
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    }, DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  // Fixed-position panel in a portal needs telling where the field is; the
  // header is sticky and the mobile band scrolls, so re-measure on both.
  useEffect(() => {
    if (!open) return;
    function measure() {
      const el = inputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setAnchor({ top: rect.bottom + 8, left: rect.left, width: rect.width });
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.("[data-global-search-panel]")) return;
      close();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  // "/" focuses search; route-local search wins on routes that have one.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      const el = inputRef.current;
      if (!el || el.getClientRects().length === 0) return;
      if (pageHasItsOwnSearch()) return;
      e.preventDefault();
      el.focus();
      el.select();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const rows = results ?? [];

  const recordRecent = useCallback(() => {
    const term = query.trim();
    if (term.length >= MIN_QUERY) setRecents(addRecentSearch(term));
  }, [query]);

  function clear() {
    setQuery("");
    lookup("", scope);
  }

  function seeAll() {
    const text = query.trim();
    if (!text) return;
    recordRecent();
    close();
    router.push(`/cellar?q=${encodeURIComponent(text)}`);
  }

  const addFromCatalogue = useCallback(
    async (row: UnifiedResult) => {
      if (row.lwinId === null) return;
      const key = row.lwinId;
      setAddStates((prev) => new Map(prev).set(key, "pending"));
      try {
        const res = await fetch("/api/wines/create-from-lwin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lwin_id: row.lwinId,
            display_name: row.name,
            producer: row.producer,
            region: row.region,
            country: row.country,
          }),
        });
        setAddStates((prev) => new Map(prev).set(key, res.ok ? "added" : "error"));
        if (res.ok) recordRecent();
      } catch {
        setAddStates((prev) => new Map(prev).set(key, "error"));
      }
    },
    [recordRecent],
  );

  const commit = useCallback(
    (row: UnifiedResult) => {
      if (row.kind === "cellar" && row.wineId !== null) {
        recordRecent();
        close();
        setQuery("");
        router.push(`/cellar/${row.wineId}`);
        return;
      }
      // Slice 2b: a catalogue row opens its detail page — add-to-cellar-first
      // is NOT required (D4). The inline Add button beside the row remains the
      // shortcut; a click on the row itself is a question, not a commitment.
      if (row.kind === "catalogue") {
        const href =
          row.lwinId !== null
            ? `/catalogue/lwin/${row.lwinId}`
            : row.xwinesWineId !== null
              ? `/catalogue/xwines/${row.xwinesWineId}`
              : null;
        if (href !== null) {
          recordRecent();
          close();
          setQuery("");
          router.push(href);
        }
      }
    },
    [recordRecent, close, router],
  );

  function runRecent(term: string) {
    setQuery(term);
    setOpen(true);
    setActive(-1);
    lookup(term, scope);
  }

  function toggleScope() {
    const next = scope === "all" ? "cellar" : "all";
    setScope(next);
    setActive(-1);
    lookup(query, next);
  }

  const showRecents = open && query.trim().length < MIN_QUERY && recents.length > 0;

  return (
    <form
      ref={rootRef}
      role="search"
      aria-label="Search all wines"
      data-global-search="true"
      className={cn("relative min-w-0", className)}
      onSubmit={(e) => {
        e.preventDefault();
        if (active >= 0 && rows[active]) commit(rows[active]);
        else seeAll();
      }}
    >
      <Search
        className="pointer-events-none absolute left-sm top-1/2 h-4 w-4 -translate-y-1/2 text-grey"
        strokeWidth={2}
        aria-hidden
      />
      <input
        ref={inputRef}
        data-global-search="true"
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${optionId}-${active}` : undefined}
        aria-label="Search all wines"
        value={query}
        placeholder="Search cellar and catalogue…"
        onChange={(e) => {
          setQuery(e.target.value);
          lookup(e.target.value, scope);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => {
          setOpen(true);
          setRecents(readRecentSearches());
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (query) clear();
            else close();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (active >= 0 && rows[active]) commit(rows[active]);
            else seeAll();
            return;
          }
          if (e.key === "ArrowDown" && rows.length > 0) {
            e.preventDefault();
            setOpen(true);
            setActive((i) => (i < rows.length - 1 ? i + 1 : 0));
          } else if (e.key === "ArrowUp" && rows.length > 0) {
            e.preventDefault();
            setOpen(true);
            setActive((i) => (i > 0 ? i - 1 : rows.length - 1));
          }
        }}
        className="h-11 w-full rounded-pill border border-edge bg-surface/70 pl-[32px] pr-[36px] text-body-sm text-ink outline-none placeholder:text-grey focus-visible:border-accent focus-ring"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear wine search"
          onClick={() => {
            clear();
            inputRef.current?.focus();
          }}
          className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-pill text-grey hover:bg-surface/60 hover:text-ink-soft focus-ring"
        >
          <X className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      ) : null}

      {open && anchor && (query.trim().length >= MIN_QUERY || showRecents) ? (
        <PaletteResultsPanel
          anchor={anchor}
          listboxId={listboxId}
          optionId={optionId}
          rows={rows}
          pending={pending}
          active={active}
          scope={scope}
          addStates={addStates}
          recents={showRecents ? recents : []}
          companion={companion}
          onPick={commit}
          onAdd={addFromCatalogue}
          onSeeAll={seeAll}
          onToggleScope={toggleScope}
          onRunRecent={runRecent}
          onScanInstead={() => {
            close();
            router.push("/scan");
          }}
          onAskCompanion={() => {
            // Shared by the all-scope-miss CTA and the companion-hint banner
            // above the results: hand the typed query to the companion as
            // asked rather than making the user retype it.
            const text = query.trim();
            close();
            requestAssistant(text === "" ? null : text);
          }}
        />
      ) : null}
    </form>
  );
}

/** True when the current route renders a search control that is not this one. */
/**
 * Exported for the /scan suite: deleting that page's search panel (P1 slice
 * 2c) is what un-shadows "/" there, and the test pins it with this exact
 * probe rather than a copy that could drift.
 */
export function pageHasItsOwnSearch(): boolean {
  const candidates = document.querySelectorAll(
    'input[type="search"], [aria-label*="Search"], [aria-label*="search"]',
  );
  for (const el of candidates) {
    if (!el.closest("[data-global-search]")) return true;
  }
  return false;
}
