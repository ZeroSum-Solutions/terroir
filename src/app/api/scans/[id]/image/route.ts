import { NextResponse, type NextRequest } from "next/server";
import {
  getScanImageUrl,
  ScanImageNotFoundError,
  ScanImageStorageError,
} from "@/domains/scanning/scan-image-service";
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

  try {
    const url = await getScanImageUrl({
      supabase,
      restaurantId,
      scanId: id,
    });
    return NextResponse.json({ url });
  } catch (error) {
    if (error instanceof ScanImageNotFoundError) {
      return Errors.notFound("Scan image");
    }
    if (error instanceof ScanImageStorageError) {
      return Errors.internal("Failed to generate image URL.");
    }
    throw error;
  }
}
