import * as Sentry from "@sentry/nextjs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { getAnthropicClient } from "@/lib/ai/anthropic-client";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import {
  fileField,
  parseJson,
  parseMultipart,
} from "@/lib/api/validation";
import { ParsedBottleLabelSchema } from "@/lib/scanner/bottle-schema";
import { BOTTLE_SYSTEM_PROMPT } from "@/lib/scanner/bottle-system-prompt";
import { classifyScannerProviderFailure } from "@/lib/scanner/provider-failure";
import { QrLookupBodySchema } from "@/lib/scanner/request-schemas";
import type { BottleScanResult } from "@/lib/scanner/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const BottlePhotoSchema = z.object({ file: fileField });

// ARCH-016 / DEBT-016: prompt lives at src/lib/scanner/bottle-system-prompt.ts
// so prompt engineering changes flow through one file (same pattern as
// BND-027's invoice system-prompt extraction).

export async function POST(request: NextRequest) {
  return withApiHandler(() => postBottleScan(request));
}

async function postBottleScan(request: NextRequest) {
  const auth = await requireMembership({ rateLimit: "expensive" });
  if (auth instanceof NextResponse) return auth;

  const { supabase, restaurantId } = auth;

  // --- QR code lookup path ---
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    const parsed = await parseJson(request, QrLookupBodySchema, {
      message: "Invalid body.",
    });
    if (!parsed.ok) return parsed.response;
    const { qr_payload } = parsed.data;

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/scan-bottle",
      payload: { qr_payload },
      releaseOnError: false,
      handler: async () => {
        const { data: scopedWine, error: scopedError } = await supabase
          .from("wines")
          .select(
            "id, producer, name, vintage, varietal, region, country, restaurant_id",
          )
          .eq("id", qr_payload)
          .eq("restaurant_id", restaurantId)
          .maybeSingle();

        if (scopedError) throw scopedError;
        if (!scopedWine || scopedWine.restaurant_id !== restaurantId) {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found",
                message: "Wine not found.",
              },
            },
          };
        }

        const { restaurant_id: _rid, ...wine } = scopedWine;
        return { status: 200, body: wine };
      },
    });
  }

  // --- Bottle label scanning path (existing) ---

  const parsed = await parseMultipart(request, BottlePhotoSchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const file = parsed.data.file;
  if (file.size === 0) {
    return Errors.badRequest("Empty file.");
  }
  if (file.size > MAX_BYTES) {
    return Errors.tooLarge("File exceeds 20 MB.");
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return Errors.unsupportedMediaType(`Unsupported file type: ${file.type || "unknown"}. Use JPEG, PNG, or WebP.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64 = Buffer.from(bytes).toString("base64");

  const mediaType = file.type as "image/jpeg" | "image/png" | "image/webp";

  return idempotentMutationResponse<unknown>({
    request,
    supabase,
    restaurantId,
    operationId: "api:POST:/api/scan-bottle",
    payload: {
      file: {
        size: file.size,
        type: mediaType,
      },
    },
    binaryParts: [bytes],
    releaseOnError: false,
    handler: async () => {
      try {
        // BND-007: the module-scoped client retains its pinned retry/timeout
        // configuration while initialization stays inside the claimed handler.
        const anthropic: Anthropic = getAnthropicClient();
        const response = await anthropic.messages.parse({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          output_config: {
            format: zodOutputFormat(ParsedBottleLabelSchema),
          },
          system: BOTTLE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: base64,
                  },
                },
                {
                  type: "text",
                  text: "Identify this wine from its bottle label.",
                },
              ],
            },
          ],
        });

        const bottle = response.parsed_output;
        if (!bottle) {
          return {
            status: 422,
            body: {
              error: {
                code: "parse_failed",
                message:
                  "Could not identify the wine from this photo. Try a clearer photo of the label.",
              },
            },
          };
        }

        const result: BottleScanResult = {
          name: bottle.name,
          producer: bottle.producer,
          vintage: bottle.vintage,
          varietal: bottle.varietal,
          region: bottle.region,
          country: bottle.country,
          confidence: bottle.confidence,
          notes: bottle.notes,
          parsedAt: new Date().toISOString(),
        };

        return { status: 200, body: result };
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) {
          return {
            status: 429,
            body: {
              error: {
                code: "rate_limited",
                message: "Rate limited. Wait a minute and try again.",
              },
            },
          };
        }
        if (error instanceof Anthropic.BadRequestError) {
          return {
            status: 400,
            body: {
              error: {
                code: "bad_request",
                message:
                  "Could not process this photo. Try a different angle or better lighting.",
              },
            },
          };
        }
        const failure = classifyScannerProviderFailure(error);
        if (failure.kind === "timeout") {
          Sentry.captureException(error, {
            tags: { surface: "scanner", phase: "claude-call" },
            extra: { failure_kind: failure.kind, retryable: failure.retryable },
          });
          return {
            status: 504,
            body: {
              error: {
                code: "provider_timeout",
                message: "The AI service timed out. Please try again.",
              },
            },
          };
        }
        if (
          error instanceof Anthropic.APIError ||
          failure.kind === "unavailable"
        ) {
          Sentry.captureException(error, {
            tags: { surface: "scanner", phase: "claude-call" },
            extra: {
              failure_kind: "unavailable",
              retryable: true,
            },
          });
          return {
            status: 502,
            body: {
              error: {
                code: "bad_gateway",
                message:
                  "The AI service encountered an error. Please try again.",
              },
            },
          };
        }
        console.error("scan-bottle failed with an unclassified provider error.");
        Sentry.captureException(error, {
          tags: { surface: "scanner", phase: "claude-call" },
          extra: { failure_kind: "unknown", retryable: false },
        });
        return {
          status: 500,
          body: {
            error: {
              code: "internal_error",
              message: "Something went wrong identifying the wine.",
            },
          },
        };
      }
    },
  });
}
