"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { TimeAgo } from "@/components/time-ago";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
  IdempotentCommandBusyError,
  readApiErrorCode,
  shouldRetainIdempotencyKey,
} from "@/lib/api/idempotency-client";

const teamMemberCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence("terroir:team-members"),
});

type Member = {
  id: string;
  user_id: string;
  role: "owner" | "manager" | "staff";
  created_at: string;
};

type Invitation = {
  id: string;
  token: string;
  role: "owner" | "manager" | "staff";
  email: string | null;
  expires_at: string;
  created_at: string;
};

type InviteResponse = Invitation & { inviteUrl: string };

type PendingInviteReconciliation =
  | {
      kind: "create";
      email: string;
      role: "manager" | "staff";
      existingIds: readonly string[];
      startedAt: number;
    }
  | {
      kind: "revoke";
      invitationId: string;
    }
  | {
      kind: "resend";
      invitationId: string;
    };

const teamInviteCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence("terroir:team-invites"),
});

function reconciliationKey(
  reconciliation: PendingInviteReconciliation,
): string {
  return reconciliation.kind === "create"
    ? "create"
    : `${reconciliation.kind}:${reconciliation.invitationId}`;
}

function currentTimeMs(): number {
  return Date.now();
}

export function TeamActions({
  members,
  invitations,
  currentUserId,
  restaurantName: _restaurantName,
}: {
  members: Member[];
  invitations: Invitation[];
  currentUserId: string;
  restaurantName: string;
}) {
  const router = useRouter();
  const [showInvite, setShowInvite] = useState(false);
  const [inviteRole, setInviteRole] = useState<"manager" | "staff">("staff");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyInvitationIds, setBusyInvitationIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const createBusyRef = useRef(false);
  const busyInvitationIdsRef = useRef<ReadonlySet<string>>(new Set());
  const pendingReconciliationsRef =
    useRef<readonly PendingInviteReconciliation[]>([]);
  // Per-row "copied" indicator for the Pending invitations table —
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
  const [busyMemberIds, setBusyMemberIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const busyMemberIdsRef = useRef(new Set<string>());

  const isOwner = members.some(
    (m) => m.user_id === currentUserId && m.role === "owner",
  );

  useEffect(() => {
    const resolved: PendingInviteReconciliation[] = [];
    let recoveredCreateUrl: string | null = null;

    for (const pending of pendingReconciliationsRef.current) {
      if (pending.kind === "revoke") {
        if (!invitations.some(({ id }) => id === pending.invitationId)) {
          resolved.push(pending);
        }
        continue;
      }
      if (pending.kind === "resend") {
        // The refresh itself reconciles the pending-invitation table. A
        // resend row has no durable link back to its source invitation, so
        // do not guess that an unrelated matching row proves success or
        // abandon the retained retry key.
        resolved.push(pending);
        continue;
      }

      const existingIds = new Set(pending.existingIds);
      const candidates = invitations.filter(
        (invitation) =>
          !existingIds.has(invitation.id) &&
          invitation.email === pending.email &&
          invitation.role === pending.role &&
          new Date(invitation.created_at).getTime() >=
            pending.startedAt - 30_000,
      );
      if (candidates.length === 1) {
        const [reconciled] = candidates;
        resolved.push(pending);
        recoveredCreateUrl = `${window.location.origin}/invite/${reconciled.token}`;
      }
    }

    if (resolved.length === 0) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      let createRecoveryBusy = false;
      if (recoveredCreateUrl) {
        try {
          teamInviteCommands.abandon("create");
        } catch (error) {
          if (error instanceof IdempotentCommandBusyError) {
            createRecoveryBusy = true;
          } else {
            throw error;
          }
        }
      }
      pendingReconciliationsRef.current =
        pendingReconciliationsRef.current.filter(
          (pending) =>
            !resolved.includes(pending) ||
            (createRecoveryBusy && pending.kind === "create"),
        );
      if (recoveredCreateUrl) {
        setInviteUrl(recoveredCreateUrl);
        setInviteError(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [invitations]);

  const trackPendingReconciliation = (
    reconciliation: PendingInviteReconciliation,
  ) => {
    const key = reconciliationKey(reconciliation);
    pendingReconciliationsRef.current = [
      ...pendingReconciliationsRef.current.filter(
        (pending) => reconciliationKey(pending) !== key,
      ),
      reconciliation,
    ];
  };

  const clearPendingReconciliation = (
    reconciliation: PendingInviteReconciliation,
  ) => {
    const key = reconciliationKey(reconciliation);
    pendingReconciliationsRef.current =
      pendingReconciliationsRef.current.filter(
        (pending) => reconciliationKey(pending) !== key,
      );
  };

  const createInvite = async () => {
    if (createBusyRef.current) return;
    const email = inviteEmail.trim().toLowerCase();
    if (!email) {
      setInviteError("Enter the invitee's email address.");
      return;
    }
    createBusyRef.current = true;
    setCreating(true);
    setInviteError(null);
    const reconciliation: PendingInviteReconciliation = {
      kind: "create",
      email,
      role: inviteRole,
      existingIds: invitations.map(({ id }) => id),
      startedAt: currentTimeMs(),
    };
    try {
      const { response, data } =
        await teamInviteCommands.json<InviteResponse>({
          slot: "create",
          url: "/api/team/invite",
          method: "POST",
          json: { email, role: inviteRole },
        });
      if (!response.ok) {
        if (
          shouldRetainIdempotencyKey(
            response.status,
            readApiErrorCode(data),
          )
        ) {
          trackPendingReconciliation(reconciliation);
          router.refresh();
        } else {
          clearPendingReconciliation(reconciliation);
        }
        const serverMessage = readApiError(
          data,
          "Failed to create invite",
        ).message;
        setInviteError(serverMessage);
        return;
      }
      clearPendingReconciliation(reconciliation);
      setInviteUrl(data.inviteUrl);
      router.refresh();
    } catch {
      trackPendingReconciliation(reconciliation);
      router.refresh();
      setInviteError(
        "Invite outcome is unknown. Invitations were refreshed; retrying will use the same command.",
      );
    } finally {
      createBusyRef.current = false;
      setCreating(false);
    }
  };

  const beginInvitationAction = (invitationId: string): boolean => {
    if (busyInvitationIdsRef.current.has(invitationId)) return false;
    const next = new Set(busyInvitationIdsRef.current);
    next.add(invitationId);
    busyInvitationIdsRef.current = next;
    setBusyInvitationIds(next);
    return true;
  };

  const finishInvitationAction = (invitationId: string) => {
    const next = new Set(busyInvitationIdsRef.current);
    next.delete(invitationId);
    busyInvitationIdsRef.current = next;
    setBusyInvitationIds(next);
  };

  const reconcileResponse = (
    response: Response,
    data: unknown,
    reconciliation: PendingInviteReconciliation,
  ) => {
    const ambiguous = shouldRetainIdempotencyKey(
      response.status,
      readApiErrorCode(data),
    );
    if (ambiguous) {
      trackPendingReconciliation(reconciliation);
    } else {
      clearPendingReconciliation(reconciliation);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setInviteError(null);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setInviteError(
        "Couldn't copy the invite link. Select and copy it manually.",
      );
    }
  };

  const copyInvitationLink = async (invitation: Invitation) => {
    const url = `${window.location.origin}/invite/${invitation.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setMemberActionError(null);
      setCopiedInvitationId(invitation.id);
      setTimeout(
        () =>
          setCopiedInvitationId((current) =>
            current === invitation.id ? null : current,
          ),
        2000,
      );
    } catch {
      setMemberActionError(
        "Couldn't copy the invite link. Try again or open the link manually.",
      );
    }
  };

  const setMemberBusy = (memberId: string, busy: boolean) => {
    if (busy) {
      busyMemberIdsRef.current.add(memberId);
    } else {
      busyMemberIdsRef.current.delete(memberId);
    }
    setBusyMemberIds(new Set(busyMemberIdsRef.current));
  };

  const changeRole = async (
    memberId: string,
    role: Member["role"],
  ) => {
    if (busyMemberIdsRef.current.has(memberId)) return;
    setMemberBusy(memberId, true);
    setMemberActionError(null);
    try {
      const { response, data } = await teamMemberCommands.json<unknown>({
        slot: `team:member:role:${memberId}`,
        url: `/api/team/members/${memberId}`,
        method: "PATCH",
        json: { role },
      });
      if (!response.ok) {
        setMemberActionError(
          readApiError(
            data,
            "Couldn't update role. Please try again.",
          ).message,
        );
        router.refresh();
        return;
      }
      if (
        !data ||
        typeof data !== "object" ||
        (data as { success?: unknown }).success !== true
      ) {
        throw new Error("The member update response was invalid.");
      }
      router.refresh();
    } catch (error) {
      setMemberActionError(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't update role. Please try again.",
      );
      router.refresh();
    } finally {
      setMemberBusy(memberId, false);
    }
  };

  const removeMember = async (memberId: string) => {
    if (busyMemberIdsRef.current.has(memberId)) return;
    setMemberBusy(memberId, true);
    setMemberActionError(null);
    try {
      const { response, data } = await teamMemberCommands.json<unknown>({
        slot: `team:member:remove:${memberId}`,
        url: `/api/team/members/${memberId}`,
        method: "DELETE",
      });
      if (!response.ok) {
        setMemberActionError(
          readApiError(
            data,
            "Couldn't remove member. Please try again.",
          ).message,
        );
        router.refresh();
        return;
      }
      if (
        !data ||
        typeof data !== "object" ||
        (data as { success?: unknown }).success !== true
      ) {
        throw new Error("The member removal response was invalid.");
      }
      router.refresh();
    } catch (error) {
      setMemberActionError(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't remove member. Please try again.",
      );
      router.refresh();
    } finally {
      setMemberBusy(memberId, false);
    }
  };

  const revokeInvitation = async (invitationId: string) => {
    if (!beginInvitationAction(invitationId)) return;
    setMemberActionError(null);
    const reconciliation: PendingInviteReconciliation = {
      kind: "revoke",
      invitationId,
    };
    try {
      const { response, data } = await teamInviteCommands.json<unknown>({
        slot: `revoke:${invitationId}`,
        url: `/api/team/invite/${invitationId}`,
        method: "DELETE",
      });
      if (!response.ok) {
        reconcileResponse(response, data, reconciliation);
        setMemberActionError(
          readApiError(
            data,
            "Couldn't revoke invitation. Please try again.",
          ).message,
        );
        router.refresh();
        return;
      }
      clearPendingReconciliation(reconciliation);
      router.refresh();
    } catch {
      trackPendingReconciliation(reconciliation);
      setMemberActionError(
        "Revoke outcome is unknown. Invitations were refreshed; retrying will use the same command.",
      );
      router.refresh();
    } finally {
      finishInvitationAction(invitationId);
    }
  };

  const resendInvitation = async (invitationId: string) => {
    if (!beginInvitationAction(invitationId)) return;
    setMemberActionError(null);
    const reconciliation: PendingInviteReconciliation = {
      kind: "resend",
      invitationId,
    };
    try {
      const { response, data } =
        await teamInviteCommands.json<InviteResponse>({
          slot: `resend:${invitationId}`,
          url: `/api/team/invite/${invitationId}/resend`,
          method: "POST",
        });
      if (!response.ok) {
        reconcileResponse(response, data, reconciliation);
        setMemberActionError(
          readApiError(
            data,
            "Couldn't resend invitation. Please try again.",
          ).message,
        );
        router.refresh();
        return;
      }
      clearPendingReconciliation(reconciliation);
      router.refresh();
    } catch {
      trackPendingReconciliation(reconciliation);
      setMemberActionError(
        "Resend outcome is unknown. Invitations were refreshed; retrying will use the same command.",
      );
      router.refresh();
    } finally {
      finishInvitationAction(invitationId);
    }
  };

  return (
    <>
      {/* Members */}
      <div className="mb-xl">
        <div className="mb-md flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">Members</h2>
          {isOwner && (
            <button
              type="button"
              onClick={() => {
                pendingReconciliationsRef.current =
                  pendingReconciliationsRef.current.filter(
                    ({ kind }) => kind !== "create",
                  );
                setShowInvite(true);
                setInviteUrl("");
                setInviteEmail("");
                setInviteError(null);
              }}
              className="flex h-[34px] items-center gap-xs rounded-sm bg-accent px-md text-[13px] font-medium text-white hover:bg-accent-hover"
            >
              <Link2 className="h-3.5 w-3.5" strokeWidth={2} />
              Create invite link
            </button>
          )}
        </div>

        {memberActionError && (
          <div
            role="alert"
            className="mb-sm flex items-start justify-between gap-sm rounded-sm border border-danger/30 bg-danger-soft px-sm py-xs text-[13px] text-danger"
          >
            <span>{memberActionError}</span>
            <button
              type="button"
              onClick={() => setMemberActionError(null)}
              aria-label="Dismiss error"
              className="-mr-2xs flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-danger/70 hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          </div>
        )}

        <div className="rounded-md border border-border bg-surface">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                <th className="px-md py-sm text-left font-semibold">User</th>
                <th className="px-md py-sm text-left font-semibold">Role</th>
                <th className="px-md py-sm text-right font-semibold">Joined</th>
                {isOwner && (
                  <th className="w-[48px] px-sm py-sm font-semibold" />
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const memberBusy = busyMemberIds.has(member.id);
                return (
                  <tr
                    key={member.id}
                    className="border-t border-dashed border-border"
                    aria-busy={memberBusy || undefined}
                  >
                  <td className="px-md py-sm font-medium text-ink">
                    {member.user_id === currentUserId
                      ? "You"
                      : member.user_id.slice(0, 8) + "..."}
                  </td>
                  <td className="px-md py-sm">
                    {isOwner && member.user_id !== currentUserId ? (
                      <select
                        value={member.role}
                        onChange={(e) =>
                          changeRole(
                            member.id,
                            e.target.value as Member["role"],
                          )
                        }
                        disabled={memberBusy}
                        className="rounded-sm border border-border bg-white px-sm py-xs text-[13px] text-ink"
                      >
                        <option value="owner">Owner</option>
                        <option value="manager">Manager</option>
                        <option value="staff">Staff</option>
                      </select>
                    ) : (
                      <span className="inline-flex items-center rounded-pill bg-surface-sunken px-sm py-xs text-[11px] font-medium capitalize text-ink-muted">
                        {member.role}
                      </span>
                    )}
                  </td>
                  <td className="px-md py-sm text-right font-mono text-[12px] text-ink-subtle">
                    <TimeAgo iso={member.created_at} />
                  </td>
                  {isOwner && (
                    <td className="px-sm py-sm text-right">
                      {member.user_id !== currentUserId && (
                        <button
                          type="button"
                          aria-label="Remove team member"
                          disabled={memberBusy}
                          onClick={() => {
                            if (window.confirm("Remove this team member?")) {
                              removeMember(member.id);
                            }
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-danger"
                        >
                          <Trash2
                            className="h-3.5 w-3.5"
                            strokeWidth={2}
                            aria-hidden="true"
                          />
                        </button>
                      )}
                    </td>
                  )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <div className="mb-xl">
          <h2 className="mb-md text-[15px] font-semibold text-ink-muted">
            Pending invitations ({invitations.length})
          </h2>
          <div className="rounded-md border border-border bg-surface">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  <th className="px-md py-sm text-left font-semibold">Email</th>
                  <th className="px-md py-sm text-left font-semibold">Role</th>
                  <th className="px-md py-sm text-left font-semibold">
                    Created
                  </th>
                  <th className="px-md py-sm text-right font-semibold">
                    Expires
                  </th>
                  {isOwner && (
                    <th className="w-[200px] px-sm py-sm font-semibold" />
                  )}
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => {
                  const justCopied = copiedInvitationId === inv.id;
                  const expiry = describeExpiry(inv.expires_at);
                  const invitationBusy = busyInvitationIds.has(inv.id);
                  return (
                    <tr
                      key={inv.id}
                      className={`border-t border-dashed border-border ${expiry.status === "expired" ? "opacity-60" : ""}`}
                    >
                      <td className="px-md py-sm text-ink">
                        {inv.email ?? (
                          <span className="text-ink-subtle italic">
                            (no email)
                          </span>
                        )}
                      </td>
                      <td className="px-md py-sm capitalize text-ink">
                        {inv.role}
                      </td>
                      <td className="px-md py-sm font-mono text-[12px] text-ink-muted">
                        <TimeAgo iso={inv.created_at} />
                      </td>
                      <td
                        className="px-md py-sm text-right text-[12px]"
                        title={new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(inv.expires_at))}
                      >
                        {expiry.status === "expired" ? (
                          <span className="inline-flex items-center rounded-pill bg-danger-soft px-sm py-xs text-[11px] font-semibold text-danger">
                            Expired
                          </span>
                        ) : expiry.status === "soon" ? (
                          <span className="inline-flex items-center gap-xs">
                            <span className="rounded-pill bg-warning-soft px-sm py-xs text-[11px] font-semibold text-warning">
                              Expires soon
                            </span>
                            <span className="font-mono text-ink-muted">
                              {expiry.label}
                            </span>
                          </span>
                        ) : (
                          <span className="font-mono text-ink-subtle">
                            {expiry.label}
                          </span>
                        )}
                      </td>
                      {isOwner && (
                        <td className="px-sm py-sm text-right">
                          <div className="flex items-center justify-end gap-xs">
                            <button
                              type="button"
                              onClick={() => copyInvitationLink(inv)}
                              aria-label={`Copy invite link for ${inv.email ?? "invitation"}`}
                              className="inline-flex h-[28px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[12px] font-medium text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                            >
                              {justCopied ? (
                                <Check
                                  className="h-3.5 w-3.5"
                                  strokeWidth={2}
                                  aria-hidden
                                />
                              ) : (
                                <Copy
                                  className="h-3.5 w-3.5"
                                  strokeWidth={2}
                                  aria-hidden
                                />
                              )}
                              {justCopied ? "Copied" : "Copy link"}
                            </button>
                            <button
                              type="button"
                              onClick={() => resendInvitation(inv.id)}
                              disabled={invitationBusy}
                              aria-label={`Resend invitation for ${inv.email ?? "invitation"}`}
                              className="inline-flex h-[28px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[12px] font-medium text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-wait disabled:opacity-60"
                            >
                              <RefreshCw
                                className={`h-3.5 w-3.5 ${invitationBusy ? "animate-spin" : ""}`}
                                strokeWidth={2}
                                aria-hidden
                              />
                              Resend
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (
                                  busyInvitationIdsRef.current.has(inv.id)
                                ) {
                                  return;
                                }
                                if (
                                  window.confirm(
                                    `Revoke invitation for ${inv.email ?? "this address"}? The link will stop working immediately.`,
                                  )
                                ) {
                                  revokeInvitation(inv.id);
                                }
                              }}
                              disabled={invitationBusy}
                              aria-label={`Revoke invitation for ${inv.email ?? "invitation"}`}
                              className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-sm border border-border-strong bg-white text-ink-subtle hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:cursor-wait disabled:opacity-60"
                            >
                              <Trash2
                                className="h-3.5 w-3.5"
                                strokeWidth={2}
                                aria-hidden
                              />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
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
        className="mx-md w-full max-w-[420px] rounded-md border border-border bg-surface p-lg shadow-lg"
      >
        <h3
          id="invite-modal-title"
          className="text-[18px] font-serif font-medium text-ink"
        >
          Invite team member
        </h3>
        <p className="mt-xs text-[13px] text-ink-muted">
          Create a shareable link. Anyone with the link can join your restaurant
          as the selected role.
        </p>

        {!inviteUrl ? (
          <>
            <div className="mt-lg">
              <label
                htmlFor="invite-email"
                className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle"
              >
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                disabled={creating}
                placeholder="teammate@restaurant.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !creating) {
                    e.preventDefault();
                    onCreate();
                  }
                }}
                className="mt-xs w-full rounded-sm border border-border bg-white px-md py-sm text-[14px] text-ink"
              />
              <p className="mt-xs text-[12px] text-ink-subtle">
                The link will only work for this address.
              </p>
            </div>

            <div className="mt-md">
              <label
                htmlFor="invite-role"
                className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle"
              >
                Role
              </label>
              <select
                id="invite-role"
                value={inviteRole}
                disabled={creating}
                onChange={(e) =>
                  setInviteRole(e.target.value as "manager" | "staff")
                }
                className="mt-xs w-full rounded-sm border border-border bg-white px-md py-sm text-[14px] text-ink"
              >
                <option value="manager">Manager</option>
                <option value="staff">Staff</option>
              </select>
              <p className="mt-xs text-[12px] text-ink-subtle">
                {inviteRole === "manager"
                  ? "Can scan, create wine lists, and publish."
                  : "Can scan invoices only."}
              </p>
            </div>

            {error && (
              <p
                role="alert"
                className="mt-md rounded-sm border border-danger/30 bg-danger-soft px-sm py-xs text-[13px] text-danger"
              >
                {error}
              </p>
            )}

            <div className="mt-lg flex justify-end gap-sm">
              <button
                type="button"
                onClick={onClose}
                className="flex h-[38px] items-center rounded-sm border border-border-strong bg-white px-md text-[14px] font-medium text-ink hover:bg-surface-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onCreate}
                disabled={creating || inviteEmail.trim().length === 0}
                className="flex h-[38px] items-center gap-xs rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {creating && (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                )}
                Generate link
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-lg rounded-sm border border-border bg-surface-muted p-md">
              <p className="break-all font-mono text-[12px] text-ink">
                {inviteUrl}
              </p>
            </div>
            {error && (
              <p
                role="alert"
                className="mt-md rounded-sm border border-danger/30 bg-danger-soft px-sm py-xs text-[13px] text-danger"
              >
                {error}
              </p>
            )}
            <div className="mt-md flex justify-end gap-sm">
              <button
                type="button"
                onClick={onClose}
                className="flex h-[38px] items-center rounded-sm border border-border-strong bg-white px-md text-[14px] font-medium text-ink hover:bg-surface-muted"
              >
                Done
              </button>
              <button
                type="button"
                onClick={onCopy}
                className="flex h-[38px] items-center gap-xs rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover"
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
 * Used to colour-code the Pending invitations table so operators can
 * see at a glance which links are still usable.
 */
function describeExpiry(expiresAt: string): {
  status: "expired" | "soon" | "ok";
  label: string;
} {
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
