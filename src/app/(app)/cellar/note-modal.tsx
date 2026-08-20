"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";

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

  // Escape also clears the draft note, mirroring handleCancel.
  const onEscape = useCallback(() => {
    setNote("");
    onCancel();
  }, [onCancel]);

  useFocusTrap({ containerRef: dialogRef, onEscape, enabled: open });

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
      <div className="w-full max-w-[420px] rounded-card border border-hairline bg-white p-lg">
        <h2 id={headingId} className="font-serif text-[20px] font-medium text-ink">
          {verb} {wineName}?
        </h2>
        <p className="mt-xs text-[13px] text-grey">
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
          className="mt-sm w-full rounded-md border border-hairline bg-canvas px-sm py-xs text-[14px] text-ink outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-blush-wash"
        />
        <div className="mt-md flex justify-end gap-sm">
          <button
            type="button"
            onClick={handleCancel}
            className="h-[38px] rounded-pill border border-ink/25 bg-white px-md text-[13px] font-medium text-ink hover:bg-bridge-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="h-[38px] rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover"
          >
            {verb}
          </button>
        </div>
      </div>
    </div>
  );
}
