import { z } from "zod";

export const WineListIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

export const CreateWineListBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().optional(),
  })
  .strict();

export const UpdateWineListBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    template: z.enum(["classic", "modern", "minimal"]).optional(),
    slug: z.string().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "No valid fields to update.",
  });

export const PublishWineListBodySchema = z
  .object({
    slug: z.string().optional(),
  })
  .strict()
  .default({});

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function normalizeWineListSlug(
  value: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return { ok: false, message: "Slug must not be empty." };
  }
  if (!SLUG_RE.test(normalized)) {
    return {
      ok: false,
      message:
        "Slug must contain only lowercase letters, numbers, and hyphens.",
    };
  }
  if (normalized.length > 50) {
    return {
      ok: false,
      message: "Slug must be 50 characters or fewer.",
    };
  }
  return { ok: true, value: normalized };
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
