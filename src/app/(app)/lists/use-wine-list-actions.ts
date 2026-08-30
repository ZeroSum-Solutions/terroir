"use client";

import { useCallback, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import type { WineListWithCount } from "@/lib/wine-list/types";
import {
  archiveKey,
  cloneKey,
  deleteKey,
  initialWineListRowActionsState,
  isDeleteTargetBusy,
  wineListRowActionsReducer,
} from "./wine-list-row-actions";

/**
 * All state and handlers behind the Wine Lists landing page: the create-list
 * modal, plus copy-link/archive/clone/delete actions on individual list
 * cards. Row-level busy/error state is a reducer keyed by row+action (see
 * wine-list-row-actions.ts) so two cards acting concurrently can't clobber
 * each other's status.
 */
export function useWineListActions() {
  const router = useRouter();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [state, dispatch] = useReducer(
    wineListRowActionsReducer,
    initialWineListRowActionsState,
  );

  const openCreateModal = () => setShowModal(true);
  const closeCreateModal = () => {
    setShowModal(false);
    setCreateError(null);
  };
  const changeNewName = (v: string) => {
    setNewName(v);
    if (createError) setCreateError(null);
  };
  const changeNewDescription = (v: string) => {
    setNewDescription(v);
    if (createError) setCreateError(null);
  };

  const copyListLink = useCallback(async (list: WineListWithCount) => {
    if (!list.slug) return;
    const url = `${window.location.origin}/list/${list.slug}`;
    await navigator.clipboard.writeText(url);
    dispatch({ type: "list-link-copied", listId: list.id });
    setTimeout(
      () => dispatch({ type: "list-copy-flash-expired", listId: list.id }),
      2000,
    );
  }, []);

  const toggleArchive = useCallback(
    async (list: WineListWithCount) => {
      const willArchive = !list.archived;
      const action = willArchive ? "archive" : "unarchive";
      const confirmMessage = willArchive
        ? `Archive "${list.name}"? It will be hidden from the default view but can be restored later.`
        : `Restore "${list.name}"? It will appear in the default view again.`;
      if (!window.confirm(confirmMessage)) return;

      const key = archiveKey(list.id);
      dispatch({ type: "row-busy-started", key });
      try {
        const res = await fetch(`/api/wine-lists/${list.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: willArchive }),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: unknown };
          throw new Error(
            typeof body.error === "string"
              ? body.error
              : `Couldn't ${action} wine list.`,
          );
        }
        dispatch({ type: "row-busy-cleared", key });
        router.refresh();
      } catch (err) {
        dispatch({
          type: "row-action-failed",
          key,
          error:
            err instanceof Error && err.message
              ? err.message
              : `Couldn't ${action} wine list. Please try again.`,
        });
      }
    },
    [router],
  );

  const deleteList = useCallback(async () => {
    const list = state.deleteTarget;
    if (!list) return;
    const key = deleteKey(list.id);
    dispatch({ type: "delete-started", key });
    try {
      const res = await fetch(`/api/wine-lists/${list.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        let serverMessage: string | undefined;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") serverMessage = body.error;
        } catch {
          // non-JSON body — fall through to generic message
        }
        throw new Error(serverMessage ?? "Couldn't delete wine list.");
      }
      dispatch({ type: "delete-succeeded", key });
      router.refresh();
    } catch (err) {
      dispatch({
        type: "row-action-failed",
        key,
        error:
          err instanceof Error && err.message
            ? err.message
            : "Couldn't delete wine list. Please try again.",
      });
    }
  }, [state.deleteTarget, router]);

  const requestDeleteList = useCallback((list: WineListWithCount) => {
    // BND-159: only archived lists can be deleted. The API enforces this,
    // but the UI should never offer DELETE on a non-archived list.
    if (!list.archived) return;
    dispatch({ type: "delete-requested", list });
  }, []);

  const dismissDeleteTarget = () => dispatch({ type: "delete-dismissed" });
  const dismissError = () => dispatch({ type: "error-cleared" });

  const cloneList = useCallback(
    async (list: WineListWithCount) => {
      const confirmMessage = `Clone "${list.name}"? A new unpublished copy will be created with all sections and items preserved.`;
      if (!window.confirm(confirmMessage)) return;

      const key = cloneKey(list.id);
      dispatch({ type: "row-busy-started", key });
      try {
        const res = await fetch(`/api/wine-lists/${list.id}/clone`, {
          method: "POST",
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: unknown };
          throw new Error(
            typeof body.error === "string"
              ? body.error
              : "Clone failed. Please try again.",
          );
        }
        const { id } = (await res.json()) as { id: string };
        dispatch({ type: "row-busy-cleared", key });
        router.refresh();
        // Navigate to the clone
        router.push(`/lists/${id}`);
      } catch (err) {
        dispatch({
          type: "row-action-failed",
          key,
          error:
            err instanceof Error && err.message
              ? err.message
              : "Clone failed. Please try again.",
        });
      }
    },
    [router],
  );

  const createList = useCallback(async () => {
    const name = newName.trim() || "Untitled Wine List";
    setCreating(true);
    setCreateError(null);
    try {
      const body: { name: string; description?: string } = { name };
      if (newDescription.trim()) {
        body.description = newDescription.trim();
      }
      const res = await fetch("/api/wine-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create wine list");
      const { id } = (await res.json()) as { id: string };
      router.push(`/lists/${id}`);
    } catch {
      setCreateError("Couldn't create wine list. Please try again.");
      setCreating(false);
    }
  }, [newName, newDescription, router]);

  return {
    // Create-list modal
    creating,
    newName,
    newDescription,
    showModal,
    createError,
    openCreateModal,
    closeCreateModal,
    changeNewName,
    changeNewDescription,
    createList,

    // Row actions
    error: state.error,
    deleteTarget: state.deleteTarget,
    copiedListId: state.copiedListId,
    isDeleteBusy: isDeleteTargetBusy(state),
    isArchiving: (listId: string) => Boolean(state.busy[archiveKey(listId)]),
    isCloning: (listId: string) => Boolean(state.busy[cloneKey(listId)]),
    isDeleting: (listId: string) => Boolean(state.busy[deleteKey(listId)]),
    copyListLink,
    toggleArchive,
    cloneList,
    deleteList,
    requestDeleteList,
    dismissDeleteTarget,
    dismissError,
  };
}
