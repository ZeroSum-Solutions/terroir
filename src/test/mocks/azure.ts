/**
 * Shared Azure Document Intelligence mock types + fixtures for route
 * tests (BND-010). As with `./anthropic.ts`, the test file inlines the
 * `vi.hoisted(...)` + `vi.mock(...)` pair because vitest factories run
 * before imports are initialized.
 *
 * Boilerplate in the consumer test file:
 *
 *   const azure = vi.hoisted(() => ({ analyzeInvoice: vi.fn() }));
 *
 *   vi.mock("@/lib/scanner/azure", () => ({
 *     analyzeInvoice: (...args: unknown[]) => azure.analyzeInvoice(...args),
 *   }));
 *
 *   // Inside a test body (after imports have initialized):
 *   azure.analyzeInvoice.mockResolvedValue(OK_OCR);
 */
import type { Mock } from "vitest";

export type AzureOcrTable = {
  description: string;
  quantity?: number | null;
  unitPrice?: number | null;
  amount?: number | null;
};

export type AzureOcrResult = {
  rawText: string;
  vendorName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  tables: AzureOcrTable[];
};

export type AzureMockHandle = {
  analyzeInvoice: Mock;
};

/** A minimal "happy path" OCR response — enough for the route to proceed
 *  to the Anthropic call without complaining. */
export const OK_OCR: AzureOcrResult = {
  rawText:
    "Domaine Drouhin Pinot Noir 2019  6 btl  $32.50\n" +
    "Château Margaux 2015  3 btl  $850.00",
  vendorName: "Test Distributor",
  invoiceNumber: "INV-1001",
  invoiceDate: "2026-04-01",
  tables: [
    {
      description: "Domaine Drouhin Pinot Noir 2019",
      quantity: 6,
      unitPrice: 32.5,
      amount: 195,
    },
    {
      description: "Château Margaux 2015",
      quantity: 3,
      unitPrice: 850,
      amount: 2550,
    },
  ],
};

/** OCR succeeded but extracted no usable text — drives the 422 path. */
export const EMPTY_OCR: AzureOcrResult = {
  rawText: "   \n  ",
  vendorName: undefined,
  invoiceNumber: undefined,
  invoiceDate: undefined,
  tables: [],
};
