"use client";

import { useCallback, useState } from "react";

/**
 * useAsyncAction — the `setBusy(true) / try / catch / finally setBusy(false)`
 * shape that recurs across the cellar action handlers, lifted into a hook.
 *
 * Only fits call sites whose busy flag and error handling are genuinely
 * local (not shared with sibling actions) — a handful of drawer actions
 * share one `busy` boolean across several buttons on purpose (so an
 * in-flight mutation on one control disables the others), and those keep
 * their own inline try/catch rather than adopting this hook.
 */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (
      action: () => Promise<void>,
      options?: {
        fallbackMessage?: string;
        onError?: (message: string) => void;
      },
    ) => {
      setError(null);
      setBusy(true);
      try {
        await action();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : (options?.fallbackMessage ?? "Something went wrong.");
        options?.onError?.(message);
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { busy, error, run };
}
