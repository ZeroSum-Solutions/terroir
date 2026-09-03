import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CORPUS_IMAGE_NOTE } from "@/lib/wine-intelligence/corpus-image";
import type { ResolvedWineFacts } from "@/lib/wine-intelligence/wine-reference-facts";
import { wineDisplayName } from "@/lib/wine-display-name";
import type {
  CorpusRead,
  VintageRating,
  XWinesProfile,
} from "@/lib/wine-intelligence/xwines-profile";
import type { ReactNode } from "react";
import { Section } from "@/components/detail-sections";
import { CellarSection } from "./blocks/cellar-section";
import { CorpusUnavailableNote, NoProfileNote } from "./blocks/corpus-notes";
import { FactsSection } from "./blocks/facts-section";
import { HeroSection } from "./blocks/hero-section";
import { PairingSection } from "./blocks/pairing-section";
import { TasteAxesSection } from "./blocks/taste-axes-section";
import { TastingNoteSection } from "./blocks/tasting-note-section";
import type { WineRow } from "./blocks/types";
import { VintageSection, VintageUnavailableSection } from "./blocks/vintage-section";

export type WineDetailViewProps = {
  wine: WineRow;
  bottleCount: number;
  locations: string[];
  facts: ResolvedWineFacts;
  profile: CorpusRead<XWinesProfile | null>;
  vintageRatings: CorpusRead<VintageRating[]>;
  /**
   * The house tasting log. Passed in as a slot rather than rendered here so
   * this component stays presentational: the log is a client component that
   * uses the router, and burying it would make every test of the reference
   * sections above need an app-router mock to say anything about a hero image.
   */
  notesSlot?: ReactNode;
};

export function WineDetailView({
  wine,
  bottleCount,
  locations,
  facts,
  profile: profileRead,
  vintageRatings: ratingsRead,
  notesSlot,
}: WineDetailViewProps) {
  // An unreadable corpus renders like an unmatched wine — no taste sections —
  // but says so in its own words below rather than borrowing "no match".
  const profile = profileRead.status === "ok" ? profileRead.value : null;
  const vintageRatings = ratingsRead.status === "ok" ? ratingsRead.value : [];

  // The tenant's own photograph always outranks the corpus's: they uploaded it
  // of the bottle they actually hold. The corpus only fills a hole.
  const corpusImage = wine.hero_image_url === null ? (profile?.image ?? null) : null;
  const heroSrc = wine.hero_image_url ?? corpusImage?.url ?? null;
  const heroAlt =
    corpusImage === null || corpusImage.kind === "label"
      ? `${wine.producer} ${wineDisplayName(wine.producer, wine.name)}`
      : CORPUS_IMAGE_NOTE[corpusImage.kind];

  const facets = [facts.country, facts.region, profile?.type ?? null, facts.varietal].filter(
    (value): value is string => Boolean(value),
  );

  // The house's own note outranks a bought-in one, but only the bought-in one
  // may carry the critic's byline: attributing a sommelier's words to "Wine
  // Advocate · 95" puts a claim in someone else's mouth. Empty strings are
  // treated as absent, so a blank tasting_notes cannot win over a real excerpt
  // and leave an empty blockquote on the page.
  const houseNote = wine.tasting_notes?.trim() || null;
  const criticNote = wine.review_excerpt?.trim() || null;
  const tastingNote = houseNote ?? criticNote;
  const isCriticNote = houseNote === null && criticNote !== null;

  return (
    <div className="bg-canvas">
      <div className="mx-auto max-w-[1100px] px-lg pb-3xl">
        <Link
          href="/cellar"
          className="inline-flex items-center gap-xs pt-lg text-caption uppercase text-grey transition-colors hover:text-accent"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          The cellar
        </Link>

        <HeroSection
          wine={wine}
          profile={profile}
          bottleCount={bottleCount}
          facets={facets}
          heroSrc={heroSrc}
          heroAlt={heroAlt}
          corpusImage={corpusImage}
        />

        {profileRead.status === "unavailable" && <CorpusUnavailableNote />}
        {profileRead.status === "ok" && profileRead.value === null && (
          <NoProfileNote producer={wine.producer} />
        )}

        {profile && (profile.body || profile.acidity) && (
          <TasteAxesSection profile={profile} />
        )}

        {profile && profile.pairings.length > 0 && (
          <PairingSection pairings={profile.pairings} />
        )}

        <FactsSection wine={wine} profile={profile} facts={facts} />

        {tastingNote !== null && (
          <TastingNoteSection
            note={tastingNote}
            isCriticNote={isCriticNote}
            ratingSource={wine.rating_source}
            rating={wine.rating}
          />
        )}

        {profile && ratingsRead.status === "unavailable" && <VintageUnavailableSection />}

        {vintageRatings.length > 1 && (
          <VintageSection
            vintageRatings={vintageRatings}
            profile={profile}
            wineVintage={wine.vintage}
          />
        )}

        <CellarSection wine={wine} bottleCount={bottleCount} locations={locations} />

        {notesSlot !== undefined && (
          <Section title="House tasting notes">{notesSlot}</Section>
        )}
      </div>
    </div>
  );
}
