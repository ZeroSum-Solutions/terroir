import { z } from "zod";

const MetricSchema = z.enum([
  "producerExact",
  "cuveeExact",
  "vintageExact",
  "formatExact",
  "quantityExact",
  "costExact",
  "invoiceLineRecall",
  "invoiceLinePrecision",
  "lineAssociationExact",
]);

export type ScannerQualityMetric = z.infer<typeof MetricSchema>;

const QualityMetricsSchema = z.object({
  producerExact: z.number().min(0).max(1),
  cuveeExact: z.number().min(0).max(1),
  vintageExact: z.number().min(0).max(1),
  formatExact: z.number().min(0).max(1),
  quantityExact: z.number().min(0).max(1),
  costExact: z.number().min(0).max(1),
  invoiceLineRecall: z.number().min(0).max(1),
  invoiceLinePrecision: z.number().min(0).max(1),
  lineAssociationExact: z.number().min(0).max(1),
}).strict();

const BenchmarkLineSchema = z.object({
  associationId: z.string().min(1),
  producer: z.string(),
  cuvee: z.string(),
  vintage: z.number().int().nullable(),
  format: z.string().nullable(),
  quantity: z.number().int().positive().nullable(),
  cost: z.number().nonnegative().nullable(),
});

const ObservedLineSchema = BenchmarkLineSchema.extend({
  associationId: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  committed: z.boolean(),
  reviewed: z.boolean(),
});

const BenchmarkCaseSchema = z.object({
  id: z.string().min(1),
  modality: z.enum(["invoice", "bottle"]),
  conditions: z.array(
    z.enum([
      "clean",
      "rotation",
      "glare",
      "blur",
      "duplicate-lines",
      "partial-page",
      "handwritten-marks",
      "non-wine-lines",
    ]),
  ).min(1),
  durationMs: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  providerOutcome: z.enum(["success", "failure"]),
  expectedLines: z.array(BenchmarkLineSchema),
  observedLines: z.array(ObservedLineSchema),
});

export const ScannerBenchmarkCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  corpusId: z.string().min(1),
  fixtureRevision: z.string().min(1),
  provenance: z.object({
    classification: z.literal("synthetic"),
    containsCustomerData: z.literal(false),
    consentBasis: z.string().min(1),
  }),
  cases: z.array(BenchmarkCaseSchema).min(1),
}).superRefine((corpus, context) => {
  const caseIds = new Set<string>();
  for (const fixture of corpus.cases) {
    if (caseIds.has(fixture.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate benchmark case id: ${fixture.id}`,
      });
    }
    caseIds.add(fixture.id);

    for (const [kind, lines] of [
      ["expected", fixture.expectedLines],
      ["observed", fixture.observedLines],
    ] as const) {
      const associationIds = new Set<string>();
      for (const line of lines) {
        if (line.associationId === null) continue;
        if (associationIds.has(line.associationId)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ${kind} association id ${line.associationId} in ${fixture.id}`,
          });
        }
        associationIds.add(line.associationId);
      }
    }
  }
});

export const ScannerThresholdsSchema = z.object({
  schemaVersion: z.literal(1),
  thresholdId: z.string().min(1),
  ratification: z.object({
    status: z.enum(["pending_product_owner", "ratified"]),
    source: z.string().min(1),
    note: z.string().min(1),
  }),
  qualityFloors: QualityMetricsSchema,
  maximumUnreviewedLowConfidenceCommits: z.number().int().nonnegative(),
  lowConfidenceCutoff: z.number().min(0).max(1),
  latency: z.object({
    invoiceP95MsExclusive: z.number().int().positive(),
    bottleP95MsExclusive: z.number().int().positive(),
  }),
  provider: z.object({
    minimumCanaries: z.number().int().positive(),
    failureRateExclusive: z.number().min(0).max(1),
  }),
  cost: z.object({
    maximumInvoiceUsd: z.number().nonnegative(),
    maximumBottleUsd: z.number().nonnegative(),
  }),
  regression: z.object({
    maximumQualityDrop: z.number().min(0).max(1),
    maximumLatencyIncreaseMs: z.number().int().nonnegative(),
    maximumFailureRateIncrease: z.number().min(0).max(1),
    maximumCostIncreaseUsd: z.number().nonnegative(),
  }),
});

export type ScannerBenchmarkCorpus = z.infer<
  typeof ScannerBenchmarkCorpusSchema
>;
export type ScannerThresholds = z.infer<typeof ScannerThresholdsSchema>;

export type ScannerBenchmarkReport = {
  corpusId: string;
  fixtureRevision: string;
  caseCount: number;
  quality: Record<ScannerQualityMetric, number>;
  counts: {
    expectedInvoiceLines: number;
    observedInvoiceLines: number;
    matchedInvoiceLines: number;
    unreviewedLowConfidenceCommits: number;
  };
  latency: { invoiceP95Ms: number; bottleP95Ms: number };
  provider: { canaryCount: number; failureCount: number; failureRate: number };
  cost: { maximumInvoiceUsd: number; maximumBottleUsd: number };
};

export const ScannerBenchmarkReportSchema: z.ZodType<ScannerBenchmarkReport> =
  z.object({
    corpusId: z.string().min(1),
    fixtureRevision: z.string().min(1),
    caseCount: z.number().int().positive(),
    quality: QualityMetricsSchema,
    counts: z.object({
      expectedInvoiceLines: z.number().int().nonnegative(),
      observedInvoiceLines: z.number().int().nonnegative(),
      matchedInvoiceLines: z.number().int().nonnegative(),
      unreviewedLowConfidenceCommits: z.number().int().nonnegative(),
    }),
    latency: z.object({
      invoiceP95Ms: z.number().int().nonnegative(),
      bottleP95Ms: z.number().int().nonnegative(),
    }),
    provider: z.object({
      canaryCount: z.number().int().nonnegative(),
      failureCount: z.number().int().nonnegative(),
      failureRate: z.number().min(0).max(1),
    }),
    cost: z.object({
      maximumInvoiceUsd: z.number().nonnegative(),
      maximumBottleUsd: z.number().nonnegative(),
    }),
  });

export type ScannerBenchmarkEvaluation = {
  report: ScannerBenchmarkReport;
  violations: string[];
};

const QUALITY_METRICS = MetricSchema.options;

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function exactValue(field: ScannerQualityMetric, expected: unknown, observed: unknown): boolean {
  if (field === "producerExact" || field === "cuveeExact" || field === "formatExact") {
    if (typeof expected !== "string" || typeof observed !== "string") {
      return expected === observed;
    }
    return normalizedText(expected) === normalizedText(observed);
  }
  if (field === "costExact") {
    return (
      typeof expected === "number" &&
      typeof observed === "number" &&
      Math.round(expected * 100) === Math.round(observed * 100)
    );
  }
  return expected === observed;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function maxOrZero(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

export function scoreScannerBenchmark(
  input: unknown,
  lowConfidenceCutoff: number,
): ScannerBenchmarkReport {
  const corpus = ScannerBenchmarkCorpusSchema.parse(input);
  const matches: Record<ScannerQualityMetric, { correct: number; total: number }> =
    Object.fromEntries(
      QUALITY_METRICS.map((metric) => [metric, { correct: 0, total: 0 }]),
    ) as Record<ScannerQualityMetric, { correct: number; total: number }>;

  let expectedInvoiceLines = 0;
  let observedInvoiceLines = 0;
  let matchedInvoiceLines = 0;
  let unreviewedLowConfidenceCommits = 0;

  for (const fixture of corpus.cases) {
    const expectedById = new Map(
      fixture.expectedLines.map((line) => [line.associationId, line]),
    );
    const observedById = new Map(
      fixture.observedLines
        .filter((line) => line.associationId !== null)
        .map((line) => [line.associationId as string, line]),
    );

    for (const observed of fixture.observedLines) {
      if (
        observed.confidence < lowConfidenceCutoff &&
        observed.committed &&
        !observed.reviewed
      ) {
        unreviewedLowConfidenceCommits += 1;
      }
    }

    if (fixture.modality === "invoice") {
      expectedInvoiceLines += fixture.expectedLines.length;
      observedInvoiceLines += fixture.observedLines.length;
      const matched = fixture.observedLines.filter(
        (line) => line.associationId !== null && expectedById.has(line.associationId),
      ).length;
      matchedInvoiceLines += matched;
      matches.invoiceLineRecall.correct += matched;
      matches.invoiceLineRecall.total += fixture.expectedLines.length;
      matches.invoiceLinePrecision.correct += matched;
      matches.invoiceLinePrecision.total += fixture.observedLines.length;
    }

    for (const expected of fixture.expectedLines) {
      const observed = observedById.get(expected.associationId);
      matches.lineAssociationExact.total += 1;
      if (observed) matches.lineAssociationExact.correct += 1;

      const comparisons: Array<
        [ScannerQualityMetric, keyof typeof expected]
      > = [
        ["producerExact", "producer"],
        ["cuveeExact", "cuvee"],
        ["vintageExact", "vintage"],
        ["formatExact", "format"],
        ["quantityExact", "quantity"],
        ["costExact", "cost"],
      ];
      for (const [metric, field] of comparisons) {
        const expectedValue = expected[field];
        if (expectedValue === null && (field === "format" || field === "quantity" || field === "cost")) {
          continue;
        }
        matches[metric].total += 1;
        if (observed && exactValue(metric, expectedValue, observed[field])) {
          matches[metric].correct += 1;
        }
      }
    }
  }

  const quality = Object.fromEntries(
    QUALITY_METRICS.map((metric) => [
      metric,
      ratio(matches[metric].correct, matches[metric].total),
    ]),
  ) as Record<ScannerQualityMetric, number>;

  const failures = corpus.cases.filter(
    (fixture) => fixture.providerOutcome === "failure",
  ).length;
  const invoiceCases = corpus.cases.filter((fixture) => fixture.modality === "invoice");
  const bottleCases = corpus.cases.filter((fixture) => fixture.modality === "bottle");

  return {
    corpusId: corpus.corpusId,
    fixtureRevision: corpus.fixtureRevision,
    caseCount: corpus.cases.length,
    quality,
    counts: {
      expectedInvoiceLines,
      observedInvoiceLines,
      matchedInvoiceLines,
      unreviewedLowConfidenceCommits,
    },
    latency: {
      invoiceP95Ms: percentile95(invoiceCases.map((fixture) => fixture.durationMs)),
      bottleP95Ms: percentile95(bottleCases.map((fixture) => fixture.durationMs)),
    },
    provider: {
      canaryCount: corpus.cases.length,
      failureCount: failures,
      failureRate: ratio(failures, corpus.cases.length),
    },
    cost: {
      maximumInvoiceUsd: maxOrZero(invoiceCases.map((fixture) => fixture.estimatedCostUsd)),
      maximumBottleUsd: maxOrZero(bottleCases.map((fixture) => fixture.estimatedCostUsd)),
    },
  };
}

function thresholdViolations(
  report: ScannerBenchmarkReport,
  thresholds: ScannerThresholds,
): string[] {
  const violations: string[] = [];
  for (const [metric, floor] of Object.entries(thresholds.qualityFloors) as Array<
    [ScannerQualityMetric, number]
  >) {
    if (report.quality[metric] < floor) {
      violations.push(`${metric} ${report.quality[metric]} is below ${floor}`);
    }
  }
  if (
    report.counts.unreviewedLowConfidenceCommits >
    thresholds.maximumUnreviewedLowConfidenceCommits
  ) {
    violations.push("unreviewed low-confidence commits exceed the release maximum");
  }
  if (report.latency.invoiceP95Ms >= thresholds.latency.invoiceP95MsExclusive) {
    violations.push("invoice p95 latency is not below the release ceiling");
  }
  if (report.latency.bottleP95Ms >= thresholds.latency.bottleP95MsExclusive) {
    violations.push("bottle p95 latency is not below the release ceiling");
  }
  if (report.provider.canaryCount < thresholds.provider.minimumCanaries) {
    violations.push("provider canary sample is below the release minimum");
  }
  if (report.provider.failureRate >= thresholds.provider.failureRateExclusive) {
    violations.push("provider failure rate is not below the release ceiling");
  }
  if (report.cost.maximumInvoiceUsd > thresholds.cost.maximumInvoiceUsd) {
    violations.push("invoice provider cost exceeds the release ceiling");
  }
  if (report.cost.maximumBottleUsd > thresholds.cost.maximumBottleUsd) {
    violations.push("bottle provider cost exceeds the release ceiling");
  }
  return violations;
}

export function evaluateScannerBenchmark(
  corpusInput: unknown,
  thresholdInput: unknown,
  baselineInput?: unknown,
): ScannerBenchmarkEvaluation {
  const thresholds = ScannerThresholdsSchema.parse(thresholdInput);
  const baseline = baselineInput === undefined
    ? undefined
    : ScannerBenchmarkReportSchema.parse(baselineInput);
  const report = scoreScannerBenchmark(corpusInput, thresholds.lowConfidenceCutoff);
  const violations = thresholdViolations(report, thresholds);

  if (baseline) {
    for (const metric of QUALITY_METRICS) {
      if (
        report.quality[metric] <
        baseline.quality[metric] - thresholds.regression.maximumQualityDrop
      ) {
        violations.push(`${metric} regressed beyond the baseline tolerance`);
      }
    }
    if (
      report.latency.invoiceP95Ms >
      baseline.latency.invoiceP95Ms + thresholds.regression.maximumLatencyIncreaseMs
    ) {
      violations.push("invoice p95 latency regressed beyond the baseline tolerance");
    }
    if (
      report.latency.bottleP95Ms >
      baseline.latency.bottleP95Ms + thresholds.regression.maximumLatencyIncreaseMs
    ) {
      violations.push("bottle p95 latency regressed beyond the baseline tolerance");
    }
    if (
      report.provider.failureRate >
      baseline.provider.failureRate + thresholds.regression.maximumFailureRateIncrease
    ) {
      violations.push("provider failure rate regressed beyond the baseline tolerance");
    }
    if (
      report.cost.maximumInvoiceUsd >
      baseline.cost.maximumInvoiceUsd + thresholds.regression.maximumCostIncreaseUsd
    ) {
      violations.push("invoice cost regressed beyond the baseline tolerance");
    }
    if (
      report.cost.maximumBottleUsd >
      baseline.cost.maximumBottleUsd + thresholds.regression.maximumCostIncreaseUsd
    ) {
      violations.push("bottle cost regressed beyond the baseline tolerance");
    }
  }

  return { report, violations };
}
