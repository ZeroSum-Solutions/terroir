import { NextResponse, type NextRequest } from "next/server";
import {
  getScanImageUrl,
  ScanImageNotFoundError,
  ScanImageStorageError,
} from "@/domains/scanning/scan-image-service";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";
import { ScanIdParamsSchema } from "@/lib/scanner/request-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(
  _request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ScanIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;

    try {
      const url = await getScanImageUrl({
        supabase,
        restaurantId,
        scanId: parsedParams.data.id,
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
  });
}
