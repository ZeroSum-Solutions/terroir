import { describe, expect, it } from "vitest";
import { checkMissingProducerAcknowledgement, countMissingProducerRows } from "./producer-acknowledgement";
import { CANONICAL_HEADERS, type CanonicalHeader } from "./constants";
import type { PreviewRow } from "./preview-service";

const EMPTY_RAW = Object.fromEntries(CANONICAL_HEADERS.map((f) => [f, null])) as Record<CanonicalHeader, string | null>;
const EMPTY_TEXT = Object.fromEntries(CANONICAL_HEADERS.map((f) => [f, ""])) as Record<CanonicalHeader, string>;

function row(overrides: Partial<PreviewRow>): PreviewRow {
  return {
    rowNumber: 1,
    raw: { ...EMPTY_RAW },
    rawText: { ...EMPTY_TEXT },
    rowState: "valid",
    errors: [],
    lwinStatus: "unmatched",
    lwinId: null,
    lwinScore: null,
    lwinDisplayName: null,
    costStatus: "present",
    producerStatus: "present",
    resolution: "auto",
    mergedFromRowNumbers: [],
    duplicateReason: null,
    ...overrides,
  };
}

describe("countMissingProducerRows", () => {
  it("counts only valid rows carrying no producer", () => {
    expect(
      countMissingProducerRows([
        row({ rowNumber: 1, producerStatus: "missing" }),
        row({ rowNumber: 2, producerStatus: "present" }),
        row({ rowNumber: 3, producerStatus: "missing" }),
      ]),
    ).toBe(2);
  });

  // An error row is excluded from the import entirely, so it never reaches
  // wines.producer — there is nothing about it to acknowledge, and counting
  // it would gate a confirm on rows that are not being written.
  it("ignores error rows even when they carry no producer", () => {
    expect(
      countMissingProducerRows([
        row({ rowNumber: 1, rowState: "error", producerStatus: "missing" }),
        row({ rowNumber: 2, producerStatus: "present" }),
      ]),
    ).toBe(0);
  });
});

describe("checkMissingProducerAcknowledgement", () => {
  it("passes with no acknowledgement when every row has a producer", () => {
    expect(checkMissingProducerAcknowledgement(undefined, [row({})])).toEqual({ ok: true });
  });

  // The whole point of SD-41: a caller that never mentions blank producers
  // cannot write them. This is what a regressed UI panel, an older client
  // or a script now hits instead of silently repeating the 1,277-wine
  // incident.
  it("REFUSES a blank-producer row when no acknowledgement was sent", () => {
    const result = checkMissingProducerAcknowledgement(undefined, [row({ producerStatus: "missing" })]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("missing_producer_unacknowledged");
    expect(result.ok === false && result.error.message).toContain("1 row has no producer");
  });

  it("refuses an acknowledgement smaller than the server's own count", () => {
    const rows = [
      row({ rowNumber: 1, producerStatus: "missing" }),
      row({ rowNumber: 2, producerStatus: "missing" }),
      row({ rowNumber: 3, producerStatus: "missing" }),
    ];
    const result = checkMissingProducerAcknowledgement(2, rows);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("missing_producer_acknowledgement_stale");
  });

  // A hardcoded constant is exactly what the count exists to defeat: it
  // survives a one-row file and fails the moment a real cellar arrives.
  it("refuses a client that always sends 1 once a file has two blank-producer rows", () => {
    expect(checkMissingProducerAcknowledgement(1, [row({ rowNumber: 1, producerStatus: "missing" })])).toEqual({
      ok: true,
    });
    expect(
      checkMissingProducerAcknowledgement(1, [
        row({ rowNumber: 1, producerStatus: "missing" }),
        row({ rowNumber: 2, producerStatus: "missing" }),
      ]).ok,
    ).toBe(false);
  });

  it("accepts an exact acknowledgement", () => {
    expect(
      checkMissingProducerAcknowledgement(2, [
        row({ rowNumber: 1, producerStatus: "missing" }),
        row({ rowNumber: 2, producerStatus: "missing" }),
      ]),
    ).toEqual({ ok: true });
  });

  // Confirm re-derives its preview WITH the operator's inline row fixes
  // applied, so a fix that supplies a producer legitimately leaves the
  // server counting FEWER blank rows than the preview showed. That must
  // never be an error — see the module header on why the comparison is
  // one-directional.
  it("accepts an acknowledgement larger than the count (an inline fix supplied a producer)", () => {
    expect(checkMissingProducerAcknowledgement(5, [row({ producerStatus: "missing" })])).toEqual({ ok: true });
  });

  it("refuses an explicit zero when the file does have blank-producer rows", () => {
    expect(checkMissingProducerAcknowledgement(0, [row({ producerStatus: "missing" })]).ok).toBe(false);
  });
});
