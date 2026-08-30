import type {
  BottleScanResult,
  LineItem,
  LineItemField,
  Scan,
} from "@/lib/scanner/types";

export type Status = "ready" | "processing" | "review" | "results" | "bottle-results" | "error";

export interface ScannerState {
  status: Status;
  progress: number;
  scan: Scan | null;
  originalItems: LineItem[];
  savedResult: { itemCount: number; wineCount: number } | null;
  error: string | null;
  rawText: string | null;
  lastFile: File | null;
  lastFiles: File[];
  bottleResult: BottleScanResult | null;
}

export const initialScannerState: ScannerState = {
  status: "ready",
  progress: 0,
  scan: null,
  originalItems: [],
  savedResult: null,
  error: null,
  rawText: null,
  lastFile: null,
  lastFiles: [],
  bottleResult: null,
};

export type ScannerAction =
  | { type: "scan-restored"; scan: Scan }
  | { type: "invoice-rejected"; message: string }
  | { type: "invoice-scan-started"; files: File[] }
  | { type: "invoice-scan-succeeded"; scan: Scan }
  | { type: "invoice-scan-failed"; message: string; rawText: string | null }
  | { type: "field-updated"; id: string; field: LineItemField; value: string | number | null }
  | { type: "source-updated"; field: "distributor" | "invoiceNo" | "invoiceDate"; value: string }
  | { type: "item-removed"; id: string }
  | { type: "reset" }
  | { type: "scan-cancelled" }
  | { type: "invoice-saved"; result: { itemCount: number; wineCount: number } }
  | { type: "manual-entry-started"; scan: Scan }
  | { type: "bottle-rejected"; message: string }
  | { type: "bottle-scan-started"; file: File }
  | { type: "bottle-scan-succeeded"; result: BottleScanResult }
  | { type: "bottle-scan-failed"; message: string }
  | { type: "bottle-saved" }
  | { type: "saved-result-dismissed" }
  | { type: "progress-tick"; progress: number }
  | { type: "review-passed" };

/**
 * Drives the Scanner's Status state machine. Each case mirrors one
 * setState-group that used to fire together in scanner.tsx — see the
 * call sites in scanner.tsx for the (mode-specific, sometimes
 * deliberately partial) field lists each transition touches.
 */
export function scannerReducer(state: ScannerState, action: ScannerAction): ScannerState {
  switch (action.type) {
    case "scan-restored":
      return { ...state, status: "results", scan: action.scan };

    case "invoice-rejected":
      return {
        ...state,
        lastFile: null,
        lastFiles: [],
        error: action.message,
        rawText: null,
        status: "error",
      };

    case "invoice-scan-started":
      return {
        ...state,
        lastFile: action.files[0] ?? null,
        lastFiles: action.files,
        progress: 0,
        status: "processing",
        error: null,
        rawText: null,
      };

    case "invoice-scan-succeeded":
      return {
        ...state,
        progress: 100,
        scan: action.scan,
        originalItems: [...action.scan.items],
        status: action.scan.quality?.manualFallbackTriggered ? "review" : "results",
      };

    case "invoice-scan-failed":
      return { ...state, error: action.message, rawText: action.rawText, status: "error" };

    case "field-updated": {
      if (!state.scan) return state;
      const next: Scan = {
        ...state.scan,
        items: state.scan.items.map((it) =>
          it.id === action.id ? ({ ...it, [action.field]: action.value } as LineItem) : it,
        ),
        edits: { ...state.scan.edits, [`${action.id}:${action.field}`]: true },
      };
      return { ...state, scan: next };
    }

    case "source-updated": {
      if (!state.scan) return state;
      const next: Scan = {
        ...state.scan,
        source: { ...state.scan.source, [action.field]: action.value },
      };
      return { ...state, scan: next };
    }

    case "item-removed": {
      if (!state.scan) return state;
      const next: Scan = {
        ...state.scan,
        items: state.scan.items.filter((it) => it.id !== action.id),
      };
      return { ...state, scan: next };
    }

    // Invoice-flow restart or bottle-flow restart ("Scan another", the
    // bottle error's "New photo"). Whether the persisted invoice draft in
    // localStorage is also cleared is decided by the caller (only an
    // invoice-mode restart may call saveScan(null)) — this action only
    // ever touches in-memory state, matching the original startOver.
    case "reset":
      return { ...state, scan: null, bottleResult: null, error: null, rawText: null, status: "ready" };

    case "scan-cancelled":
      return { ...state, progress: 0, error: null, rawText: null, status: "ready" };

    case "invoice-saved":
      return { ...state, scan: null, originalItems: [], savedResult: action.result, status: "ready" };

    case "manual-entry-started":
      return { ...state, scan: action.scan, error: null, status: "results" };

    case "bottle-rejected":
      return { ...state, lastFile: null, error: action.message, rawText: null, status: "error" };

    case "bottle-scan-started":
      return {
        ...state,
        lastFile: action.file,
        progress: 0,
        status: "processing",
        error: null,
        rawText: null,
      };

    case "bottle-scan-succeeded":
      return { ...state, progress: 100, bottleResult: action.result, status: "bottle-results" };

    case "bottle-scan-failed":
      return { ...state, error: action.message, status: "error" };

    case "bottle-saved":
      return {
        ...state,
        bottleResult: null,
        savedResult: { itemCount: 1, wineCount: 1 },
        status: "ready",
      };

    case "saved-result-dismissed":
      return { ...state, savedResult: null };

    case "progress-tick":
      return { ...state, progress: action.progress };

    // ConfidenceGateView's "Review AI results" — the scan stays exactly
    // as loaded, only the gate is dismissed.
    case "review-passed":
      return { ...state, status: "results" };

    default:
      return state;
  }
}
