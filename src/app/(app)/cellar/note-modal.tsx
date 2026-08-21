"use client";

import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";

interface NoteModalProps {
  open: boolean;
  wineName: string;
  direction: "eightysixed" | "restored";
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (note: string | undefined) => void;
}

export function NoteModal({
  open,
  wineName,
  direction,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: NoteModalProps) {
  const [note, setNote] = useState("");

  const handleCancel = () => {
    setNote("");
    onCancel();
  };

  const handleConfirm = () => {
    const trimmed = note.trim();
    onConfirm(trimmed.length > 0 ? trimmed : undefined);
  };

  const verb = direction === "eightysixed" ? "86" : "Restore";

  return (
    <ActionDialog
      open={open}
      title={`${verb} wine`}
      description="Optional note — shows up in the audit log."
      confirmLabel={`${verb} ${wineName}`}
      busy={busy}
      onClose={handleCancel}
      onConfirm={handleConfirm}
    >
      <>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="e.g., last bottle just poured"
          className="w-full rounded-md border border-hairline bg-canvas px-sm py-xs text-[14px] text-ink outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-blush-wash"
        />
        {error && (
          <p
            role="alert"
            className="mt-sm rounded-md border border-primary/30 bg-blush-wash px-sm py-xs text-[13px] text-primary"
          >
            {error}
          </p>
        )}
      </>
    </ActionDialog>
  );
}
