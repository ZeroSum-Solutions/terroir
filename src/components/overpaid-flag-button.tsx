"use client";

import React, { useCallback, useTransition } from "react";
import { Flag } from "lucide-react";
import { useRouter } from "next/navigation";

export function OverpaidFlagButton({
  wineId,
  flagged,
}: {
  wineId: string;
  flagged: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const toggle = useCallback(() => {
    startTransition(async () => {
      await fetch("/api/wines/" + wineId + "/overpaid", { method: "POST" });
      router.refresh();
    });
  }, [wineId, router]);
  return (
    React.createElement("button", {
      type: "button",
      onClick: toggle,
      disabled: isPending,
      "aria-label": flagged ? "Remove overpaid flag" : "Flag as overpaid",
      title: flagged ? "Remove overpaid flag" : "Flag as overpaid for follow-up",
      className: "inline-flex items-center justify-center rounded-sm p-xs transition-colors " + (flagged ? "text-error hover:text-error-hover bg-error-soft/50 hover:bg-error-soft" : "text-ink-subtle hover:text-error hover:bg-error-soft/30"),
    },
      React.createElement(Flag, {
        className: "h-4 w-4 " + (isPending ? "animate-pulse" : ""),
        strokeWidth: flagged ? 2.5 : 1.5,
        fill: flagged ? "currentColor" : "none",
      })
    )
  );
}