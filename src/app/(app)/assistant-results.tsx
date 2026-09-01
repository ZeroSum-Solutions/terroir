"use client";

// The companion's result rows, split out of assistant-panel.tsx the same way
// palette-results.tsx is split out of search-palette.tsx: the dialog owns the
// question and the request, these own how an answer looks.
//
// The two rows are deliberately NOT one component. A cellar row is stock the
// user can open; a corpus row is a suggestion they do not own — it has no
// link and no on-hand count, because saying nothing is the only honest thing
// a row can say about a bottle that isn't in the cellar.

import { WineThumb } from "@/components/wine-thumb";
import type {
  AssistantCellarWine,
  AssistantCorpusWine,
} from "@/lib/wine-intelligence/assistant-types";
import { wineTitle } from "@/lib/wine-display-name";

function Rating({ avg, count }: { avg: number | null; count: number | null }) {
  if (avg == null) return null;
  return (
    <span className="tabular">
      {avg.toFixed(1)}/5
      {count != null ? (
        <span className="text-grey"> from {count.toLocaleString()} ratings</span>
      ) : null}
    </span>
  );
}

export function CellarResult({
  wine,
  onOpen,
}: {
  wine: AssistantCellarWine;
  onOpen: () => void;
}) {
  const facts = [
    wine.grapes[0] ?? wine.varietal,
    wine.region ?? wine.country,
    wine.body,
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-sm rounded-md border border-edge px-md py-sm text-left transition-colors hover:bg-wash focus-ring"
    >
      {/* The label is the fastest way a sommelier recognises a bottle, so it
          leads the row. WineThumb rather than a bare <img>: it falls back to
          the producer's initials tinted by wine colour, which keeps the list
          even instead of ragged when a wine has no photograph. */}
      <WineThumb
        src={wine.imageUrl}
        producer={wine.producer}
        name={wine.name}
        colour={wine.colour}
        size={44}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-sm">
          <span className="text-control text-ink">
            {wineTitle(wine.producer, wine.name)}
            {wine.vintage ? ` ${wine.vintage}` : ""}
          </span>
          {wine.price != null ? (
            <span className="shrink-0 text-body-sm tabular text-ink-soft">
              ${wine.price.toFixed(0)}
            </span>
          ) : null}
        </span>
        <span className="mt-2xs flex flex-wrap items-center gap-x-sm text-ledger font-light text-grey">
          {facts.length > 0 ? <span>{facts.join(" · ")}</span> : null}
          <Rating avg={wine.ratingAvg} count={wine.ratingCount} />
          <span className={wine.onHand > 0 ? "text-ready-ink" : "text-risk-ink"}>
            {wine.onHand > 0 ? `${wine.onHand} on hand` : "none on hand"}
          </span>
        </span>
      </span>
    </button>
  );
}

export function CorpusResult({ wine }: { wine: AssistantCorpusWine }) {
  const facts = [wine.grapes[0], wine.region ?? wine.country, wine.body].filter(Boolean);
  return (
    <div className="flex items-start gap-sm rounded-md border border-edge px-md py-sm">
      <WineThumb
        src={wine.imageUrl}
        producer={wine.winery}
        name={wine.name}
        colour={wine.type}
        size={44}
      />
      <div className="min-w-0 flex-1">
        <p className="text-control text-ink">
          {wine.winery ? `${wine.winery} ` : ""}
          {wine.name}
        </p>
        <p className="mt-2xs flex flex-wrap items-center gap-x-sm text-ledger font-light text-grey">
          {facts.length > 0 ? <span>{facts.join(" · ")}</span> : null}
          <Rating avg={wine.ratingAvg} count={wine.ratingCount} />
        </p>
      </div>
    </div>
  );
}
