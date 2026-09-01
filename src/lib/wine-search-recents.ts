// Recent searches for wine search surfaces. Originated as SCAN-09's
// scan-panel empty state (reference screenshot
// docs/screenshots/2026-08-29-field-notes/vivino-search-empty-state.png);
// ported to src/lib for P1 so the unified search palette shares one list
// with the scan panel until that panel is deleted at parity. Kept out of
// the components so the list logic is unit-testable without rendering a
// React tree.
//
// Per-browser, per-device convenience only. Deliberately localStorage and
// not a table: a search someone typed is not cellar data, and syncing it
// would mean a migration and a write on every keystroke for no benefit.
// The storage key keeps its historical "scan" prefix — renaming it would
// throw away everyone's existing list for a cosmetic win.

export const RECENT_SEARCH_LIMIT = 5;
const STORAGE_KEY = "terroir.scan.recentSearches";

/** Most-recent-first, de-duplicated case-insensitively, capped. */
export function mergeRecentSearch(existing: string[], term: string): string[] {
  const trimmed = term.trim();
  if (!trimmed) return existing;
  const lower = trimmed.toLowerCase();
  return [trimmed, ...existing.filter((item) => item.toLowerCase() !== lower)].slice(
    0,
    RECENT_SEARCH_LIMIT,
  );
}

/**
 * Never throws. localStorage is unavailable in a server render, in
 * private-mode Safari, and whenever the user has blocked site data — and a
 * convenience list is not worth a crashed page in any of those.
 */
export function readRecentSearches(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .slice(0, RECENT_SEARCH_LIMIT);
  } catch {
    return [];
  }
}

/** Returns the new list whether or not the write itself succeeded. */
export function addRecentSearch(term: string): string[] {
  const next = mergeRecentSearch(readRecentSearches(), term);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage is full or blocked. The in-memory list is still correct.
  }
  return next;
}
