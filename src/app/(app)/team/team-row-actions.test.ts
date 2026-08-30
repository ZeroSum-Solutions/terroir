import { describe, expect, it } from "vitest";
import {
  initialTeamRowActionsState,
  invitationRevokeKey,
  isConfirmTargetBusy,
  memberRemoveKey,
  teamRowActionsReducer,
  type Invitation,
  type Member,
  type TeamRowActionsState,
} from "./team-row-actions";

const memberA: Member = {
  id: "member-a",
  user_id: "user-a",
  name: "Member A",
  email: "a@example.com",
  role: "staff",
  created_at: "2026-08-01T00:00:00.000Z",
};

const memberB: Member = {
  id: "member-b",
  user_id: "user-b",
  name: "Member B",
  email: "b@example.com",
  role: "manager",
  created_at: "2026-08-01T00:00:00.000Z",
};

const invitationA: Invitation = {
  id: "invitation-a",
  token: "token-a",
  role: "staff",
  email: "invite-a@example.com",
  expires_at: "2099-01-01T00:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
};

describe("teamRowActionsReducer", () => {
  it("opens a member-removal confirmation and clears any stale error", () => {
    const withError: TeamRowActionsState = {
      ...initialTeamRowActionsState,
      error: "stale error",
    };
    const next = teamRowActionsReducer(withError, {
      type: "member-removal-requested",
      member: memberA,
    });
    expect(next.confirmTarget).toEqual({ kind: "removeMember", member: memberA });
    expect(next.error).toBeNull();
  });

  it("opens an invitation-revocation confirmation and clears any stale error", () => {
    const withError: TeamRowActionsState = {
      ...initialTeamRowActionsState,
      error: "stale error",
    };
    const next = teamRowActionsReducer(withError, {
      type: "invitation-revocation-requested",
      invitation: invitationA,
    });
    expect(next.confirmTarget).toEqual({
      kind: "revokeInvitation",
      invitation: invitationA,
    });
    expect(next.error).toBeNull();
  });

  it("dismisses a confirmation without touching a retained error", () => {
    const state: TeamRowActionsState = {
      ...initialTeamRowActionsState,
      confirmTarget: { kind: "removeMember", member: memberA },
      error: "Cannot remove the last owner.",
    };
    const next = teamRowActionsReducer(state, { type: "confirm-dismissed" });
    expect(next.confirmTarget).toBeNull();
    expect(next.error).toBe("Cannot remove the last owner.");
  });

  it("clears and sets the shared error for non-modal actions (role change / resend)", () => {
    let state = teamRowActionsReducer(initialTeamRowActionsState, {
      type: "error-cleared",
    });
    expect(state.error).toBeNull();
    state = teamRowActionsReducer(state, {
      type: "error-set",
      error: "Couldn't update role. Please try again.",
    });
    expect(state.error).toBe("Couldn't update role. Please try again.");
  });

  describe("two rows acting concurrently", () => {
    it("keeps each row's busy flag independent — starting one row does not busy the other", () => {
      const keyA = memberRemoveKey(memberA.id);
      const keyB = memberRemoveKey(memberB.id);
      let state = teamRowActionsReducer(initialTeamRowActionsState, {
        type: "row-action-started",
        key: keyA,
      });
      state = teamRowActionsReducer(state, {
        type: "row-action-started",
        key: keyB,
      });
      expect(state.busy[keyA]).toBe(true);
      expect(state.busy[keyB]).toBe(true);
    });

    it("finishing row A does not clear row B's still-in-flight busy flag", () => {
      const keyA = memberRemoveKey(memberA.id);
      const keyB = memberRemoveKey(memberB.id);
      let state = teamRowActionsReducer(initialTeamRowActionsState, {
        type: "row-action-started",
        key: keyA,
      });
      state = teamRowActionsReducer(state, {
        type: "row-action-started",
        key: keyB,
      });
      // Row A succeeds while row B is still in flight.
      state = teamRowActionsReducer(state, {
        type: "row-action-succeeded",
        key: keyA,
      });
      expect(state.busy[keyA]).toBeUndefined();
      expect(state.busy[keyB]).toBe(true);
    });

    it("failing row A reports its error without clearing row B's busy flag", () => {
      const keyA = invitationRevokeKey(invitationA.id);
      const keyB = memberRemoveKey(memberB.id);
      let state = teamRowActionsReducer(initialTeamRowActionsState, {
        type: "row-action-started",
        key: keyA,
      });
      state = teamRowActionsReducer(state, {
        type: "row-action-started",
        key: keyB,
      });
      state = teamRowActionsReducer(state, {
        type: "row-action-failed",
        key: keyA,
        error: "Couldn't revoke invitation. Please try again.",
      });
      expect(state.busy[keyA]).toBeUndefined();
      expect(state.busy[keyB]).toBe(true);
      expect(state.error).toBe("Couldn't revoke invitation. Please try again.");
    });

    it("namespaces keys per action kind so a role-change error can't clear an in-flight removal for the same member", () => {
      const removeKey = memberRemoveKey(memberA.id);
      let state = teamRowActionsReducer(initialTeamRowActionsState, {
        type: "row-action-started",
        key: removeKey,
      });
      // A role-change failure for the same member uses error-set, never
      // row-action-failed, so it cannot touch the removal's busy key.
      state = teamRowActionsReducer(state, {
        type: "error-set",
        error: "Couldn't update role. Please try again.",
      });
      expect(state.busy[removeKey]).toBe(true);
    });
  });

  it("succeeding a row action closes the confirm dialog and clears its busy flag", () => {
    const key = memberRemoveKey(memberA.id);
    let state: TeamRowActionsState = {
      ...initialTeamRowActionsState,
      confirmTarget: { kind: "removeMember", member: memberA },
      busy: { [key]: true },
    };
    state = teamRowActionsReducer(state, {
      type: "row-action-succeeded",
      key,
    });
    expect(state.confirmTarget).toBeNull();
    expect(state.busy[key]).toBeUndefined();
  });

  it("failing a row action keeps the confirm dialog open with the error surfaced", () => {
    const key = invitationRevokeKey(invitationA.id);
    let state: TeamRowActionsState = {
      ...initialTeamRowActionsState,
      confirmTarget: { kind: "revokeInvitation", invitation: invitationA },
      busy: { [key]: true },
    };
    state = teamRowActionsReducer(state, {
      type: "row-action-failed",
      key,
      error: "Invitation could not be revoked.",
    });
    expect(state.confirmTarget).toEqual({
      kind: "revokeInvitation",
      invitation: invitationA,
    });
    expect(state.busy[key]).toBeUndefined();
    expect(state.error).toBe("Invitation could not be revoked.");
  });

  it("tracks the most recently copied invitation and clears it on flash-expiry", () => {
    let state = teamRowActionsReducer(initialTeamRowActionsState, {
      type: "invitation-link-copied",
      invitationId: invitationA.id,
    });
    expect(state.copiedInvitationId).toBe(invitationA.id);

    state = teamRowActionsReducer(state, {
      type: "invitation-copy-flash-expired",
      invitationId: invitationA.id,
    });
    expect(state.copiedInvitationId).toBeNull();
  });

  it("ignores a stale flash-expiry for a copy that has since been superseded", () => {
    let state = teamRowActionsReducer(initialTeamRowActionsState, {
      type: "invitation-link-copied",
      invitationId: "first",
    });
    state = teamRowActionsReducer(state, {
      type: "invitation-link-copied",
      invitationId: "second",
    });
    // The first copy's timer fires after the second copy has already
    // taken over the indicator — it must not clear the newer one.
    state = teamRowActionsReducer(state, {
      type: "invitation-copy-flash-expired",
      invitationId: "first",
    });
    expect(state.copiedInvitationId).toBe("second");
  });
});

describe("isConfirmTargetBusy", () => {
  it("is false when no confirmation is open", () => {
    expect(isConfirmTargetBusy(initialTeamRowActionsState)).toBe(false);
  });

  it("reads the busy flag for the open member-removal confirmation only", () => {
    const key = memberRemoveKey(memberA.id);
    const state: TeamRowActionsState = {
      ...initialTeamRowActionsState,
      confirmTarget: { kind: "removeMember", member: memberA },
      busy: { [key]: true, [memberRemoveKey(memberB.id)]: true },
    };
    expect(isConfirmTargetBusy(state)).toBe(true);
  });

  it("reads the busy flag for the open invitation-revocation confirmation only", () => {
    const state: TeamRowActionsState = {
      ...initialTeamRowActionsState,
      confirmTarget: { kind: "revokeInvitation", invitation: invitationA },
      busy: {},
    };
    expect(isConfirmTargetBusy(state)).toBe(false);
  });
});
