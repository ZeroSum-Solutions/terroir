import { describe, expect, it } from "vitest";
import {
  formatInvoiceDate,
  formatPct,
  formatPrice,
  latestPriceByDistributor,
  pickMostRecent,
  type PriceEntry,
} from "./price-comparison-helpers";

function entry(partial: Partial<PriceEntry> = {}): PriceEntry {
  return {
    distributor: "Reliable Distribution",
    unitCost: 18,
    quantity: 6,
    invoiceDate: "2026-08-19",
    ...partial,
  };
}

describe("formatPrice", () => {
  it("formats to two decimal places with a dollar sign", () => {
    expect(formatPrice(18)).toBe("$18.00");
    expect(formatPrice(18.5)).toBe("$18.50");
    expect(formatPrice(0)).toBe("$0.00");
  });
});

describe("formatPct", () => {
  it("formats a fraction as a rounded whole-number percent", () => {
    expect(formatPct(0.1)).toBe("10%");
    expect(formatPct(-0.05)).toBe("-5%");
    expect(formatPct(0)).toBe("0%");
  });
});

describe("formatInvoiceDate", () => {
  it("returns null for a null or invalid ISO string", () => {
    expect(formatInvoiceDate(null)).toBeNull();
    expect(formatInvoiceDate("not-a-date")).toBeNull();
  });

  it("omits the year for the current year and includes it otherwise", () => {
    const now = new Date();
    const thisYear = new Date(now.getFullYear(), 0, 15).toISOString();
    const lastYear = new Date(now.getFullYear() - 1, 0, 15).toISOString();

    expect(formatInvoiceDate(thisYear)).not.toMatch(String(now.getFullYear()));
    expect(formatInvoiceDate(lastYear)).toContain(String(now.getFullYear() - 1));
  });
});

describe("pickMostRecent", () => {
  it("returns undefined for an empty list", () => {
    expect(pickMostRecent([])).toBeUndefined();
  });

  it("picks the entry with the latest invoice date", () => {
    const older = entry({ distributor: "A", invoiceDate: "2026-01-01" });
    const newer = entry({ distributor: "B", invoiceDate: "2026-08-19" });
    expect(pickMostRecent([older, newer])).toBe(newer);
    expect(pickMostRecent([newer, older])).toBe(newer);
  });

  it("falls back to the last entry when none have an invoice date", () => {
    const first = entry({ distributor: "A", invoiceDate: null });
    const last = entry({ distributor: "B", invoiceDate: null });
    expect(pickMostRecent([first, last])).toBe(last);
  });
});

describe("latestPriceByDistributor", () => {
  it("keeps one entry per distributor, the most recently dated one", () => {
    const older = entry({
      distributor: "A",
      unitCost: 20,
      invoiceDate: "2026-01-01",
    });
    const newer = entry({
      distributor: "A",
      unitCost: 22,
      invoiceDate: "2026-08-19",
    });
    const other = entry({ distributor: "B", unitCost: 15 });

    const result = latestPriceByDistributor([older, newer, other]);

    expect(result).toHaveLength(2);
    expect(result.find((p) => p.distributor === "A")).toBe(newer);
  });

  it("sorts the result cheapest first", () => {
    const expensive = entry({ distributor: "A", unitCost: 30 });
    const cheap = entry({ distributor: "B", unitCost: 10 });

    const result = latestPriceByDistributor([expensive, cheap]);

    expect(result.map((p) => p.distributor)).toEqual(["B", "A"]);
  });

  it("keeps an entry with no invoice date when it is the only one for that distributor", () => {
    const undated = entry({ distributor: "A", invoiceDate: null });
    expect(latestPriceByDistributor([undated])).toEqual([undated]);
  });
});
