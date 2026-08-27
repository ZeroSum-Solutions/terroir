import { describe, expect, it } from "vitest";
import {
  formatStatusLabel,
  getDrinkWindowStatus,
  getMarkerPosition,
  getYearsUntilWindowClose,
  isClosingWindow,
  isHolding,
  shouldTriggerAlert,
} from "./status";

// Pin the year so test fixtures are deterministic. 2026 is "today" in the
// app's universe (CLAUDE.md memory). All tests pass currentYear=2026
// explicitly so the suite can't break when the wall-clock year ticks.
const NOW = 2026;

describe("getDrinkWindowStatus", () => {
  it("returns unknown when either bound is null", () => {
    expect(getDrinkWindowStatus(null, null, NOW)).toBe("unknown");
    expect(getDrinkWindowStatus(2020, null, NOW)).toBe("unknown");
    expect(getDrinkWindowStatus(null, 2030, NOW)).toBe("unknown");
    expect(getDrinkWindowStatus(undefined, undefined, NOW)).toBe("unknown");
  });

  it("returns hold when current year is before the window starts", () => {
    expect(getDrinkWindowStatus(2027, 2050, NOW)).toBe("hold");
    expect(getDrinkWindowStatus(2030, 2040, NOW)).toBe("hold");
  });

  it("returns past_peak when current year is past window end", () => {
    expect(getDrinkWindowStatus(2010, 2020, NOW)).toBe("past_peak");
    expect(getDrinkWindowStatus(2010, 2025, NOW)).toBe("past_peak");
  });

  it("returns drink_now within last 2 years of window (Pichon Lalande example)", () => {
    // Pichon Lalande 2010: window 2018-2030 → 2026 means 4 yrs left → optimal,
    // not yet drink_now (2 yr threshold).
    expect(getDrinkWindowStatus(2018, 2030, NOW)).toBe("optimal");

    // Last 2 years of window: drink_now
    expect(getDrinkWindowStatus(2018, 2028, NOW)).toBe("drink_now");
    expect(getDrinkWindowStatus(2018, 2027, NOW)).toBe("drink_now");
    expect(getDrinkWindowStatus(2018, 2026, NOW)).toBe("drink_now");
  });

  it("returns optimal when comfortably within the window", () => {
    expect(getDrinkWindowStatus(2020, 2035, NOW)).toBe("optimal");
    expect(getDrinkWindowStatus(2018, 2030, NOW)).toBe("optimal");
  });

  it("uses today's year as default when not specified", () => {
    // Verify default arg works (not pinned). Just check it doesn't throw and
    // returns a valid status for a clearly-in-window wine.
    const result = getDrinkWindowStatus(2018, 2050);
    expect(["hold", "optimal", "drink_now", "past_peak"]).toContain(result);
  });
});

describe("getYearsUntilWindowClose", () => {
  it("returns null when end is unknown", () => {
    expect(getYearsUntilWindowClose(null, NOW)).toBeNull();
    expect(getYearsUntilWindowClose(undefined, NOW)).toBeNull();
  });

  it("returns positive years for wines still in window", () => {
    expect(getYearsUntilWindowClose(2030, NOW)).toBe(4);
    expect(getYearsUntilWindowClose(2027, NOW)).toBe(1);
  });

  it("returns 0 in the final year", () => {
    expect(getYearsUntilWindowClose(2026, NOW)).toBe(0);
  });

  it("returns negative years past peak", () => {
    expect(getYearsUntilWindowClose(2020, NOW)).toBe(-6);
  });
});

describe("getMarkerPosition", () => {
  it("returns 0 when window is unknown", () => {
    expect(getMarkerPosition(null, null, NOW)).toBe(0);
    expect(getMarkerPosition(2020, null, NOW)).toBe(0);
  });

  it("places marker at start of window when current year equals start", () => {
    expect(getMarkerPosition(2026, 2050, NOW)).toBe(0);
  });

  it("places marker at end of window when current year equals end", () => {
    expect(getMarkerPosition(2010, 2026, NOW)).toBe(100);
  });

  it("clamps to 0 for wines before window starts", () => {
    expect(getMarkerPosition(2030, 2050, NOW)).toBe(0);
  });

  it("clamps to 100 for wines past peak", () => {
    expect(getMarkerPosition(2010, 2020, NOW)).toBe(100);
  });

  it("places marker proportionally inside window (Pichon Lalande, mock value)", () => {
    // 2018-2030 is a 12-year span. 2026 is 8 years in → 8/12 ≈ 66.67%.
    // The mock claims "67%" — close enough.
    const pos = getMarkerPosition(2018, 2030, NOW);
    expect(pos).toBeCloseTo(66.67, 1);
  });

  it("returns 50 for a degenerate single-year window", () => {
    expect(getMarkerPosition(2026, 2026, NOW)).toBe(50);
  });
});

describe("isClosingWindow", () => {
  it("false when end is unknown", () => {
    expect(isClosingWindow(null, undefined, NOW)).toBe(false);
  });

  it("true within default 2-year threshold", () => {
    expect(isClosingWindow(2027, 2, NOW)).toBe(true);
    expect(isClosingWindow(2026, 2, NOW)).toBe(true);
    expect(isClosingWindow(2028, 2, NOW)).toBe(true);
  });

  it("false when comfortably inside window", () => {
    expect(isClosingWindow(2030, 2, NOW)).toBe(false);
  });

  it("true past peak (must be drunk before further degradation)", () => {
    expect(isClosingWindow(2020, 2, NOW)).toBe(true);
  });

  it("respects custom threshold", () => {
    expect(isClosingWindow(2030, 5, NOW)).toBe(true); // 4 yrs left, 5 threshold
    expect(isClosingWindow(2032, 5, NOW)).toBe(false); // 6 yrs left, 5 threshold
  });
});

describe("shouldTriggerAlert", () => {
  it("only fires within 1 year of window close", () => {
    expect(shouldTriggerAlert(2027, NOW)).toBe(true);
    expect(shouldTriggerAlert(2026, NOW)).toBe(true);
    expect(shouldTriggerAlert(2028, NOW)).toBe(false);
    expect(shouldTriggerAlert(2030, NOW)).toBe(false);
  });

  it("fires past peak", () => {
    expect(shouldTriggerAlert(2020, NOW)).toBe(true);
  });

  it("does not fire when window is unknown", () => {
    expect(shouldTriggerAlert(null, NOW)).toBe(false);
  });
});

describe("isHolding", () => {
  it("true when start is in the future", () => {
    expect(isHolding(2027, NOW)).toBe(true);
    expect(isHolding(2030, NOW)).toBe(true);
  });

  it("false when start is now or past", () => {
    expect(isHolding(2026, NOW)).toBe(false);
    expect(isHolding(2018, NOW)).toBe(false);
  });

  it("false when start is unknown", () => {
    expect(isHolding(null, NOW)).toBe(false);
  });
});

describe("formatStatusLabel", () => {
  it("formats drink_now with years remaining", () => {
    expect(formatStatusLabel("drink_now", 4)).toBe("Drink now · 4 yrs left");
    expect(formatStatusLabel("drink_now", 1)).toBe("Drink now · 1 yr left");
    expect(formatStatusLabel("drink_now", 0)).toBe("Drink now · final year");
    // Negative means past-optimal; status flow shouldn't produce this
    // (past_peak wins) but the label must still distinguish from
    // "final year" if it ever does.
    expect(formatStatusLabel("drink_now", -1)).toBe("Drink now · past optimal");
  });

  it("formats hold with years until ready", () => {
    // Hold reads "ready in" off yearsUntilStart (third arg) — it used to
    // abuse yearsLeft (years until CLOSE), so a 2030–2040 window claimed
    // "ready in 14 yrs" instead of 4 (Kimi audit follow-up 2026-08-26).
    expect(formatStatusLabel("hold", 14, 3)).toBe("Hold · ready in 3 yrs");
    expect(formatStatusLabel("hold", 14, 1)).toBe("Hold · ready in 1 yr");
    expect(formatStatusLabel("hold", 14)).toBe("Hold");
  });

  it("returns plain status when years missing", () => {
    expect(formatStatusLabel("drink_now", null)).toBe("Drink now");
    expect(formatStatusLabel("hold", null)).toBe("Hold");
  });

  it("formats past_peak / optimal / unknown", () => {
    expect(formatStatusLabel("past_peak", -2)).toBe("Past peak");
    expect(formatStatusLabel("optimal", 5)).toBe("Optimal");
    expect(formatStatusLabel("unknown", null)).toBe("—");
  });
});
