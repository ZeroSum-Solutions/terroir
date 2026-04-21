import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { NextResponse, type NextRequest } from "next/server";
import { getAnthropicClient } from "@/lib/ai/anthropic-client";
import { requireMembership } from "@/lib/api/auth";
import { ParsedBottleLabelSchema } from "@/lib/scanner/bottle-schema";
import type { BottleScanResult } from "@/lib/scanner/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const SYSTEM_PROMPT = `You are a wine expert identifying a wine from a photograph of its bottle label. You will receive an image of a wine bottle label.

Identification guidelines:
- Extract the producer/domaine name exactly as printed, preserving accents and diacritics.
- Extract the wine name including any cuvée, appellation, or vineyard designation.
- Read the vintage year from the label. Use null if it is a non-vintage wine (NV).
- Determine the grape varietal. If not printed on the label, infer it from the wine name, region, or appellation (e.g., a wine from Chablis is Chardonnay, Barolo is Nebbiolo).
- Determine the wine region (not country): Burgundy, Napa Valley, Barossa Valley, etc.
- Determine the country of origin if possible.

Confidence scoring:
- 0.95-1.0: label is clearly readable, all fields unambiguous
- 0.75-0.94: slight ambiguity but reasonable identification
- 0.50-0.74: partially obscured label, some guessing required
- Below 0.50: heavily obscured, significant guessing

In notes, mention any special designations (Grand Cru, Reserva, Single Vineyard), alcohol percentage if visible, or fields you could not read.`;

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
  } catch {
    return NextResponse.json(
      { error: "Server not configured: ANTHROPIC_API_KEY missing." },
      { status: 500 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Attach a photo under the 'file' field." },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File exceeds 20 MB." },
      { status: 413 },
    );
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || "unknown"}. Use JPEG or PNG.` },
      { status: 415 },
    );
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
      system: SYSTEM_PROMPT,
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
      return NextResponse.json(
        { error: "Could not identify the wine from this photo. Try a clearer photo of the label." },
        { status: 422 },
      );
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
      return NextResponse.json(
        { error: "Rate limited. Wait a minute and try again." },
        { status: 429 },
      );
    }
    if (error instanceof Anthropic.BadRequestError) {
      return NextResponse.json(
        { error: "Could not process this photo. Try a different angle or better lighting." },
        { status: 400 },
      );
    }
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: "The AI service encountered an error. Please try again." },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: "Something went wrong identifying the wine." },
      { status: 500 },
    );
  }
}
