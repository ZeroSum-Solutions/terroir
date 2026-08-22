import { describe, expect, it } from "vitest";
import type { ParsedInvoice, ParsedLineItem } from "@/lib/scanner/schema";
import {
  toAmount,
  validateInvoiceArithmetic,
  validateLineItemArithmetic,
} from "./invoice-arithmetic";

/**
 * G1-12 — deterministic invoice arithmetic validation.
 *
 * Fixtures below mock structured model output directly (per the slice's
 * acceptance bar): no live API calls, no OCR, just ParsedInvoice-shaped
 * objects representing what Claude's extraction returned. Each corrupted
 * fixture named in the bar (wrong unit cost, transposed digits, wrong
 * currency, case-vs-bottle confusion, comma decimal separators) has its own
 * test, alongside a clean invoice that must be unaffected.
 */

function makeLineItem(overrides: Partial<ParsedLineItem> = {}): ParsedLineItem {
  return {
    name: "Volnay 1er Cru",
    producer: "Domaine Leflaive",
    vintage: 2019,
    varietal: "Pinot Noir",
    region: "Burgundy",
    qty: 6,
    unitCost: 45,
    lineTotal: 270,
    currency: "USD",
    format: "750ml",
    confidence: 0.95,
    lowFields: [],
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<ParsedInvoice> = {}): ParsedInvoice {
  return {
    distributor: "Test Distributor",
    invoiceNumber: "INV-1001",
    invoiceDate: "2026-04-01",
    lineItems: [makeLineItem()],
    invoiceTotal: null,
    taxAndFees: null,
    ...overrides,
  };
}

describe("toAmount", () => {
  it("passes finite numbers through unchanged", () => {
    expect(toAmount(12.5)).toBe(12.5);
    expect(toAmount(0)).toBe(0);
  });

  it("returns null for non-finite numbers", () => {
    expect(toAmount(NaN)).toBeNull();
    expect(toAmount(Infinity)).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(toAmount(null)).toBeNull();
    expect(toAmount(undefined)).toBeNull();
  });

  it("parses a plain decimal string", () => {
    expect(toAmount("1234.56")).toBe(1234.56);
  });

  it("parses a bare European comma decimal", () => {
    expect(toAmount("12,50")).toBe(12.5);
  });

  it("parses European thousands-grouped decimals", () => {
    expect(toAmount("1.234,56")).toBe(1234.56);
  });

  it("parses US thousands-grouped decimals", () => {
    expect(toAmount("1,234.56")).toBe(1234.56);
  });

  it("treats an unqualified comma with 3+ trailing digits as US grouping", () => {
    expect(toAmount("12,345")).toBe(12345);
  });

  it("strips currency symbols and whitespace", () => {
    expect(toAmount(" $1,234.56 ")).toBe(1234.56);
  });

  it("returns null for unparseable input", () => {
    expect(toAmount("not a number")).toBeNull();
  });
});

describe("validateLineItemArithmetic", () => {
  it("is not_applicable when the invoice prints no line total", () => {
    const result = validateLineItemArithmetic(
      makeLineItem({ lineTotal: null }),
      0,
    );
    expect(result.status).toBe("not_applicable");
    expect(result.issue).toBeUndefined();
  });

  it("is ok when qty x unit cost matches the printed line total", () => {
    const result = validateLineItemArithmetic(
      makeLineItem({ qty: 6, unitCost: 45, lineTotal: 270 }),
      0,
    );
    expect(result.status).toBe("ok");
  });

  it("tolerates a one-cent rounding difference", () => {
    const result = validateLineItemArithmetic(
      makeLineItem({ qty: 3, unitCost: 32.5, lineTotal: 97.51 }),
      0,
    );
    expect(result.status).toBe("ok");
  });
});

describe("validateInvoiceArithmetic — clean invoice (must be unaffected)", () => {
  it("passes a fully reconciled multi-line invoice with no issues", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({ qty: 6, unitCost: 45, lineTotal: 270, currency: "USD" }),
        makeLineItem({
          name: "Barolo",
          qty: 3,
          unitCost: 62.5,
          lineTotal: 187.5,
          currency: "USD",
        }),
      ],
      invoiceTotal: 457.5,
      taxAndFees: null,
    });

    const result = validateInvoiceArithmetic(invoice);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("passes when disclosed tax/fees are included in the invoice total", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({ qty: 2, unitCost: 10, lineTotal: 20 }),
        makeLineItem({ qty: 3, unitCost: 15, lineTotal: 45 }),
      ],
      invoiceTotal: 70.2,
      taxAndFees: 5.2,
    });

    expect(validateInvoiceArithmetic(invoice).ok).toBe(true);
  });
});

describe("validateInvoiceArithmetic — corrupted fixture: wrong unit cost", () => {
  it("catches a unit cost that doesn't reconcile against the printed line total", () => {
    const invoice = makeInvoice({
      lineItems: [
        // True unit cost is $28.00 (12 x 28 = 336, the printed line total).
        // Extraction returned $18.00 instead.
        makeLineItem({ qty: 12, unitCost: 18, lineTotal: 336 }),
      ],
    });

    const result = validateInvoiceArithmetic(invoice);

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      type: "line_mismatch",
      lineIndex: 0,
      expected: 216,
      actual: 336,
    });
  });
});

describe("validateInvoiceArithmetic — corrupted fixture: transposed digits", () => {
  it("catches a transposed unit cost (54.00 misread from 45.00)", () => {
    const invoice = makeInvoice({
      lineItems: [
        // Printed line total (4 x $45.00 = $180.00) reflects the true cost;
        // extraction transposed the unit cost's digits to $54.00.
        makeLineItem({ qty: 4, unitCost: 54, lineTotal: 180 }),
      ],
    });

    const result = validateInvoiceArithmetic(invoice);

    expect(result.ok).toBe(false);
    expect(result.issues[0].type).toBe("line_mismatch");
  });
});

describe("validateInvoiceArithmetic — corrupted fixture: wrong currency", () => {
  it("flags inconsistent currencies across line items even when each line's own arithmetic ties out", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({ qty: 6, unitCost: 45, lineTotal: 270, currency: "USD" }),
        makeLineItem({
          name: "Barolo",
          qty: 3,
          unitCost: 62.5,
          lineTotal: 187.5,
          currency: "EUR",
        }),
      ],
    });

    const result = validateInvoiceArithmetic(invoice);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ type: "currency_mismatch" }),
    );
  });

  it("does not flag currency when all lines agree", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({ currency: "EUR" }),
        makeLineItem({ currency: "EUR" }),
      ],
    });

    expect(
      validateInvoiceArithmetic(invoice).issues.some(
        (i) => i.type === "currency_mismatch",
      ),
    ).toBe(false);
  });

  it("does not flag currency when some lines simply have no currency reported", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({ currency: "USD" }),
        makeLineItem({ currency: null }),
      ],
    });

    expect(
      validateInvoiceArithmetic(invoice).issues.some(
        (i) => i.type === "currency_mismatch",
      ),
    ).toBe(false);
  });
});

describe("validateInvoiceArithmetic — corrupted fixture: case-vs-bottle confusion", () => {
  it("flags (without auto-correcting) when line total = qty x unit cost x 12 exactly", () => {
    const invoice = makeInvoice({
      lineItems: [
        // unit cost looks like a per-case price; qty and line total were
        // extracted as if it were a per-bottle price at 12 bottles/case.
        makeLineItem({ qty: 6, unitCost: 20, lineTotal: 1440 }),
      ],
    });

    const result = validateInvoiceArithmetic(invoice);

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      type: "case_bottle_confusion",
      lineIndex: 0,
      multiplier: 12,
      expected: 120,
      actual: 1440,
    });
  });

  it("flags a 6-bottle case-pack pattern too", () => {
    const invoice = makeInvoice({
      lineItems: [makeLineItem({ qty: 2, unitCost: 30, lineTotal: 360 })],
    });

    const result = validateInvoiceArithmetic(invoice);

    expect(result.issues[0]).toMatchObject({
      type: "case_bottle_confusion",
      multiplier: 6,
    });
  });

  it("does not treat a plain mismatch as case/bottle confusion when no case size explains it", () => {
    const invoice = makeInvoice({
      lineItems: [makeLineItem({ qty: 6, unitCost: 45, lineTotal: 1000 })],
    });

    expect(validateInvoiceArithmetic(invoice).issues[0].type).toBe(
      "line_mismatch",
    );
  });
});

describe("validateInvoiceArithmetic — corrupted fixture: comma decimal separators", () => {
  it("correctly normalizes comma-decimal amounts and finds no false mismatch", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({
          qty: 12,
          unitCost: "12,50" as unknown as number,
          lineTotal: "150,00" as unknown as number,
        }),
      ],
    });

    expect(validateInvoiceArithmetic(invoice).ok).toBe(true);
  });

  it("still catches a genuine mismatch when amounts are comma-decimal formatted", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({
          // 12 x 12,50 = 150,00 — but the printed line total reads 200,00.
          qty: 12,
          unitCost: "12,50" as unknown as number,
          lineTotal: "200,00" as unknown as number,
        }),
      ],
    });

    const result = validateInvoiceArithmetic(invoice);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      type: "line_mismatch",
      expected: 150,
      actual: 200,
    });
  });
});

describe("validateInvoiceArithmetic — honest about missing document data", () => {
  it("never invents totals: an invoice with no printed totals at all passes", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({ lineTotal: null }),
        makeLineItem({ name: "Barolo", lineTotal: null }),
      ],
      invoiceTotal: null,
      taxAndFees: null,
    });

    const result = validateInvoiceArithmetic(invoice);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("skips the invoice-level sum check when line-total coverage is partial", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({ lineTotal: null }),
        makeLineItem({ name: "Barolo", qty: 2, unitCost: 10, lineTotal: 20 }),
      ],
      // Deliberately inconsistent with the one known line total — proves
      // this isn't checked when coverage is partial, rather than invented.
      invoiceTotal: 999,
      taxAndFees: null,
    });

    const result = validateInvoiceArithmetic(invoice);
    expect(result.ok).toBe(true);
    expect(
      result.issues.some((i) => i.type === "invoice_total_mismatch"),
    ).toBe(false);
  });
});

describe("validateInvoiceArithmetic — invoice-level total mismatch", () => {
  it("flags when line totals sum correctly but disagree with the printed invoice total", () => {
    const invoice = makeInvoice({
      lineItems: [
        makeLineItem({ qty: 2, unitCost: 10, lineTotal: 20 }),
        makeLineItem({ name: "Barolo", qty: 3, unitCost: 15, lineTotal: 45 }),
      ],
      invoiceTotal: 100, // true sum is 65
      taxAndFees: null,
    });

    const result = validateInvoiceArithmetic(invoice);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        type: "invoice_total_mismatch",
        expected: 65,
        actual: 100,
      }),
    );
  });
});
