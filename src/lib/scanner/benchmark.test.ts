import { describe, expect, it } from "vitest";
import {
  evaluateScannerBenchmark,
  ScannerBenchmarkCorpusSchema,
  type ScannerBenchmarkCorpus,
  type ScannerThresholds,
} from "./benchmark";

function fixtureCorpus(): ScannerBenchmarkCorpus {
  return {
    schemaVersion: 1,
    corpusId: "test-corpus",
    fixtureRevision: "test-1",
    provenance: {
      classification: "synthetic",
      containsCustomerData: false,
      consentBasis: "Fictional test data",
    },
    cases: Array.from({ length: 20 }, (_, index) => ({
      id: `case-${index}`,
      modality: index < 10 ? ("invoice" as const) : ("bottle" as const),
      conditions: ["clean" as const],
      durationMs: index < 10 ? 1000 + index : 500 + index,
      estimatedCostUsd: index < 10 ? 0.1 : 0.02,
      providerOutcome: "success" as const,
      expectedLines: [
        {
          associationId: `line-${index}`,
          producer: "Producer",
          cuvee: "Cuvee",
          vintage: 2020,
          format: index < 10 ? "750ml" : null,
          quantity: index < 10 ? 6 : null,
          cost: index < 10 ? 12.34 : null,
        },
      ],
      observedLines: [
        {
          associationId: `line-${index}`,
          producer: "Producer",
          cuvee: "Cuvee",
          vintage: 2020,
          format: index < 10 ? "750ml" : null,
          quantity: index < 10 ? 6 : null,
          cost: index < 10 ? 12.34 : null,
          confidence: 0.99,
          committed: true,
          reviewed: false,
        },
      ],
    })),
  };
}

function thresholds(): ScannerThresholds {
  return {
    schemaVersion: 1,
    thresholdId: "test-thresholds",
    ratification: {
      status: "pending_product_owner",
      source: "test",
      note: "test thresholds",
    },
    qualityFloors: {
      producerExact: 0.9,
      cuveeExact: 0.9,
      vintageExact: 0.95,
      formatExact: 0.95,
      quantityExact: 0.98,
      costExact: 0.98,
      invoiceLineRecall: 0.98,
      invoiceLinePrecision: 0.98,
      lineAssociationExact: 0.98,
    },
    maximumUnreviewedLowConfidenceCommits: 0,
    lowConfidenceCutoff: 0.75,
    latency: {
      invoiceP95MsExclusive: 90000,
      bottleP95MsExclusive: 30000,
    },
    provider: { minimumCanaries: 20, failureRateExclusive: 0.05 },
    cost: { maximumInvoiceUsd: 0.25, maximumBottleUsd: 0.05 },
    regression: {
      maximumQualityDrop: 0.02,
      maximumLatencyIncreaseMs: 0,
      maximumFailureRateIncrease: 0,
      maximumCostIncreaseUsd: 0,
    },
  };
}

describe("scanner benchmark release gate", () => {
  it("scores the non-billed fixture corpus across quality, latency, failure, and cost", () => {
    const evaluation = evaluateScannerBenchmark(fixtureCorpus(), thresholds());

    expect(evaluation.violations).toEqual([]);
    expect(evaluation.report.quality).toEqual({
      producerExact: 1,
      cuveeExact: 1,
      vintageExact: 1,
      formatExact: 1,
      quantityExact: 1,
      costExact: 1,
      invoiceLineRecall: 1,
      invoiceLinePrecision: 1,
      lineAssociationExact: 1,
    });
    expect(evaluation.report.provider).toEqual({
      canaryCount: 20,
      failureCount: 0,
      failureRate: 0,
    });
  });

  it("blocks a missing association and the resulting field regression", () => {
    const corpus = fixtureCorpus();
    corpus.cases[0] = {
      ...corpus.cases[0],
      observedLines: [],
    };

    const evaluation = evaluateScannerBenchmark(corpus, thresholds());

    expect(evaluation.report.quality.invoiceLineRecall).toBe(0.9);
    expect(evaluation.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("invoiceLineRecall"),
        expect.stringContaining("quantityExact"),
        expect.stringContaining("lineAssociationExact"),
      ]),
    );
  });

  it("blocks one failure in the minimum 20-canary window because 5% is not below 5%", () => {
    const corpus = fixtureCorpus();
    corpus.cases[0] = { ...corpus.cases[0], providerOutcome: "failure" };

    const evaluation = evaluateScannerBenchmark(corpus, thresholds());

    expect(evaluation.report.provider.failureRate).toBe(0.05);
    expect(evaluation.violations).toContain(
      "provider failure rate is not below the release ceiling",
    );
  });

  it("blocks low-confidence commits until a reviewer approves the correction", () => {
    const corpus = fixtureCorpus();
    corpus.cases[0] = {
      ...corpus.cases[0],
      observedLines: corpus.cases[0].observedLines.map((line) => ({
        ...line,
        confidence: 0.7,
      })),
    };
    const blocked = evaluateScannerBenchmark(corpus, thresholds());
    expect(blocked.violations).toContain(
      "unreviewed low-confidence commits exceed the release maximum",
    );

    corpus.cases[0] = {
      ...corpus.cases[0],
      observedLines: corpus.cases[0].observedLines.map((line) => ({
        ...line,
        reviewed: true,
      })),
    };
    expect(evaluateScannerBenchmark(corpus, thresholds()).violations).toEqual([]);
  });

  it("blocks exact latency and cost ceiling breaches", () => {
    const corpus = fixtureCorpus();
    corpus.cases[0] = {
      ...corpus.cases[0],
      durationMs: 90000,
      estimatedCostUsd: 0.251,
    };

    const evaluation = evaluateScannerBenchmark(corpus, thresholds());

    expect(evaluation.violations).toEqual(
      expect.arrayContaining([
        "invoice p95 latency is not below the release ceiling",
        "invoice provider cost exceeds the release ceiling",
      ]),
    );
  });

  it("blocks a regression even when a relaxed release floor still passes", () => {
    const baseline = evaluateScannerBenchmark(
      fixtureCorpus(),
      thresholds(),
    ).report;
    const corpus = fixtureCorpus();
    corpus.cases[0] = {
      ...corpus.cases[0],
      observedLines: corpus.cases[0].observedLines.map((line) => ({
        ...line,
        producer: "Different producer",
      })),
    };
    const relaxed = thresholds();
    relaxed.qualityFloors.producerExact = 0.8;

    const evaluation = evaluateScannerBenchmark(corpus, relaxed, baseline);

    expect(evaluation.report.quality.producerExact).toBe(0.95);
    expect(evaluation.violations).toContain(
      "producerExact regressed beyond the baseline tolerance",
    );
  });

  it("rejects duplicate case and association identifiers", () => {
    const corpus = fixtureCorpus();
    corpus.cases[1] = {
      ...corpus.cases[1],
      id: corpus.cases[0].id,
      expectedLines: [
        corpus.cases[1].expectedLines[0],
        corpus.cases[1].expectedLines[0],
      ],
    };

    expect(() => ScannerBenchmarkCorpusSchema.parse(corpus)).toThrow(
      /Duplicate benchmark case id|Duplicate expected association id/,
    );
  });
});
