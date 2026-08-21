"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

/**
 * Submit button for the /login magic-link form.
 */
export function MagicLinkSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="flex min-h-11 items-center justify-center gap-xs rounded-pill bg-primary px-md text-[14px] font-medium text-white outline-none transition-colors hover:bg-primary-hover focus-visible:ring-[3px] focus-visible:ring-blush-wash disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-primary"
    >
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
          Sending…
        </>
      ) : (
        "Send magic link"
      )}
    </button>
  );
}

/**
 * Submit button for the /login forgot-password form.
 */
export function ResetPasswordSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="flex min-h-11 items-center justify-center rounded-pill bg-primary px-md text-[14px] font-medium text-white outline-none transition-colors hover:bg-primary-hover focus-visible:ring-[3px] focus-visible:ring-blush-wash disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-primary"
    >
      {pending ? (
        <>
          <Loader2 className="mr-xs h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
          Sending…
        </>
      ) : (
        "Send reset link"
      )}
    </button>
  );
}

/** Submit button shared by password sign-in and account creation forms. */
export function PasswordSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="flex min-h-11 items-center justify-center gap-xs rounded-pill bg-primary px-md text-[14px] font-medium text-white outline-none transition-colors hover:bg-primary-hover focus-visible:ring-[3px] focus-visible:ring-blush-wash disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-primary"
    >
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
          Working…
        </>
      ) : (
        label
      )}
    </button>
  );
}

/**
 * Submit button for /auth/reset-password form.
 */
export function SetPasswordSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="flex min-h-11 items-center justify-center rounded-pill bg-primary px-md text-[14px] font-medium text-white outline-none transition-colors hover:bg-primary-hover focus-visible:ring-[3px] focus-visible:ring-blush-wash disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-primary"
    >
      {pending ? (
        <>
          <Loader2 className="mr-xs h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
          Saving…
        </>
      ) : (
        "Save password"
      )}
    </button>
  );
}
