import { z } from "zod";

const DEFAULT_AVAILABILITY_LIMIT = 1000;
const MAX_AVAILABILITY_LIMIT = 1000;
const DEFAULT_GLASS_POUR_ML = 148;
const MAX_AVAILABILITY_OFFSET =
  Number.MAX_SAFE_INTEGER - MAX_AVAILABILITY_LIMIT;

function optionalUnsignedInteger(
  fallback: number,
  min: number,
  max: number,
) {
  return z
    .union([
      z.undefined(),
      z.string().trim().regex(/^\d+$/, "Expected a whole number."),
    ])
    .transform((raw) => (raw === undefined ? fallback : Number(raw)))
    .pipe(z.number().int().min(min).max(max));
}

const glassPourMl = z
  .union([
    z.undefined(),
    z
      .string()
    .trim()
      .regex(/^\d+(?:\.\d+)?$/, "Expected a positive number."),
  ])
  .transform((raw) =>
    raw === undefined ? DEFAULT_GLASS_POUR_ML : Math.round(Number(raw)),
  )
  .pipe(z.number().int().min(15).max(750));

const searchText = z
  .string()
  .trim()
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Search text contains unsupported control characters.",
  });

export const PricingSuggestionQuerySchema = z
  .object({
    glassPourMl,
  })
  .strict();

export const WineAvailabilityQuerySchema = z
  .object({
    limit: optionalUnsignedInteger(
      DEFAULT_AVAILABILITY_LIMIT,
      1,
      MAX_AVAILABILITY_LIMIT,
    ),
    offset: optionalUnsignedInteger(0, 0, MAX_AVAILABILITY_OFFSET),
  })
  .strict();

export const WineSearchQuerySchema = z
  .object({
    q: searchText.optional().default(""),
  })
  .strict();

export const LwinSearchQuerySchema = z
  .object({
    q: searchText.optional().default(""),
  })
  .strict();
