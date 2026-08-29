"use client";

import { Share2 } from "lucide-react";
import { useState } from "react";

type PublicMenuShareProps = {
  title: string;
  text: string;
};

export function PublicMenuShare({ title, text }: PublicMenuShareProps) {
  const [status, setStatus] = useState("");

  async function handleShare() {
    setStatus("");
    const payload = { title, text, url: window.location.href };

    if (typeof navigator.share === "function") {
      try {
        await navigator.share(payload);
        setStatus("Menu shared");
        return;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "AbortError"
        ) {
          return;
        }
      }
    }

    try {
      await navigator.clipboard.writeText(payload.url);
      setStatus("Link copied");
    } catch {
      setStatus("Unable to share. Copy the address from your browser.");
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleShare}
        className="inline-flex min-h-11 items-center justify-center gap-xs rounded-pill border border-border px-md py-sm text-[13px] font-medium text-ink print:hidden focus-ring"
      >
        <Share2 aria-hidden="true" className="h-4 w-4" />
        Share menu
      </button>
      {status && (
        <span
          role="status"
          aria-live="polite"
          className="mt-xs block text-[12px] text-grey print:hidden"
        >
          {status}
        </span>
      )}
    </div>
  );
}
