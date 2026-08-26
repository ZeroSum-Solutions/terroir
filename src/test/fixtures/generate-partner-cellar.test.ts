// P1 — tests for scripts/fixtures/generate-partner-cellar.mjs, the
// deterministic 20k "partner cellar" fixture generator. Colocated under
// src/test (like src/test/contracts/check-down-migrations.test.ts, which
// exercises a scripts/*.mjs file the same way) so it runs under the
// repo's normal `pnpm test`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  generateDataset,
  buildManifest,
  toCsvText,
  computeEan13CheckDigit,
  normalizeForDedup,
  variantKey,
  TOTAL_ROWS,
  FORMAT_LABEL,
  NV_LITERAL_VARIANT_COUNT,
} from "../../../scripts/fixtures/generate-partner-cellar.mjs";
import { decodeCsvBuffer, parseCsv } from "@/domains/import/csv-parser";
import { mapHeader, validateRow } from "@/domains/import/row-validator";
import { CANONICAL_HEADERS } from "@/domains/import/constants";

const CLI = join(process.cwd(), "scripts", "fixtures", "generate-partner-cellar.mjs");

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`generator CLI failed (status ${result.status}): ${result.stderr}`);
  }
  return result;
}

// Whole-file parse+validate accounting (chunking at MAX_ROWS, sha256
// verification, manifest-tagged expected-invalid groups, ...) is the
// shipped runner's job (scripts/validate-bulk-import.ts) — see
// src/test/fixtures/validate-bulk-import.test.ts, which drives that CLI
// directly via subprocess rather than reimplementing its chunking logic
// here. A prior version of this file had its own naive `text.split("\n")`
// chunker; that duplicated (and, pre-fix, diverged from) the real script's
// record-boundary handling, so it was removed in favor of driving the
// shipped runner end to end.

describe("generate-partner-cellar CLI", () => {
  const tempDirs: string[] = [];
  function tmp() {
    const d = mkdtempSync(join(tmpdir(), "partner-cellar-"));
    tempDirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is deterministic: two independent full runs produce byte-identical CSV and manifest", () => {
    const d1 = tmp();
    const d2 = tmp();
    runCli(["--out-dir", d1]);
    runCli(["--out-dir", d2]);
    const csv1 = readFileSync(join(d1, "partner-cellar-20k.csv"));
    const csv2 = readFileSync(join(d2, "partner-cellar-20k.csv"));
    expect(csv1.equals(csv2)).toBe(true);
    const m1 = readFileSync(join(d1, "partner-cellar-20k.manifest.json"), "utf8");
    const m2 = readFileSync(join(d2, "partner-cellar-20k.manifest.json"), "utf8");
    expect(m1).toBe(m2);
  });

  it("produces exactly 20,000 data rows by default", () => {
    const d = tmp();
    runCli(["--out-dir", d]);
    const text = readFileSync(join(d, "partner-cellar-20k.csv"), "utf8");
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    expect(lines.length - 1).toBe(TOTAL_ROWS);
  });

  it("golden sample matches the committed fixture byte-for-byte (generator drift guard)", () => {
    const d = tmp();
    runCli(["--sample-only", "--out-dir", d]);
    const fresh = readFileSync(join(d, "partner-cellar-sample-500.csv"));
    const committed = readFileSync(join(process.cwd(), "fixtures", "partner-cellar-sample-500.csv"));
    expect(fresh.equals(committed)).toBe(true);
  });

  it("locks the committed golden manifest's csv_sha256 against the committed CSV's actual bytes", () => {
    // The manifest's csv_sha256 is only trustworthy if something actually
    // recomputes and compares it (see scripts/validate-bulk-import.ts's
    // sha256 integrity check) rather than just printing it. This pins the
    // committed golden fixture's claimed hash to its real bytes so the two
    // can never silently drift apart.
    const committedCsv = readFileSync(join(process.cwd(), "fixtures", "partner-cellar-sample-500.csv"));
    const committedManifest = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures", "partner-cellar-sample-500.manifest.json"), "utf8"),
    );
    const actualSha = createHash("sha256").update(committedCsv).digest("hex");
    expect(committedManifest.csv_sha256).toBe(actualSha);
  });
});

describe("row-validator conformance", () => {
  it("every default row passes the CURRENT row-validator, including the tagged nv_literal group (valid since P2's NV allowlist)", () => {
    // Each row is rendered + parsed individually with the real toCsvText()
    // / parseCsv() (a single-record file never needs chunking), so this
    // exercises the real product code for all 20,000 rows without
    // reimplementing any chunking or line-splitting.
    const dataset = generateDataset({ extras: false, dirty: false });
    expect(dataset.records.length).toBe(TOTAL_ROWS);
    const nvLiteralVariantIds = new Set(dataset.variants.filter((v) => v.tags.nvLiteral).map((v) => v.id));
    const expectedNvLiteralRowCount = dataset.records.filter((r) => nvLiteralVariantIds.has(r.variant.id)).length;
    expect(expectedNvLiteralRowCount).toBeGreaterThan(0);

    let validCount = 0;
    let validNvLiteralCount = 0;
    let invalidCount = 0;
    for (const record of dataset.records) {
      const rowCsvText = toCsvText([record], [], false);
      const result = parseCsv(rowCsvText);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const { columnToField } = mapHeader(result.header);
      const validated = validateRow(result.rows[0], columnToField);
      if (validated.state === "valid") {
        validCount++;
        if (nvLiteralVariantIds.has(record.variant.id)) {
          // P2's NV fix (normalizeVintage's closed allowlist, plan §5):
          // the literal vintage text "NV" is the identity fact "no
          // vintage" and resolves to a valid row with vintage null —
          // not a rejection, and never a silently-coerced number.
          validNvLiteralCount++;
          // raw.vintage carries the NORMALIZED vintage (String(year) or
          // null) — for the literal text "NV", P2's allowlist resolves it
          // to null, never a silently-coerced number.
          expect(validated.raw.vintage).toBeNull();
        }
      } else {
        invalidCount++;
      }
    }
    expect(invalidCount).toBe(0);
    expect(validNvLiteralCount).toBe(expectedNvLiteralRowCount);
    expect(validCount).toBe(TOTAL_ROWS);
  });

  it("decodes cleanly as UTF-8 with no BOM issues", () => {
    const dataset = generateDataset({ extras: false, dirty: false });
    const csvText = toCsvText(dataset.records, [], false);
    const decoded = decodeCsvBuffer(Buffer.from(csvText, "utf8"));
    expect(decoded).toBe(csvText);
  });
});

describe("--dirty rows", () => {
  it("bad_vintage_text and negative_quantity fail row-validator; oversized_field fails at the parser level", () => {
    const dataset = generateDataset({ extras: false, dirty: true });
    expect(dataset.dirtyRecords.length).toBe(50);
    for (const dr of dataset.dirtyRecords) {
      const csvText = toCsvText([], [dr], false);
      const result = parseCsv(csvText);
      if (dr.dirtyCategory === "oversized_field") {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("field_too_long");
      } else {
        expect(result.ok).toBe(true);
        if (result.ok) {
          const { columnToField } = mapHeader(result.header);
          const validated = validateRow(result.rows[0], columnToField);
          expect(validated.state).toBe("error");
        }
      }
    }
  });
});

describe("category coverage", () => {
  const dataset = generateDataset({ extras: false, dirty: false });

  it("lands unique variants in the 4,000-4,500 range the blueprint calls for", () => {
    expect(dataset.variants.length).toBeGreaterThanOrEqual(4000);
    expect(dataset.variants.length).toBeLessThanOrEqual(4500);
  });

  it("has the expected exact category totals for this seed", () => {
    const totals = { famous: 0, nv: 0, nvLiteral: 0, adjacentVintage: 0, formatSibling: 0, spellingNoise: 0 };
    for (const v of dataset.variants) {
      if (v.tags.famous) totals.famous++;
      if (v.tags.nv) totals.nv++;
      if (v.tags.nvLiteral) totals.nvLiteral++;
      if (v.tags.adjacentFamily) totals.adjacentVintage++;
      if (v.tags.formatFamily) totals.formatSibling++;
      if (v.tags.spellingGroupId) totals.spellingNoise++;
    }
    expect(totals.famous).toBe(130);
    expect(totals.nv).toBe(260);
    expect(totals.nvLiteral).toBe(NV_LITERAL_VARIANT_COUNT);
    expect(totals.adjacentVintage).toBe(90);
    expect(totals.formatSibling).toBe(100);
    expect(totals.spellingNoise).toBe(40);
  });

  it("NV variants all carry a blank vintage", () => {
    const nvVariants = dataset.variants.filter((v) => v.tags.nv);
    expect(nvVariants.length).toBeGreaterThan(0);
    for (const v of nvVariants) expect(v.vintage).toBeNull();
  });

  it("nv_literal variants carry a null internal vintage but render the literal text \"NV\"", () => {
    const nvLiteralVariants = dataset.variants.filter((v) => v.tags.nvLiteral);
    expect(nvLiteralVariants.length).toBe(NV_LITERAL_VARIANT_COUNT);
    for (const v of nvLiteralVariants) {
      expect(v.vintage).toBeNull();
      expect(v.tags.nv).toBe(false); // distinct group from the blank-vintage NV pool
      const record = dataset.records.find((r) => r.variant.id === v.id);
      expect(record).toBeDefined();
      const csvText = toCsvText([record!], [], false);
      const vintageCol = CANONICAL_HEADERS.indexOf("vintage");
      const dataLine = csvText.split("\n")[1];
      expect(dataLine.split(",")[vintageCol]).toBe("NV");
    }
  });

  it("adjacent-vintage families cover exactly {2014,2015,2016} and stay distinct variant keys", () => {
    const byFamily = new Map<string, typeof dataset.variants>();
    for (const v of dataset.variants.filter((vv) => vv.tags.adjacentFamily)) {
      const arr = byFamily.get(v.tags.adjacentFamily as string) ?? [];
      arr.push(v);
      byFamily.set(v.tags.adjacentFamily as string, arr);
    }
    expect(byFamily.size).toBe(30);
    for (const members of byFamily.values()) {
      expect(members.map((m) => m.vintage).sort()).toEqual([2014, 2015, 2016]);
      const keys = members.map((m) => variantKey(m.producer, m.name, m.vintage, m.sizeMl));
      expect(new Set(keys).size).toBe(3);
      // Same wine textually...
      const normalized = new Set(members.map((m) => normalizeForDedup(`${m.producer} ${m.name}`)));
      expect(normalized.size).toBe(1);
    }
  });

  it("format-sibling families cover exactly {375,750,1500,3000} with matching format labels", () => {
    const byFamily = new Map<string, typeof dataset.variants>();
    for (const v of dataset.variants.filter((vv) => vv.tags.formatFamily)) {
      const arr = byFamily.get(v.tags.formatFamily as string) ?? [];
      arr.push(v);
      byFamily.set(v.tags.formatFamily as string, arr);
    }
    expect(byFamily.size).toBe(25);
    for (const members of byFamily.values()) {
      expect(members.map((m) => m.sizeMl).sort((a, b) => a - b)).toEqual([375, 750, 1500, 3000]);
      for (const m of members) expect(FORMAT_LABEL[m.sizeMl as keyof typeof FORMAT_LABEL]).toBeTruthy();
    }
  });
});

describe("spelling-noise groups", () => {
  const dataset = generateDataset({ extras: false, dirty: false });
  const spellingVariants = dataset.variants.filter((v) => v.tags.spellingGroupId);

  it("has 40 groups (10 per category) and every member normalizes to the same key", () => {
    expect(spellingVariants.length).toBe(40);
    for (const v of spellingVariants) {
      const canon = normalizeForDedup(`${v.producer} ${v.name}`);
      const alt = normalizeForDedup(`${v.altSpelling.producer} ${v.altSpelling.name}`);
      expect(alt).toBe(canon);
      // And the raw variant key genuinely differs — this is the naive-count inflation.
      expect(v.altSpelling.producer === v.producer && v.altSpelling.name === v.name).toBe(false);
    }
  });

  it("nfc_nfd members are visually identical but byte-distinct, with the alt form genuinely NFD", () => {
    const nfcNfd = spellingVariants.filter((v) => v.tags.spellingType === "nfc_nfd");
    expect(nfcNfd.length).toBe(10);
    const combining = /[̀-ͯ]/;
    for (const v of nfcNfd) {
      expect(v.producer.normalize("NFC")).toBe(v.producer);
      expect(combining.test(v.producer)).toBe(false);
      expect(combining.test(v.altSpelling.producer)).toBe(true);
      expect(v.altSpelling.producer.normalize("NFC")).toBe(v.producer);
      expect(v.altSpelling.producer).not.toBe(v.producer);
    }
  });

  it("both canonical and alt spellings actually appear among the rendered rows", () => {
    for (const v of spellingVariants) {
      const rows = dataset.records.filter((r) => r.variant.id === v.id);
      expect(rows.some((r) => r.spellingFormUsed === "canonical")).toBe(true);
      expect(rows.some((r) => r.spellingFormUsed === "alt")).toBe(true);
    }
  });
});

describe("manifest row indexes vs rendered CSV", () => {
  it("adjacent-vintage group row indexes point at rows that really carry that vintage and producer", () => {
    const dataset = generateDataset({ extras: false, dirty: false });
    const csvText = toCsvText(dataset.records, [], false);
    const lines = csvText.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const bodyLines = lines.slice(1);
    const vintageCol = CANONICAL_HEADERS.indexOf("vintage");
    const producerCol = CANONICAL_HEADERS.indexOf("producer");

    const family = dataset.variants.filter((v) => v.tags.adjacentFamily === "av-001");
    expect(family.length).toBe(3);
    for (const v of family) {
      const rowsForVariant = dataset.records.filter((r) => r.variant.id === v.id);
      expect(rowsForVariant.length).toBeGreaterThan(0);
      for (const r of rowsForVariant) {
        const cells = bodyLines[r.rowIndex - 1].split(",");
        expect(cells[producerCol]).toBe(v.producer);
        expect(cells[vintageCol]).toBe(String(v.vintage));
      }
    }
  });

  it("manifest nv_literal_rows point at rows whose vintage cell is exactly the literal text \"NV\"", () => {
    const dataset = generateDataset({ extras: false, dirty: false });
    const csvText = toCsvText(dataset.records, [], false);
    const manifest = buildManifest(dataset.records, [], false, csvText, dataset.variants.length);
    const lines = csvText.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const bodyLines = lines.slice(1);
    const vintageCol = CANONICAL_HEADERS.indexOf("vintage");

    const nvLiteralVariantIds = new Set(dataset.variants.filter((v) => v.tags.nvLiteral).map((v) => v.id));
    const expectedRowCount = dataset.records.filter((r) => nvLiteralVariantIds.has(r.variant.id)).length;

    expect(manifest.nv_literal_rows.length).toBe(expectedRowCount);
    expect(manifest.category_summary.nv_literal_variants).toBe(nvLiteralVariantIds.size);
    for (const entry of manifest.nv_literal_rows) {
      const cells = bodyLines[entry.row_index - 1].split(",");
      expect(cells[vintageCol]).toBe("NV");
    }
  });
});

describe("EAN-13 barcodes (--extras)", () => {
  it("every generated barcode has a valid EAN-13 check digit, coverage near 20%", () => {
    const dataset = generateDataset({ extras: true, dirty: false });
    const withBarcode = dataset.records.filter((r) => r.extra?.barcode);
    expect(withBarcode.length).toBeGreaterThan(0);
    for (const r of withBarcode) {
      const barcode = r.extra!.barcode;
      const twelve = barcode.slice(0, 12);
      const check = barcode.slice(12);
      expect(String(computeEan13CheckDigit(twelve))).toBe(check);
    }
    const coverage = withBarcode.length / dataset.records.length;
    expect(coverage).toBeGreaterThan(0.15);
    expect(coverage).toBeLessThan(0.25);
  });

  it("computeEan13CheckDigit matches known reference values", () => {
    // GTIN reference: 400638133393 -> check digit 1 (400638133393 1 is a
    // real, widely-cited EAN-13 example).
    expect(computeEan13CheckDigit("400638133393")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round-6: normalizeForDedup <-> P2's normalizeProducerOrCuvee cross-piece
// agreement. P2's critic ran both live functions side by side and found
// they disagreed on realistic possessive inputs ("O'Brien's Vineyard",
// "d'Arenberg's Estate", ...) — they only agreed before this fix by
// coincidence of the corpus (this file's own seed data happens to contain
// no possessive apostrophes), not by contract. P2 fixed a genuine
// over-merge bug ("O'Brien's Vineyard" and "O.S. Brien Vineyard" collapsing
// to one wine) in src/domains/identity/normalize.ts
// (terroir-vw, commit c537d84); normalizeForDedup() above now carries the
// identical rule, in the identical pipeline position, verbatim.
//
// normalizeProducerOrCuvee lives in a different repo/worktree (terroir-vw)
// and cannot be imported directly from here, so this inlines a byte-for-
// byte copy of P2's function (as read at commit c537d84) purely for
// independent cross-verification — it is not a second implementation
// anything else in this file depends on, and any accidental drift between
// this copy and normalizeForDedup() above would show up as a failure here
// the next time either side changes.
// ---------------------------------------------------------------------------

describe("normalizeForDedup <-> P2's normalizeProducerOrCuvee cross-piece agreement (round-6)", () => {
  function p2NormalizeProducerOrCuvee(raw: string): string {
    const folded = raw
      .replace(/œ/gi, "oe")
      .replace(/æ/gi, "ae")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/['’]s(?=\s|$)/g, "s")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    return folded.split(" ").filter(Boolean).sort().join(" ");
  }

  const ADVERSARIAL_CORPUS = [
    // Trailing possessives — the exact bug class P2 fixed.
    "O'Brien's Vineyard",
    "O.S. Brien Vineyard",
    "d'Arenberg's Estate",
    "St. James's Gate",
    "Winemakers' Selection", // plural possessive, apostrophe AFTER the s — the rule does not (and need not) touch this
    "Kings' Vineyard's Reserve", // several possessives in one name
    "Producer's Reserve", // ASCII apostrophe
    "Producer’s Reserve", // Unicode right single quote
    // Name-internal apostrophes — must NOT be treated as possessives.
    "Cœur d'Alsace",
    "Coeur d'Alsace",
    "Clos-de-Tart",
    "Clos de Tart",
    // Existing accent/NFC-NFD/reorder/no-op cases — must still converge or
    // stay distinct exactly as before.
    "Château Belair-Vauban",
    "Chateau Belair-Vauban",
    "Domaine René Léveillé".normalize("NFC"),
    "Domaine René Léveillé".normalize("NFD"),
    "Domaine Jean Grivot",
    "Jean Grivot Domaine",
    "Señorío de Valdemoro",
    "Senorio de Valdemoro",
    "Chateau 5",
    "Chateau 6",
  ];

  it("normalizeForDedup and an inlined copy of P2's normalizeProducerOrCuvee agree on every case in the adversarial corpus", () => {
    const disagreements = ADVERSARIAL_CORPUS.filter((input) => normalizeForDedup(input) !== p2NormalizeProducerOrCuvee(input));
    expect(disagreements).toEqual([]);
  });

  it("closes the over-merge bug: O'Brien's Vineyard and O.S. Brien Vineyard no longer collapse to the same key", () => {
    expect(normalizeForDedup("O'Brien's Vineyard")).not.toBe(normalizeForDedup("O.S. Brien Vineyard"));
  });

  it("still converges a name-internal apostrophe (not a trailing possessive) — Coeur d'Alsace", () => {
    expect(normalizeForDedup("Cœur d'Alsace")).toBe(normalizeForDedup("Coeur d'Alsace"));
  });

  it("Unicode right-single-quote and ASCII apostrophe possessives normalize identically", () => {
    expect(normalizeForDedup("Producer’s Reserve")).toBe(normalizeForDedup("Producer's Reserve"));
  });

  it("Chateau 5 / Chateau 6 stay distinct (unaffected by the possessive rule)", () => {
    expect(normalizeForDedup("Chateau 5")).not.toBe(normalizeForDedup("Chateau 6"));
  });
});
