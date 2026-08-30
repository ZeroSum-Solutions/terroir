import { describe, expect, it } from "vitest";
import type { WineListWithCount } from "@/lib/wine-list/types";
import {
  archiveKey,
  cloneKey,
  deleteKey,
  initialWineListRowActionsState,
  isDeleteTargetBusy,
  wineListRowActionsReducer,
  type WineListRowActionsState,
} from "./wine-list-row-actions";

function wineList(overrides: Partial<WineListWithCount> = {}): WineListWithCount {
  return {
    id: "list-1",
    restaurant_id: "restaurant-1",
    name: "Wine list",
    description: null,
    slug: null,
    template: "classic",
    theme: null,
    show_bin_codes: false,
    archived: false,
    is_published: false,
    last_published_at: null,
    created_at: "2026-08-20T12:00:00.000Z",
    updated_at: "2026-08-20T12:00:00.000Z",
    wine_count: 3,
    ...overrides,
  };
}

const listA = wineList({ id: "list-a", name: "List A", archived: true });
const listB = wineList({ id: "list-b", name: "List B", archived: true });

describe("wineListRowActionsReducer", () => {
  it("opens a delete confirmation and clears any stale error", () => {
    const withError: WineListRowActionsState = {
      ...initialWineListRowActionsState,
      error: "stale error",
    };
    const next = wineListRowActionsReducer(withError, {
      type: "delete-requested",
      list: listA,
    });
    expect(next.deleteTarget).toEqual(listA);
    expect(next.error).toBeNull();
  });

  it("dismisses a delete confirmation without touching a retained error", () => {
    const state: WineListRowActionsState = {
      ...initialWineListRowActionsState,
      deleteTarget: listA,
      error: "List is still referenced.",
    };
    const next = wineListRowActionsReducer(state, { type: "delete-dismissed" });
    expect(next.deleteTarget).toBeNull();
    expect(next.error).toBe("List is still referenced.");
  });

  it("starting an archive/clone does NOT clear a stale error (matches original archive/clone semantics)", () => {
    const withError: WineListRowActionsState = {
      ...initialWineListRowActionsState,
      error: "stale error",
    };
    const next = wineListRowActionsReducer(withError, {
      type: "row-busy-started",
      key: archiveKey(listA.id),
    });
    expect(next.error).toBe("stale error");
    expect(next.busy[archiveKey(listA.id)]).toBe(true);
  });

  it("starting a delete DOES clear a stale error (matches original delete semantics)", () => {
    const withError: WineListRowActionsState = {
      ...initialWineListRowActionsState,
      error: "stale error",
    };
    const next = wineListRowActionsReducer(withError, {
      type: "delete-started",
      key: deleteKey(listA.id),
    });
    expect(next.error).toBeNull();
    expect(next.busy[deleteKey(listA.id)]).toBe(true);
  });

  describe("two rows acting concurrently", () => {
    it("keeps each row's archive-busy flag independent", () => {
      let state = wineListRowActionsReducer(initialWineListRowActionsState, {
        type: "row-busy-started",
        key: archiveKey(listA.id),
      });
      state = wineListRowActionsReducer(state, {
        type: "row-busy-started",
        key: archiveKey(listB.id),
      });
      expect(state.busy[archiveKey(listA.id)]).toBe(true);
      expect(state.busy[archiveKey(listB.id)]).toBe(true);
    });

    it("row A finishing its archive does not clear row B's still-in-flight archive busy flag", () => {
      let state = wineListRowActionsReducer(initialWineListRowActionsState, {
        type: "row-busy-started",
        key: archiveKey(listA.id),
      });
      state = wineListRowActionsReducer(state, {
        type: "row-busy-started",
        key: archiveKey(listB.id),
      });
      // Row A's archive completes while row B's is still in flight — the
      // flat-boolean version of this state (a single archivingListId)
      // would null out its tracked id here, silently clearing row B's
      // busy flag too even though its request hasn't resolved.
      state = wineListRowActionsReducer(state, {
        type: "row-busy-cleared",
        key: archiveKey(listA.id),
      });
      expect(state.busy[archiveKey(listA.id)]).toBeUndefined();
      expect(state.busy[archiveKey(listB.id)]).toBe(true);
    });

    it("namespaces keys per action kind so an archive and a clone on the same list don't collide", () => {
      let state = wineListRowActionsReducer(initialWineListRowActionsState, {
        type: "row-busy-started",
        key: archiveKey(listA.id),
      });
      state = wineListRowActionsReducer(state, {
        type: "row-busy-started",
        key: cloneKey(listA.id),
      });
      state = wineListRowActionsReducer(state, {
        type: "row-busy-cleared",
        key: cloneKey(listA.id),
      });
      expect(state.busy[archiveKey(listA.id)]).toBe(true);
      expect(state.busy[cloneKey(listA.id)]).toBeUndefined();
    });

    it("failing row A's clone reports its error without clearing row B's archive busy flag", () => {
      let state = wineListRowActionsReducer(initialWineListRowActionsState, {
        type: "row-busy-started",
        key: cloneKey(listA.id),
      });
      state = wineListRowActionsReducer(state, {
        type: "row-busy-started",
        key: archiveKey(listB.id),
      });
      state = wineListRowActionsReducer(state, {
        type: "row-action-failed",
        key: cloneKey(listA.id),
        error: "Clone failed. Please try again.",
      });
      expect(state.busy[cloneKey(listA.id)]).toBeUndefined();
      expect(state.busy[archiveKey(listB.id)]).toBe(true);
      expect(state.error).toBe("Clone failed. Please try again.");
    });
  });

  it("succeeding a delete closes the confirm dialog and clears its busy flag", () => {
    const key = deleteKey(listA.id);
    let state: WineListRowActionsState = {
      ...initialWineListRowActionsState,
      deleteTarget: listA,
      busy: { [key]: true },
    };
    state = wineListRowActionsReducer(state, { type: "delete-succeeded", key });
    expect(state.deleteTarget).toBeNull();
    expect(state.busy[key]).toBeUndefined();
  });

  it("failing a delete keeps the confirm dialog open with the error surfaced", () => {
    const key = deleteKey(listA.id);
    let state: WineListRowActionsState = {
      ...initialWineListRowActionsState,
      deleteTarget: listA,
      busy: { [key]: true },
    };
    state = wineListRowActionsReducer(state, {
      type: "row-action-failed",
      key,
      error: "List is still referenced.",
    });
    expect(state.deleteTarget).toEqual(listA);
    expect(state.busy[key]).toBeUndefined();
    expect(state.error).toBe("List is still referenced.");
  });

  it("tracks the most recently copied list and clears it on flash-expiry", () => {
    let state = wineListRowActionsReducer(initialWineListRowActionsState, {
      type: "list-link-copied",
      listId: listA.id,
    });
    expect(state.copiedListId).toBe(listA.id);

    state = wineListRowActionsReducer(state, {
      type: "list-copy-flash-expired",
      listId: listA.id,
    });
    expect(state.copiedListId).toBeNull();
  });

  it("ignores a stale flash-expiry for a copy that has since been superseded", () => {
    let state = wineListRowActionsReducer(initialWineListRowActionsState, {
      type: "list-link-copied",
      listId: "first",
    });
    state = wineListRowActionsReducer(state, {
      type: "list-link-copied",
      listId: "second",
    });
    state = wineListRowActionsReducer(state, {
      type: "list-copy-flash-expired",
      listId: "first",
    });
    expect(state.copiedListId).toBe("second");
  });

  it("dismisses the error banner independently of any confirm target", () => {
    const state: WineListRowActionsState = {
      ...initialWineListRowActionsState,
      error: "Couldn't archive wine list. Please try again.",
    };
    const next = wineListRowActionsReducer(state, { type: "error-cleared" });
    expect(next.error).toBeNull();
  });
});

describe("isDeleteTargetBusy", () => {
  it("is false when no delete confirmation is open", () => {
    expect(isDeleteTargetBusy(initialWineListRowActionsState)).toBe(false);
  });

  it("reads the busy flag for the open delete target only", () => {
    const state: WineListRowActionsState = {
      ...initialWineListRowActionsState,
      deleteTarget: listA,
      busy: { [deleteKey(listA.id)]: true, [deleteKey(listB.id)]: true },
    };
    expect(isDeleteTargetBusy(state)).toBe(true);
  });

  it("is false when the open delete target's own key isn't busy, even if another row is", () => {
    const state: WineListRowActionsState = {
      ...initialWineListRowActionsState,
      deleteTarget: listA,
      busy: { [deleteKey(listB.id)]: true },
    };
    expect(isDeleteTargetBusy(state)).toBe(false);
  });
});
