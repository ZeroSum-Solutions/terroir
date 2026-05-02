"use client";

import { useRef, useState } from "react";
import { Check, Copy, Link2, Loader2, Trash2 } from "lucide-react";
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
  const [inviteUrl, setInviteUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const isOwner = members.some(
    (m) => m.user_id === currentUserId && m.role === "owner",
  );

  const createInvite = async () => {
    setCreating(true);
    const res = await fetch("/api/team/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: inviteRole }),
    });
    if (res.ok) {
      const invite = await res.json();
      setInviteUrl(invite.inviteUrl);
      router.refresh();
    }
    setCreating(false);
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const changeRole = async (memberId: string, role: string) => {
    await fetch(`/api/team/members/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    router.refresh();
  };

  const removeMember = async (memberId: string) => {
    await fetch(`/api/team/members/${memberId}`, { method: "DELETE" });
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
              }}
              className="flex h-[34px] items-center gap-xs rounded-sm bg-accent px-md text-[13px] font-medium text-white hover:bg-accent-hover"
            >
              <Link2 className="h-3.5 w-3.5" strokeWidth={2} />
              Create invite link
            </button>
          )}
        </div>

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
                  <th className="px-md py-sm text-left font-semibold">Role</th>
                  <th className="px-md py-sm text-left font-semibold">
                    Created
                  </th>
                  <th className="px-md py-sm text-right font-semibold">
                    Expires
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-t border-dashed border-border"
                  >
                    <td className="px-md py-sm capitalize text-ink">
                      {inv.role}
                    </td>
                    <td className="px-md py-sm font-mono text-[12px] text-ink-muted">
                      {new Intl.DateTimeFormat().format(new Date(inv.created_at))}
                    </td>
                    <td className="px-md py-sm text-right font-mono text-[12px] text-ink-subtle">
                      {new Intl.DateTimeFormat().format(new Date(inv.expires_at))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Invite modal */}
      {showInvite && (
        <InviteModal
          inviteRole={inviteRole}
          setInviteRole={setInviteRole}
          inviteUrl={inviteUrl}
          creating={creating}
          copied={copied}
          onClose={() => setShowInvite(false)}
          onCreate={createInvite}
          onCopy={copyLink}
        />
      )}
    </>
  );
}

function InviteModal({
  inviteRole,
  setInviteRole,
  inviteUrl,
  creating,
  copied,
  onClose,
  onCreate,
  onCopy,
}: {
  inviteRole: "manager" | "staff";
  setInviteRole: (r: "manager" | "staff") => void;
  inviteUrl: string;
  creating: boolean;
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
              <label className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Role
              </label>
              <select
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
                disabled={creating}
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
