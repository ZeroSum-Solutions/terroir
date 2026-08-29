"use client";

import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Field } from "@/components/field";

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
        <Field id="eightysix-note" label="Note (optional)">
          {(a11y) => (
            <textarea
              {...a11y}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="e.g., last bottle just poured"
              className="mt-xs min-h-11 w-full rounded-md border border-rule bg-canvas px-sm py-xs text-[14px] text-ink outline-none focus-visible:border-accent focus-ring"
            />
          )}
        </Field>
        {error && (
          <p
            role="alert"
            className="mt-sm rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"
          >
            {error}
          </p>
        )}
      </>
    </ActionDialog>
  );
}
