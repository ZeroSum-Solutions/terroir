import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Star } from "lucide-react";
import { StatusChip } from "@/components/status-chip";
import { WineThumb } from "@/components/wine-thumb";
import type {
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
  profile: XWinesProfile | null;
  vintageRatings: VintageRating[];
};

// The hero's candlelight: a warm pool behind the bottle that reads as a lit
// alcove on the dark room's lacquer and as low sun on the light room's cream.
// Written against the theme variables so it retints with the mode rather than
// needing a second, hardcoded palette.
const HERO_GLOW = {
  backgroundImage:
    "radial-gradient(60% 55% at 22% 42%, color-mix(in oklab, var(--t-accent) 22%, transparent) 0%, transparent 70%)",
} as const;

export function WineDetailView({
  wine,
  bottleCount,
  locations,
  profile,
  vintageRatings,
}: WineDetailViewProps) {
  const facets = [wine.country, wine.region, profile?.type ?? null, wine.varietal].filter(
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

        {/* ── Hero ─────────────────────────────────────────────────── */}
        <header
          className="relative mt-md grid gap-xl rounded-card py-2xl md:grid-cols-[minmax(0,300px)_minmax(0,1fr)] md:gap-2xl md:py-3xl"
          style={HERO_GLOW}
        >
          <div className="flex items-center justify-center">
            {wine.hero_image_url ? (
              <Image
                src={wine.hero_image_url}
                alt={`${wine.producer} ${wine.name}`}
                width={300}
                height={480}
                priority
                className="h-auto w-[min(62vw,240px)] object-contain drop-shadow-2xl md:w-full"
              />
            ) : (
              <div className="flex h-[300px] w-[132px] items-center justify-center rounded-card border border-hairline bg-surface md:h-[380px] md:w-[168px]">
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
          </div>

          <div className="flex flex-col justify-center">
            <p className="text-caption uppercase text-accent">{wine.producer}</p>
            <h1 className="mt-sm font-serif text-heading-sm leading-[1.06] text-ink md:text-heading lg:text-display">
              {wine.name}
            </h1>
            {wine.vintage !== null && (
              <p className="mt-xs font-serif text-heading-sm text-grey">{wine.vintage}</p>
            )}

            {facets.length > 0 && (
              <ul className="mt-md flex flex-wrap items-center gap-x-sm gap-y-xs text-body-sm text-ink-soft">
                {facets.map((facet, index) => (
                  <li key={facet} className="flex items-center gap-x-sm">
                    {index > 0 && <span aria-hidden="true" className="text-hairline">·</span>}
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

        {profile === null && <NoProfileNote producer={wine.producer} />}

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
                  className="rounded-pill border border-hairline bg-surface px-md py-xs text-body-sm text-ink-soft"
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

        {(wine.tasting_notes || wine.review_excerpt) && (
          <Section title="Tasting note">
            <blockquote className="card-surface rounded-card p-lg">
              <p className="font-serif text-subheading leading-relaxed text-ink-soft">
                {wine.tasting_notes ?? wine.review_excerpt}
              </p>
              {wine.rating_source && (
                <footer className="mt-md text-caption uppercase text-grey">
                  {wine.rating_source}
                  {wine.rating != null && ` · ${wine.rating}`}
                </footer>
              )}
            </blockquote>
          </Section>
        )}

        {vintageRatings.length > 1 && (
          <Section title="Compare vintages">
            <table className="w-full border-collapse text-body-sm">
              <caption className="sr-only">
                Community rating by vintage for {profile?.matchedName}
              </caption>
              <thead>
                <tr className="border-b border-hairline text-caption uppercase text-grey">
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
                      className={`border-b border-hairline ${isThisBottle ? "bg-amber-wash" : ""}`}
                    >
                      <th
                        scope="row"
                        className={`py-sm text-left font-mono text-ledger ${isThisBottle ? "text-accent" : "text-ink"}`}
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
    <section className="border-t border-hairline pt-xl mt-xl md:pt-2xl md:mt-2xl">
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
    <div className="flex items-baseline justify-between gap-md border-b border-hairline py-md last:border-b-0 sm:odd:border-b">
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
      <Star aria-hidden="true" className="h-3.5 w-3.5 fill-accent text-accent" />
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
    <span className="rounded-pill border border-hairline bg-surface px-md py-xs text-body-sm text-ink-soft">
      {count === 0 ? "None on hand" : `${count} on hand`}
    </span>
  );
}

/**
 * The common case, stated plainly. The corpus is consumer-review breadth and a
 * restaurant list skews to trade bottlings, so most wines will not be in it —
 * saying so is better than a page of empty sections.
 */
function NoProfileNote({ producer }: { producer: string }) {
  return (
    <p className="mt-xl rounded-card border border-hairline bg-surface-sunken px-lg py-md text-body-sm text-grey">
      No reference entry matched {`${producer} `}closely enough to trust, so
      taste structure, grapes and pairings aren&rsquo;t shown for this bottle.
    </p>
  );
}
