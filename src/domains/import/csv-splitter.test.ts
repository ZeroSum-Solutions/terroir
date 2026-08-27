// P3 — tests for the browser-safe chunk-splitting primitives extracted from
// scripts/validate-bulk-import.ts. Focused unit coverage for the four
// properties the client-side auto-chunking import flow depends on: chunk
// boundaries never cut a record, every chunk replicates the header, the
// data section reassembles byte-for-byte from concatenated chunks, and the
// SHA-256 hash is stable/deterministic. End-to-end drift-tripwire coverage
// against the real parser lives in
// src/test/fixtures/validate-bulk-import.test.ts — this file only exercises
// csv-splitter.ts's own exports in isolation.

import { describe, expect, it } from "vitest";
import {
  splitLogicalRecords,
  isBlankRecord,
  buildChunkPlan,
  serializeChunk,
  sha256HexOfBytes,
  decodeCsvBytesStrict,
  AmbiguousRecordSplitError,
  UnsupportedLineEndingError,
  SubtleCryptoUnavailableError,
  UnsupportedEncodingError,
} from "./csv-splitter";

const HEADER = "producer,name,vintage,varietal,region,country,size_ml,format,currency,quantity,unit_cost,bin,section";

function dataRow(n: number): string {
  return `Producer ${n},Wine ${n},2020,Cabernet,Napa,USA,750,bottle,USD,1,25.00,A${n},Cellar`;
}

describe("splitLogicalRecords", () => {
  it("splits a simple CSV into one record per line, header included", () => {
    const text = [HEADER, dataRow(1), dataRow(2), dataRow(3)].join("\n") + "\n";
    const records = splitLogicalRecords(text);
    expect(records).toEqual([HEADER, dataRow(1), dataRow(2), dataRow(3)]);
  });

  it("never cuts a record at a quoted field's embedded newline", () => {
    const quotedRow = `Producer,"Multi\nLine Name",2020,Cabernet,Napa,USA,750,bottle,USD,1,25.00,A1,Cellar`;
    const text = [HEADER, quotedRow, dataRow(2)].join("\n") + "\n";
    const records = splitLogicalRecords(text);
    expect(records).toEqual([HEADER, quotedRow, dataRow(2)]);
  });

  it("handles a file with no trailing newline", () => {
    const text = [HEADER, dataRow(1)].join("\n");
    expect(splitLogicalRecords(text)).toEqual([HEADER, dataRow(1)]);
  });

  it("throws AmbiguousRecordSplitError on an unterminated quote", () => {
    const text = `${HEADER}\nProducer,"unterminated,2020,Cabernet,Napa,USA,750,bottle,USD,1,25.00,A1,Cellar\n`;
    expect(() => splitLogicalRecords(text)).toThrow(AmbiguousRecordSplitError);
  });

  it("throws UnsupportedLineEndingError on a bare CR outside quotes", () => {
    const text = `${HEADER}\r${dataRow(1)}\r`;
    expect(() => splitLogicalRecords(text)).toThrow(UnsupportedLineEndingError);
  });
});

describe("isBlankRecord", () => {
  it("is true for an empty record", () => {
    expect(isBlankRecord("")).toBe(true);
  });

  it("is false for a real data record", () => {
    expect(isBlankRecord(dataRow(1))).toBe(false);
  });

  it("is false for the header record", () => {
    expect(isBlankRecord(HEADER)).toBe(false);
  });
});

describe("buildChunkPlan + serializeChunk", () => {
  const dataRecords = Array.from({ length: 10 }, (_, i) => dataRow(i + 1));

  it("partitions records into chunks of at most chunkTargetRows, in order", () => {
    const plan = buildChunkPlan(dataRecords, 4);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toMatchObject({ index: 1, startRow: 1, endRow: 4 });
    expect(plan[1]).toMatchObject({ index: 2, startRow: 5, endRow: 8 });
    expect(plan[2]).toMatchObject({ index: 3, startRow: 9, endRow: 10 });
    expect(plan[0].records).toEqual(dataRecords.slice(0, 4));
    expect(plan[1].records).toEqual(dataRecords.slice(4, 8));
    expect(plan[2].records).toEqual(dataRecords.slice(8, 10));
  });

  it("a chunk boundary never bisects a record — every planned record is intact", () => {
    const plan = buildChunkPlan(dataRecords, 3);
    const flattened = plan.flatMap((c) => c.records);
    expect(flattened).toEqual(dataRecords);
  });

  it("produces a single chunk when chunkTargetRows exceeds the record count", () => {
    const plan = buildChunkPlan(dataRecords, 1000);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ index: 1, startRow: 1, endRow: 10 });
  });

  it("produces zero chunks for zero records", () => {
    expect(buildChunkPlan([], 4)).toEqual([]);
  });

  it("serializeChunk replicates the shared header on every chunk", () => {
    const plan = buildChunkPlan(dataRecords, 4);
    for (const chunk of plan) {
      const serialized = serializeChunk(HEADER, chunk.records);
      const firstLine = serialized.split("\n", 1)[0];
      expect(firstLine).toBe(HEADER);
    }
  });

  it("concatenating every chunk's data rows reconstructs the original data section byte-for-byte", () => {
    const plan = buildChunkPlan(dataRecords, 3);
    const reassembled = plan.flatMap((c) => c.records).join("\n");
    const original = dataRecords.join("\n");
    expect(Buffer.from(reassembled, "utf8").equals(Buffer.from(original, "utf8"))).toBe(true);
  });

  it("serializeChunk output round-trips through splitLogicalRecords back to header + chunk records", () => {
    const plan = buildChunkPlan(dataRecords, 4);
    for (const chunk of plan) {
      const serialized = serializeChunk(HEADER, chunk.records);
      expect(splitLogicalRecords(serialized)).toEqual([HEADER, ...chunk.records]);
    }
  });
});

describe("sha256HexOfBytes", () => {
  it("is stable across repeated calls on the same bytes", async () => {
    const bytes = new TextEncoder().encode([HEADER, dataRow(1), dataRow(2)].join("\n") + "\n");
    const first = await sha256HexOfBytes(bytes);
    const second = await sha256HexOfBytes(bytes);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different bytes", async () => {
    const a = await sha256HexOfBytes(new TextEncoder().encode("a"));
    const b = await sha256HexOfBytes(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });

  it("matches Node's own createHash('sha256') for the same bytes", async () => {
    const { createHash } = await import("node:crypto");
    const text = [HEADER, dataRow(1), dataRow(2), dataRow(3)].join("\n") + "\n";
    const bytes = new TextEncoder().encode(text);
    const viaSubtle = await sha256HexOfBytes(bytes);
    const viaNode = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    expect(viaSubtle).toBe(viaNode);
  });

  it("SubtleCryptoUnavailableError is exported for callers to detect the unsupported-context case", () => {
    expect(SubtleCryptoUnavailableError.prototype).toBeInstanceOf(Error);
  });
});

describe("decodeCsvBytesStrict", () => {
  it("decodes plain UTF-8 bytes", () => {
    const bytes = new TextEncoder().encode("a,b\n1,2");
    expect(decodeCsvBytesStrict(bytes)).toBe("a,b\n1,2");
  });

  it("strips a leading UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a,b\n1,2")]);
    expect(decodeCsvBytesStrict(bytes)).toBe("a,b\n1,2");
  });

  it("throws UnsupportedEncodingError on an invalid UTF-8 byte sequence (e.g. Windows-1252 'é')", () => {
    // 0xe9 alone is "é" in Windows-1252/Latin-1 but is never valid as a
    // standalone UTF-8 byte — exactly the "Château" -> "Ch�teau" corruption
    // the audit flagged.
    const bytes = new Uint8Array([0x43, 0x68, 0xe9, 0x74, 0x65, 0x61, 0x75]);
    expect(() => decodeCsvBytesStrict(bytes)).toThrow(UnsupportedEncodingError);
  });

  it("throws UnsupportedEncodingError on a UTF-16LE BOM", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00]);
    expect(() => decodeCsvBytesStrict(bytes)).toThrow(UnsupportedEncodingError);
  });

  it("throws UnsupportedEncodingError on a UTF-16BE BOM", () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x61]);
    expect(() => decodeCsvBytesStrict(bytes)).toThrow(UnsupportedEncodingError);
  });
});
