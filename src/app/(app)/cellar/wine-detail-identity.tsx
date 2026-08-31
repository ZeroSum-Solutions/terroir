"use client";

import Image from "next/image";
import { Trash2 } from "lucide-react";
import { WineThumb } from "@/components/wine-thumb";
import { resolveWineHeroImage } from "@/lib/wine-intelligence/corpus-image";
import { useCorpusImage } from "./use-corpus-image";
import type { CellarWineRow } from "./types";

/**
 * CELLAR-05/06 — the wine, at the top of its own drawer.
 *
 * Devin, on the old drawer: "There's no information on the wine. There's no
 * hero image of the wine." The drawer led with stock counts and then handed
 * most of its height to a stock-adjustment form; the bottle appeared only when
 * the tenant had uploaded a photograph, which is the minority case.
 *
 * Two things changed here:
 *   • The picture is always present. A wine with no photograph of its own
 *     falls back to the X-Wines corpus image its identity link points at
 *     (GLOBAL-04), captioned with what that picture actually is, and then to
 *     the same producer-initials stand-in every cellar row already uses.
 *   • It follows DESIGN.md's `bottle` recipe — 3:4 portrait, object-contain,
 *     on a cool mat — instead of the 2:1 banner crop the design contract calls
 *     out by name for cutting the tops off bottles.
 *
 * The identity LINK is not the only way to a picture, and for a cellar built
 * by CSV import it is not the usual one. When neither the tenant's own
 * photograph nor the embedded corpus image exists, this asks the profile route
 * for the one wine on screen — the fetch the list page cannot afford per row.
 */
export function WineDetailIdentity({
  row,
  canManage,
  onDeleteImage,
  deleteDisabled,
}: {
  row: CellarWineRow;
  canManage: boolean;
  onDeleteImage: () => void;
  deleteDisabled: boolean;
}) {
  const embedded = row.corpus_image ?? null;
  const corpus = useCorpusImage({
    wineId: row.wine_id,
    hasImage: Boolean(row.hero_image_url) || embedded !== null,
  });

  const hero = resolveWineHeroImage({
    heroImageUrl: row.hero_image_url,
    corpusImage: embedded ?? (corpus.status === "done" ? corpus.image : null),
    producer: row.producer,
    name: row.name,
  });

  // The initials stand-in is a claim that there is no picture, and while a
  // request is in flight that claim is not yet true. Showing it and then
  // swapping in a bottle is the flash the 3:4 box exists to prevent, so the
  // box holds its own shape, empty, until the answer arrives.
  const pending = corpus.status === "loading";

  const facets = [
    row.region,
    row.country,
    row.varietal,
    row.wine_size_ml ? `${row.wine_size_ml} ml` : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <section aria-label="Wine" className="mb-md flex gap-md">
      <div className="w-[112px] shrink-0">
        <div className="relative aspect-[3/4] overflow-hidden rounded-lg border border-rule bg-surface-raised">
          {hero ? (
            <Image
              src={hero.src}
              alt={hero.alt}
              width={448}
              height={598}
              unoptimized
              className="h-full w-full object-contain"
            />
          ) : pending ? (
            <span
              aria-hidden
              className="block h-full w-full animate-pulse bg-surface-sunken"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center">
              <WineThumb
                src={null}
                producer={row.producer}
                name={row.name}
                colour={row.colour}
                size={72}
              />
            </span>
          )}
          {canManage && row.hero_image_url && (
            <button
              type="button"
              onClick={onDeleteImage}
              disabled={deleteDisabled}
              className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-pill bg-scrim text-seal-ink hover:bg-ink/70 disabled:opacity-40"
              aria-label="Remove image"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
        {hero?.note && (
          <p className="mt-2xs text-micro text-grey">{hero.note}</p>
        )}
      </div>

      {/* Producer, name and vintage are NOT repeated here. The drawer header
          immediately above this block is the dialog's accessible title and
          already carries all three; rendering them again put the same wine on
          screen twice within about sixty pixels — the same defect BUG-01
          logged for producer names, arrived at from the other direction. This
          block supplies what the header does not: the picture, and the facets
          that place the wine. */}
      <div className="min-w-0 flex-1">
        {facets.length > 0 && (
          <p className="text-body-sm text-grey">{facets.join(" · ")}</p>
        )}
      </div>
    </section>
  );
}
