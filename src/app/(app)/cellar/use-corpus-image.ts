"use client";

import { useEffect, useState } from "react";
import type { XWinesImageKind } from "@/lib/wine-intelligence/xwines-profile";

export type CorpusImage = { url: string; kind: XWinesImageKind };

/**
 * "idle" — nothing to ask for: the row already has a picture, or there is no
 * row. "loading" — asked, still waiting; the caller must hold the space rather
 * than show a stand-in it is about to replace. "done" — answered, with the
 * picture or with null, and null is a real answer meaning the corpus has
 * nothing for this wine.
 */
export type CorpusImageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; image: CorpusImage | null };

const IMAGE_KINDS: readonly string[] = ["label", "producer", "representative"];

/**
 * The picture for a wine the cellar query could not find one for.
 *
 * The list page embeds a corpus image for every wine whose identity LINK
 * reaches one, which is one join on a query it was making anyway. A wine that
 * only the producer-recovering matcher can place (wine-corpus-profile.ts)
 * costs a query or three of its own, so it is fetched HERE — once, for the one
 * wine somebody opened, and only when there is nothing at all to show. Never a
 * request per row.
 *
 * A failed request lands on `{ status: "done", image: null }` deliberately.
 * The drawer's fallback for "no picture" is the initials stand-in, which is
 * the honest thing to show when we could not find one, and a decorative fetch
 * has no business raising an error banner over a wine's stock controls.
 */
export function useCorpusImage(wine: {
  wineId: string | null;
  hasImage: boolean;
}): CorpusImageState {
  const { wineId, hasImage } = wine;
  const wanted = wineId !== null && !hasImage;
  // Keyed by the wine it answers, so switching wines reads as "loading" again
  // without an effect having to reset anything. Only the completed request
  // lives in state; "idle" and "loading" are derived below, which is what
  // keeps this effect from setting state synchronously and cascading a render.
  const [answer, setAnswer] = useState<{
    wineId: string;
    image: CorpusImage | null;
  } | null>(null);

  useEffect(() => {
    if (!wanted || wineId === null) return;

    // Not just cleanup: the drawer stays mounted while the user moves from one
    // wine to the next, so without aborting, a slow answer for the previous
    // wine can arrive after the new one's and put the wrong bottle on screen.
    const controller = new AbortController();

    (async () => {
      let image: CorpusImage | null = null;
      try {
        const response = await fetch(`/api/wines/${wineId}/profile`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        image = readImage((await response.json()) as unknown);
      } catch {
        image = null;
      }
      if (controller.signal.aborted) return;
      setAnswer({ wineId, image });
    })();

    return () => controller.abort();
  }, [wineId, wanted]);

  if (!wanted) return { status: "idle" };
  if (answer === null || answer.wineId !== wineId) return { status: "loading" };
  return { status: "done", image: answer.image };
}

/**
 * The image out of the route's envelope, or null.
 *
 * `kind` is checked against the known vocabulary rather than trusted, for the
 * same reason `toImage` checks it server-side: it is what decides the caption,
 * so an unrecognised one has to drop the picture rather than default to a kind
 * — defaulting down hides a real label, defaulting up asserts one.
 */
function readImage(payload: unknown): CorpusImage | null {
  if (!payload || typeof payload !== "object") return null;
  const profile = (payload as { profile?: unknown }).profile;
  if (!profile || typeof profile !== "object") return null;
  const image = (profile as { image?: unknown }).image;
  if (!image || typeof image !== "object") return null;
  const { url, kind } = image as { url?: unknown; kind?: unknown };
  if (typeof url !== "string" || typeof kind !== "string") return null;
  if (!IMAGE_KINDS.includes(kind)) return null;
  return { url, kind: kind as XWinesImageKind };
}
