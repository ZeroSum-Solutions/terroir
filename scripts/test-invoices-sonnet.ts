/**
 * Batch test all invoice images through the same Claude pipeline
 * used by /api/scan. Outputs a summary table + per-invoice JSON results.
 *
 * Usage:
 *   cd terroir
 *   npx tsx scripts/test-invoices.ts
 *
 * Requires ANTHROPIC_API_KEY in .env.local
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, basename, extname } from "path";

// Load .env.local manually (no dotenv dependency)
const envPath = join(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

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

const SCHEMA = {
  type: "object" as const,
  properties: {
    distributor: { type: "string" as const },
    invoiceNumber: { type: ["string", "null"] as const },
    invoiceDate: { type: ["string", "null"] as const },
    lineItems: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          producer: { type: "string" as const },
          vintage: { type: ["integer", "null"] as const },
          varietal: { type: "string" as const },
          region: { type: "string" as const },
          qty: { type: "integer" as const },
          unitCost: { type: "number" as const },
          confidence: { type: "number" as const },
          lowFields: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["name", "producer", "vintage", "varietal", "region", "qty", "unitCost", "confidence", "lowFields"],
      },
    },
  },
  required: ["distributor", "invoiceNumber", "invoiceDate", "lineItems"],
};

type InvoiceResult = {
  file: string;
  parseTimeMs: number;
  distributor: string;
  invoiceNo: string | null;
  itemCount: number;
  totalBottles: number;
  totalValue: number;
  avgConfidence: number;
  lowConfidenceItems: number;
  lowFields: string[];
  error?: string;
};

async function testInvoice(
  client: Anthropic,
  filePath: string,
): Promise<InvoiceResult> {
  const fileName = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const bytes = readFileSync(filePath);
  const b64 = bytes.toString("base64");

  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
  };
  const mediaType = mimeMap[ext] || "image/png";

  const invoiceContent: Anthropic.ContentBlockParam =
    mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType as "image/png", data: b64 } };

  const start = Date.now();

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            invoiceContent,
            { type: "text", text: "Parse every wine line on this invoice into the structured output. Use the json_output tool." },
          ],
        },
      ],
      tool_choice: { type: "auto" },
      tools: [
        {
          name: "json_output",
          description: "Output the parsed invoice data as structured JSON",
          input_schema: SCHEMA,
        },
      ],
    });

    const elapsed = Date.now() - start;

    // Extract tool use result
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      return { file: fileName, parseTimeMs: elapsed, distributor: "—", invoiceNo: null, itemCount: 0, totalBottles: 0, totalValue: 0, avgConfidence: 0, lowConfidenceItems: 0, lowFields: [], error: "No tool_use block in response" };
    }

    const parsed = toolBlock.input as {
      distributor: string;
      invoiceNumber: string | null;
      invoiceDate: string | null;
      lineItems: Array<{
        name: string; producer: string; vintage: number | null;
        varietal: string; region: string; qty: number; unitCost: number;
        confidence: number; lowFields: string[];
      }>;
    };

    const items = parsed.lineItems || [];
    const avgConf = items.length > 0
      ? items.reduce((s, i) => s + i.confidence, 0) / items.length
      : 0;
    const lowItems = items.filter((i) => i.confidence < 0.75).length;
    const allLowFields = items.flatMap((i) => i.lowFields || []);

    return {
      file: fileName,
      parseTimeMs: elapsed,
      distributor: parsed.distributor,
      invoiceNo: parsed.invoiceNumber,
      itemCount: items.length,
      totalBottles: items.reduce((s, i) => s + i.qty, 0),
      totalValue: items.reduce((s, i) => s + i.qty * i.unitCost, 0),
      avgConfidence: Math.round(avgConf * 1000) / 1000,
      lowConfidenceItems: lowItems,
      lowFields: [...new Set(allLowFields)],
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { file: fileName, parseTimeMs: elapsed, distributor: "—", invoiceNo: null, itemCount: 0, totalBottles: 0, totalValue: 0, avgConfidence: 0, lowConfidenceItems: 0, lowFields: [], error: msg };
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not found in .env.local");
    process.exit(1);
  }

  const invoiceDir = join(__dirname, "..", "test-invoices");
  if (!existsSync(invoiceDir)) {
    console.error(`Invoice directory not found: ${invoiceDir}`);
    process.exit(1);
  }

  const files = readdirSync(invoiceDir)
    .filter((f) => /\.(png|jpg|jpeg|pdf|webp)$/i.test(f))
    .sort();

  console.log(`\n🍷 Terroir Invoice Scanner — Batch Test`);
  console.log(`   ${files.length} invoices to process\n`);

  const client = new Anthropic({ apiKey });
  const results: InvoiceResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = join(invoiceDir, file);
    const label = `[${i + 1}/${files.length}]`;

    process.stdout.write(`${label} ${file} ... `);
    const result = await testInvoice(client, filePath);
    results.push(result);

    if (result.error) {
      console.log(`ERROR: ${result.error}`);
    } else {
      console.log(
        `${result.itemCount} items, ${result.avgConfidence.toFixed(2)} avg conf, ${(result.parseTimeMs / 1000).toFixed(1)}s`,
      );
    }

    // Small delay between requests to avoid rate limiting
    if (i < files.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Summary table
  console.log("\n" + "═".repeat(120));
  console.log("SUMMARY");
  console.log("═".repeat(120));
  console.log(
    "File".padEnd(50) +
    "Items".padStart(6) +
    "Bottles".padStart(8) +
    "Total $".padStart(10) +
    "Avg Conf".padStart(10) +
    "Low Conf".padStart(10) +
    "Time (s)".padStart(10) +
    "  Status",
  );
  console.log("─".repeat(120));

  let totalItems = 0;
  let totalBottles = 0;
  let totalValue = 0;
  let totalTime = 0;
  let successCount = 0;
  let confSum = 0;

  for (const r of results) {
    const status = r.error ? `ERROR: ${r.error.slice(0, 30)}` : "OK";
    console.log(
      r.file.padEnd(50) +
      String(r.itemCount).padStart(6) +
      String(r.totalBottles).padStart(8) +
      `$${r.totalValue.toFixed(0)}`.padStart(10) +
      r.avgConfidence.toFixed(3).padStart(10) +
      String(r.lowConfidenceItems).padStart(10) +
      (r.parseTimeMs / 1000).toFixed(1).padStart(10) +
      `  ${status}`,
    );
    totalItems += r.itemCount;
    totalBottles += r.totalBottles;
    totalValue += r.totalValue;
    totalTime += r.parseTimeMs;
    if (!r.error) {
      successCount++;
      confSum += r.avgConfidence;
    }
  }

  console.log("─".repeat(120));
  const avgConf = successCount > 0 ? confSum / successCount : 0;
  console.log(
    "TOTALS".padEnd(50) +
    String(totalItems).padStart(6) +
    String(totalBottles).padStart(8) +
    `$${totalValue.toFixed(0)}`.padStart(10) +
    avgConf.toFixed(3).padStart(10) +
    "".padStart(10) +
    (totalTime / 1000).toFixed(1).padStart(10) +
    `  ${successCount}/${results.length} OK`,
  );
  console.log("═".repeat(120));

  // Write detailed results to JSON
  const outPath = join(invoiceDir, "..", "test-results-sonnet.json");
  writeFileSync(outPath, JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nDetailed results saved to: ${outPath}\n`);
}

main();
