import { describe, expect, it } from "vitest";
import { decodeCsvBuffer, parseCsv } from "./csv-parser";
import { MAX_FIELD_LENGTH, MAX_ROWS } from "./constants";

describe("decodeCsvBuffer", () => {
  it("strips a UTF-8 BOM", () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n1,2")]);
    expect(decodeCsvBuffer(buffer)).toBe("a,b\n1,2");
  });

  it("never throws on invalid byte sequences (hostile/wrong encoding)", () => {
    const buffer = Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x42]);
    expect(() => decodeCsvBuffer(buffer)).not.toThrow();
  });
});

describe("parseCsv", () => {
  it("parses a simple header + rows", () => {
    const result = parseCsv("producer,name\nDomaine A,Cuvee 1\nDomaine B,Cuvee 2\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.header).toEqual(["producer", "name"]);
    expect(result.rows).toEqual([
      ["Domaine A", "Cuvee 1"],
      ["Domaine B", "Cuvee 2"],
    ]);
  });

  it("handles quoted fields with embedded commas, quotes, and newlines", () => {
    const csv = 'producer,name\n"Domaine, A","Cuvee ""Special""\nLine 2"\n';
    const result = parseCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([["Domaine, A", 'Cuvee "Special"\nLine 2']]);
  });

  it("handles CRLF line endings", () => {
    const result = parseCsv("producer,name\r\nDomaine A,Cuvee 1\r\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([["Domaine A", "Cuvee 1"]]);
  });

  it("skips a trailing blank line", () => {
    const result = parseCsv("producer,name\nDomaine A,Cuvee 1\n\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
  });

  it("fails cleanly on an empty file", () => {
    const result = parseCsv("");
    expect(result).toEqual({ ok: false, error: { code: "empty_file", message: "File is empty." } });
  });

  it("fails cleanly on an unterminated quote (hostile/malformed CSV)", () => {
    const result = parseCsv('producer,name\n"Domaine A,Cuvee 1\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unterminated_quote");
  });

  it("rejects a file with more data rows than MAX_ROWS", () => {
    const header = "producer,name\n";
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `P${i},N${i}`).join("\n");
    const result = parseCsv(header + rows);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too_many_rows");
  });

  it("accepts exactly MAX_ROWS data rows", () => {
    const header = "producer,name\n";
    const rows = Array.from({ length: MAX_ROWS }, (_, i) => `P${i},N${i}`).join("\n");
    const result = parseCsv(header + rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(MAX_ROWS);
  });

  it("rejects a cell longer than MAX_FIELD_LENGTH (hostile huge-field defense)", () => {
    const hostile = "x".repeat(MAX_FIELD_LENGTH + 1);
    const result = parseCsv(`producer,name\n${hostile},Cuvee 1\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("field_too_long");
  });

  describe("formula-injection neutralization", () => {
    const cases = ["=HYPERLINK(\"http://evil\")", "+1+1", "-1+1", "@SUM(1;1)", "\tcmd"];
    it.each(cases)("prefixes a leading quote onto %s", (hostile) => {
      const result = parseCsv(`producer,name\n${hostile},Cuvee 1\n`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows[0][0].startsWith("'")).toBe(true);
      expect(result.rows[0][0]).toBe(`'${hostile}`);
    });

    it("leaves an ordinary value alone", () => {
      const result = parseCsv("producer,name\nDomaine A,Cuvee 1\n");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows[0][0]).toBe("Domaine A");
    });

    it("neutralizes formula leads inside quoted fields too", () => {
      const result = parseCsv('producer,name\n"=cmd|calc",Cuvee 1\n');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows[0][0]).toBe("'=cmd|calc");
    });
  });
});
