/**
 * POST /api/scans/[id]/re-extract — BND-097
 *
 * Re-invokes Claude extraction using the stored OCR text from an
 * invoice_scans row. Useful when Claude misread the original scan.
 *
 * The existing invoice_scans row is updated with the new extraction results.
 * Original committed inventory_items are NOT mutated — only the
 * invoice_scans parsed_/final_line_items are refreshed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseParams } from "@/lib/api/validation";
import { AiExtractError, extractFromOcr } from "@/lib/scanner/ai-extract";
import {
  ScanIdParamsSchema,
  StoredOcrSchema,
} from "@/lib/scanner/request-schemas";
import { scoreItems } from "@/lib/scanner/scoring";
import type { LineItem } from "@/lib/scanner/types";

export const runtime = "nodejs";
export const maxDuration = 120;

function mutationError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return {
    status,
    body: {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership({ rateLimit: "expensive" });
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ScanIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const id = parsedParams.data.id.toLowerCase();

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/scans/{param}/re-extract",
      payload: { id },
      releaseOnError: false,
      handler: async () => {
        const { data: scan, error: fetchError } = await supabase
          .from("invoice_scans")
          .select("id, ocr_text")
          .eq("id", id)
          .eq("restaurant_id", restaurantId)
          .single();
        if (
          fetchError &&
          (fetchError as { code?: string }).code !== "PGRST116"
        ) {
          throw fetchError;
        }
        if (!scan) {
          return mutationError(404, "not_found", "Scan not found.");
        }

        let rawOcr: unknown = scan.ocr_text;
        if (rawOcr === null || rawOcr === undefined) {
          return mutationError(
            422,
            "missing_ocr_text",
            "Scan has no stored OCR text to re-extract.",
          );
        }
        if (typeof rawOcr === "string") {
          try {
            rawOcr = JSON.parse(rawOcr);
          } catch {
            throw new Error("Stored OCR JSON is malformed.");
          }
        }
        const parsedOcr = StoredOcrSchema.safeParse(rawOcr);
        if (!parsedOcr.success) {
          return mutationError(
            422,
            "invalid_ocr_text",
            "Scan has no valid OCR text to re-extract.",
          );
        }
        const ocr = parsedOcr.data;

        let parsed;
        try {
          parsed = await extractFromOcr(ocr);
        } catch (error) {
          if (!(error instanceof AiExtractError)) throw error;
          if (
            error.code === "parse_failed" ||
            error.code === "validation_failed"
          ) {
            return mutationError(
              422,
              error.code,
              "Unable to extract wines from stored OCR.",
              { rawText: ocr.rawText },
            );
          }
          if (error.code === "rate_limited") {
            return mutationError(
              429,
              "rate_limited",
              "Extraction provider rate limited.",
            );
          }
          if (error.code === "bad_input") {
            return mutationError(
              400,
              "bad_input",
              "Stored OCR could not be processed.",
            );
          }
          if (error.code === "timeout") {
            return mutationError(
              504,
              "provider_timeout",
              "Extraction provider timed out.",
            );
          }
          if (error.code === "upstream_error") {
            return mutationError(
              502,
              "bad_gateway",
              "Extraction provider unavailable.",
            );
          }
          throw error;
        }

        if (parsed.lineItems.length === 0) {
          return mutationError(
            422,
            "no_wines_extracted",
            "No wines could be extracted from the stored OCR.",
            { rawText: ocr.rawText },
          );
        }

        const parsedAt = new Date().toISOString();
        const items: LineItem[] = parsed.lineItems.map((item, index) => ({
          id: `${parsedAt}-${index}`,
          name: item.name,
          producer: item.producer,
          vintage: item.vintage,
          varietal: item.varietal,
          region: item.region,
          qty: item.qty,
          unitCost: item.unitCost,
          currency: item.currency ?? null,
          format: item.format ?? null,
          confidence: item.confidence,
          lowFields:
            item.lowFields.length > 0 ? item.lowFields : undefined,
        })) as LineItem[];

        const quality = scoreItems(items);
        const { error: updateError } = await supabase
          .from("invoice_scans")
          .update({
            parsed_line_items: JSON.parse(
              JSON.stringify(parsed.lineItems),
            ),
            final_line_items: JSON.parse(JSON.stringify(items)),
            accuracy_score: quality.avgConfidence,
            item_count: items.length,
          })
          .eq("id", id)
          .eq("restaurant_id", restaurantId);
        if (updateError) throw updateError;

        return {
          status: 200,
          body: {
            scanId: id,
            items,
            quality,
            rawText: ocr.rawText,
          },
        };
      },
    });
  });
}
