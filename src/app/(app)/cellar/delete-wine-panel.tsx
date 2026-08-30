"use client";

import { useCallback, useState } from "react";
import { Trash2 } from "lucide-react";

type Toast = { success: (text: string) => void; error: (text: string) => void };

/**
 * BND-058 — delete-wine panel, owner-only. `busy`/`setBusy`/`setErrorMsg`
 * are threaded down from the drawer, not owned locally — see
 * merge-duplicates-panel.tsx for why the busy flag and error banner stay
 * shared across the drawer's mutating actions.
 */
export function DeleteWinePanel({
  wineId,
  busy,
  setBusy,
  setErrorMsg,
  toast,
  refresh,
  onDeleted,
}: {
  wineId: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setErrorMsg: (message: string | null) => void;
  toast: Toast;
  refresh: () => void;
  onDeleted: () => void;
}) {
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const doDelete = useCallback(
    async () => {
      setDeleteConfirm(false);
      setErrorMsg(null);
      setBusy(true);
      try {
        const res = await fetch(`/api/cellar/${wineId}`, { method: "DELETE" });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { error?: { code?: string; message?: string } }
            | null;
          throw new Error(
            payload?.error?.message ?? `Delete failed (${res.status}).`,
          );
        }
        toast.success("Wine deleted");
        onDeleted();
        refresh();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Delete failed.");
      } finally {
        setBusy(false);
      }
    },
    [wineId, setBusy, setErrorMsg, toast, refresh, onDeleted],
  );

  if (deleteConfirm) {
    return (
      <div className="flex flex-col gap-xs rounded-lg border border-risk-ink/30 bg-risk-wash p-sm">
        <p className="text-[13px] font-medium text-risk-ink">
          Permanently delete this wine?
        </p>
        <p className="text-[12px] text-risk-ink/80">
          This action cannot be undone. Consider using &ldquo;86 this wine&rdquo; instead.
        </p>
        <div className="flex gap-xs mt-xs">
          <button
            type="button"
            disabled={busy}
            onClick={() => setDeleteConfirm(false)}
            className="h-11 flex-1 rounded-pill border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-wash disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={doDelete}
            className="h-11 flex-1 rounded-pill bg-primary text-[13px] font-medium text-seal-ink hover:bg-primary-hover disabled:opacity-60"
          >
            {busy ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => setDeleteConfirm(true)}
      className="flex h-11 items-center justify-center gap-xs rounded-pill border border-risk-ink/30 bg-surface text-[13px] font-medium text-risk-ink hover:bg-risk-wash transition-colors disabled:opacity-60"
    >
      <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
      Delete wine
    </button>
  );
}
