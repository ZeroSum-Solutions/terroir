import { NextResponse, type NextRequest } from "next/server";
import puppeteer from "puppeteer";
import { requireAuth } from "@/lib/api/auth";
import { renderTemplate } from "@/lib/wine-list/templates";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  let body: { listId: string; template?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.listId) {
    return NextResponse.json({ error: "listId is required." }, { status: 400 });
  }

  // Fetch list with sections, items, and wines
  const { data: list, error: fetchError } = await supabase
    .from("wine_lists")
    .select(
      "name, template, restaurant_id, restaurants(name), wine_list_sections(name, position, wine_list_items(position, glass_price, bottle_price, tasting_note, wines(name, producer, vintage, varietal, region)))",
    )
    .eq("id", body.listId)
    .single();

  if (fetchError || !list) {
    return NextResponse.json({ error: "Wine list not found." }, { status: 404 });
  }

  const restaurantName =
    (list.restaurants as { name: string } | null)?.name ?? "";

  const sections = (
    (list.wine_list_sections ?? []) as Array<{
      name: string;
      position: number;
      wine_list_items: Array<{
        position: number;
        glass_price: number | null;
        bottle_price: number | null;
        tasting_note: string | null;
        wines: {
          name: string;
          producer: string;
          vintage: number | null;
          varietal: string | null;
          region: string | null;
        };
      }>;
    }>
  )
    .sort((a, b) => a.position - b.position)
    .filter((s) => s.wine_list_items.length > 0)
    .map((s) => ({
      name: s.name,
      items: [...s.wine_list_items].sort((a, b) => a.position - b.position),
    }));

  const template = body.template ?? list.template ?? "classic";
  const html = renderTemplate(template, {
    name: list.name,
    restaurantName,
    sections,
  });

  // Render PDF with Puppeteer
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
    });

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${list.name.replace(/[^a-zA-Z0-9 ]/g, "")}.pdf"`,
      },
    });
  } catch (err) {
    console.error("PDF generation failed:", err);
    return NextResponse.json(
      { error: "PDF generation failed." },
      { status: 500 },
    );
  } finally {
    await browser?.close();
  }
}
