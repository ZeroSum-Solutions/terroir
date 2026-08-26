import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAndValidateVwpEvalSpec } from "../../../scripts/run-vwp-evals.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const yamlSource = readFileSync(
  join(repoRoot, "docs/evals/vwp-evals.yaml"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);

describe("VWP eval contract", () => {
  it("parses and schema-validates every declared eval", () => {
    const result = parseAndValidateVwpEvalSpec(yamlSource, packageJson);

    expect(result.violations).toEqual([]);
    expect(result.evals).toHaveLength(93);
  });

  it("keeps eval IDs unique", () => {
    const result = parseAndValidateVwpEvalSpec(yamlSource, packageJson);
    const ids = result.evals.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps all 13 PRD criteria only to declared eval IDs", () => {
    const result = parseAndValidateVwpEvalSpec(yamlSource, packageJson);

    expect(result.criteriaMap.map((criterion) => criterion.number)).toEqual(
      Array.from({ length: 13 }, (_, index) => index + 1),
    );
    expect(result.criteriaMap.flatMap((criterion) => criterion.missingEvalIds)).toEqual(
      [],
    );
  });

  it("keeps every global gate pointed at an existing package script", () => {
    const result = parseAndValidateVwpEvalSpec(yamlSource, packageJson);

    expect(result.missingGlobalGateScripts).toEqual([]);
  });

  it("rejects YAML parse errors", () => {
    const result = parseAndValidateVwpEvalSpec(
      yamlSource.replace("version: 1", "version: ["),
      packageJson,
    );

    expect(result.violations[0]).toMatch(/^YAML parse error:/);
  });

  it("rejects duplicate and malformed eval entries", () => {
    const duplicate = parseAndValidateVwpEvalSpec(
      yamlSource.replace("EV-VWP-01.2", "EV-VWP-01.1"),
      packageJson,
    );
    const malformed = parseAndValidateVwpEvalSpec(
      yamlSource.replace(
        "      - id: EV-VWP-01.2\n        then:",
        "      - id: EV-VWP-01.2\n        nope:",
      ),
      packageJson,
    );

    expect(duplicate.violations).toContain("duplicate eval ID: EV-VWP-01.1");
    expect(malformed.violations).toContain("slices[0].evals[1].then is required");
  });

  it("rejects nonexistent criteria-map eval references", () => {
    const result = parseAndValidateVwpEvalSpec(
      yamlSource.replace(
        "EV-VWP-01.2, EV-VWP-01.3. CLOSED.",
        "EV-VWP-99.9, EV-VWP-01.3. CLOSED.",
      ),
      packageJson,
    );

    expect(result.violations).toContain(
      "PRD criterion 2 references missing eval ID: EV-VWP-99.9",
    );
  });

  it("rejects global-gate package-script drift", () => {
    const { lint: _removed, ...scriptsWithoutLint } = packageJson.scripts;
    const result = parseAndValidateVwpEvalSpec(yamlSource, {
      ...packageJson,
      scripts: scriptsWithoutLint,
    });

    expect(result.missingGlobalGateScripts).toEqual(["lint"]);
  });
});
