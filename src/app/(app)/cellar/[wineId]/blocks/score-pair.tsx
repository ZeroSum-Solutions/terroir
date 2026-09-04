/**
 * The house score and the reference score, side by side, each on its own
 * scale and under its own basis.
 *
 * The scale is printed every time. X-Wines averages are 1–5 and critics are on
 * 100, and a pair that shows "4.2" beside "88" with nothing else is read as
 * 4.2 out of 100 by anyone moving quickly — which on a wine page is everyone.
 *
 * Ordinary ink, no colour ramp (D16): a 98 in a warm hue would compete with
 * the window-risk tokens in the same hue with the opposite meaning.
 */
import { Section } from "@/components/detail-sections";
import { BasisLabel } from "@/lib/provenance/basis-label";
import type { Score, Sourced } from "@/lib/provenance/sourced";

export function ScorePair({
  house,
  reference,
}: {
  house: Sourced<Score> | null;
  reference: Sourced<Score> | null;
}) {
  // Nothing rather than a heading over an empty row.
  if (house === null && reference === null) return null;

  return (
    <Section title="Score">
      <dl className="grid gap-lg sm:grid-cols-2">
        {house !== null && <OneScore label="This house" score={house} />}
        {reference !== null && <OneScore label="Published" score={reference} />}
      </dl>
    </Section>
  );
}

function OneScore({ label, score }: { label: string; score: Sourced<Score> }) {
  return (
    <div className="card-surface flex flex-col gap-xs rounded-card px-lg py-md">
      <dt className="text-caption uppercase text-grey">{label}</dt>
      <dd className="flex items-baseline gap-xs">
        <span className="font-serif text-heading text-ink">{score.value.n}</span>
        <span className="text-body-sm text-grey">/ {score.value.scale}</span>
      </dd>
      <dd>
        <BasisLabel basis={score.basis} />
      </dd>
    </div>
  );
}
