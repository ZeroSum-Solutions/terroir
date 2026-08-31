"use client";

import { useCallback, useMemo } from "react";
import { readApiError } from "@/lib/api/client-error";
import type { WineListEditorSection } from "./wine-list-editor.types";

type PourField = "glass_pour_ml" | "pour_size_mode";
type PourValue = number | "fixed" | "picker" | null;
type ItemPatch = Record<string, unknown>;

/**
 * Every write a wine-list row makes, in one place.
 *
 * SD-18: these were five near-identical handlers inline in
 * `wine-list-editor.tsx`, and all five ended the same way —
 *
 *     if (!res.ok) { startTransition(() => router.refresh()); }
 *
 * — which reverts the row and says nothing. `DELETE` had the same shape. Every
 * one of those routes is `requireRole(["owner", "manager"])`, so a staff
 * member's 403 read as the app quietly forgetting what they typed, and a
 * genuine 500 read the same way. The refresh is still right (the optimistic
 * row must go back); what was missing is the sentence explaining why.
 *
 * `onError` is the editor's existing error toast, so the message lands where
 * the failed drag-and-drop reorder message already does.
 */
export function useListItemUpdates({
  setSections,
  refresh,
  onError,
}: {
  setSections: React.Dispatch<React.SetStateAction<WineListEditorSection[]>>;
  refresh: () => void;
  onError: (message: string) => void;
}) {
  const patchItem = useCallback(
    async (itemId: string, changes: ItemPatch, whatFailed: string) => {
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, ...changes } : i,
          ),
        })),
      );
      await send(
        `/api/wine-list-items/${itemId}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) },
        `Couldn't save the ${whatFailed}.`,
        onError,
        refresh,
      );
    },
    [setSections, onError, refresh],
  );

  const deleteItem = useCallback(
    async (itemId: string) => {
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.filter((i) => i.id !== itemId),
        })),
      );
      await send(
        `/api/wine-list-items/${itemId}`,
        { method: "DELETE" },
        "Couldn't remove the wine.",
        onError,
        refresh,
      );
    },
    [setSections, onError, refresh],
  );

  return useMemo(
    () => ({
      deleteItem,
      updateItemPrice: (
        itemId: string,
        field: "glass_price" | "bottle_price",
        value: number | null,
      ) =>
        patchItem(
          itemId,
          { [field]: value },
          field === "glass_price" ? "glass price" : "bottle price",
        ),
      updateItemPour: (itemId: string, field: PourField, value: PourValue) =>
        patchItem(itemId, { [field]: value }, "pour size"),
      updateItemName: (itemId: string, value: string | null) =>
        patchItem(itemId, { name_override: value }, "display name"),
      updateItemBlurb: (itemId: string, value: string | null) =>
        patchItem(itemId, { blurb: value }, "note"),
      updateItemHidden: (itemId: string, value: boolean) =>
        patchItem(itemId, { hidden: value }, "visibility"),
    }),
    [patchItem, deleteItem],
  );
}

async function send(
  url: string,
  init: RequestInit,
  fallback: string,
  onError: (message: string) => void,
  refresh: () => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    onError(err instanceof Error ? err.message : fallback);
    refresh();
    return;
  }
  if (res.ok) return;
  onError(readApiError(await res.json().catch(() => null), fallback).message);
  refresh();
}
