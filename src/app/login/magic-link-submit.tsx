"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

/**
 * Submit button for the /login magic-link form.
 *
 * Reads the parent form's pending state via React 19's `useFormStatus` so we
 * can disable the button and swap the label to a spinner + "Sending…" while
 * the Server Action is in flight. This prevents double-submits and gives
 * the user immediate feedback that the request is being processed.
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
