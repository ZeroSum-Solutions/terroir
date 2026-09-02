import { getAnthropicClient } from "@/lib/ai/anthropic-client";

export {
  AiExtractError,
  extractFromImages,
  extractFromOcr,
  type AiExtractErrorCode,
  type InvoicePage,
  type ParsedInvoice,
  type ParsedLineItem,
} from "@/lib/scanner/ai-extract";

export function assertInvoiceExtractionConfigured() {
  getAnthropicClient();
}

