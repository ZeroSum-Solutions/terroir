"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, RefreshCw, Undo2 } from "lucide-react";
import { buildAcceptAction } from "./accept-action";
import { QueueIssueRow } from "./issue-row";
import type { QueueResponse } from "./types";

const QUEUE_PAGE_SIZE = 25;

export function ReconcileQueueClient() {
  const queue = useQueueData();
  if (queue.loading) return <QueueLoading />;
  if (queue.error || !queue.data) return <QueueError message={queue.error ?? "Queue unavailable."} retry={queue.reload} />;
  return <LoadedQueue data={queue.data} reload={queue.reload} />;
}

function LoadedQueue({ data, reload }: { data: QueueResponse; reload: () => Promise<void> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [binByIssue, setBinByIssue] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const rows = useMemo(() => [...data.issues].sort(compareRows), [data.issues]);
  const ready = rows.filter((row) => buildAcceptAction(row, binByIssue[row.id]) !== null);
  const selectedRows = rows.filter((row) => selected.has(row.id));
  const mutate = useCallback(async (path: string, body: unknown, success: string) => {
    setBusy(true);
    setMutationError(null);
    try {
      await postJson(path, body);
      setMessage(success);
      setSelected(new Set());
      await reload();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }, [reload]);
  const accept = () => {
    const actions = selectedRows.flatMap((row) => {
      const action = buildAcceptAction(row, binByIssue[row.id]);
      return action ? [action] : [];
    });
    if (actions.length) void mutate("/api/reconcile-queue/accept", actions, `${actions.length} item${actions.length === 1 ? "" : "s"} accepted`);
  };
  const undo = () => {
    const id = data.latest_batch?.id;
    if (id) void mutate("/api/reconcile-queue/undo", { batch_id: id }, "Latest batch undone");
  };
  return <QueueView data={data} rows={rows} ready={ready} selected={selected} selectedRows={selectedRows} binByIssue={binByIssue} busy={busy} message={message} mutationError={mutationError} accept={accept} undo={undo} setSelected={setSelected} setBinByIssue={setBinByIssue} />;
}

type QueueViewProps = {
  data: QueueResponse;
  rows: QueueResponse["issues"];
  ready: QueueResponse["issues"];
  selectedRows: QueueResponse["issues"];
  selected: Set<string>;
  binByIssue: Record<string, string>;
  busy: boolean;
  message: string | null;
  mutationError: string | null;
  accept: () => void;
  undo: () => void;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  setBinByIssue: React.Dispatch<React.SetStateAction<Record<string, string>>>;
};

function QueueView(props: QueueViewProps) {
  const { data, rows, ready, selectedRows, selected, binByIssue, busy } = props;
  const paginationKey = rows.map((row) => row.id).join("\u0000");
  const [pagination, setPagination] = useState({
    key: paginationKey,
    count: QUEUE_PAGE_SIZE,
  });
  const visibleCount =
    pagination.key === paginationKey ? pagination.count : QUEUE_PAGE_SIZE;
  const visibleRows = rows.slice(0, visibleCount);
  return (
    <>
      <QueueHeader summary={data.summary} latestBatch={data.latest_batch} busy={busy} undo={props.undo} />
      {(props.message || props.mutationError) && <StatusBanner message={props.message} error={props.mutationError} />}
      {rows.length === 0 ? <QueueEmpty /> : (
        <div className="overflow-hidden rounded-card border border-hairline bg-canvas">
          {visibleRows.map((row) => (
          <QueueIssueRow
            key={row.id}
            row={row}
            bins={data.bins}
            binId={binByIssue[row.id]}
            checked={selected.has(row.id)}
            disabled={busy}
            onBinChange={(binId) => props.setBinByIssue((current) => ({ ...current, [row.id]: binId }))}
            onToggle={() => props.setSelected((current) => toggleId(current, row.id))}
          />
          ))}
        </div>
      )}
      {visibleRows.length < rows.length && (
        <button
          type="button"
          onClick={() =>
            setPagination({
              key: paginationKey,
              count: visibleCount + QUEUE_PAGE_SIZE,
            })
          }
          className="mt-md min-h-11 w-full rounded-pill border border-hairline bg-white px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
        >
          Show {Math.min(QUEUE_PAGE_SIZE, rows.length - visibleRows.length)} more ·{" "}
          {visibleRows.length} of {rows.length}
        </button>
      )}
      {rows.length > 0 && (
        <BulkRail
          busy={busy}
          selectedCount={selectedRows.length}
          readyCount={ready.length}
          allReadySelected={ready.length > 0 && ready.every((row) => selected.has(row.id))}
          accept={props.accept}
          toggleAll={() => props.setSelected((current) => toggleAllReady(current, ready.map((row) => row.id)))}
        />
      )}
    </>
  );
}

function useQueueData() {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/reconcile-queue", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response));
      setData(await response.json() as QueueResponse);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Queue unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    requestQueue().then((result) => {
      if (active) setData(result);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : "Queue unavailable.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);
  return { data, loading, error, reload };
}

function QueueHeader({ summary, latestBatch, busy, undo }: { summary: QueueResponse["summary"]; latestBatch: QueueResponse["latest_batch"]; busy: boolean; undo: () => void }) {
  return (
    <header className="mb-lg flex flex-wrap items-end justify-between gap-md md:mb-xl">
      <div>
        <p className="mb-xs text-caption font-medium uppercase text-primary">Inventory control</p>
        <h1 className="font-serif text-heading-sm text-ink">Reconciliation queue</h1>
        <p className="mt-xs text-[14px] tabular-nums text-grey">{summary.itemCount} items · {summary.unitCount} units · ${formatRisk(summary.atRisk)} at risk</p>
      </div>
      {latestBatch && (
        <button type="button" onClick={undo} disabled={busy} className="flex h-11 items-center gap-xs rounded-pill border border-beige-deep bg-white px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-50">
          <Undo2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />Undo latest batch
        </button>
      )}
    </header>
  );
}

function BulkRail({ busy, selectedCount, readyCount, allReadySelected, accept, toggleAll }: { busy: boolean; selectedCount: number; readyCount: number; allReadySelected: boolean; accept: () => void; toggleAll: () => void }) {
  return (
    <div className="glass sticky bottom-[72px] z-10 mt-md flex flex-wrap items-center justify-between gap-sm rounded-lg px-sm py-sm md:bottom-md md:px-md">
      <button type="button" onClick={toggleAll} disabled={busy || readyCount === 0} className="h-11 rounded-pill px-sm text-[13px] font-medium text-grey hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-40">
        {allReadySelected ? "Clear actionable" : `Select actionable (${readyCount})`}
      </button>
      <span className="text-[12px] tabular text-grey">{selectedCount} selected</span>
      <button type="button" onClick={accept} disabled={busy || selectedCount === 0} className="flex h-11 items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 disabled:opacity-45">
        {busy ? <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden /> : <Check className="h-4 w-4" strokeWidth={2} aria-hidden />}
        Accept {selectedCount} item{selectedCount === 1 ? "" : "s"}
      </button>
    </div>
  );
}

function QueueLoading() {
  return <div aria-label="Loading reconciliation queue" className="space-y-sm"><div className="h-20 animate-pulse rounded-card bg-bridge-surface" />{[1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse border-t border-hairline bg-bridge-surface/60" />)}</div>;
}

function QueueError({ message, retry }: { message: string; retry: () => void }) {
  return <div role="alert" className="rounded-md border border-primary/30 bg-blush-wash p-md text-[13px] text-primary"><p>{message}</p><button type="button" onClick={retry} className="mt-sm h-11 rounded-pill border border-primary/30 bg-white px-md font-medium hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25">Try again</button></div>;
}

function QueueEmpty() {
  return <div className="rounded-card border border-hairline bg-bridge-surface px-lg py-3xl text-center"><Check className="mx-auto mb-sm h-8 w-8 text-sage-ink" aria-hidden /><p className="font-serif text-[18px] text-ink">Queue is clear</p><p className="mt-xs text-[13px] text-grey">No inventory records need reconciliation.</p></div>;
}

function StatusBanner({ message, error }: { message: string | null; error: string | null }) {
  return <div role={error ? "alert" : "status"} className={`mb-md rounded-md border px-md py-sm text-[13px] ${error ? "border-primary/30 bg-blush-wash text-primary" : "border-sage-ink/30 bg-sage-wash text-sage-ink"}`}>{error ?? message}</div>;
}

function toggleId(current: Set<string>, id: string) {
  const next = new Set(current);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

function toggleAllReady(current: Set<string>, ready: string[]) {
  const next = new Set(current);
  const remove = ready.every((id) => next.has(id));
  for (const id of ready) {
    if (remove) next.delete(id);
    else next.add(id);
  }
  return next;
}

function compareRows(left: QueueResponse["issues"][number], right: QueueResponse["issues"][number]) {
  return right.atRisk - left.atRisk || left.id.localeCompare(right.id);
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await responseMessage(response));
}

async function requestQueue(): Promise<QueueResponse> {
  const response = await fetch("/api/reconcile-queue", { cache: "no-store" });
  if (!response.ok) throw new Error(await responseMessage(response));
  return response.json() as Promise<QueueResponse>;
}

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
  if (typeof payload?.error === "string") return payload.error;
  return payload?.error?.message ?? `Request failed (${response.status}).`;
}

function formatRisk(value: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
