"use client";

import { Loader2 } from "lucide-react";
import type { BinRecord } from "./bin-view-model";

export type BinDraft = {
  code: string;
  zone: string;
  capacity: string;
  priority: string;
};

export function draftFor(bin?: BinRecord): BinDraft {
  return {
    code: bin?.code ?? "",
    zone: bin?.zone ?? "",
    capacity: bin?.capacity == null ? "" : String(bin.capacity),
    priority: String(bin?.priority ?? 0),
  };
}

export function payloadFor(draft: BinDraft) {
  return {
    code: draft.code.trim(),
    zone: draft.zone.trim() || null,
    capacity: draft.capacity === "" ? null : Number(draft.capacity),
    priority: Number(draft.priority),
  };
}

type Props = {
  draft: BinDraft;
  busy: boolean;
  submitLabel: string;
  onChange: (draft: BinDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export function BinForm({
  draft,
  busy,
  submitLabel,
  onChange,
  onCancel,
  onSubmit,
}: Props) {
  return (
    <form
      className="grid gap-md md:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <BinFields draft={draft} onChange={onChange} />
      <div className="flex justify-end gap-sm md:col-span-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-11 rounded-pill border border-beige-deep bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-ring disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="flex h-11 items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover focus-ring disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function BinFields({ draft, onChange }: { draft: BinDraft; onChange: (draft: BinDraft) => void }) {
  const set = (field: keyof BinDraft, value: string) => onChange({ ...draft, [field]: value });
  const common = "h-11 w-full rounded-pill border border-hairline bg-surface px-md text-[14px] text-ink focus:border-accent focus-ring";
  return <>
    <Field label="Code"><input required maxLength={50} value={draft.code} onChange={(event) => set("code", event.target.value)} className={`${common} font-mono`} /></Field>
    <Field label="Zone"><input maxLength={100} value={draft.zone} onChange={(event) => set("zone", event.target.value)} className={common} /></Field>
    <Field label="Capacity"><input type="number" min={1} value={draft.capacity} onChange={(event) => set("capacity", event.target.value)} placeholder="No limit" className={`${common} tabular-nums`} /></Field>
    <Field label="Priority"><input required type="number" step={1} value={draft.priority} onChange={(event) => set("priority", event.target.value)} className={`${common} tabular-nums`} /></Field>
  </>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-xs text-caption font-medium uppercase text-grey">
      {label}
      {children}
    </label>
  );
}
