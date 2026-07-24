import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  generateWineListPdf,
  WineListPdfGenerationError,
  WineListPdfNotFoundError,
} from "@/domains/wine-lists/wine-list-pdf-service";
import { requireMembership } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";
export const maxDuration = 30;

const BodySchema = z.object({
  listId: z.string().uuid(),
  template: z.enum(["classic", "modern", "minimal"]).optional(),
});

export async function POST(request: NextRequest) {
  return withApiHandler(() => postPdf(request));
}

async function postPdf(request: NextRequest) {
  // Gate on membership and scope every query by restaurant_id. RLS should
  // already enforce this, but belt-and-suspenders: a wine list belonging to a
  // restaurant the caller is not a member of must return 404, not 403 — a 403
  // would confirm the list exists. (ARCH-002)
  const auth = await requireMembership({ rateLimit: "expensive" });
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  try {
    const result = await generateWineListPdf({
      supabase,
      restaurantId,
      listId: body.listId,
      template: body.template,
    });

    const pdfBody = new Uint8Array(result.pdf).buffer;
    return new NextResponse(pdfBody, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${result.filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof WineListPdfNotFoundError) {
      return Errors.notFound("Wine list");
    }
    if (error instanceof WineListPdfGenerationError) {
      return apiError(500, "pdf_generation_failed", "PDF generation failed.");
    }
    throw error;
  }
}
