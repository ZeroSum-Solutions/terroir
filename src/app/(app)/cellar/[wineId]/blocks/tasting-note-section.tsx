import { Section } from "@/components/detail-sections";

export function TastingNoteSection({
  note,
  isCriticNote,
  ratingSource,
  rating,
}: {
  note: string;
  isCriticNote: boolean;
  ratingSource: string | null;
  rating: number | null;
}) {
  return (
    <Section title="Tasting note">
      <blockquote className="card-surface rounded-card p-lg">
        <p className="font-serif text-subheading leading-relaxed text-ink-soft">
          {note}
        </p>
        {isCriticNote && ratingSource && (
          <footer className="mt-md text-caption uppercase text-grey">
            {ratingSource}
            {rating != null && ` · ${rating}`}
          </footer>
        )}
      </blockquote>
    </Section>
  );
}
