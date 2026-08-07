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
      className="flex h-[38px] items-center justify-center gap-xs rounded-sm bg-accent px-md text-[14px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-accent"
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
      className="flex h-[38px] items-center justify-center rounded-sm bg-accent px-md text-[14px] font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-accent"
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
      className="flex h-[38px] items-center justify-center gap-xs rounded-sm bg-accent px-md text-[14px] font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-accent"
    >
      {pending ? (
        <>
          <Loader2 className="mr-xs h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
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
      className="flex h-[38px] items-center justify-center rounded-sm bg-accent px-md text-[14px] font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-accent"
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
