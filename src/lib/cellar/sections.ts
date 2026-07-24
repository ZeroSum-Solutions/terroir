import { z } from "zod";

const CellarLabelsSchema = z
  .object({
    sections: z.array(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(100),
      }),
    ),
  })
  .passthrough();

export type CellarSection = {
  id: string;
  name: string;
};

export function parseCellarSections(labels: unknown): CellarSection[] {
  const parsed = CellarLabelsSchema.safeParse(labels);
  return parsed.success ? parsed.data.sections : [];
}
