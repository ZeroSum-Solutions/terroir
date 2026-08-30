import type { WineListWithCount } from "@/lib/wine-list/types";

/**
 * Row-scoped busy keys. Namespaced per action kind (not just per list id)
 * so an archive failure for a list can never collide with — and
 * incorrectly clear — a clone that happens to be in flight for that same
 * list.
 */
export function archiveKey(listId: string): string {
  return `list:${listId}:archive`;
}
export function cloneKey(listId: string): string {
  return `list:${listId}:clone`;
}
export function deleteKey(listId: string): string {
  return `list:${listId}:delete`;
}

export type WineListRowActionsState = {
  /** Keyed by archiveKey/cloneKey/deleteKey — presence means busy. */
  busy: Record<string, true>;
  error: string | null;
  deleteTarget: WineListWithCount | null;
  copiedListId: string | null;
};

export const initialWineListRowActionsState: WineListRowActionsState = {
  busy: {},
  error: null,
  deleteTarget: null,
  copiedListId: null,
};

export type WineListRowActionsAction =
  | { type: "delete-requested"; list: WineListWithCount }
  | { type: "delete-dismissed" }
  | { type: "error-cleared" }
  | { type: "row-busy-started"; key: string }
  | { type: "row-busy-cleared"; key: string }
  | { type: "row-action-failed"; key: string; error: string }
  | { type: "delete-started"; key: string }
  | { type: "delete-succeeded"; key: string }
  | { type: "list-link-copied"; listId: string }
  | { type: "list-copy-flash-expired"; listId: string };

function withoutBusyKey(
  busy: Record<string, true>,
  key: string,
): Record<string, true> {
  if (!(key in busy)) return busy;
  const next = { ...busy };
  delete next[key];
  return next;
}

export function wineListRowActionsReducer(
  state: WineListRowActionsState,
  action: WineListRowActionsAction,
): WineListRowActionsState {
  switch (action.type) {
    case "delete-requested":
      return { ...state, error: null, deleteTarget: action.list };
    case "delete-dismissed":
      return { ...state, deleteTarget: null };
    case "error-cleared":
      return state.error === null ? state : { ...state, error: null };
    case "row-busy-started":
      return { ...state, busy: { ...state.busy, [action.key]: true } };
    case "row-busy-cleared":
      return { ...state, busy: withoutBusyKey(state.busy, action.key) };
    case "row-action-failed":
      return {
        ...state,
        busy: withoutBusyKey(state.busy, action.key),
        error: action.error,
      };
    case "delete-started":
      return {
        ...state,
        error: null,
        busy: { ...state.busy, [action.key]: true },
      };
    case "delete-succeeded":
      return {
        ...state,
        busy: withoutBusyKey(state.busy, action.key),
        deleteTarget: null,
      };
    case "list-link-copied":
      return { ...state, copiedListId: action.listId };
    case "list-copy-flash-expired":
      return state.copiedListId === action.listId
        ? { ...state, copiedListId: null }
        : state;
  }
}

/** Whether the currently-open delete confirmation's request is in flight. */
export function isDeleteTargetBusy(state: WineListRowActionsState): boolean {
  const target = state.deleteTarget;
  if (!target) return false;
  return Boolean(state.busy[deleteKey(target.id)]);
}
