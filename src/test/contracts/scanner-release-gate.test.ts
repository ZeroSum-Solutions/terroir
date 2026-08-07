import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOW_CONFIDENCE_ITEM_THRESHOLD } from "@/lib/scanner/scoring";

const migration = readFileSync(
  "supabase/migrations/0078_scanner_low_confidence_review.sql",
  "utf8",
);
const rollback = readFileSync(
  "supabase/migrations/down/0078_scanner_low_confidence_review.down.sql",
  "utf8",
);
const databaseAcceptance = readFileSync(
  "supabase/tests/0078_scanner_low_confidence_review.sql",
  "utf8",
);
const corpus = JSON.parse(
  readFileSync("src/test/fixtures/scanner/benchmark-v1.json", "utf8"),
) as {
  provenance: { classification: string; containsCustomerData: boolean };
  cases: Array<{ conditions: string[] }>;
};
const thresholds = JSON.parse(
  readFileSync("src/test/fixtures/scanner/thresholds-v1.json", "utf8"),
) as {
  ratification: { status: string };
  lowConfidenceCutoff: number;
};
const scoreWorkflow = readFileSync(".github/workflows/score.yml", "utf8");

describe("TER-022 scanner release contracts", () => {
  it("uses only explicit synthetic non-customer fixtures in the CI gate", () => {
    expect(corpus.provenance).toMatchObject({
      classification: "synthetic",
      containsCustomerData: false,
    });
    const covered = new Set(corpus.cases.flatMap((fixture) => fixture.conditions));
    for (const condition of [
      "rotation",
      "glare",
      "blur",
      "duplicate-lines",
      "partial-page",
      "handwritten-marks",
      "non-wine-lines",
    ]) {
      expect(covered.has(condition)).toBe(true);
    }
  });

  it("does not let pending owner ratification masquerade as runtime evidence", () => {
    expect(thresholds.ratification.status).toBe("pending_product_owner");
    expect(scoreWorkflow).toContain("intentionally non-billed");
    expect(scoreWorkflow).toContain("scripts/score-scanner-fixtures.ts");
    expect(scoreWorkflow).toContain("set -o pipefail");
    expect(scoreWorkflow).not.toMatch(/ANTHROPIC_API_KEY|AZURE_DOC_INTELLIGENCE_KEY/);
    expect(scoreWorkflow).not.toMatch(/^\s*schedule:/m);
  });

  it("keeps every low-confidence enforcement surface on the release cutoff", () => {
    expect(thresholds.lowConfidenceCutoff).toBe(LOW_CONFIDENCE_ITEM_THRESHOLD);
    expect(migration).toContain(
      `(item ->> 'confidence')::numeric < ${LOW_CONFIDENCE_ITEM_THRESHOLD}`,
    );
  });

  it("revokes the bypassing commit RPC and records an explicit review atomically", () => {
    expect(migration).toContain(
      "create or replace function public.commit_reviewed_invoice_scan_idempotent(",
    );
    expect(migration).toContain("for update");
    expect(migration).toContain("p_low_confidence_reviewed");
    expect(migration).toContain("low_confidence_review_required");
    expect(migration).toContain("low_confidence_reviewed_at = clock_timestamp()");
    expect(migration).toContain("low_confidence_reviewed_by = v_user_id");
    expect(migration).toMatch(
      /revoke all on function public\.commit_invoice_scan_idempotent\([\s\S]*?from authenticated/,
    );
    expect(migration).toContain("set search_path = ''");
    expect(rollback).toContain(
      "grant execute on function public.commit_invoice_scan_idempotent(",
    );
    expect(databaseAcceptance).toContain("v_result.outcome <> 'review_required'");
    expect(databaseAcceptance).toContain("low_confidence_reviewed_by");
    expect(databaseAcceptance).toContain("rollback;");
  });
});
