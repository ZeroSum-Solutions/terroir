import type { BottleCandidate, BottleField } from "@/lib/scanner/types";

/**
 * Below this self-assessed confidence, one-tap Confirm isn't worth
 * offering. It sits well under the "heavily obscured, significant
 * guessing" band BOTTLE_SYSTEM_PROMPT still trusts for a one-tap save
 * (<0.50) — reserved for results where the model found essentially
 * nothing to go on, most commonly a non-wine photo. A UX guard on top
 * of the model's own number, not a claim we've measured its accuracy.
 */
export const CONFIRM_CONFIDENCE_FLOOR = 0.1;

/** Every field the model can flag as identity-sensitive (bottle-schema.ts). */
const IDENTITY_FIELDS: readonly BottleField[] = [
  "producer",
  "name",
  "vintage",
  "region",
  "format",
];

/**
 * The two fields that ARE the identity. Vintage, region and format describe
 * a bottle; producer and name say which wine it is. A candidate the model
 * cannot vouch for on both of these is unidentified however sure it is
 * about the year and the size — the "all but one flagged" hole the first
 * cut of this gate left open.
 */
const CORE_IDENTITY_FIELDS: readonly BottleField[] = ["producer", "name"];

/**
 * True when the AI candidate is unreliable enough that one-tap Confirm
 * should be disabled and the user routed through "Correct details"
 * instead: below the confidence floor, every identity-sensitive field
 * flagged low-confidence, or both core identity fields flagged (issue
 * #118 — an unidentifiable photo commonly presents as all of these at
 * once, but any one alone is disqualifying).
 */
export function needsCorrectionBeforeSave(
  candidate: Pick<BottleCandidate, "confidence" | "lowFields">,
): boolean {
  const flagged = (fields: readonly BottleField[]) =>
    fields.every((field) => candidate.lowFields.includes(field));
  return (
    candidate.confidence < CONFIRM_CONFIDENCE_FLOOR ||
    flagged(IDENTITY_FIELDS) ||
    flagged(CORE_IDENTITY_FIELDS)
  );
}
