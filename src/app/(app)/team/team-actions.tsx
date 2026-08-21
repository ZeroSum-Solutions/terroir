"use client";

import { useRef, useState } from "react";
import { Check, Copy, Link2, Loader2, RefreshCw, Trash2, Users, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { RouteDataEmpty } from "@/components/route-data-state";
import { ActionDialog } from "@/components/action-dialog";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import {
  ROLE_DESCRIPTIONS,
  type MemberRole,
} from "@/lib/team/member-identities";
import { TimeAgo } from "@/components/time-ago";

type Member = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: MemberRole;
  created_at: string;
};

type Invitation = {
  id: string;
  token?: string;
  role: MemberRole;
  email: string | null;
  expires_at: string;
  created_at: string;
};

export function TeamActions({
  members,
  invitations,
  currentUserId,
  restaurantName: _restaurantName,
  canInvite,
}: {
  members: Member[];
  invitations: Invitation[];
  currentUserId: string;
  restaurantName: string;
  canInvite: boolean;
}) {
  const router = useRouter();
  const [showInvite, setShowInvite] = useState(false);
  const [inviteRole, setInviteRole] = useState<"manager" | "staff">("staff");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Per-card "copied" indicator for Pending invitations —
  // tracks the invitation id whose link was most recently copied so we
  // can flash a confirmation on that row only.
  const [copiedInvitationId, setCopiedInvitationId] = useState<string | null>(
    null,
  );
  // Surface server errors from role-change / member-removal so the
  // owner sees why an action didn't take effect (e.g. "Cannot demote
  // the last owner.", "Cannot remove yourself.").
  const [memberActionError, setMemberActionError] = useState<string | null>(
    null,
  );
  const [memberActionBusy, setMemberActionBusy] = useState(false);
  const [pendingMemberRemoval, setPendingMemberRemoval] = useState<Member | null>(
    null,
  );
  const [pendingInvitationRevocation, setPendingInvitationRevocation] =
    useState<Invitation | null>(null);

  const isOwner = members.some(
    (m) => m.user_id === currentUserId && m.role === "owner",
  );

  const openInvite = () => {
    setShowInvite(true);
    setInviteUrl("");
    setInviteEmail("");
    setInviteError(null);
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
    setCopiedInvitationId(invitation.id);
    setTimeout(
      () =>
        setCopiedInvitationId((current) =>
          current === invitation.id ? null : current,
        ),
      2000,
    );
  };

  const extractServerError = async (
    res: Response,
    fallback: string,
  ): Promise<string> => {
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) {
        return body.error;
      }
    } catch {
      // non-JSON body — fall through to fallback
    }
    return fallback;
  };

  const changeRole = async (memberId: string, role: string) => {
    setMemberActionError(null);
    const res = await fetch(`/api/team/members/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      setMemberActionError(
        await extractServerError(res, "Couldn't update role. Please try again."),
      );
      return;
    }
    router.refresh();
  };

  const removeMember = async (memberId: string) => {
    setMemberActionError(null);
    setMemberActionBusy(true);
    try {
      const res = await fetch(`/api/team/members/${memberId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setMemberActionError(
          await extractServerError(res, "Couldn't remove member. Please try again."),
        );
        return;
      }
      setPendingMemberRemoval(null);
      router.refresh();
    } catch {
      setMemberActionError(
        "Couldn't remove member. Please try again.",
      );
    } finally {
      setMemberActionBusy(false);
    }
  };

  const revokeInvitation = async (invitationId: string) => {
    setMemberActionError(null);
    setMemberActionBusy(true);
    try {
      const res = await fetch(`/api/team/invite/${invitationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setMemberActionError(
          await extractServerError(
            res,
            "Couldn't revoke invitation. Please try again.",
          ),
        );
        return;
      }
      setPendingInvitationRevocation(null);
      router.refresh();
    } catch {
      setMemberActionError(
        "Couldn't revoke invitation. Please try again.",
      );
    } finally {
      setMemberActionBusy(false);
    }
  };

  const resendInvitation = async (invitationId: string) => {
    setMemberActionError(null);
    const res = await fetch(`/api/team/invite/${invitationId}/resend`, {
      method: "POST",
    });
    if (!res.ok) {
      setMemberActionError(
        await extractServerError(
          res,
          "Couldn't resend invitation. Please try again.",
        ),
      );
      return;
    }
    router.refresh();
  };

  return (
    <>
      <section className="mb-xl" aria-labelledby="members-heading">
        <div
          data-testid="team-toolbar"
          className="mb-md flex flex-wrap items-center justify-between gap-sm"
        >
          <h2 id="members-heading" className="text-[15px] font-semibold text-ink">
            Members ({members.length})
          </h2>
          {canInvite && members.length > 0 && (
            <button
              type="button"
              onClick={openInvite}
              className="flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover"
            >
              <Link2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Create invite link
            </button>
          )}
        </div>

        {memberActionError &&
          pendingMemberRemoval === null &&
          pendingInvitationRevocation === null && (
          <div
            role="alert"
            className="mb-sm flex items-start justify-between gap-sm rounded-md border border-primary/30 bg-blush-wash px-sm py-xs text-[13px] text-primary"
          >
            <span>{memberActionError}</span>
            <button
              type="button"
              onClick={() => setMemberActionError(null)}
              aria-label="Dismiss error"
              className="-mr-2xs flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-primary/70 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          </div>
        )}

        {members.length === 0 ? (
          <RouteDataEmpty
            icon={<Users className="h-6 w-6" strokeWidth={1.5} />}
            title="No team members yet"
            description="Invite a teammate to start building your roster."
            action={
              canInvite ? (
                <button
                  type="button"
                  onClick={openInvite}
                  className="inline-flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover"
                >
                  <Link2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  Create invite link
                </button>
              ) : undefined
            }
          />
        ) : (
          <ul className="grid gap-sm">
            {members.map((member) => {
              const isCurrentUser = member.user_id === currentUserId;
              return (
                <li
                  key={member.id}
                  className="grid min-w-0 gap-md rounded-card border border-hairline bg-canvas p-md sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium text-ink">
                      {member.name}{" "}
                      {isCurrentUser && (
                        <span className="text-grey">(You)</span>
                      )}
                    </p>
                    <p className="mt-2xs break-all text-[13px] text-grey">
                      {member.email}
                    </p>
                    <p className="mt-xs text-[13px] leading-relaxed text-ink-soft">
                      {ROLE_DESCRIPTIONS[member.role]}
                    </p>
                    <p className="mt-xs font-mono text-[11px] text-grey">
                      Joined <TimeAgo iso={member.created_at} />
                    </p>
                  </div>

                  <div className="flex min-w-0 flex-wrap items-center gap-xs sm:justify-end">
                    {isOwner && !isCurrentUser ? (
                      <select
                        aria-label={`Change role for ${member.name}`}
                        value={member.role}
                        onChange={(e) => changeRole(member.id, e.target.value)}
                        className="min-h-11 rounded-pill border border-hairline bg-white px-sm text-[13px] text-ink"
                      >
                        <option value="owner">Owner</option>
                        <option value="manager">Manager</option>
                        <option value="staff">Staff</option>
                      </select>
                    ) : (
                      <span className="inline-flex min-h-11 items-center rounded-pill bg-beige px-sm text-[11px] font-medium capitalize text-ink-soft">
                        {member.role}
                      </span>
                    )}
                    {isOwner && !isCurrentUser && (
                      <button
                        type="button"
                        aria-label={`Remove ${member.name}`}
                        onClick={() => {
                          setMemberActionError(null);
                          setPendingMemberRemoval(member);
                        }}
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-grey hover:bg-bridge-surface hover:text-primary"
                      >
                        <Trash2
                          className="h-3.5 w-3.5"
                          strokeWidth={2}
                          aria-hidden
                        />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {invitations.length > 0 && (
        <section className="mb-xl" aria-labelledby="pending-heading">
          <h2
            id="pending-heading"
            className="mb-md text-[15px] font-semibold text-grey"
          >
            Pending ({invitations.length})
          </h2>
          <ul className="grid gap-sm">
            {invitations.map((inv) => {
              const justCopied = copiedInvitationId === inv.id;
              const expiry = describeExpiry(inv.expires_at);
              const identity = inv.email ?? "Email unavailable";
              return (
                <li
                  key={inv.id}
                  className={`grid min-w-0 gap-md rounded-card border border-hairline bg-canvas p-md sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${expiry.status === "expired" ? "opacity-60" : ""}`}
                >
                  <div className="min-w-0">
                    <p className="break-all font-medium text-ink">{identity}</p>
                    <p className="mt-xs text-[13px] capitalize text-ink-soft">
                      {inv.role}
                    </p>
                    <p className="mt-2xs text-[13px] leading-relaxed text-ink-soft">
                      {ROLE_DESCRIPTIONS[inv.role]}
                    </p>
                    <div className="mt-xs flex flex-wrap items-center gap-xs text-[11px] text-grey">
                      <span className="font-mono">
                        Created <TimeAgo iso={inv.created_at} />
                      </span>
                      <span aria-hidden>·</span>
                      <span
                        className={
                          expiry.status === "expired"
                            ? "font-medium text-primary"
                            : expiry.status === "soon"
                              ? "font-medium text-amber"
                              : "font-mono"
                        }
                        title={new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(inv.expires_at))}
                      >
                        {expiry.status === "expired"
                          ? "Expired"
                          : expiry.status === "soon"
                            ? `Expires soon ${expiry.label}`
                            : `Expires ${expiry.label}`}
                      </span>
                    </div>
                  </div>

                  {isOwner && (
                    <div className="flex min-w-0 flex-wrap items-center gap-xs sm:justify-end">
                      {inv.token && (
                        <button
                          type="button"
                          onClick={() => copyInvitationLink(inv)}
                          aria-label={`Copy invite link for ${identity}`}
                          className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-beige-deep bg-white px-sm text-[12px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blush-wash"
                        >
                          {justCopied ? (
                            <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                          ) : (
                            <Copy className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                          )}
                          {justCopied ? "Copied" : "Copy link"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => resendInvitation(inv.id)}
                        aria-label={`Resend invitation for ${identity}`}
                        className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-beige-deep bg-white px-sm text-[12px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blush-wash"
                      >
                        <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                        Resend
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMemberActionError(null);
                          setPendingInvitationRevocation(inv);
                        }}
                        aria-label={`Revoke invitation for ${identity}`}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill border border-beige-deep bg-white text-grey hover:bg-blush-wash hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Invite modal */}
      {showInvite && (
        <InviteModal
          inviteEmail={inviteEmail}
          setInviteEmail={(e) => {
            setInviteEmail(e);
            if (inviteError) setInviteError(null);
          }}
          inviteRole={inviteRole}
          setInviteRole={(r) => {
            setInviteRole(r);
            if (inviteError) setInviteError(null);
          }}
          inviteUrl={inviteUrl}
          creating={creating}
          error={inviteError}
          copied={copied}
          onClose={() => {
            setShowInvite(false);
            setInviteError(null);
            setInviteEmail("");
          }}
          onCreate={createInvite}
          onCopy={copyLink}
        />
      )}

      <ActionDialog
        open={pendingMemberRemoval !== null}
        title="Remove member"
        description={`${pendingMemberRemoval?.name ?? "This member"} will lose access to this restaurant.`}
        confirmLabel="Remove member"
        busy={memberActionBusy}
        onClose={() => setPendingMemberRemoval(null)}
        onConfirm={() => {
          if (pendingMemberRemoval) void removeMember(pendingMemberRemoval.id);
        }}
      >
        {memberActionError && (
          <p
            role="alert"
            className="rounded-md border border-primary/30 bg-blush-wash px-sm py-xs text-[13px] text-primary"
          >
            {memberActionError}
          </p>
        )}
      </ActionDialog>

      <ActionDialog
        open={pendingInvitationRevocation !== null}
        title="Revoke invitation"
        description={`Revoke invitation for ${pendingInvitationRevocation?.email ?? "this address"}? The link will stop working immediately.`}
        confirmLabel="Revoke invitation"
        busy={memberActionBusy}
        onClose={() => setPendingInvitationRevocation(null)}
        onConfirm={() => {
          if (pendingInvitationRevocation) {
            void revokeInvitation(pendingInvitationRevocation.id);
          }
        }}
      >
        {memberActionError && (
          <p
            role="alert"
            className="rounded-md border border-primary/30 bg-blush-wash px-sm py-xs text-[13px] text-primary"
          >
            {memberActionError}
          </p>
        )}
      </ActionDialog>
    </>
  );
}

function InviteModal({
  inviteEmail,
  setInviteEmail,
  inviteRole,
  setInviteRole,
  inviteUrl,
  creating,
  error,
  copied,
  onClose,
  onCreate,
  onCopy,
}: {
  inviteEmail: string;
  setInviteEmail: (e: string) => void;
  inviteRole: "manager" | "staff";
  setInviteRole: (r: "manager" | "staff") => void;
  inviteUrl: string;
  creating: boolean;
  error: string | null;
  copied: boolean;
  onClose: () => void;
  onCreate: () => void;
  onCopy: () => void;
}) {
  const trapRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef: trapRef, onEscape: onClose });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="glass mx-md w-full max-w-[420px] rounded-lg p-lg"
      >
        <h3
          id="invite-modal-title"
          className="text-[18px] font-serif font-medium text-ink"
        >
          Invite team member
        </h3>
        <p className="mt-xs text-[13px] text-grey">
          Create a shareable link. Anyone with the link can join your
          restaurant as the selected role.
        </p>

        {!inviteUrl ? (
          <>
            <div className="mt-lg">
              <label
                htmlFor="invite-email"
                className="block text-caption font-medium uppercase text-grey"
              >
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                placeholder="teammate@restaurant.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !creating) {
                    e.preventDefault();
                    onCreate();
                  }
                }}
                className="mt-xs min-h-11 w-full rounded-pill border border-hairline bg-white px-md text-[14px] text-ink"
              />
              <p className="mt-xs text-[12px] text-grey">
                The link will only work for this address.
              </p>
            </div>

            <div className="mt-md">
              <label
                htmlFor="invite-role"
                className="block text-caption font-medium uppercase text-grey"
              >
                Role
              </label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(e.target.value as "manager" | "staff")
                }
                className="mt-xs min-h-11 w-full rounded-pill border border-hairline bg-white px-md text-[14px] text-ink"
              >
                <option value="manager">Manager</option>
                <option value="staff">Staff</option>
              </select>
              <p className="mt-xs text-[12px] text-grey">
                {ROLE_DESCRIPTIONS[inviteRole]}
              </p>
            </div>

            {error && (
              <p
                role="alert"
                className="mt-md rounded-md border border-primary/30 bg-blush-wash px-sm py-xs text-[13px] text-primary"
              >
                {error}
              </p>
            )}

            <div className="mt-lg flex justify-end gap-sm">
              <button
                type="button"
                onClick={onClose}
                className="flex min-h-11 items-center rounded-pill border border-beige-deep bg-white px-md text-[14px] font-medium text-ink hover:bg-bridge-surface"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onCreate}
                disabled={creating || inviteEmail.trim().length === 0}
                className="flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[14px] font-medium text-white hover:bg-primary-hover disabled:opacity-60"
              >
                {creating && (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    strokeWidth={2}
                  />
                )}
                Generate link
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-lg rounded-md border border-hairline bg-bridge-surface p-md">
              <p className="break-all font-mono text-[12px] text-ink">
                {inviteUrl}
              </p>
            </div>
            <div className="mt-md flex justify-end gap-sm">
              <button
                type="button"
                onClick={onClose}
                className="flex min-h-11 items-center rounded-pill border border-beige-deep bg-white px-md text-[14px] font-medium text-ink hover:bg-bridge-surface"
              >
                Done
              </button>
              <button
                type="button"
                onClick={onCopy}
                className="flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[14px] font-medium text-white hover:bg-primary-hover"
              >
                {copied ? (
                  <Check className="h-4 w-4" strokeWidth={2} />
                ) : (
                  <Copy className="h-4 w-4" strokeWidth={2} />
                )}
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Describe an invitation's expiry as a status + short relative label.
 * - expired: expires_at is in the past
 * - soon:    expires within the next 48 hours
 * - ok:      everything else
 * Used to label Pending invitation cards so operators can
 * see at a glance which links are still usable.
 */
function describeExpiry(
  expiresAt: string,
): { status: "expired" | "soon" | "ok"; label: string } {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { status: "expired", label: "Expired" };

  const mins = Math.round(ms / 60000);
  const hours = Math.round(mins / 60);
  const days = Math.round(hours / 24);

  let label: string;
  if (mins < 60) label = `in ${Math.max(mins, 1)}m`;
  else if (hours < 24) label = `in ${hours}h`;
  else label = `in ${days}d`;

  const status = ms < 48 * 60 * 60 * 1000 ? "soon" : "ok";
  return { status, label };
}
