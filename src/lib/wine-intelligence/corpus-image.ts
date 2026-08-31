import { wineDisplayName } from "@/lib/wine-display-name";
import type { XWinesImageKind } from "./xwines-profile";

/**
 * How a corpus photograph is captioned and described, wherever it is shown.
 *
 * A corpus photograph is only sometimes a photograph of THIS wine (0138), so
 * showing one silently would put a stranger's Chianti under this bottle's
 * name. Every kind but "label" is captioned with what it actually is, and the
 * alt text degrades the same way — a screen reader must not be told the row's
 * producer over a picture of somebody else's.
 *
 * This lived inside the full-detail view. The cellar drawer needed the same
 * rule (GLOBAL-04 — it used to render no image at all when `hero_image_url`
 * was null, which is most of the corpus), and two copies of a rule this
 * careful is how the careful half gets lost.
 */
export const CORPUS_IMAGE_NOTE: Record<XWinesImageKind, string> = {
  label: "Reference label for this wine",
  producer: "A bottle from this producer — not this cuvée",
  representative: "Representative bottle — not this wine's label",
};

export type WineHeroImage = {
  src: string;
  alt: string;
  /** Null for the tenant's own photograph; a caption for a corpus stand-in. */
  note: string | null;
};

/**
 * The picture to show for a wine, and what to say about it.
 *
 * The tenant's own photograph always outranks the corpus's: they uploaded it
 * of the bottle they actually hold. The corpus only fills a hole.
 */
export function resolveWineHeroImage({
  heroImageUrl,
  corpusImage,
  producer,
  name,
}: {
  heroImageUrl: string | null;
  corpusImage: { url: string; kind: XWinesImageKind } | null;
  producer: string | null;
  name: string;
}): WineHeroImage | null {
  // BUG-01 — the alt text is a title too, and a screen reader reads it in
  // full: "Esporão Esporão Reserva Tinto" is the same duplication the visible
  // heading had, said out loud. See src/lib/wine-display-name.ts.
  const ownName = `${producer ?? ""} ${wineDisplayName(producer, name)}`.trim();
  if (heroImageUrl) return { src: heroImageUrl, alt: ownName, note: null };
  if (!corpusImage) return null;
  const note = CORPUS_IMAGE_NOTE[corpusImage.kind];
  return {
    src: corpusImage.url,
    alt: corpusImage.kind === "label" ? ownName : note,
    note,
  };
}

/**
 * How strong a claim each kind makes, so two claims can be combined.
 *
 * "label" says this picture is this wine. "producer" says it is a real bottle
 * from the right house, a different cuvée. "representative" says only that it
 * is a bottle of the same type and country, from someone else entirely.
 */
const IMAGE_KIND_STRENGTH: Record<XWinesImageKind, number> = {
  representative: 0,
  producer: 1,
  label: 2,
};

/**
 * The weaker of two claims about the same picture.
 *
 * A corpus row's `image_kind` describes the picture's relationship to THAT
 * ROW. When we are less than certain the row is this wine, that uncertainty
 * has to compose: a genuine label photograph reached through a
 * producer-level-only match is a real bottle from the right house but the
 * wrong cuvée — which is precisely "producer", not "label". Taking the
 * minimum is the only combination that cannot overstate either half, and it
 * means every existing renderer stays honest without knowing how the match
 * was made, because CORPUS_IMAGE_NOTE already captions the answer.
 */
export function weakerImageKind(
  a: XWinesImageKind,
  b: XWinesImageKind,
): XWinesImageKind {
  return IMAGE_KIND_STRENGTH[a] <= IMAGE_KIND_STRENGTH[b] ? a : b;
}

const IMAGE_KINDS: readonly XWinesImageKind[] = ["label", "producer", "representative"];

/**
 * The corpus image reachable from a wine's identity LINK, pulled straight out
 * of a PostgREST embed rather than through `resolveXWinesProfile`.
 *
 * The cellar list renders thousands of wines in one server pass, so it cannot
 * run the resolver's per-wine fuzzy `match_xwines` fallback — that is a query
 * per wine. The linked path is one join on a query the page already makes, and
 * it is where most matches come from anyway (AGENTS.md: the spine resolves
 * 1,064 of 1,385 production wines). A wine that only the fuzzy matcher could
 * place still gets its picture on the full-detail page.
 */
export function corpusImageFromEmbed(
  embed: unknown,
): { url: string; kind: XWinesImageKind } | null {
  const canonical = Array.isArray(embed) ? embed[0] : embed;
  if (!canonical || typeof canonical !== "object") return null;
  const catalogValue = (canonical as { xwines_catalog?: unknown }).xwines_catalog;
  const catalog = Array.isArray(catalogValue) ? catalogValue[0] : catalogValue;
  if (!catalog || typeof catalog !== "object") return null;
  const { image_url: url, image_kind: kind } = catalog as {
    image_url?: unknown;
    image_kind?: unknown;
  };
  if (typeof url !== "string" || typeof kind !== "string") return null;
  if (!(IMAGE_KINDS as readonly string[]).includes(kind)) return null;
  return { url, kind: kind as XWinesImageKind };
}
