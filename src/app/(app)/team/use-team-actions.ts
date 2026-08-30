"use client";

import { useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import {
  initialTeamRowActionsState,
  invitationRevokeKey,
  isConfirmTargetBusy,
  memberRemoveKey,
  teamRowActionsReducer,
  type Invitation,
  type Member,
} from "./team-row-actions";

async function extractServerError(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // non-JSON body — fall through to fallback
  }
  return fallback;
}

/**
 * All state and handlers behind the Team page's members/invitations panel:
 * the invite-link creation modal, plus role-change/removal/revocation/resend/
 * copy actions on individual member and invitation rows. Row-level busy/error
 * state is a reducer keyed by row+action (see team-row-actions.ts) so two
 * rows acting concurrently can't clobber each other's status.
 */
export function useTeamActions() {
  const router = useRouter();

  const [showInvite, setShowInvite] = useState(false);
  const [inviteRole, setInviteRole] = useState<"manager" | "staff">("staff");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [state, dispatch] = useReducer(
    teamRowActionsReducer,
    initialTeamRowActionsState,
  );

  const openInvite = () => {
    setShowInvite(true);
    setInviteUrl("");
    setInviteEmail("");
    setInviteError(null);
  };

  const closeInvite = () => {
    setShowInvite(false);
    setInviteError(null);
    setInviteEmail("");
  };

  const changeInviteEmail = (email: string) => {
    setInviteEmail(email);
    if (inviteError) setInviteError(null);
  };

  const changeInviteRole = (role: "manager" | "staff") => {
    setInviteRole(role);
    if (inviteError) setInviteError(null);
  };

  const createInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) {
      setInviteError("Enter the invitee's email address.");
      return;
    }
    setCreating(true);
    setInviteError(null);
    try {
      const res = await fetch("/api/team/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      if (!res.ok) {
        let serverMessage: string | undefined;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") serverMessage = body.error;
        } catch {
          // non-JSON body — fall through to status-based message
        }
        throw new Error(
          res.status === 403
            ? "Only owners can create invite links."
            : serverMessage ?? "Failed to create invite",
        );
      }
      const invite = await res.json();
      setInviteUrl(invite.inviteUrl);
      router.refresh();
    } catch (err) {
      setInviteError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't create invite link. Please try again.",
      );
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyInvitationLink = async (invitation: Invitation) => {
    if (!invitation.token) return;
    const url = `${window.location.origin}/invite/${invitation.token}`;
    await navigator.clipboard.writeText(url);
    dispatch({ type: "invitation-link-copied", invitationId: invitation.id });
    setTimeout(
      () =>
        dispatch({
          type: "invitation-copy-flash-expired",
          invitationId: invitation.id,
        }),
      2000,
    );
  };

  const changeRole = async (memberId: string, role: string) => {
    dispatch({ type: "error-cleared" });
    const res = await fetch(`/api/team/members/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      dispatch({
        type: "error-set",
        error: await extractServerError(
          res,
          "Couldn't update role. Please try again.",
        ),
      });
      return;
    }
    router.refresh();
  };

  const removeMember = async (memberId: string) => {
    const key = memberRemoveKey(memberId);
    dispatch({ type: "row-action-started", key });
    try {
      const res = await fetch(`/api/team/members/${memberId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        dispatch({
          type: "row-action-failed",
          key,
          error: await extractServerError(
            res,
            "Couldn't remove member. Please try again.",
          ),
        });
        return;
      }
      dispatch({ type: "row-action-succeeded", key });
      router.refresh();
    } catch {
      dispatch({
        type: "row-action-failed",
        key,
        error: "Couldn't remove member. Please try again.",
      });
    }
  };

  const revokeInvitation = async (invitationId: string) => {
    const key = invitationRevokeKey(invitationId);
    dispatch({ type: "row-action-started", key });
    try {
      const res = await fetch(`/api/team/invite/${invitationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        dispatch({
          type: "row-action-failed",
          key,
          error: await extractServerError(
            res,
            "Couldn't revoke invitation. Please try again.",
          ),
        });
        return;
      }
      dispatch({ type: "row-action-succeeded", key });
      router.refresh();
    } catch {
      dispatch({
        type: "row-action-failed",
        key,
        error: "Couldn't revoke invitation. Please try again.",
      });
    }
  };

  const resendInvitation = async (invitationId: string) => {
    dispatch({ type: "error-cleared" });
    const res = await fetch(`/api/team/invite/${invitationId}/resend`, {
      method: "POST",
    });
    if (!res.ok) {
      dispatch({
        type: "error-set",
        error: await extractServerError(
          res,
          "Couldn't resend invitation. Please try again.",
        ),
      });
      return;
    }
    router.refresh();
  };

  const requestMemberRemoval = (member: Member) =>
    dispatch({ type: "member-removal-requested", member });

  const requestInvitationRevocation = (invitation: Invitation) =>
    dispatch({ type: "invitation-revocation-requested", invitation });

  const dismissConfirm = () => dispatch({ type: "confirm-dismissed" });
  const dismissError = () => dispatch({ type: "error-cleared" });

  return {
    // Invite-link modal
    showInvite,
    inviteRole,
    inviteEmail,
    inviteUrl,
    creating,
    inviteError,
    copied,
    openInvite,
    closeInvite,
    changeInviteEmail,
    changeInviteRole,
    createInvite,
    copyLink,

    // Row actions
    error: state.error,
    confirmTarget: state.confirmTarget,
    copiedInvitationId: state.copiedInvitationId,
    isConfirmBusy: isConfirmTargetBusy(state),
    changeRole,
    removeMember,
    revokeInvitation,
    resendInvitation,
    copyInvitationLink,
    requestMemberRemoval,
    requestInvitationRevocation,
    dismissConfirm,
    dismissError,
  };
}
