"use client";

import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readApiError } from "@/lib/api/client-error";
import {
  createBinaryCommandFingerprint,
  createIdempotentCommandStore,
  createSessionCommandPersistence,
  readApiErrorCode,
} from "@/lib/api/idempotency-client";
import { csvFilename, downloadCsv, toCsv } from "@/lib/scanner/csv";
import {
  PERSISTED_SCAN_VERSION,
  PersistedScanSchema,
} from "@/lib/scanner/schema";
import { SCORED_FIELDS_COUNT } from "@/lib/scanner/scored-fields";
import { useRestaurant } from "@/lib/context/restaurant";
import type {
  BottleScanResult,
  LineItem,
  LineItemField,
  RecentScan,
  Scan,
  ScanMode,
} from "@/lib/scanner/types";
import { ReadyView } from "./views/ready-view";
import { ProcessingView } from "./views/processing-view";
import { ErrorView } from "./views/error-view";
import { ConfidenceGateView } from "./views/confidence-gate";
import { ResultsView } from "./views/results-view";
import { BottleResultsView } from "./views/bottle-results-view";

type Status = "ready" | "processing" | "review" | "results" | "bottle-results" | "error";
const STORAGE_KEY = "terroir:current-scan";
const bottleScanCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence(
    "terroir:bottle-label-scan",
  ),
});

export { formatMoney } from "./components/field-inputs";

/**
 * BND-024 / ARCH-010 — the persisted scan is wrapped in a version
 * envelope: `{ version: N, data: Scan-without-rawText }`. Anything
 * that doesn't round-trip through PersistedScanSchema is dropped AND
 * removed from localStorage so a stale blob can't trigger the drop
 * path on every subsequent mount.
 */
function loadScan(): Scan | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }

  const result = PersistedScanSchema.safeParse(parsed);
  if (!result.success) {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return result.data.data as Scan;
}

function saveScan(scan: Scan | null) {
  if (typeof window === "undefined") return;
  if (scan) {
    // Strip rawText to avoid bloating localStorage with OCR dumps
    const { rawText: _, ...data } = scan;
    const envelope = { version: PERSISTED_SCAN_VERSION, data };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

class ScanError extends Error {
  status: number;
  code: string | null;
  rawText?: string;
  constructor(
    message: string,
    status: number,
    code: string | null,
    rawText?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.rawText = rawText;
  }
}

export function Scanner({ recentScans = [] }: { recentScans?: RecentScan[] }) {
  const { restaurantId: _restaurantId } = useRestaurant();
  const [status, setStatus] = useState<Status>("ready");
  const [progress, setProgress] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [scan, setScan] = useState<Scan | null>(null);
  const [originalItems, setOriginalItems] = useState<LineItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const [commands] = useState(() => createIdempotentCommandStore());
  const [savedResult, setSavedResult] = useState<{
    itemCount: number;
    wineCount: number;
  } | null>(null);
  // SSR-safe hydration flag: returns false during SSR, true after mount.
  // Avoids the setState-in-effect pattern for a one-shot client-only boolean.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [lastFiles, setLastFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<ScanMode>("invoice");
  const [bottleResult, setBottleResult] = useState<BottleScanResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottleScanBusyRef = useRef(false);

  useEffect(() => {
    queueMicrotask(() => {
      const saved = loadScan();
      if (saved) {
        setScan(saved);
        setStatus(
          saved.quality?.manualFallbackTriggered &&
            !saved.reviewedLowConfidence
            ? "review"
            : "results",
        );
      }
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  /* Progress animation — advances independent of fetch, clamps at 90% until
     the response arrives, then jumps to 100%. Reset to 0 happens in startScan
     (when status transitions to "processing") so this effect has no
     synchronous setState on entry. */
  useEffect(() => {
    if (status !== "processing") return;
    const start = performance.now();
    const SOFT_DURATION = 18000;
    const id = window.setInterval(() => {
      const elapsed = performance.now() - start;
      const pct =
        elapsed <= SOFT_DURATION
          ? Math.min(90, Math.round((elapsed / SOFT_DURATION) * 90))
          : Math.min(95, 90 + Math.round(((elapsed - SOFT_DURATION) / 60000) * 5));
      setProgress(pct);
      setStepIndex(pct < 30 ? 0 : pct < 60 ? 1 : 2);
    }, 250);
    return () => window.clearInterval(id);
  }, [status]);

  const startScan = useCallback(
    async (files: File[]) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLastFile(files[0]);
      setLastFiles(files);
      setProgress(0);
      setStepIndex(0);
      setStatus("processing");
      setError(null);

      try {
        const identity = {
          files: files.map((file) => ({
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified,
          })),
        };
        const fingerprint = await createBinaryCommandFingerprint(
          identity,
          ...files,
        );
        const { response, data } = await commands.binary<unknown>({
          slot: `scan:invoice:${fingerprint}`,
          url: "/api/scan",
          method: "POST",
          fingerprint,
          signal: ac.signal,
          makeBody: () => {
            const body = new FormData();
            files.forEach((file) => body.append("file", file));
            return body;
          },
        });
        if (ac.signal.aborted) return;
        if (!response.ok) {
          const failure = readApiError(
            data,
            `Scan failed (${response.status})`,
          );
          throw new ScanError(
            failure.message,
            response.status,
            readApiErrorCode(data),
            failure.rawText,
          );
        }

        const fresh = data as Scan;
        setProgress(100);
        setScan(fresh);
        setOriginalItems([...fresh.items]);
        saveScan(fresh);
        setStatus(
          fresh.quality?.manualFallbackTriggered
            ? "review"
            : "results",
        );
      } catch (err) {
        if (ac.signal.aborted) return;
        const message =
          err instanceof Error ? err.message : "Scan failed.";
        setError(message);
        setRawText(
          err instanceof ScanError ? err.rawText ?? null : null,
        );
        setStatus("error");
      }
    },
    [commands],
  );

  const updateField = useCallback(
    (id: string, field: LineItemField, value: string | number | null) => {
      setScan((prev) => {
        if (!prev) return prev;
        const next: Scan = {
          ...prev,
          items: prev.items.map((it) =>
            it.id === id ? ({ ...it, [field]: value } as LineItem) : it,
          ),
          edits: { ...prev.edits, [`${id}:${field}`]: true },
        };
        saveScan(next);
        return next;
      });
    },
    [],
  );


  const updateSource = useCallback(
    (field: "distributor" | "invoiceNo" | "invoiceDate", value: string) => {
      setScan((prev) => {
        if (!prev) return prev;
        const next: Scan = {
          ...prev,
          source: { ...prev.source, [field]: value },
        };
        saveScan(next);
        return next;
      });
    },
    [],
  );

  const removeItem = useCallback((id: string) => {
    setScan((prev) => {
      if (!prev) return prev;
      const next: Scan = {
        ...prev,
        items: prev.items.filter((it) => it.id !== id),
      };
      saveScan(next);
      return next;
    });
  }, []);

  const startOver = useCallback(() => {
    abortRef.current?.abort();
    saveScan(null);
    setScan(null);
    setLastFile(null);
    setLastFiles([]);
    setBottleResult(null);
    setError(null);
    setRawText(null);
    setStatus("ready");
  }, []);

  const exportCsv = useCallback(() => {
    if (!scan) return;
    downloadCsv(csvFilename(scan.source), toCsv(scan.items));
    setToast(`Exported ${scan.items.length} wines to CSV`);
  }, [scan]);

  const exportAccuracyJson = useCallback(() => {
    if (!scan) return;
    const totalFields = scan.items.length * SCORED_FIELDS_COUNT;
    const editedFields = Object.keys(scan.edits).length;
    const accuracy =
      totalFields === 0
        ? 1
        : Math.max(0, (totalFields - editedFields) / totalFields);
    const report = {
      exportedAt: new Date().toISOString(),
      source: scan.source,
      items: scan.items,
      edits: scan.edits,
      accuracy: {
        percentage: Math.round(accuracy * 1000) / 10,
        editedFields,
        totalFields,
      },
    };
    const json = JSON.stringify(report, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const date = scan.source.parsedAt.slice(0, 10);
    const slug = scan.source.distributor
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const a = document.createElement("a");
    a.href = url;
    a.download = `terroir-accuracy-${date}-${slug}.json`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setToast("Exported accuracy report");
  }, [scan]);

  const saveToInventory = useCallback(async () => {
    if (!scan || savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const fingerprint = await createBinaryCommandFingerprint(
        {
          scan,
          originalItems,
          file: lastFile
            ? {
                name: lastFile.name,
                size: lastFile.size,
                type: lastFile.type,
                lastModified: lastFile.lastModified,
              }
            : null,
        },
        ...(lastFile ? [lastFile] : []),
      );
      const { response, data } = await commands.binary<{
        scanId: string;
        itemCount: number;
        wineCount: number;
      }>({
        slot: "inventory:invoice-save",
        url: "/api/inventory/save-scan",
        method: "POST",
        fingerprint,
        makeBody: () => {
          const body = new FormData();
          body.append(
            "data",
            JSON.stringify({ scan, originalItems }),
          );
          if (lastFile) body.append("file", lastFile);
          return body;
        },
      });
      if (!response.ok) {
        throw new Error(
          readApiError(
            data,
            `Save failed (${response.status})`,
          ).message,
        );
      }
      saveScan(null);
      setScan(null);
      setOriginalItems([]);
      setLastFile(null);
      setLastFiles([]);
      setSavedResult(data);
      setStatus("ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed.";
      setToast(message);
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [commands, scan, originalItems, lastFile]);

  const enterManualEntry = useCallback(() => {
    const parsedAt = new Date().toISOString();
    const fresh: Scan = {
      source: {
        distributor: "Manual entry",
        invoiceNo: "—",
        invoiceDate: parsedAt.slice(0, 10),
        parsedAt,
      },
      items: [
        {
          id: `${parsedAt}-0`,
          name: "",
          producer: "",
          vintage: null,
          varietal: "",
          region: "",
          qty: 1,
          unitCost: 0,
          currency: null,
          format: null,
          confidence: 1,
        },
      ],
      edits: {},
      rawText: rawText ?? undefined,
    };
    setScan(fresh);
    saveScan(fresh);
    setError(null);
    setStatus("results");
  }, [rawText]);

  const reviewLowConfidenceResults = useCallback(() => {
    setScan((current) => {
      if (!current) return current;
      const reviewed = { ...current, reviewedLowConfidence: true };
      saveScan(reviewed);
      return reviewed;
    });
    setStatus("results");
  }, []);

  const startBottleScan = useCallback(async (file: File) => {
    if (bottleScanBusyRef.current) return;
    bottleScanBusyRef.current = true;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLastFile(file);
    setLastFiles([file]);
    setStatus("processing");
    setError(null);

    try {
      const identity = {
        file: {
          size: file.size,
          type: file.type,
        },
      };
      const fingerprint = await createBinaryCommandFingerprint(
        identity,
        file,
      );
      const { response, data } =
        await bottleScanCommands.binary<unknown>({
          slot: "identify",
          url: "/api/scan-bottle",
          method: "POST",
          fingerprint,
          signal: ac.signal,
          makeBody: () => {
            const body = new FormData();
            body.append("file", file);
            return body;
          },
        });
      if (ac.signal.aborted) return;
      if (!response.ok) {
        const storedResult =
          response.headers.get("Idempotency-Replayed") !== null;
        if (
          storedResult &&
          (response.status === 429 || response.status >= 500)
        ) {
          bottleScanCommands.abandon("identify");
        }
        throw new Error(
          readApiError(
            data,
            `Scan failed (${response.status})`,
          ).message,
        );
      }
      const result = data as BottleScanResult;
      setProgress(100);
      setBottleResult(result);
      setStatus("bottle-results");
    } catch (err) {
      if (ac.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Scan failed.";
      setError(message);
      setStatus("error");
    } finally {
      bottleScanBusyRef.current = false;
    }
  }, []);

  const retryScan = useCallback(() => {
    if (mode === "bottle") {
      if (lastFile) void startBottleScan(lastFile);
      return;
    }
    if (lastFiles.length > 0) void startScan(lastFiles);
  }, [lastFile, lastFiles, mode, startBottleScan, startScan]);

  const saveBottleToInventory = useCallback(
    async (wine: {
      name: string;
      producer: string;
      vintage: number | null;
      varietal: string;
      region: string;
      country: string | null;
      qty: number;
      unitCost: number;
    }) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setIsSaving(true);
      try {
        const { response, data } =
          await commands.json<unknown>({
            slot: "inventory:bottle-save",
            url: "/api/inventory/save-bottle-scan",
            method: "POST",
            json: { wine },
          });
        if (!response.ok) {
          throw new Error(
            readApiError(
              data,
              `Save failed (${response.status})`,
            ).message,
          );
        }
        setBottleResult(null);
        setLastFile(null);
        setLastFiles([]);
        setSavedResult({ itemCount: 1, wineCount: 1 });
        setStatus("ready");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Save failed.";
        setToast(message);
      } finally {
        savingRef.current = false;
        setIsSaving(false);
      }
    },
    [commands],
  );

  const handleStart = useCallback(
    (files: File[]) => {
      if (mode === "bottle") {
        if (files[0]) startBottleScan(files[0]);
      } else {
        startScan(files);
      }
    },
    [mode, startBottleScan, startScan],
  );

  if (!hydrated) return <ReadyView onStart={handleStart} mode={mode} onModeChange={setMode} recentScans={recentScans} savedResult={null} onDismissSaved={() => {}} />;

  return (
    <>
      {status === "ready" && <ReadyView onStart={handleStart} mode={mode} onModeChange={setMode} recentScans={recentScans} savedResult={savedResult} onDismissSaved={() => setSavedResult(null)} />}
      {status === "processing" && (
        <ProcessingView progress={progress} stepIndex={stepIndex} mode={mode} />
      )}
      {status === "error" && (
        <ErrorView
          message={error ?? "Unknown error."}
          onRetry={lastFiles.length > 0 ? retryScan : startOver}
          onNewPhoto={startOver}
          hasFile={lastFiles.length > 0}
          onManual={enterManualEntry}
        />
      )}
      {status === "review" && scan && (
        <ConfidenceGateView
          quality={scan.quality!}
          onReviewResults={reviewLowConfidenceResults}
          onManualEntry={enterManualEntry}
        />
      )}
      {status === "results" && scan && (
        <ResultsView
          scan={scan}
          onUpdate={updateField}
          onUpdateSource={updateSource}
          onRemove={removeItem}
          onScanAnother={startOver}
          onExportCsv={exportCsv}
          onExportAccuracy={exportAccuracyJson}
          onSaveToInventory={saveToInventory}
          isSaving={isSaving}
        />
      )}
      {status === "bottle-results" && bottleResult && (
        <BottleResultsView
          result={bottleResult}
          onSave={saveBottleToInventory}
          onScanAnother={startOver}
          isSaving={isSaving}
        />
      )}
      {toast && (
        <div role="alert" aria-live="assertive" className="fixed inset-x-md bottom-[88px] z-30 mx-auto max-w-[420px] rounded-md bg-surface-inverse px-md py-sm text-[14px] text-white shadow-lg md:bottom-lg">
          <div className="flex items-center gap-sm">
            <Check className="h-4 w-4 text-success" strokeWidth={2.25} aria-hidden="true" />
            {toast}
          </div>
        </div>
      )}
    </>
  );
}
