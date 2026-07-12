export type CellarNavigationIntent = {
  filter: "open" | null;
  selectedWineId: string | null;
  shouldFocusSearch: boolean;
  shouldConsumeParams: boolean;
};

/**
 * Translate the short-lived Cellar URL parameters used by the mobile FAB
 * into the UI state they request. Keeping this pure makes same-path query
 * navigations testable without coupling the behavior to Next's router.
 */
export function resolveCellarNavigationIntent(
  mode: string | null,
  wineId: string | null,
  wineIds: ReadonlySet<string>,
): CellarNavigationIntent {
  const shouldFocusSearch = mode === "pour" || mode === "eightysix";

  return {
    filter: mode === "pour" ? "open" : null,
    selectedWineId: wineId && wineIds.has(wineId) ? wineId : null,
    shouldFocusSearch,
    shouldConsumeParams: Boolean(mode || wineId),
  };
}
