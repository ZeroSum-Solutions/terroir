"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import { DESCRIPTOR_FAMILIES, type DescriptorFamily } from "./descriptor-families";

export type ComposerTerm = { slug: string; label: string; family: string };

export type NoteDraft = {
  body: string;
  score: number | null;
  tastedOn: string | null;
  confirmedSlugs: string[];
};

type NoteComposerProps = {
  vocabulary: ComposerTerm[];
  onSave: (draft: NoteDraft) => Promise<void>;
  suggest: (body: string) => Promise<string[]>;
};

/**
 * Writes one house tasting note.
 *
 * The chips the author leaves ticked are what gets stored and counted. A
 * suggestion pre-ticks them; it never stores anything by itself. See D3 and
 * D11 in docs/superpowers/specs/2026-09-03-wine-page-design.md.
 */
export function NoteComposer({ vocabulary, onSave, suggest }: NoteComposerProps) {
  const [body, setBody] = useState("");
  const [score, setScore] = useState("");
  const [tastedOn, setTastedOn] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grouped = DESCRIPTOR_FAMILIES.map((family) => ({
    family,
    terms: vocabulary.filter((term) => term.family === family),
  })).filter((group) => group.terms.length > 0);

  function toggle(slug: string) {
    setSelected((current) =>
      current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug],
    );
  }

  async function handleSuggest() {
    if (body.trim().length === 0) return;
    setSuggesting(true);
    try {
      const suggestions = await suggest(body);
      // Union, never replacement: a chip the author ticked by hand outranks
      // the model and must not be cleared by asking for suggestions again.
      setSelected((current) => [...new Set([...current, ...suggestions])]);
    } catch {
      // Suggestion is a convenience. Its failure is not worth a message and
      // must never block the save.
    } finally {
      setSuggesting(false);
    }
  }

  async function handleSave() {
    if (body.trim().length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        body: body.trim(),
        score: score.trim() === "" ? null : Number(score),
        tastedOn: tastedOn.trim() === "" ? null : tastedOn,
        // Ordered by the vocabulary rather than by tap order, so the same set
        // of chips always produces the same array.
        confirmedSlugs: vocabulary.map((t) => t.slug).filter((s) => selected.includes(s)),
      });
      setBody("");
      setScore("");
      setTastedOn("");
      setSelected([]);
    } catch {
      // Everything the author typed stays exactly where it is. Losing a note
      // because the network blinked is not a recoverable experience.
      setError("Could not save that note. It is still here — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card-surface rounded-card p-lg">
      <Field id="note-body" label="Note">
        {(a11y) => (
          <textarea
            {...a11y}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            className="mt-xs w-full rounded-card border border-rule bg-surface px-md py-sm text-body text-ink focus-ring"
            placeholder="What does it taste like tonight?"
          />
        )}
      </Field>

      <div className="mt-md flex flex-wrap gap-sm">
        <button
          type="button"
          onClick={handleSuggest}
          disabled={suggesting || body.trim().length === 0}
          className="inline-flex min-h-[44px] items-center rounded-pill border border-rule bg-surface px-lg text-body-sm text-ink hover:bg-wash focus-ring disabled:opacity-50"
        >
          {suggesting ? "Reading…" : "Suggest descriptors"}
        </button>
      </div>

      <fieldset className="mt-lg border-0 p-0">
        <legend className="text-caption uppercase tracking-[0.18em] text-grey">
          Descriptors
        </legend>
        {grouped.map((group) => (
          <div key={group.family} className="mt-md">
            <p className="text-caption uppercase tracking-[0.18em] text-grey">
              {familyLabel(group.family)}
            </p>
            <div className="mt-xs flex flex-wrap gap-sm">
              {group.terms.map((term) => (
                <label
                  key={term.slug}
                  className="inline-flex min-h-[44px] cursor-pointer items-center gap-xs rounded-pill border border-rule bg-surface px-md text-body-sm text-ink-soft has-[:checked]:border-accent has-[:checked]:text-ink"
                >
                  <input
                    type="checkbox"
                    value={term.slug}
                    checked={selected.includes(term.slug)}
                    onChange={() => toggle(term.slug)}
                    className="h-4 w-4 accent-[var(--t-accent)]"
                  />
                  {term.label}
                </label>
              ))}
            </div>
          </div>
        ))}
      </fieldset>

      <div className="mt-lg grid gap-md sm:grid-cols-2">
        <Field id="note-score" label="Score (optional)">
          {(a11y) => (
            <input
              {...a11y}
              type="number"
              min={50}
              max={100}
              value={score}
              onChange={(event) => setScore(event.target.value)}
              className="mt-xs h-[44px] w-full rounded-card border border-rule bg-surface px-md tabular text-ink focus-ring"
            />
          )}
        </Field>
        <Field id="note-tasted-on" label="Tasted on (optional)">
          {(a11y) => (
            <input
              {...a11y}
              type="date"
              value={tastedOn}
              onChange={(event) => setTastedOn(event.target.value)}
              className="mt-xs h-[44px] w-full rounded-card border border-rule bg-surface px-md tabular text-ink focus-ring"
            />
          )}
        </Field>
      </div>

      {error !== null && (
        <p role="alert" className="mt-md text-body-sm text-risk-ink">{error}</p>
      )}

      <div className="mt-lg">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || body.trim().length === 0}
          className="inline-flex min-h-[44px] items-center rounded-pill bg-primary px-xl text-body-sm font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save note"}
        </button>
      </div>
    </div>
  );
}

const FAMILY_LABELS: Record<DescriptorFamily, string> = {
  fruit: "Fruit",
  floral: "Floral",
  herbal: "Herbal",
  oak: "Oak",
  earth: "Earth",
  spice: "Spice",
  fault: "Faults",
};

function familyLabel(family: string) {
  return FAMILY_LABELS[family as DescriptorFamily] ?? family;
}
