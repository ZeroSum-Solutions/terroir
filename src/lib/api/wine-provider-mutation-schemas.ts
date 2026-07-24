import { z } from "zod";
import { fileField } from "./validation";

const nullableMetadata = z.string().trim().max(255).nullable().optional();

export const CreateWineFromLwinBodySchema = z
  .object({
    lwin_id: z.string().trim().min(1).max(32),
    display_name: z.string().trim().min(1).max(500),
    producer: nullableMetadata,
    varietal: nullableMetadata,
    region: nullableMetadata,
    country: nullableMetadata,
  })
  .strict();

export const WineImageFormSchema = z
  .object({
    file: fileField,
  })
  .strict();
