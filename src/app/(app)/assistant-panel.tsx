"use client";

// The wine assistant, available on every page from the header.
//
// Everything it shows comes from /api/assistant, which reads rows and never
// generates prose (see src/lib/wine-intelligence/assistant-query.ts for the
// D-006b decision behind that). The UI's job is to keep that honesty legible:
// it shows the constraints it actually understood as chips, names any word it
// could not place, and labels corpus suggestions as NOT being cellar stock.
// A panel that quietly rendered an unfiltered list would look identical to one
// that answered the question — which is the failure worth designing against.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { MessageCircleQuestion, Search, X } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import type {
  AssistantCellarWine,
  AssistantCorpusWine,
  AssistantResponse,
} from "@/lib/wine-intelligence/assistant-types";

const EXAMPLES = [
  "a bold red that pairs with beef",
  "something under $40 for fish",
  "a blend from Argentina, $200-400, for meats",
  "a crisp white from Portugal",
];

function chipsFor(query: AssistantResponse["query"]): string[] {
  const chips: string[] = [];
  if (query.type) chips.push(query.type);
  if (query.body) chips.push(query.body);
  if (query.blend === true) chips.push("Blend");
  if (query.blend === false) chips.push("Single varietal");
  if (query.grape) chips.push(query.grape);
  if (query.region) chips.push(query.region);
  if (query.country) chips.push(query.country);
  if (query.pairing?.length) chips.push(`Pairs with ${query.pairing.join(" or ")}`);
  if (query.priceMin != null && query.priceMax != null) {
    chips.push(`$${query.priceMin}–$${query.priceMax}`);
  } else if (query.priceMax != null) {
    chips.push(`Under $${query.priceMax}`);
  } else if (query.priceMin != null) {
    chips.push(`Over $${query.priceMin}`);
  }
  return chips;
}

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Ask about your cellar"
        className="grid h-11 w-11 place-items-center rounded-pill text-ink transition-colors hover:bg-wash focus-ring"
      >
        <MessageCircleQuestion className="h-5 w-5" strokeWidth={1.75} aria-hidden />
      </button>
      {open ? <AssistantDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AssistantDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const titleId = useId();
  const inputId = useId();
  const trapRef = useRef<HTMLDivElement>(null);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssistantResponse | null>(null);
  useFocusTrap({ containerRef: trapRef, onEscape: onClose });

  // The request is keyed to the question that produced it, so a slow earlier
  // answer cannot overwrite a faster later one.
  const latest = useRef(0);

  const ask = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ticket = ++latest.current;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/assistant?q=${encodeURIComponent(trimmed)}`);
      if (ticket !== latest.current) return;
      if (!res.ok) {
        setError("That search could not be run. Try again.");
        setResult(null);
        return;
      }
      setResult((await res.json()) as AssistantResponse);
    } catch {
      if (ticket === latest.current) {
        setError("That search could not be run. Try again.");
        setResult(null);
      }
    } finally {
      if (ticket === latest.current) setPending(false);
    }
  }, []);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const chips = result ? chipsFor(result.query) : [];
  const understoodNothing = result != null && result.query.understood.length === 0;

  // Portalled to <body> because the trigger lives in the header, and the
  // header carries `.glass` — which sets backdrop-filter, and an element with
  // a backdrop-filter becomes the CONTAINING BLOCK for its position:fixed
  // descendants. Rendered in place, this dialog's `inset-0` resolved against
  // the header's own 72px-tall box instead of the viewport, so the panel was
  // squashed into the header strip. Nothing in the DOM or the tests showed
  // it: role="dialog" was present and focusable either way. Keep the portal.
  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-start justify-center bg-scrim px-md py-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        ref={trapRef}
        className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-card card-surface"
      >
        <div className="flex items-center justify-between border-b border-edge px-lg py-md">
          <h2 id={titleId} className="font-serif text-subheading font-normal text-ink">
            Ask about your cellar
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 place-items-center rounded-pill text-grey transition-colors hover:bg-wash hover:text-ink focus-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
        </div>

        <form
          className="flex items-center gap-sm px-lg pt-md"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Your question
          </label>
          <input
            id={inputId}
            autoFocus
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="a bold red that pairs with beef…"
            className="h-11 min-w-0 flex-1 rounded-pill border border-edge bg-canvas px-md text-control text-ink placeholder:text-grey focus-visible:border-accent focus-ring"
          />
          <button
            type="submit"
            disabled={pending || question.trim() === ""}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-pill bg-primary text-seal-ink transition-colors hover:bg-primary-hover disabled:opacity-40 focus-ring"
            aria-label="Ask"
          >
            <Search className="h-4 w-4" strokeWidth={2.25} aria-hidden />
          </button>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto px-lg pb-lg pt-md">
          {result == null && !pending && error == null ? (
            <div>
              <p className="text-body-sm font-light text-grey">
                Answers come from your cellar and the reference corpus — grape, body,
                pairing, community rating and price. Nothing is written by a model.
              </p>
              <ul className="mt-md flex flex-col gap-xs">
                {EXAMPLES.map((example) => (
                  <li key={example}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuestion(example);
                        void ask(example);
                      }}
                      className="w-full rounded-md border border-edge px-md py-sm text-left text-body-sm text-ink transition-colors hover:bg-wash focus-ring"
                    >
                      {example}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pending ? (
            <p className="text-body-sm font-light text-grey" role="status">
              Searching…
            </p>
          ) : null}

          {error ? (
            <p className="text-body-sm text-risk-ink" role="alert">
              {error}
            </p>
          ) : null}

          {result != null && !pending ? (
            <div>
              {chips.length > 0 ? (
                <ul className="mb-md flex flex-wrap gap-xs" aria-label="Understood as">
                  {chips.map((chip) => (
                    <li
                      key={chip}
                      className="rounded-pill bg-wash px-sm py-2xs text-ledger text-ink-soft"
                    >
                      {chip}
                    </li>
                  ))}
                </ul>
              ) : null}

              {understoodNothing ? (
                <p className="text-body-sm font-light text-grey">
                  I could not read a wine constraint in that. Try a style, a grape, a
                  country, a price or a food — for example “a bold red for lamb”.
                </p>
              ) : null}

              {result.query.unrecognized.length > 0 && !understoodNothing ? (
                // Load-bearing, not a footnote. "A red from Narnia" matches
                // every red in the cellar, and without this line that list
                // reads as an answer about Narnia. Say what was dropped
                // BEFORE the results, in the results' own type size.
                <p className="mb-md rounded-md bg-risk-wash px-md py-sm text-body-sm text-risk-ink">
                  I did not understand{" "}
                  <strong className="font-medium">
                    {result.query.unrecognized.join(", ")}
                  </strong>
                  , so {result.query.unrecognized.length > 1 ? "those were" : "that was"}{" "}
                  left out of this search.
                </p>
              ) : null}

              {result.cellar.length > 0 ? (
                <>
                  <p className="mb-sm text-ledger uppercase tracking-[0.08em] text-grey">
                    {result.cellarTotal} in your cellar
                    {result.cellarTotal > result.cellar.length
                      ? ` · showing ${result.cellar.length}`
                      : ""}
                  </p>
                  <ul className="flex flex-col gap-sm">
                    {result.cellar.map((wine) => (
                      <li key={wine.wineId}>
                        <CellarResult
                          wine={wine}
                          onOpen={() => {
                            onClose();
                            router.push(`/cellar/${wine.wineId}`);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {result.cellar.length === 0 && !understoodNothing ? (
                <p className="text-body-sm font-light text-grey">
                  Nothing in your cellar matches that.
                </p>
              ) : null}

              {result.corpus.length > 0 ? (
                <>
                  <p className="mb-sm mt-lg text-ledger uppercase tracking-[0.08em] text-grey">
                    Not in your cellar — from the reference corpus
                  </p>
                  <ul className="flex flex-col gap-sm">
                    {result.corpus.map((wine) => (
                      <li key={wine.wineId}>
                        <CorpusResult wine={wine} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

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

function CellarResult({
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
      className="w-full rounded-md border border-edge px-md py-sm text-left transition-colors hover:bg-wash focus-ring"
    >
      <span className="flex items-baseline justify-between gap-sm">
        <span className="text-control text-ink">
          {wine.producer ? `${wine.producer} ` : ""}
          {wine.name}
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
    </button>
  );
}

function CorpusResult({ wine }: { wine: AssistantCorpusWine }) {
  const facts = [wine.grapes[0], wine.region ?? wine.country, wine.body].filter(Boolean);
  return (
    <div className="rounded-md border border-edge px-md py-sm">
      <p className="text-control text-ink">
        {wine.winery ? `${wine.winery} ` : ""}
        {wine.name}
      </p>
      <p className="mt-2xs flex flex-wrap items-center gap-x-sm text-ledger font-light text-grey">
        {facts.length > 0 ? <span>{facts.join(" · ")}</span> : null}
        <Rating avg={wine.ratingAvg} count={wine.ratingCount} />
      </p>
    </div>
  );
}
