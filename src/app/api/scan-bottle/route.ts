import * as Sentry from "@sentry/nextjs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { NextResponse, type NextRequest } from "next/server";
import { getAnthropicClient } from "@/lib/ai/anthropic-client";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { ParsedBottleLabelSchema } from "@/lib/scanner/bottle-schema";
import { BOTTLE_SYSTEM_PROMPT } from "@/lib/scanner/bottle-system-prompt";
import type { BottleScanResult } from "@/lib/scanner/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// ARCH-016 / DEBT-016: prompt lives at src/lib/scanner/bottle-system-prompt.ts
// so prompt engineering changes flow through one file (same pattern as
// BND-027's invoice system-prompt extraction).

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;

  // BND-007: Anthropic client is a module-scoped singleton with
  // maxRetries: 2 and timeout: 100_000 pinned, keeping total latency
  // under the `maxDuration = 60` ceiling declared on this route. That
  // 60s is the bound on a single bottle-label Claude call; Railway
  // itself has no hard request timeout so the ceiling is ours to set.
  let anthropic: Anthropic;
  try {
    anthropic = getAnthropicClient();
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "scanner", phase: "client-init" },
      extra: {},
    });
    return Errors.internal("Server not configured: ANTHROPIC_API_KEY missing.");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Errors.badRequest("Invalid form data.");
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Errors.badRequest("Attach a photo under the 'file' field.");
  }
  if (file.size === 0) {
    return Errors.badRequest("Empty file.");
  }
  if (file.size > MAX_BYTES) {
    return Errors.tooLarge("File exceeds 20 MB.");
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return Errors.unsupportedMediaType(`Unsupported file type: ${file.type || "unknown"}. Use JPEG or PNG.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64 = Buffer.from(bytes).toString("base64");

  const mediaType = file.type as "image/jpeg" | "image/png" | "image/webp";

  try {
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

    const parsed = response.parsed_output;
    if (!parsed) {
      return Errors.unprocessable("parse_failed", "Could not identify the wine from this photo. Try a clearer photo of the label.");
    }

    const result: BottleScanResult = {
      name: parsed.name,
      producer: parsed.producer,
      vintage: parsed.vintage,
      varietal: parsed.varietal,
      region: parsed.region,
      country: parsed.country,
      confidence: parsed.confidence,
      notes: parsed.notes,
      parsedAt: new Date().toISOString(),
    };

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return Errors.rateLimited("Rate limited. Wait a minute and try again.");
    }
    if (error instanceof Anthropic.BadRequestError) {
      return Errors.badRequest("Could not process this photo. Try a different angle or better lighting.");
    }
    if (error instanceof Anthropic.APIError) {
      return Errors.badGateway("The AI service encountered an error. Please try again.");
    }
    console.error("scan-bottle failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "scanner", phase: "claude-call" },
      extra: { file_size: file.size, file_type: file.type },
    });
    return Errors.internal("Something went wrong identifying the wine.");
  }
}
