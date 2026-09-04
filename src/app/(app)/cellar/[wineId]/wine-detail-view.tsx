import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { HouseNote } from "@/domains/notes/note-list";
import type { Badge } from "@/domains/wine-profile/badges";
import type { HouseTaste } from "@/domains/wine-profile/resolve-house-profile";
import type { ReferenceProfile } from "@/domains/wine-profile/resolve-reference-profile";
import { CORPUS_IMAGE_NOTE } from "@/lib/wine-intelligence/corpus-image";
import type { ResolvedWineFacts } from "@/lib/wine-intelligence/wine-reference-facts";
import { wineDisplayName } from "@/lib/wine-display-name";
import type { Score, Sourced } from "@/lib/provenance/sourced";
import type {
  CorpusRead,
  VintageRating,
  XWinesProfile,
} from "@/lib/wine-intelligence/xwines-profile";
import type { ReactNode } from "react";
import { Section } from "@/components/detail-sections";
import { CellarSection } from "./blocks/cellar-section";
import { CorpusUnavailableNote, NoProfileNote } from "./blocks/corpus-notes";
import { DrinkWindowBlock } from "./blocks/drink-window-block";
import { FactsSection } from "./blocks/facts-section";
import { HeroSection } from "./blocks/hero-section";
import { OperationalBadges } from "./blocks/operational-badges";
import { PairingSection } from "./blocks/pairing-section";
import { ReferenceNotes } from "./blocks/reference-notes";
import { ScorePair } from "./blocks/score-pair";
import { TasteBlock } from "./blocks/taste-block";
import type { WineRow } from "./blocks/types";
import { VintageRail, VintageUnavailableSection } from "./blocks/vintage-rail";

export type WineDetailViewProps = {
  wine: WineRow;
  bottleCount: number;
  locations: string[];
  facts: ResolvedWineFacts;
  profile: CorpusRead<XWinesProfile | null>;
  vintageRatings: CorpusRead<VintageRating[]>;
  /** The house's own palates: confirmed descriptors and score, and the notes. */
  house: { taste: Sourced<HouseTaste>; score: Sourced<Score> | null; notes: HouseNote[] };
  /** What is published about this vintage, and the corpus structure. */
  reference: ReferenceProfile;
  badges: Sourced<Badge[]>;
  currentYear: number;
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
  house,
  reference,
  badges,
  currentYear,
  notesSlot,
}: WineDetailViewProps) {
  // An unreadable corpus renders like an unmatched wine — no taste sections —
  // but says so in its own words below rather than borrowing "no match".
  const profile = profileRead.status === "ok" ? profileRead.value : null;

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

        <OperationalBadges badges={badges} />

        {profileRead.status === "unavailable" && <CorpusUnavailableNote />}
        {profileRead.status === "ok" && profileRead.value === null && (
          <NoProfileNote producer={wine.producer} />
        )}

        <TasteBlock taste={house.taste} structure={reference.structure} notes={house.notes} />

        <ScorePair house={house.score} reference={reference.score} />

        {reference.window !== null && (
          <DrinkWindowBlock window={reference.window} currentYear={currentYear} />
        )}

        {profile && profile.pairings.length > 0 && (
          <PairingSection pairings={profile.pairings} />
        )}

        <FactsSection wine={wine} profile={profile} facts={facts} />

        <ReferenceNotes notes={reference.notes} />

        {profile && ratingsRead.status === "unavailable" && <VintageUnavailableSection />}
        {ratingsRead.status === "ok" && (
          <VintageRail
            rows={{ value: ratingsRead.value, basis: { kind: "corpus", name: "X-Wines" } }}
            wineVintage={wine.vintage}
            matchedName={profile?.matchedName ?? null}
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
