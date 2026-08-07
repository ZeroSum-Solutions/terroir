import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderHtmlToPdf } from "../../adapters/pdf/html-to-pdf.ts";
import { renderWineListSections } from "../../lib/wine-list/render.ts";
import type { WineListSectionEmbed } from "../../lib/wine-list/shapes.ts";
import { renderTemplate } from "../../lib/wine-list/templates.ts";
import type { Database } from "../../types/database.ts";

export class WineListPdfNotFoundError extends Error {
  constructor() {
    super("Wine list not found.");
    this.name = "WineListPdfNotFoundError";
  }
}

export class WineListPdfGenerationError extends Error {
  constructor(cause: unknown) {
    super("PDF generation failed.");
    this.name = "WineListPdfGenerationError";
    this.cause = cause;
  }
}

export type WineListPdfTemplate = "classic" | "modern" | "minimal";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveWineListPdfTemplate(value: unknown): WineListPdfTemplate {
  return value === "modern" || value === "minimal" ? value : "classic";
}

type PdfWineListItem = {
  position: number;
  glass_price: number | null;
  bottle_price: number | null;
  tasting_note: string | null;
  name_override: string | null;
  wines: {
    name: string;
    producer: string;
    vintage: number | null;
    varietal: string | null;
    region: string | null;
    is_eightysixed: boolean;
  } | null;
};

export type GenerateWineListPdfInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  listId: string;
  signal?: AbortSignal;
  template?: WineListPdfTemplate;
};

export type GenerateWineListPdfResult = {
  filename: string;
  pdf: Buffer;
  template: WineListPdfTemplate;
};

export function wineListPdfArtifactPath(input: {
  restaurantId: string;
  listId: string;
  template: WineListPdfTemplate;
}): string {
  if (!UUID_PATTERN.test(input.restaurantId) || !UUID_PATTERN.test(input.listId)) {
    throw new Error("Wine-list PDF artifact identity is invalid");
  }
  return `${input.restaurantId}/${input.listId}_${input.template}.pdf`;
}

export function wineListPdfFilename(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9 ]/g, "").trim();
  return `${safeName || "wine-list"}.pdf`;
}

export async function generateWineListPdf(
  input: GenerateWineListPdfInput,
): Promise<GenerateWineListPdfResult> {
  const { supabase, restaurantId, listId } = input;

  const { data: list, error: fetchError } = await supabase
    .from("wine_lists")
    .select(
      "name, template, restaurant_id, restaurants(name), wine_list_sections(name, position, wine_list_items(position, glass_price, bottle_price, tasting_note, name_override, wines(name, producer, vintage, varietal, region, is_eightysixed)))",
    )
    .eq("id", listId)
    .eq("restaurant_id", restaurantId)
    .single();

  if (
    fetchError &&
    (fetchError as { code?: string }).code !== "PGRST116"
  ) {
    throw fetchError;
  }
  if (!list) {
    throw new WineListPdfNotFoundError();
  }

  const restaurantName =
    (list.restaurants as { name: string } | null)?.name ?? "";

  const sections = renderWineListSections(
    (list.wine_list_sections ?? []) as unknown as WineListSectionEmbed<PdfWineListItem>[],
  );

  const template = resolveWineListPdfTemplate(input.template ?? list.template);
  const html = renderTemplate(template, {
    name: list.name,
    restaurantName,
    sections,
  });

  try {
    const pdf = await renderHtmlToPdf(html, input.signal);
    return {
      filename: wineListPdfFilename(list.name),
      pdf,
      template,
    };
  } catch (error) {
    console.error("PDF generation failed");
    Sentry.captureException(error, {
      tags: { surface: "pdf", phase: "puppeteer-render" },
    });
    throw new WineListPdfGenerationError(error);
  }
}
