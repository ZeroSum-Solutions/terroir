import { describe, expect, it } from "vitest";
import {
  bottleScanReducer,
  initialBottleScanState,
  type BottleScanState,
  type MatchedWine,
} from "./scan-bottle-state";

function wine(overrides: Partial<MatchedWine> = {}): MatchedWine {
  return {
    id: "wine-1",
    producer: "Test Producer",
    name: "Test Wine",
    vintage: 2022,
    varietal: "Pinot Noir",
    region: "Willamette Valley",
    country: "United States",
    ...overrides,
  };
}

describe("bottleScanReducer", () => {
  it("starts in scanning", () => {
    expect(initialBottleScanState.phase).toBe("scanning");
    expect(initialBottleScanState.session).toEqual([]);
  });

  it("camera-unavailable only downgrades from scanning, not any other phase", () => {
    const fromScanning = bottleScanReducer(initialBottleScanState, { type: "camera-unavailable" });
    expect(fromScanning.phase).toBe("no-camera");

    const manual: BottleScanState = { ...initialBottleScanState, phase: "manual" };
    const fromManual = bottleScanReducer(manual, { type: "camera-unavailable" });
    expect(fromManual.phase).toBe("manual");
  });

  it("decode-started only records the payload", () => {
    const next = bottleScanReducer(initialBottleScanState, { type: "decode-started", payload: "QR123" });
    expect(next.payload).toBe("QR123");
    expect(next.phase).toBe("scanning");
  });

  it("lookup-succeeded moves to matched and clears error", () => {
    const seeded: BottleScanState = { ...initialBottleScanState, error: "stale" };
    const w = wine();
    const next = bottleScanReducer(seeded, { type: "lookup-succeeded", wine: w });
    expect(next.wine).toBe(w);
    expect(next.phase).toBe("matched");
    expect(next.error).toBeNull();
  });

  it("lookup-failed moves to error with the message", () => {
    const next = bottleScanReducer(initialBottleScanState, { type: "lookup-failed", message: "not found" });
    expect(next.phase).toBe("error");
    expect(next.error).toBe("not found");
  });

  it("correct-search-query-changed always sets the query, and clears results only when short", () => {
    const seeded: BottleScanState = { ...initialBottleScanState, searchResults: [wine()] };
    const short = bottleScanReducer(seeded, { type: "correct-search-query-changed", query: "a" });
    expect(short.searchQuery).toBe("a");
    expect(short.searchResults).toEqual([]);

    const long = bottleScanReducer(seeded, { type: "correct-search-query-changed", query: "abc" });
    expect(long.searchQuery).toBe("abc");
    // Untouched — the caller decides whether to actually run a search.
    expect(long.searchResults).toEqual([wine()]);
  });

  it("correct-search-started/completed toggle the searching flag", () => {
    const started = bottleScanReducer(initialBottleScanState, { type: "correct-search-started" });
    expect(started.searching).toBe(true);
    const results = [wine()];
    const completed = bottleScanReducer(started, { type: "correct-search-completed", results });
    expect(completed.searching).toBe(false);
    expect(completed.searchResults).toBe(results);
  });

  it("correct-search-failed clears results and records the message", () => {
    const seeded: BottleScanState = {
      ...initialBottleScanState,
      searchResults: [wine()],
      searching: true,
    };
    const failed = bottleScanReducer(seeded, {
      type: "correct-search-failed",
      message: "Search failed (500)",
    });
    expect(failed.searching).toBe(false);
    expect(failed.searchResults).toEqual([]);
    expect(failed.searchError).toBe("Search failed (500)");
    // The phase is untouched: a failed search must not tear the user out of
    // the correcting flow the way a failed lookup does.
    expect(failed.phase).toBe(seeded.phase);

    const retyped = bottleScanReducer(failed, {
      type: "correct-search-query-changed",
      query: "esporao",
    });
    expect(retyped.searchError).toBeNull();
  });

  it("correction-started resets the search box and results", () => {
    const seeded: BottleScanState = {
      ...initialBottleScanState,
      phase: "matched",
      searchQuery: "old",
      searchResults: [wine()],
    };
    const next = bottleScanReducer(seeded, { type: "correction-started" });
    expect(next.phase).toBe("correcting");
    expect(next.searchQuery).toBe("");
    expect(next.searchResults).toEqual([]);
  });

  it("correction-cancelled only changes phase (used by both Cancel and Back)", () => {
    const seeded: BottleScanState = { ...initialBottleScanState, phase: "correcting", searchQuery: "kept" };
    const next = bottleScanReducer(seeded, { type: "correction-cancelled" });
    expect(next.phase).toBe("matched");
    expect(next.searchQuery).toBe("kept");
  });

  it("location-entry-started clears section/binLocation", () => {
    const seeded: BottleScanState = { ...initialBottleScanState, section: "A", binLocation: "B" };
    const next = bottleScanReducer(seeded, { type: "location-entry-started" });
    expect(next.phase).toBe("location");
    expect(next.section).toBe("");
    expect(next.binLocation).toBe("");
  });

  it("location-confirmed appends to the session and returns to confirmed, clearing confirming", () => {
    const seeded: BottleScanState = { ...initialBottleScanState, confirming: true };
    const scan = { wine: wine(), section: "Red Room", binLocation: "A-1" };
    const next = bottleScanReducer(seeded, { type: "location-confirmed", scan });
    expect(next.session).toEqual([scan]);
    expect(next.phase).toBe("confirmed");
    expect(next.confirming).toBe(false);
  });

  /**
   * SD-10 — a failed bin save used to switch to the `error` phase, whose view
   * is headed "Lookup failed" (a different failure entirely) and whose only
   * way out is "Try again" → `scan-again`, which throws away the wine, the
   * section and the bin the operator had just typed. The failure is now shown
   * in place, exactly the way `searchError` is during `correcting`.
   */
  it("location-confirm-failed reports in place and keeps the typed bin", () => {
    const scan = { wine: wine(), section: "Red Room", binLocation: "A-1" };
    const seeded: BottleScanState = {
      ...initialBottleScanState,
      phase: "location",
      wine: wine(),
      section: "Red Room",
      binLocation: "A-1",
      confirming: true,
      session: [scan],
    };
    const next = bottleScanReducer(seeded, { type: "location-confirm-failed", message: "Bin already full." });
    expect(next.phase).toBe("location");
    expect(next.locationError).toBe("Bin already full.");
    expect(next.error).toBeNull();
    expect(next.confirming).toBe(false);
    expect(next.wine).toEqual(wine());
    expect(next.section).toBe("Red Room");
    expect(next.binLocation).toBe("A-1");
    expect(next.session).toEqual([scan]);
  });

  it("editing either location field clears a stale save error", () => {
    const seeded: BottleScanState = {
      ...initialBottleScanState,
      phase: "location",
      locationError: "Bin already full.",
    };
    expect(bottleScanReducer(seeded, { type: "section-changed", value: "Cave" }).locationError).toBeNull();
    expect(bottleScanReducer(seeded, { type: "bin-location-changed", value: "B-2" }).locationError).toBeNull();
  });

  it("starting a new location entry and a successful save both clear the error", () => {
    const seeded: BottleScanState = {
      ...initialBottleScanState,
      phase: "location",
      locationError: "Bin already full.",
    };
    expect(bottleScanReducer(seeded, { type: "location-entry-started" }).locationError).toBeNull();
    const scan = { wine: wine(), section: "Red Room", binLocation: "A-1" };
    expect(bottleScanReducer(seeded, { type: "location-confirmed", scan }).locationError).toBeNull();
  });

  it("scan-again resets the capture form but preserves the session", () => {
    const scan = { wine: wine(), section: "Red Room", binLocation: "A-1" };
    const seeded: BottleScanState = {
      ...initialBottleScanState,
      phase: "confirmed",
      wine: wine(),
      payload: "QR1",
      manualCode: "code",
      section: "s",
      binLocation: "b",
      session: [scan],
    };
    const next = bottleScanReducer(seeded, { type: "scan-again" });
    expect(next.phase).toBe("scanning");
    expect(next.wine).toBeNull();
    expect(next.payload).toBeNull();
    expect(next.manualCode).toBe("");
    expect(next.section).toBe("");
    expect(next.binLocation).toBe("");
    expect(next.session).toEqual([scan]);
  });

  it("session-ended only changes phase", () => {
    const scan = { wine: wine(), section: "Red Room", binLocation: "A-1" };
    const seeded: BottleScanState = { ...initialBottleScanState, session: [scan] };
    const next = bottleScanReducer(seeded, { type: "session-ended" });
    expect(next.phase).toBe("summary");
    expect(next.session).toEqual([scan]);
  });

  it("new-session-started clears the session on top of the scan-again reset", () => {
    const scan = { wine: wine(), section: "Red Room", binLocation: "A-1" };
    const seeded: BottleScanState = { ...initialBottleScanState, phase: "summary", session: [scan] };
    const next = bottleScanReducer(seeded, { type: "new-session-started" });
    expect(next.phase).toBe("scanning");
    expect(next.session).toEqual([]);
  });

  it("manual-entry-opened clears error; no-camera-manual-entry does not", () => {
    const seeded: BottleScanState = { ...initialBottleScanState, error: "stale" };
    const opened = bottleScanReducer(seeded, { type: "manual-entry-opened" });
    expect(opened.phase).toBe("manual");
    expect(opened.error).toBeNull();

    const fromNoCamera = bottleScanReducer(seeded, { type: "no-camera-manual-entry" });
    expect(fromNoCamera.phase).toBe("manual");
    expect(fromNoCamera.error).toBe("stale");
  });

  it("camera-entry-opened returns to scanning and clears error", () => {
    const seeded: BottleScanState = { ...initialBottleScanState, phase: "manual", error: "stale" };
    const next = bottleScanReducer(seeded, { type: "camera-entry-opened" });
    expect(next.phase).toBe("scanning");
    expect(next.error).toBeNull();
  });
});
