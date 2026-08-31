export type MatchedWine = {
  id: string;
  producer: string;
  name: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
};

export type SessionScan = {
  wine: MatchedWine;
  section: string;
  binLocation: string;
};

export type Phase =
  | "scanning"
  | "manual"
  | "matched"
  | "correcting"
  | "location"
  | "confirmed"
  | "error"
  | "no-camera"
  | "summary";

export interface BottleScanState {
  phase: Phase;
  error: string | null;
  wine: MatchedWine | null;
  payload: string | null;
  manualCode: string;
  searchQuery: string;
  searchResults: MatchedWine[];
  searching: boolean;
  /** A failed correction search, shown in place rather than tearing the
      user out of the correcting phase the way `error` does. */
  searchError: string | null;
  /** SD-10: a failed bin save, shown in place for the same reason. It used
      to become `error`, whose view is headed "Lookup failed" and whose only
      exit discards the wine, the section and the bin just typed. */
  locationError: string | null;
  section: string;
  binLocation: string;
  confirming: boolean;
  // BND-112: batch scanning session state
  session: SessionScan[];
}

export const initialBottleScanState: BottleScanState = {
  phase: "scanning",
  error: null,
  wine: null,
  payload: null,
  manualCode: "",
  searchQuery: "",
  searchResults: [],
  searching: false,
  searchError: null,
  locationError: null,
  section: "",
  binLocation: "",
  confirming: false,
  session: [],
};

export type BottleScanAction =
  | { type: "camera-unavailable" }
  | { type: "decode-started"; payload: string }
  | { type: "lookup-succeeded"; wine: MatchedWine }
  | { type: "lookup-failed"; message: string }
  | { type: "manual-code-changed"; value: string }
  | { type: "correct-search-query-changed"; query: string }
  | { type: "correct-search-started" }
  | { type: "correct-search-completed"; results: MatchedWine[] }
  | { type: "correct-search-failed"; message: string }
  | { type: "correct-wine-selected"; wine: MatchedWine }
  | { type: "correction-started" }
  | { type: "correction-cancelled" }
  | { type: "location-entry-started" }
  | { type: "section-changed"; value: string }
  | { type: "bin-location-changed"; value: string }
  | { type: "location-confirm-started" }
  | { type: "location-confirmed"; scan: SessionScan }
  | { type: "location-confirm-failed"; message: string }
  | { type: "scan-again" }
  | { type: "session-ended" }
  | { type: "new-session-started" }
  | { type: "manual-entry-opened" }
  | { type: "no-camera-manual-entry" }
  | { type: "camera-entry-opened" };

/**
 * Drives the scan-bottle Phase state machine. Each case mirrors one
 * setState-group that used to fire together in page.tsx — see the call
 * sites in page.tsx for exactly which fields each transition touches
 * (several intentionally touch fewer fields than a same-shaped neighbor,
 * e.g. "no-camera-manual-entry" does not clear `error` the way
 * "manual-entry-opened" does).
 */
export function bottleScanReducer(state: BottleScanState, action: BottleScanAction): BottleScanState {
  switch (action.type) {
    case "camera-unavailable":
      return state.phase === "scanning" ? { ...state, phase: "no-camera" } : state;

    case "decode-started":
      return { ...state, payload: action.payload };

    case "lookup-succeeded":
      return { ...state, wine: action.wine, phase: "matched", error: null };

    case "lookup-failed":
      return { ...state, error: action.message, phase: "error" };

    case "manual-code-changed":
      return { ...state, manualCode: action.value };

    case "correct-search-query-changed":
      return action.query.length < 2
        ? { ...state, searchQuery: action.query, searchResults: [], searchError: null }
        : { ...state, searchQuery: action.query, searchError: null };

    case "correct-search-started":
      return { ...state, searching: true, searchError: null };

    case "correct-search-completed":
      return { ...state, searchResults: action.results, searching: false, searchError: null };

    case "correct-search-failed":
      return { ...state, searchResults: [], searching: false, searchError: action.message };

    case "correct-wine-selected":
      return { ...state, wine: action.wine, phase: "matched", error: null };

    case "correction-started":
      return { ...state, phase: "correcting", searchQuery: "", searchResults: [], searchError: null };

    case "correction-cancelled":
      return { ...state, phase: "matched" };

    case "location-entry-started":
      return { ...state, phase: "location", section: "", binLocation: "", locationError: null };

    case "section-changed":
      return { ...state, section: action.value, locationError: null };

    case "bin-location-changed":
      return { ...state, binLocation: action.value, locationError: null };

    case "location-confirm-started":
      return { ...state, confirming: true };

    case "location-confirmed":
      return {
        ...state,
        session: [...state.session, action.scan],
        phase: "confirmed",
        confirming: false,
        locationError: null,
      };

    case "location-confirm-failed":
      return { ...state, locationError: action.message, confirming: false };

    case "scan-again":
      return {
        ...state,
        phase: "scanning",
        error: null,
        wine: null,
        payload: null,
        manualCode: "",
        section: "",
        binLocation: "",
        confirming: false,
        locationError: null,
      };

    case "session-ended":
      return { ...state, phase: "summary" };

    case "new-session-started":
      return {
        ...state,
        session: [],
        phase: "scanning",
        error: null,
        wine: null,
        payload: null,
        manualCode: "",
        section: "",
        binLocation: "",
        confirming: false,
        locationError: null,
      };

    case "manual-entry-opened":
      return { ...state, phase: "manual", error: null };

    case "no-camera-manual-entry":
      return { ...state, phase: "manual" };

    case "camera-entry-opened":
      return { ...state, phase: "scanning", error: null };

    default:
      return state;
  }
}
