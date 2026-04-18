"use client";

import {
  AlertTriangle,
  Camera,
  Check,
  Download,
  FileJson,
  FileUp,
  Loader2,
  Minus,
  Plus,
  RotateCw,
  ScanLine,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { csvFilename, downloadCsv, toCsv } from "@/lib/scanner/csv";
import { MOCK_RECENT_SCANS } from "@/lib/scanner/mock-data";
import { useRestaurant } from "@/lib/context/restaurant";
import type {
  LineItem,
  LineItemField,
  RecentScan,
  Scan,
} from "@/lib/scanner/types";

type Status = "ready" | "processing" | "results" | "error";
const STORAGE_KEY = "terroir:current-scan";
const STEPS = [
  "Reading invoice",
  "Identifying wines",
  "Structuring line items",
] as const;

function formatMoney(n: number) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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
  if (scan) localStorage.setItem(STORAGE_KEY, JSON.stringify(scan));
  else localStorage.removeItem(STORAGE_KEY);
}

async function postScan(file: File, signal: AbortSignal): Promise<Scan> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/scan", { method: "POST", body, signal });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error ?? `Scan failed (${res.status})`);
  }
  return (await res.json()) as Scan;
}

export function Scanner() {
  const { restaurantId } = useRestaurant();
  const [status, setStatus] = useState<Status>("ready");
  const [progress, setProgress] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [scan, setScan] = useState<Scan | null>(null);
  const [originalItems, setOriginalItems] = useState<LineItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      const pct = Math.min(90, Math.round((elapsed / SOFT_DURATION) * 90));
      setProgress(pct);
      setStepIndex(pct < 30 ? 0 : pct < 60 ? 1 : 2);
    }, 120);
    return () => window.clearInterval(id);
  }, [status]);

  const startScan = useCallback(async (file: File) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setStatus("processing");
    setError(null);

    try {
      const fresh = await postScan(file, ac.signal);
      if (ac.signal.aborted) return;
      setProgress(100);
      setScan(fresh);
      setOriginalItems([...fresh.items]);
      saveScan(fresh);
      setStatus("results");
    } catch (err) {
      if (ac.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Scan failed.";
      setError(message);
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
    setStatus("ready");
  }, []);

  const exportCsv = useCallback(() => {
    if (!scan) return;
    downloadCsv(csvFilename(scan.source), toCsv(scan.items));
    setToast(`Exported ${scan.items.length} wines to CSV`);
  }, [scan]);

  const exportAccuracyJson = useCallback(() => {
    if (!scan) return;
    const totalFields = scan.items.length * 6;
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
      setStatus("ready");
      setToast(
        `Saved ${result.itemCount} items (${result.wineCount} wines) to inventory`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed.";
      setToast(message);
    } finally {
      setIsSaving(false);
    }
  }, [scan, originalItems, isSaving]);

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
    };
    setScan(fresh);
    saveScan(fresh);
    setError(null);
    setStatus("results");
  }, []);

  if (!hydrated) return <ReadyView onStart={startScan} />;

  return (
    <>
      {status === "ready" && <ReadyView onStart={startScan} />}
      {status === "processing" && (
        <ProcessingView progress={progress} stepIndex={stepIndex} />
      )}
      {status === "error" && (
        <ErrorView
          message={error ?? "Unknown error."}
          onRetry={startOver}
          onManual={enterManualEntry}
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
        <div className="fixed inset-x-md bottom-[88px] z-30 mx-auto max-w-[420px] rounded-md bg-surface-inverse px-md py-sm text-[14px] text-white shadow-lg md:bottom-lg">
          <div className="flex items-center gap-sm">
            <Check className="h-4 w-4 text-success" strokeWidth={2.25} />
            {toast}
          </div>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Ready view                                                                 */
/* -------------------------------------------------------------------------- */
function ReadyView({ onStart }: { onStart: (file: File) => void }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    onStart(file);
  };

  return (
    <section>
      <header className="mb-lg md:mb-xl">
        <h1 className="font-serif text-[22px] text-ink md:text-[28px]">
          Scan an invoice
        </h1>
        <p className="mt-xs text-[14px] text-ink-muted md:text-[15px]">
          Photograph a wine invoice with your phone. Parsed in about 20 seconds.
        </p>
      </header>

      <button
        type="button"
        onClick={() => cameraRef.current?.click()}
        className="flex w-full flex-col items-center justify-center rounded-md border-2 border-dashed border-border-strong bg-surface-muted px-lg py-2xl text-center transition-colors hover:border-accent hover:bg-accent-soft/40 md:py-3xl"
      >
        <span className="mb-md flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white md:h-16 md:w-16">
          <Camera className="h-6 w-6 md:h-7 md:w-7" strokeWidth={1.75} />
        </span>
        <h2 className="font-serif text-[20px] text-ink md:text-[22px]">
          Tap to photograph
        </h2>
        <p className="mt-xs text-[13px] text-ink-muted">
          JPG, PNG, or PDF · up to 20MB
        </p>
      </button>

      <div className="mt-md grid grid-cols-2 gap-sm md:mt-lg md:gap-md">
        <button
          type="button"
          onClick={() => cameraRef.current?.click()}
          className="flex h-12 items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover md:h-[38px]"
        >
          <Camera className="h-4 w-4" strokeWidth={2} />
          Take photo
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-12 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted md:h-[38px]"
        >
          <FileUp className="h-4 w-4" strokeWidth={2} />
          Upload file
        </button>
      </div>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
      />

      <RecentScansList scans={MOCK_RECENT_SCANS} />
    </section>
  );
}

function RecentScansList({ scans }: { scans: RecentScan[] }) {
  if (scans.length === 0) return null;
  return (
    <section className="mt-2xl">
      <h3 className="mb-md text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
        Recent scans
      </h3>
      <div className="grid grid-cols-1 gap-sm md:grid-cols-3 md:gap-md">
        {scans.map((s) => (
          <article
            key={s.id}
            className="rounded-md border border-border bg-white p-md"
          >
            <div className="mb-sm flex items-center justify-between">
              <span className="tabular text-[12px] text-ink-muted">{s.parsedAt}</span>
              <span className="tabular text-[12px] text-success">{s.accuracy}%</span>
            </div>
            <div className="mb-xs text-[14px] font-medium text-ink">
              {s.distributor}
            </div>
            <div className="flex items-center gap-xs text-[13px] text-ink-muted">
              <span>{s.items} wines</span>
              <span aria-hidden className="text-ink-subtle">·</span>
              <span className="tabular">${formatMoney(s.total)}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Processing view                                                            */
/* -------------------------------------------------------------------------- */
function ProcessingView({
  progress,
  stepIndex,
}: {
  progress: number;
  stepIndex: number;
}) {
  const capped = progress >= 90;
  return (
    <section className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-[420px] rounded-md border border-border bg-white p-xl text-center">
        <div className="mx-auto mb-md flex h-16 w-16 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Sparkles className="h-7 w-7" strokeWidth={1.5} />
        </div>
        <h2 className="font-serif text-[22px] text-ink">Reading your invoice</h2>
        <p className="mt-xs text-[14px] text-ink-muted">
          {capped
            ? "Finishing up — messy invoices can take a bit longer."
            : "Usually 20-30 seconds."}
        </p>

        <div className="relative mt-md h-1.5 overflow-hidden rounded-pill bg-surface-sunken">
          <div
            className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-100 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-xs flex items-center justify-between text-[11px] tabular text-ink-subtle">
          <span>{progress}%</span>
          <span>Claude Opus 4.7</span>
        </div>

        <ul className="mt-lg flex flex-col gap-sm text-left">
          {STEPS.map((label, i) => {
            const done = i < stepIndex;
            const active = i === stepIndex;
            return (
              <li
                key={label}
                className={cn(
                  "flex items-center gap-sm text-[14px]",
                  done && "text-ink",
                  active && "text-accent",
                  !done && !active && "text-ink-subtle",
                )}
              >
                {done ? (
                  <Check className="h-4 w-4" strokeWidth={2.25} />
                ) : active ? (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                ) : (
                  <span className="block h-3.5 w-3.5 rounded-full border-2 border-current opacity-40" />
                )}
                {label}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Error view                                                                 */
/* -------------------------------------------------------------------------- */
function ErrorView({
  message,
  onRetry,
  onManual,
}: {
  message: string;
  onRetry: () => void;
  onManual: () => void;
}) {
  return (
    <section className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-[480px] rounded-md border border-border bg-white p-xl text-center">
        <div className="mx-auto mb-md flex h-14 w-14 items-center justify-center rounded-full bg-warning-soft text-warning">
          <AlertTriangle className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <h2 className="font-serif text-[22px] text-ink">Couldn&rsquo;t read the invoice</h2>
        <p className="mt-sm text-[14px] text-ink-muted">{message}</p>
        <div className="mt-lg grid grid-cols-1 gap-sm md:grid-cols-2 md:gap-md">
          <button
            type="button"
            onClick={onRetry}
            className="flex h-11 items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover md:h-[38px]"
          >
            <RotateCw className="h-4 w-4" strokeWidth={2} />
            Try again
          </button>
          <button
            type="button"
            onClick={onManual}
            className="flex h-11 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted md:h-[38px]"
          >
            Enter manually
          </button>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Results view                                                               */
/* -------------------------------------------------------------------------- */
function ResultsView({
  scan,
  onUpdate,
  onRemove,
  onScanAnother,
  onExportCsv,
  onExportAccuracy,
  onSaveToInventory,
  isSaving,
}: {
  scan: Scan;
  onUpdate: (id: string, field: LineItemField, value: string | number | null) => void;
  onRemove: (id: string) => void;
  onScanAnother: () => void;
  onExportCsv: () => void;
  onExportAccuracy: () => void;
  onSaveToInventory: () => void;
  isSaving: boolean;
}) {
  const { items, edits, source } = scan;

  const { total, bottles, lowCount, accuracy } = useMemo(() => {
    const totalFields = items.length * 6;
    const edited = Object.keys(edits).length;
    return {
      total: items.reduce((s, it) => s + it.qty * it.unitCost, 0),
      bottles: items.reduce((s, it) => s + it.qty, 0),
      lowCount: items.reduce(
        (n, it) => n + (it.lowFields?.length ?? 0),
        0,
      ),
      accuracy:
        totalFields === 0
          ? 100
          : Math.max(
              0,
              Math.round(((totalFields - edited) / totalFields) * 100),
            ),
    };
  }, [items, edits]);

  const isLow = (item: LineItem, field: LineItemField) =>
    (item.lowFields ?? []).includes(field) && !edits[`${item.id}:${field}`];

  const isEdited = (item: LineItem, field: LineItemField) =>
    edits[`${item.id}:${field}`] === true;

  return (
    <section>
      <header className="mb-lg flex flex-col gap-sm md:mb-xl md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-serif text-[22px] text-ink md:text-[28px]">
            Invoice scan results
          </h1>
          <p className="mt-xs text-[14px] text-ink-muted md:text-[15px]">
            Review, correct, and export. Yellow fields need a second look.
          </p>
        </div>
        <div className="flex items-center gap-xs self-start rounded-pill bg-success-soft px-sm py-xs text-[12px] font-medium text-success md:self-auto">
          <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
          <span>Parsed accuracy</span>
          <span className="tabular">{accuracy}%</span>
        </div>
      </header>

      <div className="mb-lg rounded-md border border-border bg-white p-md">
        <div className="flex items-center justify-between gap-md">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium text-ink">
              {source.distributor}
            </div>
            <div className="mt-2xs flex items-center gap-xs tabular text-[12px] text-ink-muted">
              <span>INV {source.invoiceNo}</span>
              <span className="text-ink-subtle">·</span>
              <span>{source.invoiceDate}</span>
            </div>
          </div>
          <span className="rounded-sm bg-surface-muted px-sm py-xs text-[11px] uppercase tracking-[0.06em] text-ink-subtle">
            {items.length} items
          </span>
        </div>
      </div>

      <SummaryRow
        items={items.length}
        bottles={bottles}
        total={total}
        lowCount={lowCount}
      />

      {/* Desktop table (md+) */}
      <div className="mt-lg hidden overflow-hidden rounded-md border border-border md:block">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="bg-surface-muted">
              <Th className="w-[32%]">Wine</Th>
              <Th className="w-[14%]">Varietal</Th>
              <Th className="w-[9%]">Vintage</Th>
              <Th className="w-[14%]">Region</Th>
              <Th className="w-[11%] text-center">Qty</Th>
              <Th className="w-[14%] text-right">Unit cost</Th>
              <Th className="w-[6%]" />
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr
                key={it.id}
                className="border-t border-border align-middle hover:bg-[#FBFAF6]"
              >
                <td className="p-sm">
                  <TextInput
                    value={it.name}
                    low={isLow(it, "name")}
                    edited={isEdited(it, "name")}
                    onCommit={(v) => onUpdate(it.id, "name", v)}
                    className="font-medium"
                  />
                  <div className="mt-2xs pl-sm text-[12px] text-ink-muted">
                    {it.producer}
                  </div>
                </td>
                <td className="p-sm">
                  <TextInput
                    value={it.varietal}
                    low={isLow(it, "varietal")}
                    edited={isEdited(it, "varietal")}
                    onCommit={(v) => onUpdate(it.id, "varietal", v)}
                  />
                </td>
                <td className="p-sm">
                  <VintageInput
                    value={it.vintage}
                    low={isLow(it, "vintage")}
                    edited={isEdited(it, "vintage")}
                    onCommit={(v) => onUpdate(it.id, "vintage", v)}
                  />
                </td>
                <td className="p-sm">
                  <TextInput
                    value={it.region}
                    low={isLow(it, "region")}
                    edited={isEdited(it, "region")}
                    onCommit={(v) => onUpdate(it.id, "region", v)}
                  />
                </td>
                <td className="p-sm">
                  <div className="flex justify-center">
                    <QtyStepper
                      value={it.qty}
                      onChange={(v) => onUpdate(it.id, "qty", v)}
                    />
                  </div>
                </td>
                <td className="p-sm">
                  <MoneyInput
                    value={it.unitCost}
                    low={isLow(it, "unitCost")}
                    edited={isEdited(it, "unitCost")}
                    onCommit={(v) => onUpdate(it.id, "unitCost", v)}
                  />
                </td>
                <td className="p-sm text-center">
                  <button
                    type="button"
                    aria-label={`Remove ${it.name}`}
                    onClick={() => onRemove(it.id)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards (< md) */}
      <div className="mt-md flex flex-col gap-sm md:hidden">
        {items.map((it) => (
          <LineItemCard
            key={it.id}
            item={it}
            isLow={isLow}
            isEdited={isEdited}
            onUpdate={onUpdate}
            onRemove={onRemove}
          />
        ))}
      </div>

      {/* Action bar */}
      <div
        className="sticky bottom-[64px] z-10 mt-md flex flex-col gap-sm rounded-md border border-border bg-white p-md shadow-sm md:static md:bottom-auto md:mt-lg md:flex-row md:items-center md:justify-between md:shadow-none"
        style={{ marginBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}
      >
        <div className="text-[13px] text-ink-muted md:text-[14px]">
          <span className="font-medium text-ink">{items.length} wines</span>
          <span className="mx-xs text-ink-subtle">·</span>
          <span>{Object.keys(edits).length} corrections</span>
        </div>
        <div className="grid grid-cols-2 gap-sm md:flex md:gap-md">
          <button
            type="button"
            onClick={onScanAnother}
            className="flex h-11 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted md:h-[38px] md:px-md"
          >
            <ScanLine className="h-4 w-4" strokeWidth={2} />
            <span className="hidden sm:inline">Scan another</span>
            <span className="sm:hidden">Scan</span>
          </button>
          <div className="flex gap-sm">
            <button
              type="button"
              onClick={onExportCsv}
              className="flex h-11 flex-1 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted md:h-[38px] md:flex-none md:px-md"
              title="Export as CSV"
            >
              <Download className="h-4 w-4" strokeWidth={2} />
              <span className="hidden md:inline">CSV</span>
            </button>
            <button
              type="button"
              onClick={onExportAccuracy}
              className="flex h-11 flex-1 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted md:h-[38px] md:flex-none md:px-md"
              title="Export accuracy JSON (source + items + per-field edits)"
            >
              <FileJson className="h-4 w-4" strokeWidth={2} />
              <span className="hidden md:inline">JSON</span>
            </button>
          </div>
          <button
            type="button"
            onClick={onSaveToInventory}
            disabled={isSaving}
            className="col-span-2 flex h-11 items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-60 md:h-[38px] md:px-md"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <Save className="h-4 w-4" strokeWidth={2} />
            )}
            <span>{isSaving ? "Saving..." : "Save to Inventory"}</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function SummaryRow({
  items,
  bottles,
  total,
  lowCount,
}: {
  items: number;
  bottles: number;
  total: number;
  lowCount: number;
}) {
  const stats: Array<{
    label: string;
    value: React.ReactNode;
    tone?: "warning" | "success";
  }> = [
    { label: "Line items", value: items },
    { label: "Bottles", value: bottles },
    { label: "Invoice total", value: <span className="tabular">${formatMoney(total)}</span> },
    {
      label: "Need review",
      value: (
        <>
          {lowCount}
          <span className="ml-xs text-[12px] font-normal text-ink-muted">fields</span>
        </>
      ),
      tone: lowCount > 0 ? "warning" : "success",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-sm md:grid-cols-4 md:gap-md">
      {stats.map((s) => (
        <div
          key={s.label}
          className="rounded-md border border-border bg-white p-md"
        >
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            {s.label}
          </div>
          <div
            className={cn(
              "mt-xs text-[20px] font-medium",
              s.tone === "warning" && "text-warning",
              s.tone === "success" && "text-success",
              !s.tone && "text-ink",
            )}
          >
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */
const FIELD_WRAP =
  "relative flex w-full items-center rounded-sm border border-transparent bg-transparent px-sm py-xs transition-colors focus-within:border-accent focus-within:bg-white focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)] hover:border-border hover:bg-white";

function FieldWrap({
  low,
  edited,
  children,
}: {
  low?: boolean;
  edited?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        FIELD_WRAP,
        low && "border-l-[3px] border-l-warning bg-warning-soft/60",
        edited && !low && "bg-success-soft/40",
      )}
    >
      {children}
      {low && (
        <AlertTriangle
          className="ml-xs h-4 w-4 shrink-0 text-warning"
          strokeWidth={2}
          aria-label="Needs review"
        />
      )}
    </div>
  );
}

function TextInput({
  value,
  low,
  edited,
  onCommit,
  className,
}: {
  value: string;
  low?: boolean;
  edited?: boolean;
  onCommit: (v: string) => void;
  className?: string;
}) {
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);
  return (
    <FieldWrap low={low} edited={edited}>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => val !== value && onCommit(val)}
        className={cn(
          "w-full bg-transparent text-[14px] text-ink outline-none",
          className,
        )}
      />
    </FieldWrap>
  );
}

function VintageInput({
  value,
  low,
  edited,
  onCommit,
}: {
  value: number | null;
  low?: boolean;
  edited?: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [val, setVal] = useState(value === null ? "NV" : String(value));
  useEffect(() => setVal(value === null ? "NV" : String(value)), [value]);
  const commit = () => {
    const trimmed = val.trim().toUpperCase();
    if (!trimmed || trimmed === "NV") return onCommit(null);
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n)) return onCommit(null);
    onCommit(n);
  };
  return (
    <FieldWrap low={low} edited={edited}>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        inputMode="numeric"
        className="w-full bg-transparent font-mono text-[13px] text-ink outline-none"
      />
    </FieldWrap>
  );
}

function MoneyInput({
  value,
  low,
  edited,
  onCommit,
}: {
  value: number;
  low?: boolean;
  edited?: boolean;
  onCommit: (v: number) => void;
}) {
  const [val, setVal] = useState(value.toFixed(2));
  useEffect(() => setVal(value.toFixed(2)), [value]);
  const commit = () => {
    const n = parseFloat(val.replace(/,/g, ""));
    if (!Number.isFinite(n)) return;
    if (n !== value) onCommit(n);
  };
  return (
    <FieldWrap low={low} edited={edited}>
      <span className="mr-2xs font-mono text-[13px] text-ink-subtle">$</span>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        inputMode="decimal"
        className="w-full bg-transparent text-right font-mono text-[13px] font-medium text-ink outline-none"
      />
    </FieldWrap>
  );
}

function QtyStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-sm border border-border bg-white">
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="flex h-11 w-11 items-center justify-center text-ink-muted hover:text-ink md:h-9 md:w-9"
      >
        <Minus className="h-4 w-4" strokeWidth={2.25} />
      </button>
      <span className="min-w-10 text-center font-mono text-[14px] font-medium text-ink tabular">
        {value}
      </span>
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={() => onChange(value + 1)}
        className="flex h-11 w-11 items-center justify-center text-ink-muted hover:text-ink md:h-9 md:w-9"
      >
        <Plus className="h-4 w-4" strokeWidth={2.25} />
      </button>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "px-sm py-sm text-left text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle",
        className,
      )}
    >
      {children}
    </th>
  );
}

/* -------------------------------------------------------------------------- */
/* Mobile line-item card                                                       */
/* -------------------------------------------------------------------------- */
function LineItemCard({
  item,
  isLow,
  isEdited,
  onUpdate,
  onRemove,
}: {
  item: LineItem;
  isLow: (it: LineItem, f: LineItemField) => boolean;
  isEdited: (it: LineItem, f: LineItemField) => boolean;
  onUpdate: (id: string, field: LineItemField, value: string | number | null) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <article className="rounded-md border border-border bg-white p-md">
      <header className="mb-md flex items-start justify-between gap-sm">
        <div className="min-w-0 flex-1">
          <TextInput
            value={item.name}
            low={isLow(item, "name")}
            edited={isEdited(item, "name")}
            onCommit={(v) => onUpdate(item.id, "name", v)}
            className="font-serif text-[18px] font-medium"
          />
          <div className="mt-2xs px-sm text-[13px] text-ink-muted">
            {item.producer}
          </div>
        </div>
        <button
          type="button"
          aria-label={`Remove ${item.name}`}
          onClick={() => onRemove(item.id)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-danger"
        >
          <Trash2 className="h-5 w-5" strokeWidth={1.75} />
        </button>
      </header>

      <dl className="grid grid-cols-2 gap-x-md gap-y-sm">
        <MobileField label="Vintage">
          <VintageInput
            value={item.vintage}
            low={isLow(item, "vintage")}
            edited={isEdited(item, "vintage")}
            onCommit={(v) => onUpdate(item.id, "vintage", v)}
          />
        </MobileField>
        <MobileField label="Varietal">
          <TextInput
            value={item.varietal}
            low={isLow(item, "varietal")}
            edited={isEdited(item, "varietal")}
            onCommit={(v) => onUpdate(item.id, "varietal", v)}
          />
        </MobileField>
        <MobileField label="Region" span>
          <TextInput
            value={item.region}
            low={isLow(item, "region")}
            edited={isEdited(item, "region")}
            onCommit={(v) => onUpdate(item.id, "region", v)}
          />
        </MobileField>
        <MobileField label="Quantity">
          <div className="flex">
            <QtyStepper
              value={item.qty}
              onChange={(v) => onUpdate(item.id, "qty", v)}
            />
          </div>
        </MobileField>
        <MobileField label="Unit cost">
          <MoneyInput
            value={item.unitCost}
            low={isLow(item, "unitCost")}
            edited={isEdited(item, "unitCost")}
            onCommit={(v) => onUpdate(item.id, "unitCost", v)}
          />
        </MobileField>
      </dl>

      <footer className="mt-md flex items-center justify-between border-t border-border pt-sm">
        <span className="text-[12px] text-ink-muted">Line total</span>
        <span className="font-mono text-[14px] font-medium text-ink tabular">
          ${formatMoney(item.qty * item.unitCost)}
        </span>
      </footer>
    </article>
  );
}

function MobileField({
  label,
  span,
  children,
}: {
  label: string;
  span?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-xs", span && "col-span-2")}>
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
