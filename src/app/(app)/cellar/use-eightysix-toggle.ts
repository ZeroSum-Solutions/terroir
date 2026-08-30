"use client";

import { useState } from "react";

type Toast = { success: (text: string) => void; error: (text: string) => void };

/**
 * 86/restore toggle. The trigger button lives in the drawer's Actions
 * section and the confirmation modal (NoteModal) renders as a separate
 * top-level sibling at the drawer's foot — two different JSX locations
 * for one state machine — so only the state and handler move here; the
 * drawer keeps rendering both call sites inline, wired to this hook's
 * return values.
 *
 * `busy`/`setBusy`/`setErrorMsg` are threaded in rather than owned here —
 * see merge-duplicates-panel.tsx for why this action shares its busy flag
 * and error banner with merge/pour/undo/delete.
 */
export function useEightysixToggle({
  wineId,
  busy,
  setBusy,
  setErrorMsg,
  toast,
  refresh,
}: {
  wineId: string | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setErrorMsg: (message: string | null) => void;
  toast: Toast;
  refresh: () => void;
}) {
  const [pendingDirection, setPendingDirection] = useState<
    "eightysixed" | "restored" | null
  >(null);

  const onConfirm86 = async (note: string | undefined) => {
    if (!wineId || !pendingDirection) return;
    const direction = pendingDirection;
    setErrorMsg(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/wines/${wineId}/availability`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, note }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `Request failed (${res.status}).`);
      }
      toast.success(direction === "eightysixed" ? "Marked as 86'd" : "Restored");
      setPendingDirection(null);
      refresh();
    } catch (err) {
      toast.error("Toggle failed");
      setErrorMsg(err instanceof Error ? err.message : "Toggle failed.");
    } finally {
      setBusy(false);
    }
  };

  return { pendingDirection, setPendingDirection, busy, onConfirm86 };
}
