"use client";

import { useState } from "react";

// The one action on the catalogue detail page (D4: "add is one action on
// it"). Same endpoint and payload as the palette's inline Add — a
// find-or-create keyed on the LWIN identity, so pressing it twice cannot
// duplicate a wine.

export type CatalogueAddPayload = {
  lwin_id: string;
  display_name: string;
  producer: string | null;
  region: string | null;
  country: string | null;
};

type AddState = "idle" | "pending" | "added" | "error";

export function CatalogueAddButton({ payload }: { payload: CatalogueAddPayload }) {
  const [state, setState] = useState<AddState>("idle");

  async function add() {
    setState("pending");
    try {
      const res = await fetch("/api/wines/create-from-lwin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setState(res.ok ? "added" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <button
      type="button"
      onClick={add}
      disabled={state === "pending" || state === "added"}
      className="rounded-pill border border-edge px-lg py-sm text-body-sm text-ink-soft transition-colors hover:bg-wash focus-ring disabled:opacity-70"
    >
      {state === "added"
        ? "Added to your cellar"
        : state === "pending"
          ? "Adding…"
          : state === "error"
            ? "Retry add"
            : "Add to cellar"}
    </button>
  );
}
