"use client";

import { useRef, useState } from "react";
import { Check, Copy, Link2, Loader2, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";

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

  const isOwner = members.some(
    (m) => m.user_id === currentUserId && m.role === "owner",
  );

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
    const res = await fetch(`/api/team/members/${memberId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setMemberActionError(
        await extractServerError(res, "Couldn't remove member. Please try again."),
      );
      return;
    }
    router.refresh();
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
                <th className="px-md py-sm text-right font-semibold">
                  Joined
                </th>
                {isOwner && (
                  <th className="w-[48px] px-sm py-sm font-semibold" />
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr
                  key={member.id}
                  className="border-t border-dashed border-border"
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
                        onChange={(e) => changeRole(member.id, e.target.value)}
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
                    {new Intl.DateTimeFormat().format(new Date(member.created_at))}
                  </td>
                  {isOwner && (
                    <td className="px-sm py-sm text-right">
                      {member.user_id !== currentUserId && (
                        <button
                          type="button"
                          aria-label="Remove team member"
                          onClick={() => {
                            if (window.confirm("Remove this team member?")) {
                              removeMember(member.id);
                            }
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
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
                    <th className="w-[120px] px-sm py-sm font-semibold" />
                  )}
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => {
                  const justCopied = copiedInvitationId === inv.id;
                  return (
                    <tr
                      key={inv.id}
                      className="border-t border-dashed border-border"
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
                        {new Intl.DateTimeFormat().format(new Date(inv.created_at))}
                      </td>
                      <td className="px-md py-sm text-right font-mono text-[12px] text-ink-subtle">
                        {new Intl.DateTimeFormat().format(new Date(inv.expires_at))}
                      </td>
                      {isOwner && (
                        <td className="px-sm py-sm text-right">
                          <button
                            type="button"
                            onClick={() => copyInvitationLink(inv)}
                            aria-label={`Copy invite link for ${inv.email ?? "invitation"}`}
                            className="inline-flex h-[28px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[12px] font-medium text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                          >
                            {justCopied ? (
                              <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                            ) : (
                              <Copy className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                            )}
                            {justCopied ? "Copied" : "Copy link"}
                          </button>
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
          Create a shareable link. Anyone with the link can join your
          restaurant as the selected role.
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
            <div className="mt-lg rounded-sm border border-border bg-surface-muted p-md">
              <p className="break-all font-mono text-[12px] text-ink">
                {inviteUrl}
              </p>
            </div>
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
