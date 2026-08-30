"use client";

import { useCallback, useRef } from "react";
import { useAsyncAction } from "./use-async-action";

type Toast = { success: (text: string) => void; error: (text: string) => void };

/**
 * Hero-image upload/delete for the drawer. Both handlers share one busy
 * flag in the original component (the "Add hero image" prompt and the
 * "Remove image" button render in two different spots — before the Stock
 * card, and near the drawer's foot — so the JSX stays inline at the
 * call sites; only the handlers move here). That single shared flag is
 * local to these two actions only (no other drawer control reads it),
 * which is exactly the shape useAsyncAction replaces.
 */
export function useHeroImageActions({
  wineId,
  setErrorMsg,
  toast,
  refresh,
}: {
  wineId: string | null;
  setErrorMsg: (message: string | null) => void;
  toast: Toast;
  refresh: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const action = useAsyncAction();

  const handleImageUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !wineId) return;
      setErrorMsg(null);
      await action.run(
        async () => {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch(`/api/wines/${wineId}/image`, {
            method: "POST",
            body: formData,
          });
          if (!res.ok) {
            const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
            throw new Error(payload?.error?.message ?? `Upload failed (${res.status}).`);
          }
          toast.success("Image uploaded");
          refresh();
        },
        {
          fallbackMessage: "Upload failed.",
          onError: (message) => setErrorMsg(message),
        },
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [wineId, refresh, setErrorMsg, toast, action],
  );

  const handleImageDelete = useCallback(
    async () => {
      if (!wineId) return;
      setErrorMsg(null);
      await action.run(
        async () => {
          const res = await fetch(`/api/wines/${wineId}/image`, { method: "DELETE" });
          if (!res.ok) {
            const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
            throw new Error(payload?.error?.message ?? `Delete failed (${res.status}).`);
          }
          toast.success("Image removed");
          refresh();
        },
        {
          fallbackMessage: "Delete failed.",
          onError: (message) => setErrorMsg(message),
        },
      );
    },
    [wineId, refresh, setErrorMsg, toast, action],
  );

  return {
    uploading: action.busy,
    fileInputRef,
    handleImageUpload,
    handleImageDelete,
  };
}
