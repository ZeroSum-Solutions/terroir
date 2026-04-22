"use client";

import { useEffect, useRef, useState } from "react";

interface NoteModalProps {
  open: boolean;
  wineName: string;
  direction: "eightysixed" | "restored";
  onCancel: () => void;
  onConfirm: (note: string | undefined) => void;
}

// Matches MDN's "tabbable" set well enough for a single-panel dialog.
// We intentionally don't filter by offsetParent (visibility) — this dialog
// has no hidden controls.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function NoteModal({
  open,
  wineName,
  direction,
  onCancel,
  onConfirm,
}: NoteModalProps) {
  const [note, setNote] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const headingId = "note-modal-heading";

  const handleCancel = () => {
    setNote("");
    onCancel();
  };

  const handleConfirm = () => {
    const trimmed = note.trim();
    setNote("");
    onConfirm(trimmed.length > 0 ? trimmed : undefined);
  };

  // Escape-to-close + focus-trap. Attached at the document level so a Tab
  // from anywhere inside the dialog is caught — the dialog is the only
  // interactive surface while open (aria-modal="true").
  useEffect(() => {
    if (!open) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setNote("");
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;

      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  // Auto-focus the textarea when the dialog opens so keyboard users can
  // start typing immediately.
  useEffect(() => {
    if (!open) return;
    // Defer to next tick so the textarea has mounted.
    const id = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const verb = direction === "eightysixed" ? "86" : "Restore";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-lg"
    >
      <div className="w-full max-w-[420px] rounded-md border border-border bg-white p-lg shadow-lg">
        <h2 id={headingId} className="font-serif text-[20px] text-ink">
          {verb} {wineName}?
        </h2>
        <p className="mt-xs text-[13px] text-ink-muted">
          Optional note — shows up in the audit log.
        </p>
        <textarea
          ref={textareaRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="e.g., last bottle just poured"
          autoFocus
          className="mt-sm w-full rounded-sm border border-border bg-surface px-sm py-xs text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
        />
        <div className="mt-md flex justify-end gap-sm">
          <button
            type="button"
            onClick={handleCancel}
            className="h-[38px] rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="h-[38px] rounded-sm bg-accent px-md text-[13px] font-medium text-white hover:bg-accent-hover"
          >
            {verb}
          </button>
        </div>
      </div>
    </div>
  );
}
