import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ParsedInvoiceSchema } from "@/lib/scanner/schema";
import type { LineItem, Scan, ScanQuality } from "@/lib/scanner/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

const SYSTEM_PROMPT = `You are an expert at parsing wine invoices from US and European distributors. Wine directors photograph these invoices with their phones and expect every bottle captured correctly.

Parsing guidelines:
- Skip non-wine lines: shipping, tax, subtotals, totals, gift cards, delivery fees.
- For non-vintage wines (most Champagnes marked "NV"), set vintage to null.
- Preserve accents and diacritics in producer names (Château, Müller, d'Oliveira).
- Common French/Italian/German producer names use European comma decimals (e.g., "445,00") — convert to US decimal.
- When OCR leaves a digit ambiguous, make your best guess but set confidence <0.75 and list that field in lowFields.
- Handwritten annotations often correct or clarify the printed line — trust handwriting when it's legible and clearly meant as a correction.
- "Varietal" means the grape, not the country. Infer it from the wine name + region if not explicitly printed (e.g., a wine from Pauillac is Cabernet Sauvignon-based / "Bordeaux Blend").
- "Region" is the wine region, not the country or continent (Burgundy, not France; Piedmont, not Italy).

Confidence scoring:
- 0.95-1.0: clean typed print, all fields unambiguous
- 0.75-0.94: slight ambiguity but reasonable to proceed without review
- 0.50-0.74: needs human review; list ambiguous fields in lowFields
- Below 0.50: guessed significant fields

Return every wine line on the invoice, in the order it appears.`;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
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
      { error: "Attach the invoice as a file under the 'file' field." },
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
      { error: `Unsupported file type: ${file.type || "unknown"}.` },
      { status: 415 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const b64 = Buffer.from(bytes).toString("base64");
  const mediaType = file.type as
    | "image/jpeg"
    | "image/png"
    | "image/webp"
    | "image/gif"
    | "application/pdf";

  const client = new Anthropic({ apiKey });

  const invoiceContent: Anthropic.ContentBlockParam =
    mediaType === "application/pdf"
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: b64 },
        }
      : {
          type: "image",
          source: { type: "base64", media_type: mediaType, data: b64 },
        };

  try {
    const response = await client.messages.parse({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: zodOutputFormat(ParsedInvoiceSchema),
      },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            invoiceContent,
            {
              type: "text",
              text: "Parse every wine line on this invoice into the structured output.",
            },
          ],
        },
      ],
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      return NextResponse.json(
        { error: "Could not parse the invoice. The image may be unreadable — try a sharper photo or higher resolution." },
        { status: 422 },
      );
    }

    const parsedAt = new Date().toISOString();
    const items: LineItem[] = parsed.lineItems.map((item, idx) => ({
      id: `${parsedAt}-${idx}`,
      name: item.name,
      producer: item.producer,
      vintage: item.vintage,
      varietal: item.varietal,
      region: item.region,
      qty: item.qty,
      unitCost: item.unitCost,
      confidence: item.confidence,
      lowFields: item.lowFields.length > 0 ? item.lowFields : undefined,
    }));

    // Confidence gate: flag scans that need extra review
    const avgConfidence =
      items.length > 0
        ? items.reduce((s, i) => s + i.confidence, 0) / items.length
        : 0;
    const lowConfidenceItems = items.filter((i) => i.confidence < 0.75).length;
    const lowConf = avgConfidence < 0.9;
    const tooFew = items.length < 3;
    const quality: ScanQuality = {
      avgConfidence: Math.round(avgConfidence * 1000) / 1000,
      lowConfidenceItems,
      totalItems: items.length,
      manualFallbackTriggered: lowConf || tooFew,
      reason: lowConf && tooFew ? "both" : lowConf ? "low_confidence" : tooFew ? "too_few_items" : undefined,
    };

    const scan: Scan = {
      source: {
        distributor: parsed.distributor,
        invoiceNo: parsed.invoiceNumber ?? "—",
        invoiceDate: parsed.invoiceDate ?? parsedAt.slice(0, 10),
        parsedAt,
      },
      items,
      edits: {},
      quality,
    };

    return NextResponse.json(scan);
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "Rate limited. Wait a minute and try again." },
        { status: 429 },
      );
    }
    if (error instanceof Anthropic.BadRequestError) {
      return NextResponse.json(
        { error: `Claude rejected the request: ${error.message}` },
        { status: 400 },
      );
    }
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: `Claude API error (${error.status}): ${error.message}` },
        { status: 502 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
