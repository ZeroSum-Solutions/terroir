"use client";

import { useRef } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { ROLE_DESCRIPTIONS } from "@/lib/team/member-identities";

export function InviteModal({
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
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- backdrop-click-to-dismiss is a mouse-only convenience; this dialog already has full keyboard access via useFocusTrap (Escape + a visible Close button).
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-scrim backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="glass mx-md w-full max-w-[420px] rounded-card p-lg"
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
                className="mt-xs min-h-11 w-full rounded-pill border border-rule bg-surface px-md text-[14px] text-ink focus:border-accent focus-ring"
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
                className="mt-xs min-h-11 w-full rounded-pill border border-rule bg-surface px-md text-[14px] text-ink focus:border-accent focus-ring"
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
                className="mt-md rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"
              >
                {error}
              </p>
            )}

            <div className="mt-lg flex justify-end gap-sm">
              <button
                type="button"
                onClick={onClose}
                className="flex min-h-11 items-center rounded-pill border border-rule-strong bg-surface px-md text-[14px] font-medium text-ink hover:bg-wash focus-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onCreate}
                disabled={creating || inviteEmail.trim().length === 0}
                className="flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-60"
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
            <div className="mt-lg rounded-md border border-rule bg-wash p-md">
              <p className="break-all font-mono text-[12px] text-ink">
                {inviteUrl}
              </p>
            </div>
            <div className="mt-md flex justify-end gap-sm">
              <button
                type="button"
                onClick={onClose}
                className="flex min-h-11 items-center rounded-pill border border-rule-strong bg-surface px-md text-[14px] font-medium text-ink hover:bg-wash focus-ring"
              >
                Done
              </button>
              <button
                type="button"
                onClick={onCopy}
                className="flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
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
