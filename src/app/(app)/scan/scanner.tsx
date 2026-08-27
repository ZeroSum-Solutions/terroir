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
import { markScanStage, reportScanStage } from "@/lib/scanner/scan-timing";
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
// Mirrors MAX_INVOICE_PAGES in /api/scan/route.ts.
const MAX_INVOICE_PAGES = 8;
// Mirrors ALLOWED_MIME in /api/scan/route.ts, so an unsupported file type
// fails immediately, client-side, instead of only after a round trip.
const ALLOWED_INVOICE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "application/pdf",
]);
const ALLOWED_INVOICE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "heif", "pdf"]);
// A request that never resolves (dropped connection, stalled proxy) must
// still fail visibly rather than leaving the user staring at "still
// working" forever — generous ceiling above the ~90s Azure OCR budget
// plus one Claude extraction retry.
const SCAN_TIMEOUT_MS = 150_000;

function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

/**
 * Some mobile browsers/webviews hand over a camera-captured file with no
 * declared MIME type (or a generic one) — fall back to the extension
 * rather than rejecting a legitimate photo or PDF outright.
 */
function isAllowedInvoiceFile(file: File): boolean {
  if (file.type) return ALLOWED_INVOICE_MIME.has(file.type);
  return ALLOWED_INVOICE_EXTENSIONS.has(fileExtension(file.name));
}

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
  // M1-1: client-side "prep" (building the request) and "upload" (the
  // network round trip) stages. scanId is the scan's own idempotency key
  // so these reports correlate with the server-side spans in
  // src/domains/scanning/scan-telemetry.ts.
  const scanId = key ?? "unkeyed";
  markScanStage("prep", "start");
  const body = new FormData();
  files.forEach(function(f) { body.append("file", f); });
  const headers: Record<string, string> = {};
  if (key) headers["Idempotency-Key"] = key;
  markScanStage("prep", "end");
  reportScanStage(scanId, "prep", { fileCount: files.length });

  markScanStage("upload", "start");
  const res = await fetch("/api/scan", { method: "POST", body, signal, headers });
  if (!res.ok) {
    const failure = readApiError(
      await res.json().catch(() => null),
      `Scan failed (${res.status})`,
    );
    markScanStage("upload", "end");
    reportScanStage(scanId, "upload", { ok: false, status: res.status });
    throw new ScanError(failure.message, failure.rawText);
  }
  const result = (await res.json()) as Scan;
  markScanStage("upload", "end");
  reportScanStage(scanId, "upload", { ok: true, status: res.status });
  return result;
}

export function Scanner({
  recentScans = [],
  initialMode = "invoice",
}: {
  recentScans?: RecentScan[];
  initialMode?: ScanMode;
}) {
  const { restaurantId: _restaurantId } = useRestaurant();
  const [status, setStatus] = useState<Status>("ready");
  const [progress, setProgress] = useState(0);
  const [scan, setScan] = useState<Scan | null>(null);
  const [originalItems, setOriginalItems] = useState<LineItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  // Authoritative synchronous guard against a double-tap double-submit:
  // `isSaving` state only flips the button's `disabled` attribute on the
  // NEXT render (~10ms later), so two native click events dispatched in
  // the same synchronous task both see the stale `isSaving === false`
  // closure and both pass the `if (isSaving) return` check, firing two
  // POSTs. A ref is read AND written synchronously, before any render, so
  // the second same-tick call sees the first call's write immediately.
  // Shared by both save paths below since they share `isSaving` itself.
  const isSavingRef = useRef(false);
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
  // The full originally-selected invoice batch (possibly several files),
  // preserved so a recoverable error's "Retry" resubmits everything the
  // user picked — not just the first file (see BND-089 retry gap).
  const [lastFiles, setLastFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<ScanMode>(initialMode);
  const [bottleResult, setBottleResult] = useState<BottleScanResult | null>(null);
  // Immediate-acknowledgment preview (walkthrough §1.2, item 7): an object
  // URL for the just-picked label photo, set synchronously before the
  // /api/scan-bottle round-trip resolves so ProcessingView can render the
  // user's own photo instead of a generic icon.
  const [bottlePreviewUrl, setBottlePreviewUrlState] = useState<string | null>(null);
  const bottlePreviewUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scanTimeoutRef = useRef<number | null>(null);
  const timedOutRef = useRef(false);

  const setBottlePreview = useCallback((file: File | null) => {
    if (bottlePreviewUrlRef.current) URL.revokeObjectURL(bottlePreviewUrlRef.current);
    const url = file ? URL.createObjectURL(file) : null;
    bottlePreviewUrlRef.current = url;
    setBottlePreviewUrlState(url);
  }, []);

  const clearScanTimeout = useCallback(() => {
    if (scanTimeoutRef.current != null) {
      window.clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      const saved = loadScan();
      if (saved) {
        setScan(saved);
        setStatus("results");
      }
    });
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      clearScanTimeout();
      if (bottlePreviewUrlRef.current) URL.revokeObjectURL(bottlePreviewUrlRef.current);
    },
    [clearScanTimeout],
  );

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
    // Client-side pre-validation — every case below must fail immediately,
    // before any network call, with a specific and visible explanation.
    // Retry is never offered for these: the same files would fail the same
    // way, so lastFiles is cleared rather than preserved.
    const unsupported = files.find((f) => !isAllowedInvoiceFile(f));
    if (unsupported) {
      setLastFile(null);
      setLastFiles([]);
      setError(`"${unsupported.name}" isn't a supported file type. Upload a JPG, PNG, HEIC, or PDF.`);
      setRawText(null);
      setStatus("error");
      return;
    }

    // A PDF is already a complete multi-page document, unlike a photo — so
    // combining one with ANY other file (another PDF, or a loose photo)
    // would silently merge unrelated documents into one garbled result
    // (mirrors the /api/scan check). Only two shapes are allowed: exactly
    // one PDF alone, or up to MAX_INVOICE_PAGES photos with no PDF at all.
    const pdfCount = files.filter((f) => f.type === "application/pdf" || fileExtension(f.name) === "pdf").length;
    if (pdfCount > 0 && files.length > 1) {
      setLastFile(null);
      setLastFiles([]);
      setError(
        pdfCount > 1
          ? `You selected ${pdfCount} PDFs. Upload one PDF per invoice — scan each invoice separately, or take a photo of each page instead.`
          : "A PDF is a complete invoice on its own — upload it by itself, or upload photos without a PDF.",
      );
      setRawText(null);
      setStatus("error");
      return;
    }

    if (files.length > MAX_INVOICE_PAGES) {
      setLastFile(null);
      setLastFiles([]);
      setError(`Select up to ${MAX_INVOICE_PAGES} pages per invoice scan. You selected ${files.length}.`);
      setRawText(null);
      setStatus("error");
      return;
    }

    const oversized = files.find((f) => f.size > INVOICE_MAX_BYTES);
    if (oversized) {
      setLastFile(null);
      setLastFiles([]);
      setError(`"${oversized.name}" is larger than 10 MB. Choose a smaller photo or a lower-resolution scan.`);
      setRawText(null);
      setStatus("error");
      return;
    }

    abortRef.current?.abort();
    clearScanTimeout();
    const ac = new AbortController();
    abortRef.current = ac;
    timedOutRef.current = false;
    // A stalled/dropped connection must fail visibly instead of leaving
    // "still working" on screen forever — see SCAN_TIMEOUT_MS.
    scanTimeoutRef.current = window.setTimeout(() => {
      timedOutRef.current = true;
      ac.abort();
    }, SCAN_TIMEOUT_MS);

    setLastFile(files[0]);
    setLastFiles(files);
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
    // M1-1: scanTelemetryId keys the client-side stage reports so they
    // correlate across a retry even after scanKeyRef is cleared below.
    const scanTelemetryId = scanKeyRef.current ?? "unkeyed";
    reportScanStage(scanTelemetryId, "capture", { fileCount: files.length });
    try {
      const fresh = await postScan(files, ac.signal, scanKeyRef.current);
      if (ac.signal.aborted) return;
      markScanStage("render", "start");
      setProgress(100);
      scanKeyRef.current = null; // 2xx → clear for next scan
      setScan(fresh);
      setOriginalItems([...fresh.items]);
      saveScan(fresh);
      setStatus(fresh.quality?.manualFallbackTriggered ? "review" : "results");
      // Double rAF: wait for the browser to actually paint the new status
      // before marking "render" done, not just for React to schedule it.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            markScanStage("render", "end");
            reportScanStage(scanTelemetryId, "render", { itemCount: fresh.items.length });
          });
        });
      }
    } catch (err) {
      // A user-initiated cancel also aborts the signal — only treat this
      // as a silent, expected abort when OUR timeout didn't cause it.
      if (ac.signal.aborted && !timedOutRef.current) return;
      const message = timedOutRef.current
        ? "This is taking longer than expected. Check your connection and try again."
        : err instanceof Error
          ? err.message
          : "Scan failed.";
      setError(message);
      setRawText(!timedOutRef.current && err instanceof ScanError ? err.rawText ?? null : null);
      setStatus("error");
    } finally {
      clearScanTimeout();
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [clearScanTimeout]);

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
    clearScanTimeout();
    scanKeyRef.current = null;
    saveScan(null);
    setScan(null);
    setBottleResult(null);
    setBottlePreview(null);
    setError(null);
    setRawText(null);
    setStatus("ready");
  }, [clearScanTimeout, setBottlePreview]);

  const cancelScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearScanTimeout();
    scanKeyRef.current = null;
    setProgress(0);
    setError(null);
    setRawText(null);
    setStatus("ready");
  }, [clearScanTimeout]);

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
    if (!scan || isSavingRef.current) return;
    isSavingRef.current = true;
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
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [scan, originalItems, lastFile]);

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
    setBottlePreview(file);
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
  }, [setBottlePreview]);

  const retryScan = useCallback(() => {
    if (mode === "bottle") {
      if (lastFile) startBottleScan(lastFile);
    } else if (lastFiles.length > 0) {
      // Resubmit the FULL originally-selected batch, not just the first
      // file — a recoverable (network) error must not silently drop the
      // other pages of a multi-file invoice on retry.
      startScan(lastFiles);
    }
  }, [lastFile, lastFiles, mode, startBottleScan, startScan]);

  const saveBottleToInventory = useCallback(
    async (wine: {
      name: string;
      producer: string;
      vintage: number | null;
      varietal: string;
      region: string;
      country: string | null;
      format: string | null;
      qty: number;
      unitCost: number;
    }) => {
      if (isSavingRef.current) return;
      isSavingRef.current = true;
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
        setBottlePreview(null);
        setSavedResult({ itemCount: 1, wineCount: 1 });
        setStatus("ready");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Save failed.";
        setFeedback({ kind: "error", message });
      } finally {
        isSavingRef.current = false;
        setIsSaving(false);
      }
    },
    [setBottlePreview],
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

  const hasRetryableFile = mode === "bottle" ? !!lastFile : lastFiles.length > 0;

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
          previewUrl={bottlePreviewUrl}
        />
      )}
      {status === "error" && (
        <ErrorView
          mode={mode}
          message={error ?? "Unknown error."}
          onRetry={hasRetryableFile ? retryScan : startOver}
          onNewPhoto={startOver}
          hasFile={hasRetryableFile}
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
          previewUrl={bottlePreviewUrl}
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
              <AlertTriangle className="h-4 w-4 text-accent" strokeWidth={2.25} aria-hidden="true" />
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
