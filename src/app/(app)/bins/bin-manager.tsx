"use client";

import { useMemo, useState } from "react";
import { Archive, Pencil, Plus, Search, X } from "lucide-react";
import {
  findBottleMatches,
  type BottleInventoryRow,
} from "@/lib/bins";
import { BinForm, type BinDraft } from "./bin-form";
import type { BinViewModel } from "./bin-view-model";
import { useBinEditor, useBinRequests } from "./use-bin-manager";

type Props = {
  bins: BinViewModel[];
  inventory: BottleInventoryRow[];
  canManage: boolean;
  unplacedCount: number;
};

export function BinManager({ bins, inventory, canManage, unplacedCount }: Props) {
  const [query, setQuery] = useState("");
  const editor = useBinEditor();
  const requests = useBinRequests(editor);
  const matches = useMemo(
    () => findBottleMatches(query, inventory),
    [query, inventory],
  );
  return (
    <>
      <ManagerToolbar query={query} onQueryChange={setQuery} canManage={canManage} onCreate={editor.openCreate} />
      {query.trim() && <SearchResults matches={matches} />}
      <UnplacedAnchor count={unplacedCount} />
      {requests.error && <ErrorBanner message={requests.error} dismiss={requests.dismissError} />}
      {editor.creating && (
        <FormPanel title="Create bin">
          <BinForm draft={editor.draft} busy={requests.busy} submitLabel="Create bin" onChange={editor.setDraft} onCancel={editor.close} onSubmit={requests.save} />
        </FormPanel>
      )}
      <BinTable bins={bins} canManage={canManage} busy={requests.busy} editingId={editor.editingId} draft={editor.draft} onDraftChange={editor.setDraft} onEdit={editor.openEdit} onCancel={editor.close} onSave={requests.save} onRetire={requests.retire} />
    </>
  );
}

function ManagerToolbar({ query, onQueryChange, canManage, onCreate }: { query: string; onQueryChange: (value: string) => void; canManage: boolean; onCreate: () => void }) {
  return <div className="mb-lg grid gap-sm md:grid-cols-[minmax(0,1fr)_auto]"><SearchBox query={query} onChange={onQueryChange} />{canManage && <button type="button" onClick={onCreate} className="flex h-11 items-center justify-center gap-xs rounded-sm bg-accent px-md text-[13px] font-medium text-white hover:bg-accent-hover"><Plus className="h-4 w-4" strokeWidth={2} aria-hidden />Create bin</button>}</div>;
}

function UnplacedAnchor({ count }: { count: number }) {
  if (count === 0) return null;
  return <a id="unplaced" href="#unplaced" className="mb-lg flex min-h-11 items-center justify-between rounded-md border border-border bg-surface-muted px-md py-sm text-[13px] text-ink"><span className="font-medium">Unplaced inventory</span><span className="tabular text-ink-muted">{count} {count === 1 ? "bottle" : "bottles"}</span></a>;
}

function SearchBox({ query, onChange }: { query: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block">
      <span className="sr-only">Find a bottle</span>
      <Search className="absolute left-sm top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden />
      <input
        type="search"
        aria-label="Find a bottle"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Find a bottle by wine or producer"
        className="h-11 w-full rounded-sm border border-border bg-white pl-[36px] pr-sm text-[14px] text-ink outline-none placeholder:text-ink-subtle focus:border-accent focus:ring-2 focus:ring-accent/15"
      />
    </label>
  );
}

type Match = ReturnType<typeof findBottleMatches>[number];

function SearchResults({ matches }: { matches: Match[] }) {
  return (
    <div className="mb-lg rounded-md border border-border bg-surface">
      {matches.length === 0 ? (
        <p className="px-md py-md text-[13px] text-ink-muted">No placed bottles match.</p>
      ) : (
        matches.map((match) => (
          <div key={`${match.wineId}:${match.binId}`} data-bottle-match className="flex items-center justify-between gap-md border-b border-dashed border-border px-md py-sm last:border-b-0">
            <div className="min-w-0">
              <p className="truncate text-[14px] font-medium text-ink">{match.name}</p>
              <p className="truncate text-[12px] text-ink-muted">{match.producer}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-[12px] text-ink">{match.binZone ? `${match.binZone} › ` : ""}{match.binCode}</p>
              <p className="text-[12px] tabular text-ink-muted">{match.quantity} {match.quantity === 1 ? "bottle" : "bottles"}</p>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

type TableProps = {
  bins: BinViewModel[];
  canManage: boolean;
  busy: boolean;
  editingId: string | null;
  draft: BinDraft;
  onDraftChange: (draft: BinDraft) => void;
  onEdit: (bin: BinViewModel) => void;
  onCancel: () => void;
  onSave: () => void;
  onRetire: (bin: BinViewModel) => void;
};

function BinTable(props: TableProps) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead><tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle"><th className="px-md py-sm text-left">Code</th><th className="px-md py-sm text-left">Zone</th><th className="px-md py-sm text-left">Occupancy</th><th className="px-md py-sm text-right">Capacity</th><th className="px-md py-sm text-right">Priority</th>{props.canManage && <th className="w-[104px] px-sm py-sm" />}</tr></thead>
          <tbody>{props.bins.map((bin) => <BinRow key={bin.id} bin={bin} {...props} />)}</tbody>
        </table>
      </div>
      {props.bins.length === 0 && <p className="px-md py-xl text-center text-[13px] text-ink-muted">No bins have been created yet.</p>}
    </div>
  );
}

function BinRow({ bin, canManage, busy, editingId, draft, onDraftChange, onEdit, onCancel, onSave, onRetire }: TableProps & { bin: BinViewModel }) {
  if (editingId === bin.id) {
    return <tr data-bin-row className="border-t border-dashed border-border"><td colSpan={6} className="bg-surface-muted px-md py-md"><BinForm draft={draft} busy={busy} submitLabel="Save changes" onChange={onDraftChange} onCancel={onCancel} onSubmit={onSave} /></td></tr>;
  }
  return (
    <tr data-bin-row className="border-t border-dashed border-border">
      <td className="px-md py-sm font-mono font-medium text-ink">{bin.code}</td>
      <td className="px-md py-sm text-ink-muted">{bin.zone ?? "—"}</td>
      <td className="px-md py-sm text-ink">{bin.occupancy}</td>
      <td className="px-md py-sm text-right tabular text-ink-muted">{bin.capacity ?? "—"}</td>
      <td className="px-md py-sm text-right tabular text-ink-muted">{bin.priority}</td>
      {canManage && <td className="px-sm py-sm"><div className="flex justify-end gap-2xs"><button type="button" aria-label={`Edit bin ${bin.code}`} onClick={() => onEdit(bin)} className="flex h-11 w-11 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button><button type="button" aria-label={`Retire bin ${bin.code}`} onClick={() => onRetire(bin)} disabled={busy} className="flex h-11 w-11 items-center justify-center rounded-sm text-ink-subtle hover:bg-danger-soft hover:text-danger disabled:opacity-50"><Archive className="h-3.5 w-3.5" aria-hidden /></button></div></td>}
    </tr>
  );
}

function FormPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-lg rounded-md border border-border bg-surface p-md"><h2 className="mb-md text-[15px] font-semibold text-ink">{title}</h2>{children}</section>;
}

function ErrorBanner({ message, dismiss }: { message: string; dismiss: () => void }) {
  return <div role="alert" className="mb-md flex items-center justify-between gap-sm rounded-sm border border-danger/30 bg-danger-soft px-sm py-xs text-[13px] text-danger"><span>{message}</span><button type="button" onClick={dismiss} aria-label="Dismiss error" className="flex h-11 w-11 shrink-0 items-center justify-center"><X className="h-4 w-4" aria-hidden /></button></div>;
}
