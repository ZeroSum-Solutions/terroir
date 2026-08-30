"use client";

import { useRef } from "react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";

export function CreateListModal({
  newName,
  setNewName,
  newDescription,
  setNewDescription,
  creating,
  error,
  onClose,
  onCreate,
}: {
  newName: string;
  setNewName: (v: string) => void;
  newDescription: string;
  setNewDescription: (v: string) => void;
  creating: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: () => void;
}) {
  const trapRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef: trapRef, onEscape: onClose });

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- backdrop-click-to-dismiss is a mouse-only convenience; this dialog already has full keyboard access via useFocusTrap (Escape + a visible Close button).
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-scrim px-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-wine-list-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="w-full max-w-[400px] rounded-card card-surface p-lg"
      >
        <h2
          id="new-wine-list-title"
          className="font-serif text-[22px] text-ink"
        >
          New wine list
        </h2>
        <p className="mt-xs text-[13px] text-grey">
          Default sections will be created. You can rename or add more later.
        </p>
        <input
          autoFocus
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCreate();
          }}
          placeholder="Spring 2026 Wine List…"
          className="mt-lg h-11 w-full rounded-pill border border-edge bg-canvas px-md text-[14px] text-ink placeholder:text-grey focus-visible:border-accent focus-ring"
        />
        <textarea
          value={newDescription}
          onChange={(e) => setNewDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={3}
          className="mt-sm w-full rounded-md border border-rule bg-canvas px-sm py-xs text-[14px] text-ink placeholder:text-grey focus-visible:border-accent focus-ring resize-none"
        />
        {error && (
          <p
            role="alert"
            className="mt-sm rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"
          >
            {error}
          </p>
        )}
        <div className="mt-lg flex justify-end gap-sm">
          <button
            type="button"
            onClick={onClose}
            className="h-[38px] rounded-pill border border-rule px-md text-[14px] font-medium text-ink hover:bg-wash focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCreate}
            disabled={creating}
            className="h-[38px] rounded-pill bg-primary px-md text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-60"
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
