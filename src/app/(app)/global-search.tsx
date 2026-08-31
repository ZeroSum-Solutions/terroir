"use client";

// GLOBAL-02 — the search bar is exempt from the one-row rule, it sits at the
// top, and it is on every page.
//
// It lives in the app shell (src/app/(app)/layout.tsx), not in each route, for
// two reasons. "Every page" implemented per route is a claim that decays the
// first time someone adds a route; implemented in the shell it is structurally
// true. And the header is already the only element guaranteed to render above
// every page's own chrome, which is what "at the top" means here.
//
// WHY THIS IS NOT THE ASSISTANT PANEL
// -----------------------------------
// assistant-panel.tsx also takes free text, so merging them was the obvious
// move. It is the wrong one. /api/assistant is a deterministic *constraint*
// parser (src/lib/wine-intelligence/assistant-query.ts): it recognises type,
// body, blend, pairing, country, region, grape and price, and — deliberately,
// so it can never invent a wine — it emits nothing for words outside the
// tenant's own vocabulary. Typing a producer or a label, which is what
// "search" means to a sommelier holding a bottle, returns "I did not
// understand Ridge Monte Bello". This field asks /api/wines/search instead,
// which matches name and producer with ILIKE against the tenant's rows. Two
// different questions, two different backends. The assistant keeps its icon
// beside this field; its input is inside a dialog, so the header still shows
// exactly one text field.
//
// The results panel is PORTALLED TO <body>. The header carries `.glass`, and
// backdrop-filter makes an element the containing block for its position:fixed
// descendants — the same trap documented at length in assistant-panel.tsx.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { WineThumb } from "@/components/wine-thumb";
import { cn } from "@/lib/utils";

/** The row shape /api/wines/search returns. */
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

const MIN_QUERY = 2;
const DEBOUNCE_MS = 200;

export function GlobalSearch({ className }: { className?: string }) {
  const router = useRouter();
  const rootRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const optionId = useId();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchWine[] | null>(null);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  // Debounced lookup, driven from the change handler rather than an effect on
  // `query`: the effect form has to clear state synchronously on every
  // keystroke, which is the cascading-render pattern react-hooks rejects.
  // The abort controller keeps a slow earlier response from overwriting a
  // faster later one.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const lookup = useCallback((text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const trimmed = text.trim();
    if (trimmed.length < MIN_QUERY) {
      setResults(null);
      setPending(false);
      return;
    }
    setPending(true);
    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(
          `/api/wines/search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        setResults(res.ok ? ((await res.json()) as SearchWine[]) : []);
      } catch {
        // An abort is the normal path on every keystroke; a real failure shows
        // as the empty state rather than a broken panel.
        if (!controller.signal.aborted) setResults([]);
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

  // The panel is fixed-positioned in the portal, so it has to be told where the
  // field is. The header is sticky and the mobile band scrolls with the page,
  // so re-measure on scroll as well as resize.
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

  // "/" focuses search, the convention this app already uses on /cellar
  // (cellar-shell.tsx). That handler is route-local and cannot be edited from
  // here, so this one yields whenever the page has a search control of its
  // own: route-local search wins on the routes that have one, and this is the
  // fallback everywhere else. Feature detection, not a pathname list, so a
  // route that gains or loses its own search needs no change here.
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
      // Both breakpoint placements are mounted; only the visible one responds.
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

  function commit(wine: SearchWine) {
    close();
    clear();
    router.push(`/cellar/${wine.id}`);
  }

  function clear() {
    setQuery("");
    lookup("");
  }

  function seeAll() {
    const text = query.trim();
    if (!text) return;
    close();
    router.push(`/cellar?q=${encodeURIComponent(text)}`);
  }

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
        placeholder="Search all wines…"
        onChange={(e) => {
          setQuery(e.target.value);
          lookup(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (query) clear();
            else close();
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

      {open && anchor && query.trim().length >= MIN_QUERY ? (
        <ResultsPanel
          anchor={anchor}
          listboxId={listboxId}
          optionId={optionId}
          rows={rows}
          pending={pending}
          active={active}
          onPick={commit}
          onSeeAll={seeAll}
        />
      ) : null}
    </form>
  );
}

/** True when the current route renders a search control that is not this one. */
function pageHasItsOwnSearch(): boolean {
  const candidates = document.querySelectorAll(
    'input[type="search"], [aria-label*="Search"], [aria-label*="search"]',
  );
  for (const el of candidates) {
    if (!el.closest("[data-global-search]")) return true;
  }
  return false;
}

function ResultsPanel({
  anchor,
  listboxId,
  optionId,
  rows,
  pending,
  active,
  onPick,
  onSeeAll,
}: {
  anchor: { top: number; left: number; width: number };
  listboxId: string;
  optionId: string;
  rows: SearchWine[];
  pending: boolean;
  active: number;
  onPick: (wine: SearchWine) => void;
  onSeeAll: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      data-global-search-panel="true"
      className="fixed z-[var(--z-overlay)] max-h-[60vh] overflow-y-auto rounded-card card-surface"
      style={{
        top: anchor.top,
        left: anchor.left,
        width: anchor.width,
        minWidth: 260,
      }}
    >
      {pending && rows.length === 0 ? (
        <p className="px-md py-sm text-body-sm font-light text-grey" role="status">
          Searching…
        </p>
      ) : null}

      {!pending && rows.length === 0 ? (
        <p className="px-md py-sm text-body-sm font-light text-grey">
          No wine in your cellar matches that.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul id={listboxId} role="listbox" aria-label="Wine search results">
          {rows.map((wine, index) => (
            <li key={wine.id} id={`${optionId}-${index}`} role="option" aria-selected={index === active}>
              <button
                type="button"
                onClick={() => onPick(wine)}
                className={cn(
                  "flex w-full items-center gap-sm px-md py-sm text-left transition-colors hover:bg-wash focus-ring",
                  index === active && "bg-wash",
                )}
              >
                <WineThumb
                  src={wine.hero_image_url}
                  producer={wine.producer}
                  name={wine.name}
                  colour={wine.colour}
                  size={32}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-control text-ink">
                    {wine.producer ? `${wine.producer} ` : ""}
                    {wine.name}
                    {wine.vintage ? ` ${wine.vintage}` : ""}
                  </span>
                  <span className="block truncate text-ledger font-light text-grey">
                    {[wine.varietal, wine.region].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        onClick={onSeeAll}
        className="flex min-h-11 w-full items-center border-t border-rule px-md py-sm text-left text-body-sm text-ink-soft transition-colors hover:bg-wash focus-ring"
      >
        See all matches in the cellar
      </button>
    </div>,
    document.body,
  );
}
