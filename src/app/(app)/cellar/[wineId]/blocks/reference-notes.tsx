/**
 * What published sources say about this vintage, each quote under its own
 * source and the date it was read. There is no unattributed quote: the
 * reference resolver only returns notes it can cite, and a blank body is
 * dropped there rather than rendered as an empty blockquote.
 */
import { Section } from "@/components/detail-sections";
import { BasisLabel } from "@/lib/provenance/basis-label";
import type { Sourced } from "@/lib/provenance/sourced";

export function ReferenceNotes({ notes }: { notes: Sourced<string>[] }) {
  if (notes.length === 0) return null;
  return (
    <Section title="What others have published">
      <div className="flex flex-col gap-md">
        {notes.map((note, index) => (
          <blockquote key={index} className="card-surface rounded-card p-lg">
            <p className="font-serif text-subheading leading-relaxed text-ink-soft">{note.value}</p>
            <footer className="mt-md">
              <BasisLabel basis={note.basis} />
            </footer>
          </blockquote>
        ))}
      </div>
    </Section>
  );
}
