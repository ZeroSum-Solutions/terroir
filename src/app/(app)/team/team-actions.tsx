"use client";

import { Check, Copy, Link2, RefreshCw, Trash2, Users, X } from "lucide-react";
import { RouteDataEmpty } from "@/components/route-data-state";
import { ActionDialog } from "@/components/action-dialog";
import { IconButton } from "@/components/icon-button";
import { ROLE_DESCRIPTIONS } from "@/lib/team/member-identities";
import { TimeAgo } from "@/components/time-ago";
import { InviteModal } from "./invite-modal";
import { useTeamActions } from "./use-team-actions";
import type { Invitation, Member } from "./team-row-actions";

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
  const actions = useTeamActions();
  const { confirmTarget } = actions;

  const isOwner = members.some(
    (m) => m.user_id === currentUserId && m.role === "owner",
  );

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
              onClick={actions.openInvite}
              className="flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
            >
              <Link2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Create invite link
            </button>
          )}
        </div>

        {actions.error && confirmTarget === null && (
          <div
            role="alert"
            className="mb-sm flex items-start justify-between gap-sm rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"
          >
            <span>{actions.error}</span>
            <IconButton
              label="Dismiss error"
              onClick={actions.dismissError}
              className="shrink-0 rounded-md text-risk-ink/70 hover:bg-risk-wash hover:text-risk-ink focus-ring"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            </IconButton>
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
                  onClick={actions.openInvite}
                  className="inline-flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
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
                  className="grid min-w-0 gap-md rounded-card card-surface p-md sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
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
                        onChange={(e) => actions.changeRole(member.id, e.target.value)}
                        className="min-h-11 rounded-pill border border-rule bg-surface px-sm text-[13px] text-ink focus-ring"
                      >
                        <option value="owner">Owner</option>
                        <option value="manager">Manager</option>
                        <option value="staff">Staff</option>
                      </select>
                    ) : (
                      <span className="inline-flex min-h-11 items-center rounded-pill bg-surface-sunken px-sm text-[11px] font-medium capitalize text-ink-soft">
                        {member.role}
                      </span>
                    )}
                    {isOwner && !isCurrentUser && (
                      <IconButton
                        label={`Remove ${member.name}`}
                        onClick={() => actions.requestMemberRemoval(member)}
                        className="rounded-md text-grey hover:bg-risk-wash hover:text-risk-ink focus-ring"
                      >
                        <Trash2
                          className="h-3.5 w-3.5"
                          strokeWidth={1.75}
                          aria-hidden
                        />
                      </IconButton>
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
              const justCopied = actions.copiedInvitationId === inv.id;
              const expiry = describeExpiry(inv.expires_at);
              const identity = inv.email ?? "Email unavailable";
              return (
                <li
                  key={inv.id}
                  className={`grid min-w-0 gap-md rounded-card card-surface p-md sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${expiry.status === "expired" ? "opacity-60" : ""}`}
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
                            ? "font-medium text-risk-ink"
                            : expiry.status === "soon"
                              ? "font-medium text-risk-ink"
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
                          onClick={() => actions.copyInvitationLink(inv)}
                          aria-label={`Copy invite link for ${identity}`}
                          className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-rule-strong bg-surface px-sm text-[12px] font-medium text-ink hover:bg-wash focus-ring"
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
                        onClick={() => actions.resendInvitation(inv.id)}
                        aria-label={`Resend invitation for ${identity}`}
                        className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-rule-strong bg-surface px-sm text-[12px] font-medium text-ink hover:bg-wash focus-ring"
                      >
                        <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                        Resend
                      </button>
                      <IconButton
                        label={`Revoke invitation for ${identity}`}
                        onClick={() => actions.requestInvitationRevocation(inv)}
                        className="rounded-pill border border-rule-strong bg-surface text-grey hover:bg-risk-wash hover:text-risk-ink focus-ring"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                      </IconButton>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Invite modal */}
      {actions.showInvite && (
        <InviteModal
          inviteEmail={actions.inviteEmail}
          setInviteEmail={actions.changeInviteEmail}
          inviteRole={actions.inviteRole}
          setInviteRole={actions.changeInviteRole}
          inviteUrl={actions.inviteUrl}
          creating={actions.creating}
          error={actions.inviteError}
          copied={actions.copied}
          onClose={actions.closeInvite}
          onCreate={actions.createInvite}
          onCopy={actions.copyLink}
        />
      )}

      <ActionDialog
        open={confirmTarget?.kind === "removeMember"}
        title="Remove member"
        description={`${confirmTarget?.kind === "removeMember" ? confirmTarget.member.name : "This member"} will lose access to this restaurant.`}
        confirmLabel="Remove member"
        busy={actions.isConfirmBusy}
        onClose={actions.dismissConfirm}
        onConfirm={() => {
          if (confirmTarget?.kind === "removeMember") {
            void actions.removeMember(confirmTarget.member.id);
          }
        }}
      >
        {actions.error && (
          <p
            role="alert"
            className="rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"
          >
            {actions.error}
          </p>
        )}
      </ActionDialog>

      <ActionDialog
        open={confirmTarget?.kind === "revokeInvitation"}
        title="Revoke invitation"
        description={`Revoke invitation for ${confirmTarget?.kind === "revokeInvitation" ? confirmTarget.invitation.email ?? "this address" : "this address"}? The link will stop working immediately.`}
        confirmLabel="Revoke invitation"
        busy={actions.isConfirmBusy}
        onClose={actions.dismissConfirm}
        onConfirm={() => {
          if (confirmTarget?.kind === "revokeInvitation") {
            void actions.revokeInvitation(confirmTarget.invitation.id);
          }
        }}
      >
        {actions.error && (
          <p
            role="alert"
            className="rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"
          >
            {actions.error}
          </p>
        )}
      </ActionDialog>
    </>
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
