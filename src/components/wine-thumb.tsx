import Image from "next/image";

import { cn } from "@/lib/utils";

/**
 * A wine's picture, or a stand-in for one.
 *
 * Before this existed, a wine with no image rendered nothing at all — so a
 * cellar list was a ragged mix of rows that had a thumbnail and rows that
 * simply didn't, which reads as broken rather than as "no photo yet". A
 * stand-in every row can fall back to makes the list look deliberate, and it
 * carries real information: the producer's initials, tinted by wine colour.
 */

/** LWIN populates `wines.colour` as free text. Normalised and matched against
 * the values that actually appear; anything else takes the neutral tint rather
 * than guessing. */
const TINTS: Record<string, { surface: string; ink: string }> = {
  red: { surface: "bg-risk-wash", ink: "text-risk-ink" },
  white: { surface: "bg-risk-wash", ink: "text-mark" },
  rose: { surface: "bg-risk-wash", ink: "text-risk-ink" },
  rosé: { surface: "bg-risk-wash", ink: "text-risk-ink" },
  sparkling: { surface: "bg-hold-wash", ink: "text-hold-ink" },
  fortified: { surface: "bg-risk-wash", ink: "text-mark" },
  sweet: { surface: "bg-risk-wash", ink: "text-mark" },
};

const NEUTRAL = { surface: "bg-wash", ink: "text-grey" };

export function wineTint(colour: string | null | undefined) {
  return TINTS[colour?.trim().toLocaleLowerCase() ?? ""] ?? NEUTRAL;
}

/**
 * Up to two initials for the stand-in.
 *
 * Prefers the producer — a cellar groups by who made the wine, so "DR" for
 * Domaine Romanée is more recognisable at 36px than the wine's own name. Falls
 * back to the wine name, then to nothing rather than a meaningless glyph.
 */
export function wineInitials(producer: string | null | undefined, name: string | null | undefined): string {
  const source = (producer?.trim() || name?.trim() || "");
  if (!source) return "";
  const words = source.split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0) return "";
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toLocaleUpperCase();
}

export interface WineThumbProps {
  src: string | null | undefined;
  producer: string | null | undefined;
  name: string | null | undefined;
  colour?: string | null;
  /** Rendered size in px. The image is requested at 2× for retina. */
  size: number;
  className?: string;
}

export function WineThumb({ src, producer, name, colour, size, className }: WineThumbProps) {
  const shared = cn("shrink-0 rounded-md object-cover", className);

  if (src) {
    return (
      <Image
        src={src}
        alt=""
        width={size * 2}
        height={size * 2}
        unoptimized
        style={{ width: size, height: size }}
        className={shared}
      />
    );
  }

  const tint = wineTint(colour);
  const initials = wineInitials(producer, name);

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
      className={cn(
        shared,
        tint.surface,
        tint.ink,
        "flex items-center justify-center font-serif font-medium leading-none tracking-[0.02em]",
      )}
    >
      {initials}
    </span>
  );
}
