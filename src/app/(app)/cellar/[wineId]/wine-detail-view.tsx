import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Star } from "lucide-react";
import { StatusChip } from "@/components/status-chip";
import { WineThumb } from "@/components/wine-thumb";
import { CORPUS_IMAGE_NOTE } from "@/lib/wine-intelligence/corpus-image";
import { wineDisplayName } from "@/lib/wine-display-name";
import type {
  CorpusRead,
  TasteAxis,
  VintageRating,
  XWinesProfile,
} from "@/lib/wine-intelligence/xwines-profile";

type WineRow = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
  size_ml: number | null;
  colour: string | null;
  hero_image_url: string | null;
  tasting_notes: string | null;
  is_eightysixed: boolean;
  retail_min: number | null;
  retail_max: number | null;
  retail_median: number | null;
  retail_retailer_count: number | null;
  rating: number | null;
  rating_source: string | null;
  review_excerpt: string | null;
};

export type WineDetailViewProps = {
  wine: WineRow;
  bottleCount: number;
  locations: string[];
  profile: CorpusRead<XWinesProfile | null>;
  vintageRatings: CorpusRead<VintageRating[]>;
};

// The hero's candlelight: a warm pool behind the bottle that reads as a lit
// alcove. It is drawn with the `mark` — champagne in Nocturne, claret in
// Daylight — because that is the one warm value in the system. `accent` is
// bone in the dark room and would light the alcove in white.
const HERO_GLOW = {
  backgroundImage:
    "radial-gradient(60% 55% at 22% 42%, color-mix(in oklab, var(--t-mark) 22%, transparent) 0%, transparent 70%)",
} as const;

export function WineDetailView({
  wine,
  bottleCount,
  locations,
  profile: profileRead,
  vintageRatings: ratingsRead,
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

  const facets = [wine.country, wine.region, profile?.type ?? null, wine.varietal].filter(
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

        {/* ── Hero ─────────────────────────────────────────────────── */}
        <header
          className="relative mt-md grid gap-xl rounded-card py-2xl md:grid-cols-[minmax(0,300px)_minmax(0,1fr)] md:gap-2xl md:py-3xl"
          style={HERO_GLOW}
        >
          <div className="flex flex-col items-center justify-center gap-sm">
            {heroSrc !== null ? (
              /* unoptimized, as every other hero_image_url render does
                 (wine-detail-drawer, WineThumb): the URL is an absolute
                 Supabase Storage one and next.config.ts declares no
                 images.remotePatterns, so the optimizer would refuse it and
                 the page would throw for any wine that HAS a picture. */
              <Image
                src={heroSrc}
                alt={heroAlt}
                width={300}
                height={480}
                priority
                unoptimized
                className="h-auto w-[min(62vw,240px)] object-contain drop-shadow-2xl md:w-full"
              />
            ) : (
              <div className="flex h-[300px] w-[132px] items-center justify-center rounded-card border border-rule bg-surface md:h-[380px] md:w-[168px]">
                <WineThumb
                  src={null}
                  colour={wine.colour}
                  producer={wine.producer}
                  name={wine.name}
                  size={96}
                  className="rounded-pill"
                />
              </div>
            )}
            {corpusImage !== null && (
              <p className="max-w-[240px] text-center text-caption text-grey md:max-w-full">
                {CORPUS_IMAGE_NOTE[corpusImage.kind]}
                {corpusImage.credit !== null && (
                  <span className="block">{corpusImage.credit}</span>
                )}
              </p>
            )}
          </div>

          <div className="flex flex-col justify-center">
            <p className="text-caption uppercase text-mark">{wine.producer}</p>
            <h1 className="mt-sm font-serif text-heading-sm leading-[1.06] text-ink md:text-heading lg:text-display">
              {wineDisplayName(wine.producer, wine.name)}
            </h1>
            {wine.vintage !== null && (
              <p className="mt-xs font-serif text-heading-sm text-grey">{wine.vintage}</p>
            )}

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

            <div className="mt-lg flex flex-wrap items-center gap-md">
              {profile?.ratingAvg != null && (
                <CommunityRating avg={profile.ratingAvg} count={profile.ratingCount} />
              )}
              <StockBadge count={bottleCount} />
              {wine.is_eightysixed && <StatusChip tone="urgent">86&rsquo;d</StatusChip>}
            </div>
          </div>
        </header>

        {profileRead.status === "unavailable" && <CorpusUnavailableNote />}
        {profileRead.status === "ok" && profileRead.value === null && (
          <NoProfileNote producer={wine.producer} />
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
            <Fact label="Producer" value={wine.producer} />
            <Fact label="Grapes" value={profile?.grapes.join(", ") || wine.varietal} />
            <Fact
              label="Region"
              value={[wine.region, wine.country].filter(Boolean).join(", ") || null}
            />
            <Fact label="Style" value={profile?.elaborate ?? profile?.type ?? null} />
            <Fact
              label="Alcohol"
              value={profile?.abv != null ? `${profile.abv}%` : null}
            />
            <Fact
              label="Bottle"
              value={wine.size_ml != null ? `${wine.size_ml} ml` : null}
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
                    {profile.matchedWinery ?? wine.producer}
                    <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                  </a>
                }
              />
            )}
          </dl>
        </Section>

        {tastingNote !== null && (
          <Section title="Tasting note">
            <blockquote className="card-surface rounded-card p-lg">
              <p className="font-serif text-subheading leading-relaxed text-ink-soft">
                {tastingNote}
              </p>
              {isCriticNote && wine.rating_source && (
                <footer className="mt-md text-caption uppercase text-grey">
                  {wine.rating_source}
                  {wine.rating != null && ` · ${wine.rating}`}
                </footer>
              )}
            </blockquote>
          </Section>
        )}

        {profile && ratingsRead.status === "unavailable" && (
          <Section title="Compare vintages">
            <p className="text-body-sm text-grey">
              Per-vintage ratings couldn&rsquo;t be read just now. This is a
              problem at our end, not a wine without ratings — try again
              shortly.
            </p>
          </Section>
        )}

        {vintageRatings.length > 1 && (
          <Section title="Compare vintages">
            <table className="w-full border-collapse text-body-sm">
              <caption className="sr-only">
                Community rating by vintage for {profile?.matchedName}
              </caption>
              <thead>
                <tr className="border-b border-rule text-caption uppercase text-grey">
                  <th scope="col" className="py-sm text-left font-medium">Vintage</th>
                  <th scope="col" className="py-sm text-left font-medium">Rating</th>
                  <th scope="col" className="py-sm text-right font-medium">Ratings</th>
                </tr>
              </thead>
              <tbody>
                {vintageRatings.map((row) => {
                  const isThisBottle = row.vintage === wine.vintage;
                  return (
                    <tr
                      key={row.vintage}
                      className={`border-b border-rule ${isThisBottle ? "bg-risk-wash" : ""}`}
                    >
                      <th
                        scope="row"
                        className={`py-sm text-left font-mono text-ledger ${isThisBottle ? "text-mark" : "text-ink"}`}
                      >
                        {row.vintage}
                        {isThisBottle && (
                          <span className="ml-sm text-caption uppercase">Yours</span>
                        )}
                      </th>
                      <td className="py-sm">
                        <Stars value={row.ratingAvg} />
                      </td>
                      <td className="py-sm text-right font-mono text-ledger text-grey">
                        {row.ratingCount.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Section>
        )}

        <Section title="In your cellar">
          <dl className="card-surface grid gap-0 rounded-card px-lg py-xs sm:grid-cols-2 sm:gap-x-2xl">
            <Fact
              label="Bottles on hand"
              value={bottleCount === 0 ? "None" : `${bottleCount}`}
            />
            <Fact label="Stored" value={locations.join(", ") || null} />
            <Fact
              label="Retail range"
              value={
                wine.retail_min != null && wine.retail_max != null
                  ? `$${wine.retail_min} – $${wine.retail_max}`
                  : null
              }
            />
            <Fact
              label="Retail median"
              value={
                wine.retail_median != null
                  ? `$${wine.retail_median}` +
                    (wine.retail_retailer_count
                      ? ` from ${wine.retail_retailer_count} retailers`
                      : "")
                  : null
              }
            />
          </dl>
        </Section>
      </div>
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-rule pt-xl mt-xl md:pt-2xl md:mt-2xl">
      <h2 className="mb-lg font-serif text-heading-sm text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Fact({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode | null;
}) {
  if (value === null || value === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-md border-b border-rule py-md last:border-b-0 sm:odd:border-b">
      <dt className="text-caption uppercase text-grey">{label}</dt>
      <dd className="text-right text-body-sm text-ink">{value}</dd>
    </div>
  );
}

/**
 * A taste axis. The corpus's own word for the value is shown alongside the bar
 * so the position is never the only claim being made — a reader who distrusts
 * a bar can still read "Very full-bodied".
 */
function AxisBar({ axis }: { axis: TasteAxis }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-caption uppercase text-grey">
        <span>{axis.low}</span>
        <span className="text-ink-soft">{axis.label}</span>
        <span>{axis.high}</span>
      </div>
      <div
        className="mt-sm h-1.5 rounded-pill bg-surface-sunken"
        role="img"
        aria-label={`${axis.label}, between ${axis.low} and ${axis.high}`}
      >
        <div
          className="h-full rounded-pill bg-primary"
          style={{ width: `${Math.round(axis.position * 100)}%` }}
        />
      </div>
    </div>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-xs">
      <Star aria-hidden="true" className="h-3.5 w-3.5 fill-mark text-mark" />
      <span className="font-mono text-ledger text-ink">{value.toFixed(1)}</span>
    </span>
  );
}

function CommunityRating({ avg, count }: { avg: number; count: number }) {
  return (
    <div className="flex items-baseline gap-sm">
      <span className="font-serif text-heading text-ink">{avg.toFixed(1)}</span>
      <span className="text-body-sm text-grey">
        from {count.toLocaleString()} ratings
      </span>
    </div>
  );
}

function StockBadge({ count }: { count: number }) {
  return (
    <span className="rounded-pill border border-rule bg-surface px-md py-xs text-body-sm text-ink-soft">
      {count === 0 ? "None on hand" : `${count} on hand`}
    </span>
  );
}

/**
 * The other reason the taste sections are missing. Kept distinct from
 * NoProfileNote on purpose: "we looked and this wine isn't in the reference"
 * is a fact about the wine, and saying it during an outage is a lie that
 * repeats itself on every reload.
 */
function CorpusUnavailableNote() {
  return (
    <p className="mt-xl rounded-card border border-rule bg-surface-sunken px-lg py-md text-body-sm text-grey">
      The reference corpus couldn&rsquo;t be reached, so taste structure, grapes
      and pairings aren&rsquo;t shown for this bottle. That&rsquo;s a problem at
      our end rather than a gap in the reference — try again shortly.
    </p>
  );
}

/**
 * The common case, stated plainly. The corpus is consumer-review breadth and a
 * restaurant list skews to trade bottlings, so most wines will not be in it —
 * saying so is better than a page of empty sections.
 *
 * BUG-01, from the other side. The same CSV import that embedded producers in
 * `name` also left 321 production wines — 23% of that cellar — with an EMPTY
 * `producer`, and migration `0137` deliberately left them empty rather than
 * guess. Naming that blank put a hole in the sentence: "No reference entry
 * matched  closely enough to trust", with two spaces where the winery should
 * be. With no producer to name, the sentence names the bottle instead — the
 * phrasing CorpusUnavailableNote above already uses for the same shortfall.
 */
function NoProfileNote({ producer }: { producer: string }) {
  const subject = producer.trim();
  return (
    <p className="mt-xl rounded-card border border-rule bg-surface-sunken px-lg py-md text-body-sm text-grey">
      No reference entry matched {subject === "" ? "this wine" : subject}{" "}
      closely enough to trust, so taste structure, grapes and pairings
      aren&rsquo;t shown for this bottle.
    </p>
  );
}
