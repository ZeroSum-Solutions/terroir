/**
 * The families that group descriptor chips in the note composer and the taste
 * block.
 *
 * A family groups and labels. It does NOT carry a colour. DESIGN.md states
 * there is no fifth hue beyond the four wine states and "there must not be
 * one", and scripts/check-design-palette.mjs bans warm hues at L < 0.72 as
 * brown and at L >= 0.80 as cream — which is precisely where oak, spice,
 * earth and honey sit. Giving each family a constant colour, as the adoption
 * plan originally asked, would be a new palette rather than a re-derivation of
 * the existing one. See D10 in the design spec.
 */
export const DESCRIPTOR_FAMILIES = [
  "fruit",
  "floral",
  "herbal",
  "oak",
  "earth",
  "spice",
  "fault",
] as const;

export type DescriptorFamily = (typeof DESCRIPTOR_FAMILIES)[number];

export function isDescriptorFamily(value: string): value is DescriptorFamily {
  return (DESCRIPTOR_FAMILIES as readonly string[]).includes(value);
}
