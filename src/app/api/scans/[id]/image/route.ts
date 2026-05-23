import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;
  const { id } = await params;

  const { data: scan } = await supabase
    .from("invoice_scans")
    .select("raw_image_path")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (!scan?.raw_image_path) {
    return Errors.notFound("Scan image");
  }

  const { data: signed, error } = await supabase.storage
    .from("invoice-images")
    .createSignedUrl(scan.raw_image_path, 3600);

  if (error || !signed?.signedUrl) {
    console.error("fetch-storage failed:", error);
    Sentry.captureException(error ?? new Error("No signed URL returned"), {
      tags: { surface: "scanner", phase: "fetch-storage" },
      extra: { scan_id: id },
    });
    return Errors.internal("Failed to generate image URL.");
  }

  return NextResponse.json({ url: signed.signedUrl });
}
