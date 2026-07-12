import { describe, expect, it } from "vitest";
import { resolveCellarNavigationIntent } from "./cellar-navigation";

describe("resolveCellarNavigationIntent", () => {
  const wineIds = new Set(["wine-1"]);

  it("opens the live-pour view for the Pour FAB action", () => {
    expect(resolveCellarNavigationIntent("pour", null, wineIds)).toEqual({
      filter: "open",
      selectedWineId: null,
      shouldFocusSearch: true,
      shouldConsumeParams: true,
    });
  });

  it("opens search for the 86 FAB action", () => {
    expect(resolveCellarNavigationIntent("eightysix", null, wineIds)).toEqual({
      filter: null,
      selectedWineId: null,
      shouldFocusSearch: true,
      shouldConsumeParams: true,
    });
  });

  it("selects only wines that exist in the current cellar", () => {
    expect(resolveCellarNavigationIntent(null, "wine-1", wineIds).selectedWineId).toBe("wine-1");
    expect(resolveCellarNavigationIntent(null, "missing-wine", wineIds).selectedWineId).toBeNull();
  });
});
