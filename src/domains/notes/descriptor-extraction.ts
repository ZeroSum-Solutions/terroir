/**
 * Suggests descriptors from a note's prose.
 *
 * This module NEVER writes. It returns slugs for the composer to pre-select,
 * and a human tap is what promotes a suggestion into a stored, counted
 * `confirmed` row. That separation is the whole reason a mention count can be
 * trusted: an untouched inference is a model's vote, not a mention, and it
 * never reaches a tally. See D3 and D11 in
 * docs/superpowers/specs/2026-09-03-wine-page-design.md.
 *
 * Every failure path returns an empty array. A suggestion is a convenience —
 * if the model is down, slow, or talking nonsense, the sommelier must still be
 * able to write their note and tick the chips by hand.
 */
import { getAnthropicClient } from "@/lib/ai/anthropic-client";
import { DESCRIPTOR_SUGGESTION } from "@/lib/ai/models";

/** Enough prose to characterise a tasting note; a wall of text is a paste accident. */
const MAX_PROSE_CHARS = 2_000;

export type VocabularyTerm = { slug: string; label: string };

export type SuggestDeps = {
  /** Injectable so tests never reach the network. */
  complete: (prompt: string) => Promise<string>;
};

export async function suggestDescriptors(
  body: string,
  vocabulary: VocabularyTerm[],
  deps: SuggestDeps = { complete: defaultComplete },
): Promise<string[]> {
  const prose = body.trim();
  if (prose.length === 0 || vocabulary.length === 0) return [];

  const prompt = buildPrompt(prose.slice(0, MAX_PROSE_CHARS), vocabulary);

  let raw: string;
  try {
    raw = await deps.complete(prompt);
  } catch {
    return [];
  }

  const parsed = parseSlugArray(raw);
  if (parsed === null) return [];

  // Filter against the vocabulary rather than trusting the answer. A model
  // asked for slugs will occasionally invent one, and an invented slug
  // violates the foreign key at write time — after the note row exists.
  const known = new Set(vocabulary.map((v) => v.slug));
  return [...new Set(parsed.filter((slug) => known.has(slug)))];
}

function buildPrompt(prose: string, vocabulary: VocabularyTerm[]): string {
  const list = vocabulary.map((v) => `${v.slug} (${v.label})`).join("\n");
  return [
    "You are reading one sommelier's tasting note.",
    "",
    "Return a JSON array of the slugs below that the note actually describes.",
    "Use only slugs from this list. Return [] if none apply. No prose, no fences.",
    "",
    "Slugs:",
    list,
    "",
    "Note:",
    prose,
  ].join("\n");
}

/**
 * Returns null when the response is not a JSON array of strings. Tolerates a
 * markdown fence, because models add them whatever the instruction says, but
 * deliberately does NOT try to pull slugs out of prose: a model that answered
 * in sentences did not follow the contract, and guessing at its meaning is how
 * an unasked-for descriptor ends up pre-ticked in front of a busy sommelier.
 */
function parseSlugArray(raw: string): string[] | null {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!unfenced.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(unfenced);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((v) => typeof v === "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

async function defaultComplete(prompt: string): Promise<string> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: DESCRIPTOR_SUGGESTION.model,
    max_tokens: DESCRIPTOR_SUGGESTION.maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  return block && block.type === "text" ? block.text : "";
}
