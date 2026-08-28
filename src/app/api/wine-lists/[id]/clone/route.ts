import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

type SourceItem = {
  id: string;
  wine_id: string;
  bottle_price: number | null;
  glass_price: number | null;
  glass_pour_ml: number | null;
  pour_size_mode: string | null;
  position: number;
  is_available: boolean | null;
  tasting_note: string | null;
};

type SourceSection = {
  id: string;
  name: string;
  position: number;
  wine_list_items?: SourceItem[];
};

/**
 * POST /api/wine-lists/[id]/clone
 *
 * Clones an existing wine list — name, description, template, sections, and
 * items — into a new, unpublished list. The clone name appends " (copy)" to
 * the original name. Pricing, positioning, and wine references are preserved.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // 1. Fetch the source list (scope by restaurant_id + id)
  const { data: sourceList, error: fetchError } = await supabase
    .from("wine_lists")
    .select("name, description, template")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError || !sourceList) {
    return Errors.notFound("Wine list");
  }

  // 2. Fetch source sections and items
  const { data: sourceSections, error: sectionsError } = await supabase
    .from("wine_list_sections")
    .select("id, name, position, wine_list_items(id, wine_id, bottle_price, glass_price, glass_pour_ml, pour_size_mode, position, is_available, tasting_note)")
    .eq("wine_list_id", id)
    .order("position");

  if (sectionsError || !sourceSections) {
    console.error("clone: fetch sections failed:", sectionsError);
    Sentry.captureException(sectionsError ?? new Error("sections null without error"), {
      tags: { surface: "wine-lists", phase: "clone-sections-fetch" },
      extra: { restaurantId, list_id: id },
    });
    return Errors.internal("Clone failed.");
  }

  // 3. Create the clone list (unpublished, no slug)
  const cloneName = `${sourceList.name} (copy)`;
  const { data: cloneList, error: createError } = await supabase
    .from("wine_lists")
    .insert({
      name: cloneName,
      description: sourceList.description,
      template: sourceList.template ?? "classic",
      restaurant_id: restaurantId,
      is_published: false,
      archived: false,
    })
    .select("id")
    .single();

  if (createError || !cloneList) {
    console.error("clone: create list failed:", createError);
    Sentry.captureException(createError ?? new Error("clone null without error"), {
      tags: { surface: "wine-lists", phase: "clone-create" },
      extra: { restaurantId, source_id: id },
    });
    return Errors.internal("Clone failed.");
  }

  // 4. Clone sections and items — batched into one insert per table
  // (was one insert per source section). Section ids are generated
  // client-side so the item inserts below can reference the right new
  // section without depending on the order rows come back from the DB.
  const sectionIdMap = new Map<string, string>(); // source section id -> clone section id
  const sectionInserts = (sourceSections as SourceSection[]).map((section) => {
    const newId = crypto.randomUUID();
    sectionIdMap.set(section.id, newId);
    return {
      id: newId,
      wine_list_id: cloneList.id,
      name: section.name,
      position: section.position,
    };
  });

  if (sectionInserts.length > 0) {
    const { error: sectionsInsertError } = await supabase
      .from("wine_list_sections")
      .insert(sectionInserts);

    if (sectionsInsertError) {
      console.error("clone: insert sections failed:", sectionsInsertError);
      Sentry.captureException(sectionsInsertError, {
        tags: { surface: "wine-lists", phase: "clone-sections-insert" },
        extra: { restaurantId, clone_id: cloneList.id, section_count: sectionInserts.length },
      });
      // Clean up partial clone
      await supabase.from("wine_lists").delete().eq("id", cloneList.id).eq("restaurant_id", restaurantId);
      return Errors.internal("Clone failed.");
    }
  }

  const itemInserts = (sourceSections as SourceSection[]).flatMap((section) =>
    (section.wine_list_items ?? []).map((item) => ({
      section_id: sectionIdMap.get(section.id)!,
      wine_id: item.wine_id,
      // C05 (db audit 2026-08-23): restaurant_id is now required, FK-
      // enforced against the wine's own restaurant_id — restaurantId is
      // already this handler's own verified tenant (requireRole), and
      // every cloned wine_id belongs to it (source list was fetched
      // scoped to restaurant_id above).
      restaurant_id: restaurantId,
      bottle_price: item.bottle_price,
      glass_price: item.glass_price,
      glass_pour_ml: item.glass_pour_ml,
      pour_size_mode: item.pour_size_mode ?? "bottle_only",
      position: item.position,
      is_available: item.is_available ?? true,
      tasting_note: item.tasting_note,
    })),
  );

  if (itemInserts.length > 0) {
    const { error: itemsError } = await supabase
      .from("wine_list_items")
      .insert(itemInserts);

    if (itemsError) {
      console.error("clone: insert items failed:", itemsError);
      Sentry.captureException(itemsError, {
        tags: { surface: "wine-lists", phase: "clone-items-insert" },
        extra: { restaurantId, clone_id: cloneList.id, item_count: itemInserts.length },
      });
      // Clean up partial clone
      await supabase.from("wine_lists").delete().eq("id", cloneList.id).eq("restaurant_id", restaurantId);
      return Errors.internal("Clone failed.");
    }
  }

  return NextResponse.json({ id: cloneList.id });
}
