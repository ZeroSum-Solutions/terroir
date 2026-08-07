import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  evaluateScannerBenchmark,
  ScannerBenchmarkReportSchema,
} from "../src/lib/scanner/benchmark.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

const baselineEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  baselineId: z.string().min(1),
  observationKind: z.literal("synthetic_non_billed_contract"),
  sourceRef: z.string().regex(/^[0-9a-f]{40}$/),
  capturedAt: z.string().date(),
  report: ScannerBenchmarkReportSchema,
  limitations: z.array(z.string().min(1)).min(1),
});

const corpus = readJson("src/test/fixtures/scanner/benchmark-v1.json");
const thresholds = readJson("src/test/fixtures/scanner/thresholds-v1.json");
const baseline = baselineEnvelopeSchema.parse(
  readJson("docs/scanner-baselines/scanner-contract-baseline-v1.json"),
);
const evaluation = evaluateScannerBenchmark(corpus, thresholds, baseline.report);

if (
  baseline.report.corpusId !== evaluation.report.corpusId ||
  baseline.report.fixtureRevision !== evaluation.report.fixtureRevision
) {
  evaluation.violations.push(
    "committed baseline does not identify the current corpus revision",
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      evidenceClass: "fixture-only",
      billedProviderCalls: 0,
      baselineId: baseline.baselineId,
      report: evaluation.report,
      violations: evaluation.violations,
    },
    null,
    2,
  )}\n`,
);

if (evaluation.violations.length > 0) {
  process.exitCode = 1;
}
