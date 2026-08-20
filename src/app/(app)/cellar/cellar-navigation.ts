export type CellarNavigationIntent = {
  filter: "open" | null;
  selectedWineId: string | null;
  shouldFocusSearch: boolean;
  shouldConsumeParams: boolean;
};

/**
 * Translate the short-lived `mode` parameter used by the mobile FAB while
 * treating `wine` as persistent, shareable Cellar state.
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
    shouldConsumeParams: Boolean(mode),
  };
}
