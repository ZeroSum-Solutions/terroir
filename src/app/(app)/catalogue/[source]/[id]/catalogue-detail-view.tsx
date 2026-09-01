import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { AxisBar, CommunityRating, Fact, Section } from "@/components/detail-sections";
import { WineThumb } from "@/components/wine-thumb";
import { CORPUS_IMAGE_NOTE } from "@/lib/wine-intelligence/corpus-image";
import { catalogueWineTitle } from "@/lib/wine-display-name";
import type {
  CorpusRead,
  XWinesProfile,
} from "@/lib/wine-intelligence/xwines-profile";
import { CatalogueAddButton, type CatalogueAddPayload } from "./catalogue-add-button";

// P1 slice 2b — the catalogue detail view (program plan D4: "catalogue rows
// get a detail view rendered from canonical facts; add is one action on it").
//
// Until P2's canonical facts layer lands, this renders what the interim
// contract can honestly show: the reference identity, plus any X-Wines
// features an ACCEPTED P0 link stands behind — and it says out loud what it
// does not know. A catalogue wine has no tenant facts (stock, bins, pricing,
// vintage-specific detail) BY DEFINITION, and an unlinked one has no taste
// data either; both absences are stated rather than left as suspicious blank
// space, because a blank section reads as "this wine has nothing", which is
// a claim nobody verified.

export type CatalogueDetailViewProps = {
  identity: {
    lwinId: string | null;
    xwinesWineId: number | null;
    name: string;
    producer: string | null;
    region: string | null;
    country: string | null;
    colour: string | null;
    type: string | null;
    varietal: string | null;
  };
  profile: CorpusRead<XWinesProfile | null>;
  /** Present exactly when an LWIN identity backs an add — never provisional. */
  addPayload: CatalogueAddPayload | null;
};

export function CatalogueDetailView({
  identity,
  profile: profileRead,
  addPayload,
}: CatalogueDetailViewProps) {
  const profile = profileRead.status === "ok" ? profileRead.value : null;

  const title = catalogueWineTitle(identity.producer, identity.name);
  const image = profile?.image ?? null;
  const imageAlt = image === null || image.kind === "label" ? title : CORPUS_IMAGE_NOTE[image.kind];

  const facets = [
    identity.country,
    identity.region,
    profile?.type ?? identity.type ?? identity.colour,
    identity.varietal,
  ].filter((value): value is string => Boolean(value));

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

        <header className="mt-md grid gap-xl rounded-card py-2xl md:grid-cols-[minmax(0,300px)_minmax(0,1fr)] md:gap-2xl">
          <div className="flex flex-col items-center justify-center gap-sm">
            {image !== null ? (
              /* unoptimized for the same reason every corpus image render is:
                 next.config.ts declares no images.remotePatterns, so the
                 optimizer would refuse the Storage URL outright. */
              <Image
                src={image.url}
                alt={imageAlt}
                width={300}
                height={480}
                priority
                unoptimized
                className="h-auto w-[min(62vw,240px)] object-contain drop-shadow-2xl md:w-full"
              />
            ) : (
              <WineThumb
                src={null}
                producer={identity.producer ?? ""}
                name={identity.name}
                colour={identity.colour ?? profile?.type ?? null}
                size={120}
              />
            )}
            {/* Every corpus picture is captioned in VISIBLE text, exactly as
                the cellar detail page does: only a "label" kind is this
                wine's own label, and an uncaptioned stand-in at hero size is
                a visual claim the corpus never made. */}
            {image !== null && (
              <p className="max-w-[240px] text-center text-caption text-grey md:max-w-full">
                {CORPUS_IMAGE_NOTE[image.kind]}
                {image.credit !== null && <span className="block">{image.credit}</span>}
              </p>
            )}
          </div>

          <div className="flex flex-col justify-center">
            <p className="text-caption uppercase text-grey">From the catalogue</p>
            <h1 className="mt-xs font-serif text-heading text-ink">{title}</h1>

            {facets.length > 0 && (
              <ul className="mt-md flex flex-wrap items-center gap-x-sm gap-y-xs text-body-sm text-ink-soft">
                {facets.map((facet, index) => (
                  <li key={facet} className="flex items-center gap-x-sm">
                    {index > 0 && <span aria-hidden="true" className="text-rule">·</span>}
                    {facet}
                  </li>
                ))}
              </ul>
            )}

            {/* The reference identity, on display: which corpora stand behind
                this page is the claim everything below rests on. */}
            <ul className="mt-md flex flex-wrap gap-xs" aria-label="Reference identity">
              {identity.lwinId !== null && (
                <li className="rounded-pill border border-edge px-sm py-[2px] text-ledger text-grey">
                  LWIN {identity.lwinId}
                </li>
              )}
              {(identity.xwinesWineId !== null || profile !== null) && (
                <li className="rounded-pill border border-edge px-sm py-[2px] text-ledger text-grey">
                  X-Wines
                </li>
              )}
            </ul>

            <div className="mt-lg flex flex-wrap items-center gap-md">
              {profile?.ratingAvg != null && (
                <CommunityRating avg={profile.ratingAvg} count={profile.ratingCount} />
              )}
              {addPayload !== null ? (
                <CatalogueAddButton payload={addPayload} />
              ) : (
                <p className="text-body-sm font-light text-grey">
                  This wine can&rsquo;t be added to your cellar yet — no LWIN
                  identity is linked to it, and adding it under a guessed one
                  would put a wrong wine in your records.
                </p>
              )}
            </div>
          </div>
        </header>

        {profileRead.status === "unavailable" && (
          <p className="mt-xl rounded-card border border-rule bg-surface-sunken px-lg py-md text-body-sm text-grey">
            The reference corpus couldn&rsquo;t be reached, so the taste
            structure, grapes and pairings linked to this wine aren&rsquo;t
            shown. That&rsquo;s a problem at our end rather than a gap in the
            reference — try again shortly.
          </p>
        )}
        {profileRead.status === "ok" && profileRead.value === null && (
          <p className="mt-xl rounded-card border border-rule bg-surface-sunken px-lg py-md text-body-sm text-grey">
            No linked X-Wines entry yet, so taste structure, grapes, pairings
            and community ratings are unknown for this wine — unknown, not
            blank: nobody has verified them either way.
          </p>
        )}

        {profile && (profile.body || profile.acidity) && (
          <Section title="What does this wine taste like?">
            <div className="grid gap-xl md:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
              <div className="flex flex-col gap-lg">
                {profile.body && <AxisBar axis={profile.body} />}
                {profile.acidity && <AxisBar axis={profile.acidity} />}
              </div>
              <p className="text-body-sm text-grey">
                Structure for{" "}
                <span className="text-ink-soft">{profile.matchedName}</span>{" "}
                from the X-Wines reference corpus. It describes body and acidity
                only — tannin and sweetness aren&rsquo;t recorded, so they
                aren&rsquo;t shown.
              </p>
            </div>
          </Section>
        )}

        {profile && profile.pairings.length > 0 && (
          <Section title="Food that goes well with this wine">
            <ul className="flex flex-wrap gap-sm">
              {profile.pairings.map((pairing) => (
                <li
                  key={pairing}
                  className="rounded-pill border border-rule bg-surface px-md py-xs text-body-sm text-ink-soft"
                >
                  {pairing}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Facts about the wine">
          <dl className="card-surface grid gap-0 rounded-card px-lg py-xs sm:grid-cols-2 sm:gap-x-2xl">
            <Fact label="Producer" value={identity.producer} />
            <Fact label="Grapes" value={profile?.grapes.join(", ") || identity.varietal} />
            <Fact
              label="Region"
              value={[identity.region, identity.country].filter(Boolean).join(", ") || null}
            />
            <Fact label="Style" value={profile?.elaborate ?? profile?.type ?? identity.type} />
            <Fact
              label="Alcohol"
              value={profile?.abv != null ? `${profile.abv}%` : null}
            />
            {profile?.website && (
              <Fact
                label="Winery"
                value={
                  <a
                    href={profile.website}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-xs text-accent hover:underline"
                  >
                    {profile.matchedWinery ?? identity.producer}
                    <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                  </a>
                }
              />
            )}
          </dl>
        </Section>

        <Section title="Not in your cellar">
          <p className="text-body-sm text-grey">
            This is a catalogue wine — stock, bins, pricing and vintage-specific
            details exist only for wines in your cellar, so none are shown here.
            {addPayload !== null && " Add it and they start accruing."}
          </p>
        </Section>
      </div>
    </div>
  );
}
