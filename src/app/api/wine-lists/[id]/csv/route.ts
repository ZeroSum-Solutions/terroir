import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";
import { WineListIdParamsSchema } from "@/lib/api/wine-list-lifecycle-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

function escapeField(value: string): string {
  const formulaLike =
    /^[\t\r\n]/.test(value) || /^[ \t\r\n]*[=+\-@]/.test(value);
  const safe = formulaLike ? `'${value}` : value;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

type RawSection = {
  name: string;
  position: number;
  wine_list_items: Array<{
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

export async function GET(
  _request: Request,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineListIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: list, error } = await supabase
      .from("wine_lists")
      .select(
        "name, wine_list_sections(name, position, wine_list_items(position, glass_price, bottle_price, name_override, hidden, wines(producer, name, vintage)))",
      )
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (error) throw error;
    if (!list) return Errors.notFound("Wine list");

    const lines = [
      "Section,Producer,Name,Vintage,Glass Price,Bottle Price,Name Override,Hidden",
    ];
    const sections = ((list.wine_list_sections ?? []) as RawSection[]).sort(
      (a, b) => a.position - b.position,
    );
    for (const section of sections) {
      const items = [...section.wine_list_items].sort(
        (a, b) => a.position - b.position,
      );
      for (const item of items) {
        lines.push(
          [
            escapeField(section.name),
            escapeField(item.wines?.producer ?? ""),
            escapeField(item.wines?.name ?? ""),
            item.wines?.vintage ?? "",
            item.glass_price != null ? item.glass_price.toString() : "",
            item.bottle_price != null ? item.bottle_price.toString() : "",
            escapeField(item.name_override ?? ""),
            item.hidden ? "Yes" : "No",
          ].join(","),
        );
      }
    }

    const filename = `${list.name.replace(/[^a-zA-Z0-9_-]/g, "_")}-export.csv`;
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  });
}
