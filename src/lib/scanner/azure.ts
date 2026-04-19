import DocumentIntelligence, {
  getLongRunningPoller,
  isUnexpected,
} from "@azure-rest/ai-document-intelligence";
import { AzureKeyCredential } from "@azure/core-auth";

export interface AzureOcrResult {
  rawText: string;
  tables: Array<{
    description: string;
    quantity: number | null;
    unitPrice: number | null;
    amount: number | null;
  }>;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  confidence: number;
}

/**
 * Analyze an invoice image using Azure Document Intelligence's
 * prebuilt-invoice model. Returns raw text, extracted table rows,
 * and invoice metadata.
 */
export async function analyzeInvoice(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<AzureOcrResult> {
  const endpoint = process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT;
  const key = process.env.AZURE_DOC_INTELLIGENCE_KEY;

  if (!endpoint || !key) {
    throw new Error(
      "Azure Document Intelligence not configured: set AZURE_DOC_INTELLIGENCE_ENDPOINT and AZURE_DOC_INTELLIGENCE_KEY.",
    );
  }

  const client = DocumentIntelligence(
    endpoint,
    new AzureKeyCredential(key),
  );

  const contentType =
    mimeType === "application/pdf"
      ? "application/pdf"
      : mimeType === "image/png"
        ? "image/png"
        : mimeType === "image/webp"
          ? "image/png" // Azure doesn't support webp; caller should convert
          : "image/jpeg";

  const initialResponse = await client
    .path("/documentModels/{modelId}:analyze", "prebuilt-invoice")
    .post({
      contentType: contentType as "application/pdf" | "image/jpeg" | "image/png" | "image/tiff" | "image/bmp" | "image/heif",
      body: fileBuffer,
    });

  if (isUnexpected(initialResponse)) {
    const status = (initialResponse as { status: string }).status;
    const body = initialResponse.body as { error?: { message?: string } };
    throw new Error(
      `Azure DI request failed (${status}): ${body?.error?.message ?? "Unknown error"}`,
    );
  }

  const poller = getLongRunningPoller(client, initialResponse);
  const result = await poller.pollUntilDone();

  const analyzeResult = (result.body as { analyzeResult?: Record<string, unknown> })
    .analyzeResult;
  if (!analyzeResult) {
    throw new Error("Azure DI returned no analyzeResult.");
  }

  const rawText = (analyzeResult.content as string) ?? "";

  // Extract invoice-level fields from the prebuilt-invoice model
  const documents = (analyzeResult.documents as Array<{
    fields?: Record<string, { content?: string; valueString?: string; valueDate?: string; confidence?: number }>;
    confidence?: number;
  }>) ?? [];

  const doc = documents[0];
  const fields = doc?.fields ?? {};

  const vendorName =
    fields.VendorName?.content ??
    fields.VendorName?.valueString ??
    null;
  const invoiceNumber =
    fields.InvoiceId?.content ??
    fields.InvoiceId?.valueString ??
    null;
  const invoiceDate =
    fields.InvoiceDate?.valueDate ??
    fields.InvoiceDate?.content ??
    null;

  // Extract line items from the Items field
  const itemsField = fields.Items as unknown as {
    valueArray?: Array<{
      valueObject?: Record<string, { content?: string; valueCurrency?: { amount?: number }; valueNumber?: number; confidence?: number }>;
    }>;
  } | undefined;

  const tables: AzureOcrResult["tables"] = [];
  if (itemsField?.valueArray) {
    for (const item of itemsField.valueArray) {
      const obj = item.valueObject ?? {};
      tables.push({
        description: obj.Description?.content ?? "",
        quantity: obj.Quantity?.valueNumber ?? null,
        unitPrice: obj.UnitPrice?.valueCurrency?.amount ?? null,
        amount: obj.Amount?.valueCurrency?.amount ?? null,
      });
    }
  }

  const confidence = doc?.confidence ?? 0;

  return {
    rawText,
    tables,
    vendorName,
    invoiceNumber,
    invoiceDate,
    confidence,
  };
}
