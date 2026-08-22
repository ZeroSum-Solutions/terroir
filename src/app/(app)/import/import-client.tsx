"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Upload,
} from "lucide-react";
import { ActionDialog } from "@/components/action-dialog";
import { cn } from "@/lib/utils";
import { CANONICAL_HEADERS } from "@/domains/import/constants";
import type { PreviewRow, PreviewSummary } from "@/domains/import/preview-service";

type BatchSummary = {
  id: string;
  filename: string;
  status: "created" | "applying" | "completed" | "reverted";
  total_rows: number;
  created_at: string;
  reverted_at: string | null;
};

type BatchRow = {
  id: string;
  row_number: number;
  raw: Record<string, string | null>;
  row_state: "valid" | "error";
  validation_errors: { field: string; message: string }[];
  lwin_status: "matched" | "unmatched";
  lwin_id: string | null;
  cost_status: "present" | "missing";
  resolution: "auto" | "pending" | "include" | "exclude";
  manual_unit_cost: number | null;
  apply_status: "not_applied" | "applied" | "reverted";
};

type BatchDetail = { batch: BatchSummary; rows: BatchRow[] };

type Step = "upload" | "preview" | "batch";

const TEMPLATE_CSV = `${CANONICAL_HEADERS.join(",")}\nDomaine Example,Cuvee One,2020,Pinot Noir,Burgundy,France,750,,USD,6,24.50,,\n`;

export function ImportClient() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; summary: PreviewSummary } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [recent, setRecent] = useState<BatchSummary[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadRecent = useCallback(async () => {
    const response = await fetch("/api/import/batches", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load recent imports.");
    return (await response.json()) as { batches: BatchSummary[] };
  }, []);

  useEffect(() => {
    let active = true;
    loadRecent()
      .then((data) => {
        if (active) setRecent(data.batches);
      })
      .catch(() => {
        // Best-effort — the recent-imports list is a convenience, not load-bearing.
      });
    return () => {
      active = false;
    };
  }, [loadRecent]);

  const handlePreview = useCallback(async () => {
    if (!file) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/import/preview", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) {
        setPreviewError(body?.error?.message ?? "Preview failed.");
        setPreview(null);
        return;
      }
      setPreview(body);
      setStep("preview");
    } catch {
      setPreviewError("Preview failed. Check your connection and try again.");
    } finally {
      setPreviewing(false);
    }
  }, [file]);

  const handleConfirm = useCallback(async () => {
    if (!file) return;
    setConfirming(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/import/batches", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) {
        setPreviewError(body?.error?.message ?? "Import could not be created.");
        return;
      }
      await loadBatchDetail(body.batchId, setBatch);
      setStep("batch");
      void loadRecent();
    } catch {
      setPreviewError("Import could not be created. Check your connection and try again.");
    } finally {
      setConfirming(false);
    }
  }, [file, loadRecent]);

  const reset = useCallback(() => {
    setStep("upload");
    setFile(null);
    setPreview(null);
    setPreviewError(null);
    setBatch(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  return (
    <div className="mx-auto max-w-[640px] px-md py-lg">
      <header className="mb-lg">
        <h1 className="font-serif text-[28px] font-normal leading-tight text-ink">Import cellar</h1>
        <p className="mt-2xs text-[14px] text-grey">
          Upload a CSV of your existing inventory. Nothing is written to your cellar until you confirm the preview.
        </p>
      </header>

      {step === "upload" && (
        <UploadStep
          file={file}
          setFile={setFile}
          fileInputRef={fileInputRef}
          onPreview={handlePreview}
          previewing={previewing}
          error={previewError}
        />
      )}

      {step === "preview" && preview && (
        <PreviewStep
          preview={preview}
          filename={file?.name ?? "cellar.csv"}
          onConfirm={handleConfirm}
          confirming={confirming}
          onBack={reset}
          error={previewError}
        />
      )}

      {step === "batch" && batch && (
        <BatchStep batch={batch} setBatch={setBatch} onDone={() => { reset(); void loadRecent(); }} />
      )}

      <RecentImports batches={recent} onOpen={async (id) => {
        await loadBatchDetail(id, setBatch);
        setStep("batch");
      }} />
    </div>
  );
}

async function loadBatchDetail(id: string, setBatch: (b: BatchDetail) => void) {
  const response = await fetch(`/api/import/batches/${id}`, { cache: "no-store" });
  if (!response.ok) return;
  setBatch(await response.json());
}

function UploadStep({
  file,
  setFile,
  fileInputRef,
  onPreview,
  previewing,
  error,
}: {
  file: File | null;
  setFile: (f: File | null) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onPreview: () => void;
  previewing: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-card border border-hairline bg-canvas p-lg">
      <label
        htmlFor="import-file"
        className="flex min-h-11 cursor-pointer flex-col items-center justify-center gap-sm rounded-card border border-dashed border-beige-deep bg-bridge-surface px-lg py-xl text-center"
      >
        <Upload className="h-6 w-6 text-grey" aria-hidden="true" />
        <span className="text-[14px] font-medium text-ink">
          {file ? file.name : "Choose a CSV file"}
        </span>
        <span className="text-caption text-grey">.csv up to 5 MB</span>
      </label>
      <input
        ref={fileInputRef}
        id="import-file"
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />

      {error && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-primary">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!file || previewing}
        onClick={onPreview}
        className="mt-lg flex min-h-11 w-full items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {previewing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        {previewing ? "Reading file…" : "Preview import"}
      </button>

      <a
        href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`}
        download="cellar-import-template.csv"
        className="mt-md flex min-h-11 items-center justify-center text-[13px] font-medium text-ink-muted underline underline-offset-4"
      >
        Download CSV template
      </a>
    </div>
  );
}

function PreviewStep({
  preview,
  filename,
  onConfirm,
  confirming,
  onBack,
  error,
}: {
  preview: { rows: PreviewRow[]; summary: PreviewSummary };
  filename: string;
  onConfirm: () => void;
  confirming: boolean;
  onBack: () => void;
  error: string | null;
}) {
  const { summary } = preview;
  const errorRows = preview.rows.filter((r) => r.rowState === "error").slice(0, 20);
  const canConfirm = summary.validRows > 0;

  return (
    <div className="rounded-card border border-hairline bg-canvas p-lg">
      <h2 className="font-serif text-[20px] text-ink">Preview: {filename}</h2>
      <dl className="mt-md grid grid-cols-2 gap-sm text-[13px]">
        <SummaryStat label="Total rows" value={summary.totalRows} />
        <SummaryStat label="Ready to apply" value={summary.readyToApplyRows} />
        <SummaryStat label="Needs resolution" value={summary.pendingResolutionRows} />
        <SummaryStat label="Errors (excluded)" value={summary.errorRows} />
        <SummaryStat label="LWIN matched" value={summary.matchedRows} />
        <SummaryStat label="Missing cost" value={summary.missingCostRows} />
      </dl>

      {errorRows.length > 0 && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Row errors
          </h3>
          <ul className="mt-xs space-y-2xs">
            {errorRows.map((row) => (
              <li key={row.rowNumber} className="rounded-card bg-bridge-surface px-sm py-xs text-[13px] text-ink">
                Row {row.rowNumber}: {row.errors.map((e) => e.message).join(" ")}
              </li>
            ))}
          </ul>
          {summary.errorRows > errorRows.length && (
            <p className="mt-2xs text-caption text-grey">
              +{summary.errorRows - errorRows.length} more error row(s) not shown.
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-primary">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      <div className="mt-lg flex flex-col-reverse gap-sm sm:flex-row">
        <button
          type="button"
          onClick={onBack}
          className="min-h-11 flex-1 rounded-pill border border-hairline bg-white px-lg text-[14px] font-medium text-ink transition-colors hover:bg-bridge-surface"
        >
          Choose a different file
        </button>
        <button
          type="button"
          disabled={!canConfirm || confirming}
          onClick={onConfirm}
          className="flex min-h-11 flex-1 items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {confirming ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {confirming ? "Creating import…" : "Confirm import"}
        </button>
      </div>
      {!canConfirm && (
        <p className="mt-sm text-caption text-grey">No valid rows to import — fix the errors above and re-upload.</p>
      )}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-caption text-grey">{label}</dt>
      <dd className="font-serif text-[20px] text-ink">{value}</dd>
    </div>
  );
}

function BatchStep({
  batch,
  setBatch,
  onDone,
}: {
  batch: BatchDetail;
  setBatch: (b: BatchDetail) => void;
  onDone: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertDialogOpen, setRevertDialogOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [manualCostDrafts, setManualCostDrafts] = useState<Record<string, string>>({});

  const pending = batch.rows.filter((r) => r.resolution === "pending");
  const eligibleNotApplied = batch.rows.filter(
    (r) => r.apply_status === "not_applied" && (r.resolution === "auto" || r.resolution === "include"),
  );
  const appliedCount = batch.rows.filter((r) => r.apply_status === "applied").length;

  const refresh = useCallback(async () => {
    await loadBatchDetail(batch.batch.id, setBatch);
  }, [batch.batch.id, setBatch]);

  const applyAll = useCallback(async () => {
    setApplying(true);
    setActionError(null);
    try {
      let done = false;
      let guard = 0;
      while (!done && guard < 200) {
        guard += 1;
        const response = await fetch(`/api/import/batches/${batch.batch.id}/apply`, { method: "POST" });
        const body = await response.json();
        if (!response.ok) {
          setActionError(body?.error?.message ?? "Apply failed.");
          break;
        }
        done = body.done;
        await refresh();
      }
    } catch {
      setActionError("Apply failed. Your progress so far is saved — try again.");
    } finally {
      setApplying(false);
    }
  }, [batch.batch.id, refresh]);

  const resolveRow = useCallback(
    async (rowId: string, action: "include" | "exclude", manualUnitCost?: number) => {
      setActionError(null);
      try {
        const response = await fetch(`/api/import/batches/${batch.batch.id}/rows/${rowId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, manualUnitCost }),
        });
        const body = await response.json();
        if (!response.ok) {
          setActionError(body?.error?.message ?? "Could not resolve row.");
          return;
        }
        await refresh();
      } catch {
        setActionError("Could not resolve row. Check your connection and try again.");
      }
    },
    [batch.batch.id, refresh],
  );

  const doRevert = useCallback(async () => {
    setReverting(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/import/batches/${batch.batch.id}/revert`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setActionError(body?.error?.message ?? "Revert failed.");
        return;
      }
      setRevertDialogOpen(false);
      onDone();
    } catch {
      setActionError("Revert failed. Check your connection and try again.");
    } finally {
      setReverting(false);
    }
  }, [batch.batch.id, onDone]);

  return (
    <div className="rounded-card border border-hairline bg-canvas p-lg">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-[20px] text-ink">{batch.batch.filename}</h2>
        <StatusBadge status={batch.batch.status} />
      </div>

      <dl className="mt-md grid grid-cols-2 gap-sm text-[13px]">
        <SummaryStat label="Total rows" value={batch.batch.total_rows} />
        <SummaryStat label="Applied" value={appliedCount} />
        <SummaryStat label="Needs resolution" value={pending.length} />
        <SummaryStat label="Ready, not yet applied" value={eligibleNotApplied.length} />
      </dl>

      {actionError && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-primary">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {actionError}
        </p>
      )}

      {pending.length > 0 && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Needs your decision ({pending.length})
          </h3>
          <ul className="mt-xs space-y-sm">
            {pending.map((row) => (
              <li key={row.id} className="rounded-card border border-hairline p-sm">
                <p className="text-[14px] text-ink">
                  Row {row.row_number}: {row.raw.producer} — {row.raw.name}
                </p>
                <p className="mt-2xs text-caption text-grey">
                  {row.lwin_status === "unmatched" ? "No LWIN catalog match. " : ""}
                  {row.cost_status === "missing" ? "No unit cost provided." : ""}
                </p>
                <div className="mt-sm flex flex-wrap items-center gap-sm">
                  {row.cost_status === "missing" && (
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Unit cost"
                      value={manualCostDrafts[row.id] ?? ""}
                      onChange={(e) => setManualCostDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                      className="min-h-11 w-28 rounded-card border border-hairline px-sm text-[14px]"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const draft = manualCostDrafts[row.id];
                      const manualUnitCost = row.cost_status === "missing" && draft ? Number(draft) : undefined;
                      void resolveRow(row.id, "include", manualUnitCost);
                    }}
                    disabled={row.cost_status === "missing" && !manualCostDrafts[row.id]}
                    className="min-h-11 rounded-pill bg-ink px-md text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Include anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveRow(row.id, "exclude")}
                    className="min-h-11 rounded-pill border border-hairline px-md text-[13px] font-medium text-ink"
                  >
                    Exclude
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-lg flex flex-col gap-sm">
        {eligibleNotApplied.length > 0 && (
          <button
            type="button"
            disabled={applying}
            onClick={applyAll}
            className="flex min-h-11 items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {applying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {applying ? `Applying… (${appliedCount} of ${batch.batch.total_rows})` : `Apply ${eligibleNotApplied.length} row(s)`}
          </button>
        )}

        {batch.batch.status === "completed" && (
          <button
            type="button"
            onClick={() => setRevertDialogOpen(true)}
            className="flex min-h-11 items-center justify-center gap-xs rounded-pill border border-hairline px-lg text-[14px] font-medium text-ink transition-colors hover:bg-bridge-surface"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Revert this import
          </button>
        )}

        <button
          type="button"
          onClick={onDone}
          className="min-h-11 rounded-pill px-lg text-[14px] font-medium text-ink-muted underline underline-offset-4"
        >
          Start a new import
        </button>
      </div>

      <ActionDialog
        open={revertDialogOpen}
        title="Revert this import?"
        description={`This removes exactly the ${appliedCount} inventory row(s) this import created. Nothing else in your cellar is touched.`}
        confirmLabel="Revert import"
        busy={reverting}
        onConfirm={() => void doRevert()}
        onClose={() => setRevertDialogOpen(false)}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: BatchSummary["status"] }) {
  const label = {
    created: "Not yet applied",
    applying: "In progress",
    completed: "Completed",
    reverted: "Reverted",
  }[status];
  return (
    <span className="inline-flex items-center gap-2xs rounded-pill bg-bridge-surface px-sm py-2xs text-caption font-medium text-ink">
      {status === "completed" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </span>
  );
}

function RecentImports({
  batches,
  onOpen,
}: {
  batches: BatchSummary[] | null;
  onOpen: (id: string) => void;
}) {
  if (!batches || batches.length === 0) return null;
  return (
    <section className="mt-lg">
      <h2 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">Recent imports</h2>
      <ul className="mt-xs space-y-2xs">
        {batches.slice(0, 10).map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onOpen(b.id)}
              className={cn(
                "flex min-h-11 w-full items-center justify-between rounded-card border border-hairline bg-canvas px-sm text-left text-[13px] text-ink transition-colors hover:bg-bridge-surface",
              )}
            >
              <span className="truncate">{b.filename}</span>
              <span className="shrink-0 text-caption text-grey">{b.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
