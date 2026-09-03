import { BasisLabel } from "@/lib/provenance/basis-label";

export type HouseNote = {
  id: string;
  body: string;
  score: number | null;
  tastedOn: string | null;
  createdAt: string;
  authorName: string | null;
  descriptors: { slug: string; label: string }[];
};

/**
 * The house's own notes on one wine, newest first.
 *
 * Every note is attributed and dated. A tasting note whose author cannot be
 * named is worth much less to the next person reading it — they cannot ask
 * the question the note raises.
 */
export function NoteList({ notes }: { notes: HouseNote[] }) {
  if (notes.length === 0) {
    return (
      <p className="text-body-sm text-grey">
        No one has written about this wine yet. The first note is the one that
        makes the rest worth reading.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-md">
      {notes.map((note) => (
        <li key={note.id} className="card-surface rounded-card p-lg">
          <div className="flex flex-wrap items-baseline justify-between gap-sm">
            <p className="text-caption uppercase tracking-[0.18em] text-grey">
              {note.authorName ?? "Someone here"}
            </p>
            {note.score !== null && (
              <p className="tabular text-ledger text-ink">{note.score}</p>
            )}
          </div>

          <p className="mt-sm font-serif text-subheading leading-relaxed text-ink-soft">
            {note.body}
          </p>

          {note.descriptors.length > 0 && (
            <ul className="mt-md flex flex-wrap gap-xs">
              {note.descriptors.map((descriptor) => (
                <li
                  key={descriptor.slug}
                  className="rounded-pill border border-rule bg-surface px-md py-2xs text-body-sm text-ink-soft"
                >
                  {descriptor.label}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-md">
            <BasisLabel basis={{ kind: "measured", asOf: note.tastedOn ?? note.createdAt }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
