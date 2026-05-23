import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import puppeteer from "puppeteer";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { renderWineListSections } from "@/lib/wine-list/render";
import type { WineListSectionEmbed } from "@/lib/wine-list/shapes";
import { renderTemplate } from "@/lib/wine-list/templates";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // Gate on membership and scope every query by restaurant_id. RLS should
  // already enforce this, but belt-and-suspenders: a wine list belonging to a
  // restaurant the caller is not a member of must return 404, not 403 — a 403
  // would confirm the list exists. (ARCH-002)
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let body: { listId: string; template?: string };
  try {
    body = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  if (!body.listId) {
    return Errors.badRequest("listId is required.");
  }

  // Fetch list with sections, items, and wines
  const { data: list, error: fetchError } = await supabase
    .from("wine_lists")
    .select(
      "name, template, restaurant_id, restaurants(name), wine_list_sections(name, position, wine_list_items(position, glass_price, bottle_price, tasting_note, name_override, wines(name, producer, vintage, varietal, region, is_eightysixed)))",
    )
    .eq("id", body.listId)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError || !list) {
    return Errors.notFound("Wine list");
  }

  const restaurantName =
    (list.restaurants as { name: string } | null)?.name ?? "";

  type PdfWineListItem = {
    position: number;
    glass_price: number | null;
    bottle_price: number | null;
    tasting_note: string | null;
    name_override: string | null;    wines: {
      name: string;
      producer: string;
      vintage: number | null;
      varietal: string | null;
      region: string | null;
      is_eightysixed: boolean;
    } | null;
  };

  // DEBT-013: shared WineListSectionEmbed<TItem> generic.
  // ARCH-020: shared renderWineListSections() filter + sort pipeline —
  // identical rules to the public /list/[slug] page. One function,
  // one source of truth for "what a customer actually sees."
  const sections = renderWineListSections(
    (list.wine_list_sections ?? []) as unknown as WineListSectionEmbed<PdfWineListItem>[],
  );

  const template = body.template ?? list.template ?? "classic";
  const html = renderTemplate(template, {
    name: list.name,
    restaurantName,
    sections,
  });

  // Render PDF with Puppeteer.
  //
  // BND-004: waitUntil was previously 'networkidle0' with no timeout, which
  // waited indefinitely for external font fetches. Combined with templates
  // that have since been switched to system font stacks (no external
  // requests), 'domcontentloaded' is correct here — the HTML is passed via
  // setContent so there is nothing to network-idle on — and the explicit
  // timeouts bound the worst case.
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      timeout: 30_000,
    });

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${list.name.replace(/[^a-zA-Z0-9 ]/g, "")}.pdf"`,
      },
    });
  } catch (err) {
    console.error("PDF generation failed:", err);
    Sentry.captureException(err, {
      tags: { surface: "pdf", phase: "puppeteer-render" },
    });
    return Errors.internal("PDF generation failed.");
  } finally {
    await browser?.close();
  }
}
