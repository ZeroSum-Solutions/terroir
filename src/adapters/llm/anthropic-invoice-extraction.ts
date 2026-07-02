import { getAnthropicClient } from "@/lib/ai/anthropic-client";

export {
  AiExtractError,
  extractFromOcr,
  type AiExtractErrorCode,
  type ParsedInvoice,
  type ParsedLineItem,
} from "@/lib/scanner/ai-extract";

export function assertInvoiceExtractionConfigured() {
  getAnthropicClient();
}

