import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

function escapeField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * GET /api/wine-lists/[id]/csv — export a wine list as CSV.
 *
 * Columns: section, producer, name, vintage, glass_price,
 *          bottle_price, name_override, hidden
 */
export async function GET(
  _request: Request,
  { params }: { params: Params },
) {
  const { id } = await params;

  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  try {
    const { data: list, error } = await supabase
      .from("wine_lists")
      .select(
        "name, wine_list_sections(id, name, position, wine_list_items(id, position, glass_price, bottle_price, name_override, hidden, wines(producer, name, vintage)))",
      )
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .single();

    if (error || !list) {
      return NextResponse.json(
        { error: "Wine list not found." },
        { status: 404 },
      );
    }

    type RawSection = {
      id: string;
      name: string;
      position: number;
      wine_list_items: Array<{
        id: string;
        position: number;
        glass_price: number | null;
        bottle_price: number | null;
        name_override: string | null;
        hidden: boolean;
        wines: {
          producer: string;
          name: string;
          vintage: number | null;
        } | null;
      }>;
    };

    const sections = ((list.wine_list_sections ?? []) as RawSection[])
      .sort((a, b) => a.position - b.position);

    const lines: string[] = [];

    lines.push(
      "Section,Producer,Name,Vintage,Glass Price,Bottle Price,Name Override,Hidden",
    );

    for (const section of sections) {
      const items = [...section.wine_list_items].sort(
        (a, b) => a.position - b.position,
      );

      for (const item of items) {
        const wine = item.wines;
        lines.push(
          [
            escapeField(section.name),
            escapeField(wine?.producer ?? ""),
            escapeField(wine?.name ?? ""),
            wine?.vintage ?? "",
            item.glass_price != null ? item.glass_price.toString() : "",
            item.bottle_price != null ? item.bottle_price.toString() : "",
            escapeField(item.name_override ?? ""),
            item.hidden ? "Yes" : "No",
          ].join(","),
        );
      }
    }

    const csv = lines.join("\n");
    const filename = `${list.name.replace(/[^a-zA-Z0-9_-]/g, "_")}-export.csv`;

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "wine-list", phase: "csv-export" },
      extra: { restaurantId, listId: id },
    });
    return NextResponse.json(
      { error: "Failed to generate CSV export." },
      { status: 500 },
    );
  }
}
