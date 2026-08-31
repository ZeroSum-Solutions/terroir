"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { WineThumb } from "@/components/wine-thumb";
import { Archive, ChevronDown, Pencil, Plus, Search, X } from "lucide-react";
import { IconButton } from "@/components/icon-button";
import { cn } from "@/lib/utils";
import {
  findBottleMatches,
  type BottleInventoryRow,
} from "@/lib/bins";
import { BinForm, type BinDraft } from "./bin-form";
import type { BinViewModel } from "./bin-view-model";
import { useBinEditor, useBinRequests } from "./use-bin-manager";
import { wineDisplayName } from "@/lib/wine-display-name";

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
      <BinTable bins={bins} inventory={inventory} canManage={canManage} busy={requests.busy} editingId={editor.editingId} draft={editor.draft} onDraftChange={editor.setDraft} onEdit={editor.openEdit} onCancel={editor.close} onSave={requests.save} onRetire={requests.retire} />
    </>
  );
}

function ManagerToolbar({ query, onQueryChange, canManage, onCreate }: { query: string; onQueryChange: (value: string) => void; canManage: boolean; onCreate: () => void }) {
  return <div className="mb-lg grid gap-sm md:grid-cols-[minmax(0,1fr)_auto]"><SearchBox query={query} onChange={onQueryChange} />{canManage && <button type="button" onClick={onCreate} className="flex h-11 items-center justify-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"><Plus className="h-4 w-4" strokeWidth={2} aria-hidden />Create bin</button>}</div>;
}

function UnplacedAnchor({ count }: { count: number }) {
  if (count === 0) return null;
  return <a id="unplaced" href="#unplaced" className="mb-lg flex min-h-11 items-center justify-between rounded-md border border-rule bg-wash px-md py-sm text-[13px] text-ink"><span className="font-medium">Unplaced inventory</span><span className="tabular text-grey">{count} {count === 1 ? "bottle" : "bottles"}</span></a>;
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
        className="h-11 w-full rounded-pill border border-rule bg-surface pl-[40px] pr-sm text-[14px] text-ink placeholder:text-grey focus:border-accent focus-ring"
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
          <div key={`${match.wineId}:${match.binId}`} data-bottle-match className="border-b border-rule last:border-b-0">
            {/* CELLAR-08 — the search result is the "somebody is on the floor
                hunting for a bottle" path, so the whole row opens the wine. */}
            <Link
              href={`/cellar?wine=${match.wineId}`}
              className="flex min-h-11 items-center justify-between gap-md px-md py-sm transition-colors hover:bg-wash focus-ring"
            >
              <WineThumb
                src={match.heroImageUrl}
                producer={match.producer}
                name={match.name}
                colour={match.colour}
                size={36}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-serif text-[17px] font-medium text-ink">{wineDisplayName(match.producer, match.name)}</p>
                <p className="truncate text-[12px] text-grey">{match.producer}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono text-[12px] text-ink">{match.binZone ? `${match.binZone} › ` : ""}{match.binCode}</p>
                <p className="text-[12px] tabular text-grey">{match.quantity} {match.quantity === 1 ? "bottle" : "bottles"}</p>
              </div>
            </Link>
          </div>
        ))
      )}
    </div>
  );
}

type TableProps = {
  bins: BinViewModel[];
  inventory: BottleInventoryRow[];
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
  // CELLAR-08 — a bin row was a dead end: no picture, and nothing on it
  // clickable but Edit and Retire. Someone sent to Bin A5 for one of ten
  // bottles could not tell which was which. Opening a row now shows what is
  // in it, with the bottle's picture, and each wine goes to its own detail.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="overflow-hidden rounded-card card-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead><tr className="bg-wash text-[11px] font-medium uppercase tracking-[0.18em] text-grey"><th className="px-md py-sm text-left">Code</th><th className="px-md py-sm text-left">Zone</th><th className="px-md py-sm text-left">Occupancy</th><th className="px-md py-sm text-right">Capacity</th><th className="px-md py-sm text-right">Priority</th>{props.canManage && <th className="w-[104px] px-sm py-sm" />}</tr></thead>
          <tbody>
            {props.bins.map((bin) => (
              <BinRow
                key={bin.id}
                bin={bin}
                expanded={expandedId === bin.id}
                onToggle={() => setExpandedId(expandedId === bin.id ? null : bin.id)}
                {...props}
              />
            ))}
          </tbody>
        </table>
      </div>
      {props.bins.length === 0 && <p className="px-md py-xl text-center text-[13px] text-grey">No bins have been created yet.</p>}
    </div>
  );
}

function BinRow({ bin, inventory, canManage, busy, editingId, draft, onDraftChange, onEdit, onCancel, onSave, onRetire, expanded, onToggle }: TableProps & { bin: BinViewModel; expanded: boolean; onToggle: () => void }) {
  if (editingId === bin.id) {
    return <tr data-bin-row className="border-t border-rule"><td colSpan={6} className="bg-wash px-md py-md"><BinForm draft={draft} busy={busy} submitLabel="Save changes" onChange={onDraftChange} onCancel={onCancel} onSubmit={onSave} /></td></tr>;
  }
  const wines = inventory.filter((item) => item.binId === bin.id);
  return (
    <>
      <tr data-bin-row className="border-t border-rule hover:bg-wash">
        <td className="px-md py-sm font-mono font-medium text-ink">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            disabled={wines.length === 0}
            className="inline-flex min-h-11 items-center gap-xs rounded-md px-2xs text-left font-medium text-ink focus-ring disabled:cursor-default"
          >
            <ChevronDown
              className={cn("h-4 w-4 shrink-0 text-grey transition-transform", !expanded && "-rotate-90", wines.length === 0 && "invisible")}
              strokeWidth={1.75}
              aria-hidden
            />
            {bin.code}
          </button>
        </td>
        <td className="px-md py-sm text-grey">{bin.zone ?? "—"}</td>
        <td className="px-md py-sm text-ink">
          <div className="flex items-center gap-sm">
            {/* The bottles themselves, at a glance — this is what tells ten
                bottles in one bin apart. */}
            {wines.slice(0, 5).map((wine) => (
              <WineThumb
                key={`${wine.wineId}:${wine.binId}`}
                src={wine.heroImageUrl}
                producer={wine.producer}
                name={wine.name}
                colour={wine.colour}
                size={28}
              />
            ))}
            <span>{bin.occupancy}</span>
          </div>
          {bin.capacity != null && bin.capacity > 0 && (
            <div className="mt-2xs h-1.5 w-full max-w-[160px] overflow-hidden rounded-pill bg-surface-sunken">
              <div
                className="h-full rounded-pill bg-primary"
                style={{ width: `${Math.min(100, (bin.bottleCount / bin.capacity) * 100)}%` }}
              />
            </div>
          )}
        </td>
        <td className="px-md py-sm text-right tabular text-grey">{bin.capacity ?? "—"}</td>
        <td className="px-md py-sm text-right tabular text-grey">{bin.priority}</td>
        {canManage && <td className="px-sm py-sm"><div className="flex justify-end gap-2xs"><IconButton label={`Edit bin ${bin.code}`} onClick={() => onEdit(bin)} className="rounded-md text-grey hover:bg-wash hover:text-ink focus-ring"><Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden /></IconButton><IconButton label={`Retire bin ${bin.code}`} onClick={() => onRetire(bin)} disabled={busy} className="rounded-md text-grey hover:bg-risk-wash hover:text-risk-ink disabled:opacity-50"><Archive className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden /></IconButton></div></td>}
      </tr>
      {expanded && wines.length > 0 && (
        <tr data-bin-wines={bin.code} className="border-t border-rule">
          <td colSpan={6} className="bg-wash px-md py-sm">
            <div className="flex flex-col gap-xs">
              {wines.map((wine) => (
                <Link
                  key={`${wine.wineId}:${wine.binId}`}
                  href={`/cellar?wine=${wine.wineId}`}
                  data-bin-wine={wine.wineId}
                  className="flex min-h-11 items-center gap-sm rounded-md border border-rule bg-surface px-sm py-xs transition-colors hover:bg-wash focus-ring"
                >
                  <WineThumb src={wine.heroImageUrl} producer={wine.producer} name={wine.name} colour={wine.colour} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-caption font-medium uppercase text-grey">{wine.producer}</span>
                    <span className="block truncate font-serif text-body-lg font-medium text-ink">{wineDisplayName(wine.producer, wine.name)}</span>
                  </span>
                  <span className="shrink-0 tabular text-body-sm text-grey">{wine.quantity} {wine.quantity === 1 ? "bottle" : "bottles"}</span>
                </Link>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function FormPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-lg rounded-card card-surface p-md"><h2 className="mb-md text-[15px] font-semibold text-ink">{title}</h2>{children}</section>;
}

function ErrorBanner({ message, dismiss }: { message: string; dismiss: () => void }) {
  return <div role="alert" className="mb-md flex items-center justify-between gap-sm rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"><span>{message}</span><IconButton label="Dismiss error" onClick={dismiss} className="shrink-0 rounded-md text-risk-ink/70 hover:bg-risk-wash hover:text-risk-ink focus-ring"><X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden /></IconButton></div>;
}
