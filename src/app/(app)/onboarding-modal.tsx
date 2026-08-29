"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";

export function OnboardingModal({
  restaurantId,
}: {
  restaurantId: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const trapRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef: trapRef, onEscape: () => router.refresh() });

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
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-scrim px-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div ref={trapRef} className="w-full max-w-[400px] rounded-card card-surface p-lg">
        <h2 id="onboarding-title" className="font-serif text-[22px] font-normal text-ink">
          Name your restaurant
        </h2>
        <p className="mt-xs text-[13px] font-light text-grey">
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
          className="mt-lg h-[38px] w-full rounded-pill border border-hairline bg-canvas px-md text-[14px] text-ink placeholder:text-grey focus-visible:border-accent focus-ring"
        />
        <div className="mt-lg flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={saving || !name.trim()}
            className="h-[38px] rounded-pill bg-primary px-md text-[14px] font-medium text-seal-ink transition-colors hover:bg-primary-hover focus-ring disabled:opacity-60"
          >
            {saving ? "Saving..." : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
