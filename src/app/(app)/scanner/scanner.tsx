"use client";

import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { csvFilename, downloadCsv, toCsv } from "@/lib/scanner/csv";
import { useRestaurant } from "@/lib/context/restaurant";
import type {
  LineItem,
  LineItemField,
  RecentScan,
  Scan,
} from "@/lib/scanner/types";
import { ReadyView } from "./views/ready-view";
import { ProcessingView } from "./views/processing-view";
import { ErrorView } from "./views/error-view";
import { ConfidenceGateView } from "./views/confidence-gate";
import { ResultsView } from "./views/results-view";

type Status = "ready" | "processing" | "review" | "results" | "error";
const STORAGE_KEY = "terroir:current-scan";

export { formatMoney } from "./components/field-inputs";

function loadScan(): Scan | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Scan;
  } catch {
    return null;
  }
}

function saveScan(scan: Scan | null) {
  if (typeof window === "undefined") return;
  if (scan) {
    // Strip rawText to avoid bloating localStorage with OCR dumps
    const { rawText: _, ...rest } = scan;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
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

async function postScan(file: File, signal: AbortSignal): Promise<Scan> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/scan", { method: "POST", body, signal });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as
      | { error?: string; rawText?: string }
      | null;
    throw new ScanError(
      payload?.error ?? `Scan failed (${res.status})`,
      payload?.rawText,
    );
  }
  return (await res.json()) as Scan;
}

export function Scanner({ recentScans = [] }: { recentScans?: RecentScan[] }) {
  const { restaurantId: _restaurantId } = useRestaurant();
  const [status, setStatus] = useState<Status>("ready");
  const [progress, setProgress] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [scan, setScan] = useState<Scan | null>(null);
  const [originalItems, setOriginalItems] = useState<LineItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [savedResult, setSavedResult] = useState<{
    itemCount: number;
    wineCount: number;
  } | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setHydrated(true);
    const saved = loadScan();
    if (saved) {
      setScan(saved);
      setStatus("results");
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  /* Progress animation — advances independent of fetch, clamps at 90% until
     the response arrives, then jumps to 100%. */
  useEffect(() => {
    if (status !== "processing") return;
    setProgress(0);
    setStepIndex(0);
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
    }, 120);
    return () => window.clearInterval(id);
  }, [status]);

  const startScan = useCallback(async (file: File) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLastFile(file);
    setStatus("processing");
    setError(null);

    try {
      const fresh = await postScan(file, ac.signal);
      if (ac.signal.aborted) return;
      setProgress(100);
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
    const totalFields = scan.items.length * 7;
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
    if (!scan || isSaving) return;
    setIsSaving(true);
    try {
      const res = await fetch("/api/inventory/save-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scan, originalItems }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `Save failed (${res.status})`);
      }
      const result = (await res.json()) as {
        scanId: string;
        itemCount: number;
        wineCount: number;
      };
      saveScan(null);
      setScan(null);
      setOriginalItems([]);
      setSavedResult(result);
      setStatus("ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed.";
      setToast(message);
    } finally {
      setIsSaving(false);
    }
  }, [scan, originalItems, isSaving]);

  const retryScan = useCallback(() => {
    if (lastFile) startScan(lastFile);
  }, [lastFile, startScan]);

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

  if (!hydrated) return <ReadyView onStart={startScan} recentScans={recentScans} savedResult={null} onDismissSaved={() => {}} />;

  return (
    <>
      {status === "ready" && <ReadyView onStart={startScan} recentScans={recentScans} savedResult={savedResult} onDismissSaved={() => setSavedResult(null)} />}
      {status === "processing" && (
        <ProcessingView progress={progress} stepIndex={stepIndex} />
      )}
      {status === "error" && (
        <ErrorView
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
          onRemove={removeItem}
          onScanAnother={startOver}
          onExportCsv={exportCsv}
          onExportAccuracy={exportAccuracyJson}
          onSaveToInventory={saveToInventory}
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
