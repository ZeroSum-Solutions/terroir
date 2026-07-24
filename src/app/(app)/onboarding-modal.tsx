"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readApiError } from "@/lib/api/client-error";
import { createIdempotentCommandStore } from "@/lib/api/idempotency-client";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";

export function OnboardingModal({
  restaurantId,
}: {
  restaurantId: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [commands] = useState(() => createIdempotentCommandStore());
  const trapRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef: trapRef, onEscape: () => router.refresh() });

  const submit = useCallback(async () => {
    if (savingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    savingRef.current = true;
    setError(null);
    setSaving(true);
    try {
      const { response, data } = await commands.json<unknown>({
        slot: `restaurant:${restaurantId}:name`,
        url: `/api/restaurant/${restaurantId}`,
        method: "PATCH",
        json: { name: trimmed },
      });
      if (!response.ok) {
        throw new Error(
          readApiError(
            data,
            `Failed to save restaurant name (${response.status}).`,
          ).message,
        );
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [commands, name, restaurantId, router]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div ref={trapRef} className="w-full max-w-[400px] rounded-md border border-border bg-surface p-lg shadow-lg">
        <h2 id="onboarding-title" className="font-serif text-[22px] text-ink">
          Name your restaurant
        </h2>
        <p className="mt-xs text-[13px] text-ink-muted">
          You can change this later in settings.
        </p>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Tartine Cellar…"
          className="mt-lg h-[38px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink placeholder:text-ink-subtle focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        />
        <div className="mt-lg flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={saving || !name.trim()}
            className="h-[38px] rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {saving ? "Saving..." : "Continue"}
          </button>
        </div>
        {error && (
          <p className="mt-sm text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
