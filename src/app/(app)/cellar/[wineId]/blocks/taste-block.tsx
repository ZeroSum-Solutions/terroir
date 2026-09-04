/**
 * What this wine tastes like, in two halves with two different origins that
 * say so (spec §4.3, D15).
 *
 * The house half is confirmed descriptors from this restaurant's own notes.
 * At or above AGGREGATE_FLOOR it shows each descriptor with the number of
 * notes that mention it; below the floor it shows each note's own chips under
 * that note's author, because two palates are two palates and "Cherry ×2"
 * from two people is a consensus nobody reached.
 *
 * The structure half is body and acidity from the X-Wines corpus, with the
 * corpus's own wording. Nothing is drawn faintly: an axis the corpus does not
 * know is absent, not greyed, because a faint bar reads as data.
 */
import { AxisBar, Section } from "@/components/detail-sections";
import type { HouseNote } from "@/domains/notes/note-list";
import { AGGREGATE_FLOOR, type HouseTaste } from "@/domains/wine-profile/resolve-house-profile";
import type { CorpusStructure } from "@/domains/wine-profile/resolve-reference-profile";
import { BasisLabel } from "@/lib/provenance/basis-label";
import type { Sourced } from "@/lib/provenance/sourced";

export function TasteBlock({
  taste,
  structure,
  notes,
}: {
  taste: Sourced<HouseTaste>;
  structure: Sourced<CorpusStructure> | null;
  notes: HouseNote[];
}) {
  const hasHouse = taste.value.corpusSize > 0;
  if (!hasHouse && structure === null) return null;

  return (
    <Section title="What does this wine taste like?">
      <div className="grid gap-xl md:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        {structure !== null && (
          <div className="flex flex-col gap-lg">
            {structure.value.body && <AxisBar axis={structure.value.body} />}
            {structure.value.acidity && <AxisBar axis={structure.value.acidity} />}
            <BasisLabel basis={structure.basis} />
          </div>
        )}
        {hasHouse &&
          (taste.value.corpusSize >= AGGREGATE_FLOOR ? (
            <Aggregate taste={taste} />
          ) : (
            <PerNote notes={notes} />
          ))}
      </div>
    </Section>
  );
}

function Aggregate({ taste }: { taste: Sourced<HouseTaste> }) {
  return (
    <div className="flex flex-col gap-md">
      <ul className="flex flex-wrap gap-sm">
        {taste.value.descriptors.map((d) => (
          <li key={d.slug}>
            <Chip label={d.label} count={d.notes} />
          </li>
        ))}
      </ul>
      <BasisLabel basis={taste.basis} />
    </div>
  );
}

function PerNote({ notes }: { notes: HouseNote[] }) {
  const withChips = notes.filter((n) => n.descriptors.length > 0);
  return (
    <div className="flex flex-col gap-md">
      {withChips.map((n) => (
        <div key={n.id} className="flex flex-col gap-xs">
          <p className="text-caption uppercase text-grey">
            {n.authorName ?? (n.attributed ? "A colleague" : "Cellar record")}
          </p>
          <ul className="flex flex-wrap gap-sm">
            {n.descriptors.map((d) => (
              <li key={d.slug}>
                <Chip label={d.label} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="text-body-sm text-grey">
        {notes.length} {notes.length === 1 ? "note" : "notes"} so far. The house
        aggregate appears at {AGGREGATE_FLOOR}.
      </p>
    </div>
  );
}

/** Achromatic on purpose: no per-family colour (D10). */
function Chip({ label, count }: { label: string; count?: number }) {
  return (
    <span className="inline-flex items-baseline gap-xs rounded-pill border border-rule bg-surface px-md py-xs text-body-sm text-ink-soft">
      {label}
      {count !== undefined && <span className="tabular text-caption text-grey">{count}</span>}
    </span>
  );
}
