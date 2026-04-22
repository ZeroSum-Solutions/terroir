"use client";

import { useState } from "react";

interface NoteModalProps {
  open: boolean;
  wineName: string;
  direction: "eightysixed" | "restored";
  onCancel: () => void;
  onConfirm: (note: string | undefined) => void;
}

export function NoteModal({
  open,
  wineName,
  direction,
  onCancel,
  onConfirm,
}: NoteModalProps) {
  const [note, setNote] = useState("");
  if (!open) return null;

  const verb = direction === "eightysixed" ? "86" : "Restore";

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-lg"
    >
      <div className="w-full max-w-[420px] rounded-md border border-border bg-white p-lg shadow-lg">
        <h2 className="font-serif text-[20px] text-ink">
          {verb} {wineName}?
        </h2>
        <p className="mt-xs text-[13px] text-ink-muted">
          Optional note — shows up in the audit log.
        </p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="e.g., last bottle just poured"
          className="mt-sm w-full rounded-sm border border-border bg-surface px-sm py-xs text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
        />
        <div className="mt-md flex justify-end gap-sm">
          <button
            type="button"
            onClick={onCancel}
            className="h-[38px] rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const trimmed = note.trim();
              onConfirm(trimmed.length > 0 ? trimmed : undefined);
              setNote("");
            }}
            className="h-[38px] rounded-sm bg-accent px-md text-[13px] font-medium text-white hover:bg-accent-hover"
          >
            {verb}
          </button>
        </div>
      </div>
    </div>
  );
}
