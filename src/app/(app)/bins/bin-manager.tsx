"use client";

import { useMemo, useState } from "react";
import { Archive, Pencil, Plus, Search, X } from "lucide-react";
import { IconButton } from "@/components/icon-button";
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
  return <div className="mb-lg grid gap-sm md:grid-cols-[minmax(0,1fr)_auto]"><SearchBox query={query} onChange={onQueryChange} />{canManage && <button type="button" onClick={onCreate} className="flex h-11 items-center justify-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"><Plus className="h-4 w-4" strokeWidth={2} aria-hidden />Create bin</button>}</div>;
}

function UnplacedAnchor({ count }: { count: number }) {
  if (count === 0) return null;
  return <a id="unplaced" href="#unplaced" className="mb-lg flex min-h-11 items-center justify-between rounded-md border border-hairline bg-bridge-surface px-md py-sm text-[13px] text-ink"><span className="font-medium">Unplaced inventory</span><span className="tabular text-grey">{count} {count === 1 ? "bottle" : "bottles"}</span></a>;
}

function SearchBox({ query, onChange }: { query: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block">
      <span className="sr-only">Find a bottle</span>
      <Search className="absolute left-md top-1/2 h-4 w-4 -translate-y-1/2 text-grey" aria-hidden />
      <input
        type="search"
        aria-label="Find a bottle"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Find a bottle by wine or producer"
        className="h-11 w-full rounded-pill border border-hairline bg-surface pl-[40px] pr-sm text-[14px] text-ink placeholder:text-grey focus:border-accent focus-ring"
      />
    </label>
  );
}

type Match = ReturnType<typeof findBottleMatches>[number];

function SearchResults({ matches }: { matches: Match[] }) {
  return (
    <div className="mb-lg overflow-hidden rounded-card card-surface">
      {matches.length === 0 ? (
        <p className="px-md py-md text-[13px] text-grey">No placed bottles match.</p>
      ) : (
        matches.map((match) => (
          <div key={`${match.wineId}:${match.binId}`} data-bottle-match className="flex items-center justify-between gap-md border-b border-hairline px-md py-sm last:border-b-0">
            <div className="min-w-0">
              <p className="truncate font-serif text-[17px] font-medium text-ink">{match.name}</p>
              <p className="truncate text-[12px] text-grey">{match.producer}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-[12px] text-ink">{match.binZone ? `${match.binZone} › ` : ""}{match.binCode}</p>
              <p className="text-[12px] tabular text-grey">{match.quantity} {match.quantity === 1 ? "bottle" : "bottles"}</p>
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
    <div className="overflow-hidden rounded-card card-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead><tr className="bg-bridge-surface text-[11px] font-medium uppercase tracking-[0.18em] text-grey"><th className="px-md py-sm text-left">Code</th><th className="px-md py-sm text-left">Zone</th><th className="px-md py-sm text-left">Occupancy</th><th className="px-md py-sm text-right">Capacity</th><th className="px-md py-sm text-right">Priority</th>{props.canManage && <th className="w-[104px] px-sm py-sm" />}</tr></thead>
          <tbody>{props.bins.map((bin) => <BinRow key={bin.id} bin={bin} {...props} />)}</tbody>
        </table>
      </div>
      {props.bins.length === 0 && <p className="px-md py-xl text-center text-[13px] text-grey">No bins have been created yet.</p>}
    </div>
  );
}

function BinRow({ bin, canManage, busy, editingId, draft, onDraftChange, onEdit, onCancel, onSave, onRetire }: TableProps & { bin: BinViewModel }) {
  if (editingId === bin.id) {
    return <tr data-bin-row className="border-t border-hairline"><td colSpan={6} className="bg-bridge-surface px-md py-md"><BinForm draft={draft} busy={busy} submitLabel="Save changes" onChange={onDraftChange} onCancel={onCancel} onSubmit={onSave} /></td></tr>;
  }
  return (
    <tr data-bin-row className="border-t border-hairline hover:bg-bridge-surface">
      <td className="px-md py-sm font-mono font-medium text-ink">{bin.code}</td>
      <td className="px-md py-sm text-grey">{bin.zone ?? "—"}</td>
      <td className="px-md py-sm text-ink">
        <div>{bin.occupancy}</div>
        {bin.capacity != null && bin.capacity > 0 && (
          <div className="mt-2xs h-1.5 w-full max-w-[160px] overflow-hidden rounded-pill bg-beige">
            <div
              className="h-full rounded-pill bg-primary"
              style={{ width: `${Math.min(100, (bin.bottleCount / bin.capacity) * 100)}%` }}
            />
          </div>
        )}
      </td>
      <td className="px-md py-sm text-right tabular text-grey">{bin.capacity ?? "—"}</td>
      <td className="px-md py-sm text-right tabular text-grey">{bin.priority}</td>
      {canManage && <td className="px-sm py-sm"><div className="flex justify-end gap-2xs"><IconButton label={`Edit bin ${bin.code}`} onClick={() => onEdit(bin)} className="rounded-md text-grey hover:bg-bridge-surface hover:text-ink focus-ring"><Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden /></IconButton><IconButton label={`Retire bin ${bin.code}`} onClick={() => onRetire(bin)} disabled={busy} className="rounded-md text-grey hover:bg-blush-wash hover:text-accent disabled:opacity-50"><Archive className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden /></IconButton></div></td>}
    </tr>
  );
}

function FormPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-lg rounded-card card-surface p-md"><h2 className="mb-md text-[15px] font-semibold text-ink">{title}</h2>{children}</section>;
}

function ErrorBanner({ message, dismiss }: { message: string; dismiss: () => void }) {
  return <div role="alert" className="mb-md flex items-center justify-between gap-sm rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"><span>{message}</span><IconButton label="Dismiss error" onClick={dismiss} className="shrink-0 rounded-md text-risk-ink/70 hover:bg-risk-wash hover:text-risk-ink focus-ring"><X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden /></IconButton></div>;
}
