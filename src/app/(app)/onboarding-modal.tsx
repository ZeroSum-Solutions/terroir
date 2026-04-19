"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useFocusTrap } from "@/lib/use-focus-trap";

export function OnboardingModal({
  restaurantId,
}: {
  restaurantId: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const trapRef = useFocusTrap<HTMLDivElement>();

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.ok) {
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }, [name, restaurantId, router]);

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
      </div>
    </div>
  );
}
