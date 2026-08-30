import type { MemberRole } from "@/lib/team/member-identities";

export type Member = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: MemberRole;
  created_at: string;
};

export type Invitation = {
  id: string;
  token?: string;
  role: MemberRole;
  email: string | null;
  expires_at: string;
  created_at: string;
};

/**
 * Row-scoped busy keys. Namespaced per action kind (not just per member/
 * invitation id) so a role-change error for a member can never collide
 * with — and incorrectly clear — a removal that happens to be in flight
 * for that same member.
 */
export function memberRemoveKey(memberId: string): string {
  return `member:${memberId}:remove`;
}
export function invitationRevokeKey(invitationId: string): string {
  return `invitation:${invitationId}:revoke`;
}

export type TeamConfirmTarget =
  | { kind: "removeMember"; member: Member }
  | { kind: "revokeInvitation"; invitation: Invitation };

export type TeamRowActionsState = {
  /** Keyed by memberRemoveKey/invitationRevokeKey — presence means busy. */
  busy: Record<string, true>;
  error: string | null;
  confirmTarget: TeamConfirmTarget | null;
  copiedInvitationId: string | null;
};

export const initialTeamRowActionsState: TeamRowActionsState = {
  busy: {},
  error: null,
  confirmTarget: null,
  copiedInvitationId: null,
};

export type TeamRowActionsAction =
  | { type: "member-removal-requested"; member: Member }
  | { type: "invitation-revocation-requested"; invitation: Invitation }
  | { type: "confirm-dismissed" }
  | { type: "error-cleared" }
  | { type: "error-set"; error: string }
  | { type: "row-action-started"; key: string }
  | { type: "row-action-failed"; key: string; error: string }
  | { type: "row-action-succeeded"; key: string }
  | { type: "invitation-link-copied"; invitationId: string }
  | { type: "invitation-copy-flash-expired"; invitationId: string };

function withoutBusyKey(
  busy: Record<string, true>,
  key: string,
): Record<string, true> {
  if (!(key in busy)) return busy;
  const next = { ...busy };
  delete next[key];
  return next;
}

export function teamRowActionsReducer(
  state: TeamRowActionsState,
  action: TeamRowActionsAction,
): TeamRowActionsState {
  switch (action.type) {
    case "member-removal-requested":
      return {
        ...state,
        error: null,
        confirmTarget: { kind: "removeMember", member: action.member },
      };
    case "invitation-revocation-requested":
      return {
        ...state,
        error: null,
        confirmTarget: { kind: "revokeInvitation", invitation: action.invitation },
      };
    case "confirm-dismissed":
      return { ...state, confirmTarget: null };
    case "error-cleared":
      return state.error === null ? state : { ...state, error: null };
    case "error-set":
      return { ...state, error: action.error };
    case "row-action-started":
      return {
        ...state,
        error: null,
        busy: { ...state.busy, [action.key]: true },
      };
    case "row-action-failed":
      return {
        ...state,
        busy: withoutBusyKey(state.busy, action.key),
        error: action.error,
      };
    case "row-action-succeeded":
      return {
        ...state,
        busy: withoutBusyKey(state.busy, action.key),
        confirmTarget: null,
      };
    case "invitation-link-copied":
      return { ...state, copiedInvitationId: action.invitationId };
    case "invitation-copy-flash-expired":
      return state.copiedInvitationId === action.invitationId
        ? { ...state, copiedInvitationId: null }
        : state;
  }
}

/** Whether the currently-open confirm dialog's action is in flight. */
export function isConfirmTargetBusy(state: TeamRowActionsState): boolean {
  const target = state.confirmTarget;
  if (!target) return false;
  const key =
    target.kind === "removeMember"
      ? memberRemoveKey(target.member.id)
      : invitationRevokeKey(target.invitation.id);
  return Boolean(state.busy[key]);
}
