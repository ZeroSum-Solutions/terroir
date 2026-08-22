"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readApiError } from "@/lib/api/client-error";
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
import { ProcessingView, stageForProgress } from "./views/processing-view";
import { ErrorView } from "./views/error-view";
import { ConfidenceGateView } from "./views/confidence-gate";
import { ResultsView } from "./views/results-view";
import { BottleResultsView } from "./views/bottle-results-view";

type Status = "ready" | "processing" | "review" | "results" | "bottle-results" | "error";
type Feedback = { kind: "success" | "error"; message: string };
const STORAGE_KEY = "terroir:current-scan";
// Mirrors the server-side limits in /api/scan and /api/scan-bottle so an
// oversized file fails immediately, client-side, instead of only after a
// full network upload.
const INVOICE_MAX_BYTES = 10 * 1024 * 1024;
const BOTTLE_MAX_BYTES = 20 * 1024 * 1024;

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
  rawText?: string;
  constructor(message: string, rawText?: string) {
    super(message);
    this.rawText = rawText;
  }
}

async function postScan(files: File[], signal: AbortSignal, key?: string | null): Promise<Scan> {
  const body = new FormData();
  files.forEach(function(f) { body.append("file", f); });
  const headers: Record<string, string> = {};
  if (key) headers["Idempotency-Key"] = key;
  const res = await fetch("/api/scan", { method: "POST", body, signal, headers });
  if (!res.ok) {
    const failure = readApiError(
      await res.json().catch(() => null),
      `Scan failed (${res.status})`,
    );
    throw new ScanError(failure.message, failure.rawText);
  }
  return (await res.json()) as Scan;
}

export function Scanner({ recentScans = [] }: { recentScans?: RecentScan[] }) {
  const { restaurantId: _restaurantId } = useRestaurant();
  const [status, setStatus] = useState<Status>("ready");
  const [progress, setProgress] = useState(0);
  const [scan, setScan] = useState<Scan | null>(null);
  const [originalItems, setOriginalItems] = useState<LineItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  // BND-006: UUIDv4 generated on the first save attempt and reused across
  // retries of the SAME logical save. Cleared on a successful 2xx (or on a
  // 4xx validation error) so the next save starts with a fresh key; held
  // across 5xx / network failures so a retry hits the idempotency cache
  // instead of double-inserting inventory rows.
  const saveKeyRef = useRef<string | null>(null);
  const bottleSaveKeyRef = useRef<string | null>(null);
  // BND-089: scan idempotency key — generated on first scan attempt, reused
  // across retries. Cleared on success or 4xx validation error; held across
  // 5xx / network failures so retry returns cached result.
  const scanKeyRef = useRef<string | null>(null);
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
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [mode, setMode] = useState<ScanMode>("invoice");
  const [bottleResult, setBottleResult] = useState<BottleScanResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      const saved = loadScan();
      if (saved) {
        setScan(saved);
        setStatus("results");
      }
    });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!feedback) return;
    const id = window.setTimeout(() => setFeedback(null), 2600);
    return () => window.clearTimeout(id);
  }, [feedback]);

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
    }, 250);
    return () => window.clearInterval(id);
  }, [status]);

  const startScan = useCallback(async (files: File[]) => {
    const oversized = files.find((f) => f.size > INVOICE_MAX_BYTES);
    if (oversized) {
      setLastFile(null);
      setError(`"${oversized.name}" is larger than 10 MB. Choose a smaller photo or a lower-resolution scan.`);
      setRawText(null);
      setStatus("error");
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLastFile(files[0]);
    setProgress(0);
    setStatus("processing");
    setError(null);
    setRawText(null);

    // BND-089: mint scanIdempotency key on first attempt, reuse on retry.
    if (!scanKeyRef.current) {
      scanKeyRef.current =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    try {
      const fresh = await postScan(files, ac.signal, scanKeyRef.current);
      if (ac.signal.aborted) return;
      setProgress(100);
      scanKeyRef.current = null; // 2xx → clear for next scan
      setScan(fresh);
      setOriginalItems([...fresh.items]);
      saveScan(fresh);
      setStatus(fresh.quality?.manualFallbackTriggered ? "review" : "results");
    } catch (err) {
      if (ac.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Scan failed.";
      setError(message);
      setRawText(err instanceof ScanError ? err.rawText ?? null : null);
      setStatus("error");
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, []);

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
    scanKeyRef.current = null;
    saveScan(null);
    setScan(null);
    setBottleResult(null);
    setError(null);
    setRawText(null);
    setStatus("ready");
  }, []);

  const cancelScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    scanKeyRef.current = null;
    setProgress(0);
    setError(null);
    setRawText(null);
    setStatus("ready");
  }, []);

  const exportCsv = useCallback(() => {
    if (!scan) return;
    try {
      downloadCsv(csvFilename(scan.source), toCsv(scan.items));
      setFeedback({
        kind: "success",
        message: `Exported ${scan.items.length} wines to CSV`,
      });
    } catch (err) {
      setFeedback({
        kind: "error",
        message: err instanceof Error ? err.message : "CSV export failed.",
      });
    }
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
    let url: string | null = null;
    let link: HTMLAnchorElement | null = null;
    try {
      const json = JSON.stringify(report, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      url = URL.createObjectURL(blob);
      const date = scan.source.parsedAt.slice(0, 10);
      const slug = scan.source.distributor
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      link = document.createElement("a");
      link.href = url;
      link.download = `terroir-accuracy-${date}-${slug}.json`;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      if (link.isConnected) link.remove();
      link = null;
      URL.revokeObjectURL(url);
      url = null;
      setFeedback({ kind: "success", message: "Exported accuracy report" });
    } catch (err) {
      try {
        if (link?.isConnected) link.remove();
      } catch {
        // Preserve the original export or cleanup failure below.
      }
      try {
        if (url) URL.revokeObjectURL(url);
      } catch {
        // Preserve the original export or cleanup failure below.
      }
      setFeedback({
        kind: "error",
        message: err instanceof Error ? err.message : "Accuracy export failed.",
      });
    }
  }, [scan]);

  const saveToInventory = useCallback(async () => {
    if (!scan || isSaving) return;
    setIsSaving(true);
    // Reuse an existing key on retry, or mint a new one on first attempt.
    if (!saveKeyRef.current) {
      saveKeyRef.current =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    try {
      const body = new FormData();
      body.append("data", JSON.stringify({ scan, originalItems }));
      if (lastFile) body.append("file", lastFile);
      const res = await fetch("/api/inventory/save-scan", {
        method: "POST",
        headers: { "Idempotency-Key": saveKeyRef.current },
        body,
      });
      if (!res.ok) {
        // Validation errors (4xx except 408/429) mean the request is
        // structurally broken — a retry with the same key would just
        // replay the same error. Reset so the user can fix and resend.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          saveKeyRef.current = null;
        }
        throw new Error(
          readApiError(
            await res.json().catch(() => null),
            `Save failed (${res.status})`,
          ).message,
        );
      }
      const result = (await res.json()) as {
        scanId: string;
        itemCount: number;
        wineCount: number;
      };
      saveKeyRef.current = null; // 2xx → clear so the next save mints a fresh key
      saveScan(null);
      setScan(null);
      setOriginalItems([]);
      setSavedResult(result);
      setStatus("ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed.";
      setFeedback({ kind: "error", message });
    } finally {
      setIsSaving(false);
    }
  }, [scan, originalItems, isSaving, lastFile]);

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

  const startBottleScan = useCallback(async (file: File) => {
    if (file.size > BOTTLE_MAX_BYTES) {
      setLastFile(null);
      setError(`"${file.name}" is larger than 20 MB. Choose a smaller photo.`);
      setRawText(null);
      setStatus("error");
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLastFile(file);
    setProgress(0);
    setStatus("processing");
    setError(null);
    setRawText(null);

    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/scan-bottle", {
        method: "POST",
        body,
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      if (!res.ok) {
        throw new Error(
          readApiError(
            await res.json().catch(() => null),
            `Scan failed (${res.status})`,
          ).message,
        );
      }
      const result = (await res.json()) as BottleScanResult;
      if (ac.signal.aborted) return;
      setProgress(100);
      setBottleResult(result);
      setStatus("bottle-results");
    } catch (err) {
      if (ac.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Scan failed.";
      setError(message);
      setStatus("error");
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, []);

  const retryScan = useCallback(() => {
    if (!lastFile) return;
    if (mode === "bottle") {
      startBottleScan(lastFile);
    } else {
      startScan([lastFile]);
    }
  }, [lastFile, mode, startBottleScan, startScan]);

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
      if (isSaving) return;
      setIsSaving(true);
      if (!bottleSaveKeyRef.current) {
        bottleSaveKeyRef.current =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      try {
        const res = await fetch("/api/inventory/save-bottle-scan", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": bottleSaveKeyRef.current,
          },
          body: JSON.stringify({ wine }),
        });
        if (!res.ok) {
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            bottleSaveKeyRef.current = null;
          }
          throw new Error(
            readApiError(
              await res.json().catch(() => null),
              `Save failed (${res.status})`,
            ).message,
          );
        }
        bottleSaveKeyRef.current = null;
        setBottleResult(null);
        setSavedResult({ itemCount: 1, wineCount: 1 });
        setStatus("ready");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Save failed.";
        setFeedback({ kind: "error", message });
      } finally {
        setIsSaving(false);
      }
    },
    [isSaving],
  );

  const handleStart = useCallback(
    (files: File[]) => {
      if (mode === "bottle") {
        // A bottle scan identifies one wine from one label photo — unlike
        // an invoice, there's no multi-page concept to batch into. Reject
        // immediately rather than silently scanning only the first photo.
        if (files.length > 1) {
          setLastFile(null);
          setError("Select a single bottle photo. Take or choose one photo per wine.");
          setRawText(null);
          setStatus("error");
          return;
        }
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
        <ProcessingView
          progress={progress}
          stage={stageForProgress(mode, progress)}
          mode={mode}
          onCancel={cancelScan}
        />
      )}
      {status === "error" && (
        <ErrorView
          mode={mode}
          message={error ?? "Unknown error."}
          onRetry={lastFile ? retryScan : startOver}
          onNewPhoto={startOver}
          hasFile={!!lastFile}
          onManual={enterManualEntry}
        />
      )}
      {status === "review" && scan && (
        <ConfidenceGateView
          quality={scan.quality!}
          onReviewResults={() => setStatus("results")}
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
      {feedback && (
        <div
          role={feedback.kind === "error" ? "alert" : "status"}
          aria-live={feedback.kind === "error" ? "assertive" : "polite"}
          className="glass fixed inset-x-md bottom-[88px] z-30 mx-auto max-w-[420px] rounded-card px-md py-sm text-[14px] text-ink md:bottom-lg"
        >
          <div className="flex items-center gap-sm">
            {feedback.kind === "error" ? (
              <AlertTriangle className="h-4 w-4 text-primary" strokeWidth={2.25} aria-hidden="true" />
            ) : (
              <Check className="h-4 w-4 text-sage-ink" strokeWidth={2.25} aria-hidden="true" />
            )}
            {feedback.message}
          </div>
        </div>
      )}
    </>
  );
}
