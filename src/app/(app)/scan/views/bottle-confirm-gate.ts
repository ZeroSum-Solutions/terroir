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
 * True when the AI candidate is unreliable enough that one-tap Confirm
 * should be disabled and the user routed through "Correct details"
 * instead: below the confidence floor, or every identity-sensitive
 * field flagged low-confidence (issue #118 — an unidentifiable photo
 * commonly presents as both at once, but either alone is disqualifying).
 */
export function needsCorrectionBeforeSave(
  candidate: Pick<BottleCandidate, "confidence" | "lowFields">,
): boolean {
  const allFieldsFlagged = IDENTITY_FIELDS.every((field) =>
    candidate.lowFields.includes(field),
  );
  return candidate.confidence < CONFIRM_CONFIDENCE_FLOOR || allFieldsFlagged;
}
