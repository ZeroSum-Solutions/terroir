// C02 — drive a real 20,000-row Terroir CSV through the real parse/validate
// entry points (parseCsv + validateUploadedCsvFile), no HTTP/DB involved.
import { parseCsv, decodeCsvBuffer } from "../../../src/domains/import/csv-parser";
import { validateUploadedCsvFile } from "../../../src/domains/import/upload-validation";
import { MAX_ROWS, MAX_UPLOAD_BYTES, CANONICAL_HEADERS } from "../../../src/domains/import/constants";

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log(...args);
}

const producers = [
  "Domaine de la Romanee-Conti", "Chateau Margaux", "Screaming Eagle", "Opus One",
  "Vega Sicilia", "Antinori", "Penfolds", "Ridge Vineyards", "Domaine Leflaive", "Sassicaia",
];
const names = [
  "La Tache Grand Cru", "Grand Vin", "Cabernet Sauvignon", "Napa Valley Red",
  "Unico Reserva", "Tignanello", "Grange Bin 95", "Monte Bello", "Batard-Montrachet", "Tenuta San Guido",
];
const varietals = ["Pinot Noir", "Cabernet Sauvignon", "Merlot", "Chardonnay", "Syrah", "Nebbiolo"];
const regions = ["Burgundy", "Bordeaux", "Napa Valley", "Ribera del Duero", "Tuscany", "Barossa Valley"];
const countries = ["France", "USA", "Spain", "Italy", "Australia"];
const bins = ["R4-S12", "R1-S3", "C2-S8", "R7-S1", "W3-S5"];
const sections = ["Reds", "Whites", "Reserve", "Sparkling"];

function buildRow(i: number): string {
  const p = producers[i % producers.length];
  const n = names[i % names.length];
  const vintage = 1995 + (i % 28);
  const varietal = varietals[i % varietals.length];
  const region = regions[i % regions.length];
  const country = countries[i % countries.length];
  const size = 750;
  const format = "";
  const currency = "USD";
  const qty = 1 + (i % 12);
  const cost = (25 + (i % 975) + 0.5).toFixed(2);
  const bin = bins[i % bins.length];
  const section = sections[i % sections.length];
  return [p, n, String(vintage), varietal, region, country, String(size), format, currency, String(qty), cost, bin, section].join(",");
}

function build20kCsv(rowCount: number): Buffer {
  const header = CANONICAL_HEADERS.join(",");
  const lines = [header];
  for (let i = 0; i < rowCount; i++) lines.push(buildRow(i));
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

// 1. Confirm literal constants.
log("=== Literal constants (src/domains/import/constants.ts) ===");
log({ MAX_ROWS, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB: MAX_UPLOAD_BYTES / (1024 * 1024) });

// 2. Build a realistic 20,000-row CSV and measure its size.
const csv20k = build20kCsv(20000);
log("\n=== Realistic 20,000-row Terroir CSV ===");
log({
  totalBytes: csv20k.length,
  totalMB: (csv20k.length / (1024 * 1024)).toFixed(3),
  breaches5MBAlone: csv20k.length > MAX_UPLOAD_BYTES,
  bytesPerRowAvg: (csv20k.length / 20000).toFixed(1),
});

// 3. Run it through validateUploadedCsvFile (the upload-size/MIME gate).
const uploadCheck = validateUploadedCsvFile({ size: csv20k.length, type: "text/csv", name: "cellar-20k.csv" });
log("\n=== validateUploadedCsvFile(20k-row file) ===");
log(uploadCheck);

// 4. Run it through the real parseCsv entry point (row-count gate).
const text = decodeCsvBuffer(csv20k);
const parseResult = parseCsv(text);
log("\n=== parseCsv(20k-row file text) ===");
log(parseResult.ok ? { ok: true, rows: parseResult.rows.length } : parseResult);

// 5. Find the exact row count boundary: 5000 rows should pass, 5001 should fail.
const csv5000 = build20kCsv(5000);
const parse5000 = parseCsv(decodeCsvBuffer(csv5000));
log("\n=== parseCsv(exactly MAX_ROWS=5000 data rows) ===");
log(parse5000.ok ? { ok: true, rows: parse5000.rows.length } : parse5000);

const csv5001 = build20kCsv(5001);
const parse5001 = parseCsv(decodeCsvBuffer(csv5001));
log("\n=== parseCsv(MAX_ROWS+1=5001 data rows) ===");
log(parse5001.ok ? { ok: true, rows: parse5001.rows.length } : parse5001);

// 6. How many realistic rows fit in 5MB alone (ignoring the row cap)?
// Binary-search-ish: use the measured average bytes/row to estimate, then verify.
const avgBytesPerRow = csv20k.length / 20000;
const estRowsFor5MB = Math.floor(MAX_UPLOAD_BYTES / avgBytesPerRow);
log("\n=== Rows-for-5MB estimate (ignoring row cap) ===");
log({ avgBytesPerRow: avgBytesPerRow.toFixed(2), estimatedRowsThatFitIn5MB: estRowsFor5MB });
