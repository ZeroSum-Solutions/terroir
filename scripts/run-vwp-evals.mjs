#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

const EVALS_PATH = "docs/evals/vwp-evals.yaml";
const PACKAGE_PATH = "package.json";
const TEST_ROOTS = ["src", "e2e"];
const TEST_FILE_PATTERN = /\.(?:eval\.)?(?:test|spec)\.[cm]?[jt]sx?$/;
const EVAL_ID_PATTERN = /^EV-VWP-(?:F\d+|\d{2})\.\d+$/;
const CRITERIA_MAP_MARKER = "# PRD criteria map —";
const CRITERIA_COUNT = 13;
const TEST_TIMEOUT_MS = 80_000;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(value, token) {
  return new RegExp(
    `(?:^|[^A-Za-z0-9.])${escapeRegExp(token)}(?![A-Za-z0-9.])`,
  ).test(value);
}

function packageScriptForGate(command) {
  if (command === "npm test") return "test";
  const match = command.match(/^npm run (\S+)$/);
  return match?.[1] ?? null;
}

export function parseCriteriaMap(source, evalIds) {
  const markerIndex = source.indexOf(CRITERIA_MAP_MARKER);
  if (markerIndex === -1) return [];

  const mapSource = source.slice(markerIndex);
  const headings = [...mapSource.matchAll(/^#\s+(\d{1,2})\.\s/gm)];

  return headings.map((heading, index) => {
    const number = Number(heading[1]);
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? mapSource.length;
    const block = mapSource.slice(start, end);
    const referencedEvalIds = [
      ...new Set(block.match(/\bEV-VWP-[A-Z0-9]+(?:\.[A-Z0-9]+)+\b/g) ?? []),
    ];

    return {
      number,
      referencedEvalIds,
      missingEvalIds: referencedEvalIds.filter((id) => !evalIds.has(id)),
    };
  });
}

export function parseAndValidateVwpEvalSpec(source, packageJson = {}) {
  const violations = [];
  let document;

  try {
    document = yaml.load(source);
  } catch (error) {
    return {
      document: null,
      evals: [],
      criteriaMap: [],
      missingGlobalGateScripts: [],
      violations: [
        `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  if (!isObject(document)) {
    return {
      document,
      evals: [],
      criteriaMap: [],
      missingGlobalGateScripts: [],
      violations: ["document must be a YAML object"],
    };
  }

  if (document.version !== 1) violations.push("version must be 1");

  const globalGates = Array.isArray(document.global_gates)
    ? document.global_gates
    : [];
  if (!Array.isArray(document.global_gates) || globalGates.length === 0) {
    violations.push("global_gates must be a non-empty array");
  }

  const packageScripts = isObject(packageJson.scripts) ? packageJson.scripts : {};
  const missingGlobalGateScripts = [];
  globalGates.forEach((gate, index) => {
    if (!isNonEmptyString(gate)) {
      violations.push(`global_gates[${index}] must be a non-empty string`);
      return;
    }
    const scriptName = packageScriptForGate(gate);
    if (!scriptName) {
      violations.push(`global_gates[${index}] has unsupported command: ${gate}`);
    } else if (!Object.hasOwn(packageScripts, scriptName)) {
      missingGlobalGateScripts.push(scriptName);
      violations.push(
        `global_gates[${index}] references missing package script: ${scriptName}`,
      );
    }
  });

  const foundations = Array.isArray(document.foundations)
    ? document.foundations
    : [];
  const slices = Array.isArray(document.slices) ? document.slices : [];
  if (!Array.isArray(document.foundations)) {
    violations.push("foundations must be an array");
  }
  if (!Array.isArray(document.slices)) violations.push("slices must be an array");

  const evals = [];
  const seenEvalIds = new Set();

  function validateGroup(group, index, kind) {
    const label = `${kind}[${index}]`;
    if (!isObject(group)) {
      violations.push(`${label} must be an object`);
      return;
    }

    const expectedId = kind === "foundations" ? /^F-VWP-\d+$/ : /^SPEC-\d{2}$/;
    if (!isNonEmptyString(group.id) || !expectedId.test(group.id)) {
      violations.push(`${label}.id is malformed`);
    }
    if (!isNonEmptyString(group.name)) violations.push(`${label}.name is required`);

    if (kind === "slices") {
      if (!isNonEmptyString(group.branch)) {
        violations.push(`${label}.branch is required`);
      }
      if (!isNonEmptyString(group.e2e_tag) || !/^@vwp-\d{2}$/.test(group.e2e_tag)) {
        violations.push(`${label}.e2e_tag is malformed`);
      }
      if (
        group.depends_on !== undefined &&
        (!Array.isArray(group.depends_on) ||
          group.depends_on.some((dependency) => !isNonEmptyString(dependency)))
      ) {
        violations.push(`${label}.depends_on must be an array of slice IDs`);
      }
    }

    if (!Array.isArray(group.evals) || group.evals.length === 0) {
      violations.push(`${label}.evals must be a non-empty array`);
      return;
    }

    group.evals.forEach((entry, evalIndex) => {
      const evalLabel = `${label}.evals[${evalIndex}]`;
      if (!isObject(entry)) {
        violations.push(`${evalLabel} must be an object`);
        return;
      }
      if (!isNonEmptyString(entry.id) || !EVAL_ID_PATTERN.test(entry.id)) {
        violations.push(`${evalLabel}.id is malformed`);
      }
      if (!isNonEmptyString(entry.then)) {
        violations.push(`${evalLabel}.then is required`);
      }
      if (isNonEmptyString(entry.id)) {
        if (seenEvalIds.has(entry.id)) {
          violations.push(`duplicate eval ID: ${entry.id}`);
        }
        seenEvalIds.add(entry.id);
        evals.push({
          id: entry.id,
          slice: isNonEmptyString(group.id) ? group.id : label,
          tag: kind === "slices" && isNonEmptyString(group.e2e_tag)
            ? group.e2e_tag
            : null,
        });
      }
    });
  }

  foundations.forEach((group, index) => validateGroup(group, index, "foundations"));
  slices.forEach((group, index) => validateGroup(group, index, "slices"));

  const criteriaMap = parseCriteriaMap(source, seenEvalIds);
  const criterionNumbers = criteriaMap.map((criterion) => criterion.number);
  const expectedCriteria = Array.from(
    { length: CRITERIA_COUNT },
    (_, index) => index + 1,
  );
  if (JSON.stringify(criterionNumbers) !== JSON.stringify(expectedCriteria)) {
    violations.push("PRD criteria map must contain criteria 1 through 13 exactly once");
  }
  criteriaMap.forEach((criterion) => {
    if (criterion.referencedEvalIds.length === 0) {
      violations.push(`PRD criterion ${criterion.number} has no eval reference`);
    }
    criterion.missingEvalIds.forEach((id) => {
      violations.push(`PRD criterion ${criterion.number} references missing eval ID: ${id}`);
    });
  });

  return {
    document,
    evals,
    criteriaMap,
    missingGlobalGateScripts,
    violations,
  };
}

function findTestFiles(root) {
  const files = [];

  for (const relativeRoot of TEST_ROOTS) {
    const absoluteRoot = path.join(root, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) continue;

    const pendingDirectories = [absoluteRoot];
    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) pendingDirectories.push(absolutePath);
        else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
          files.push(path.relative(root, absolutePath));
        }
      }
    }
  }

  return files.sort();
}

function findReferenceCandidates(root, evals) {
  const testFiles = findTestFiles(root);
  const sources = new Map(
    testFiles.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]),
  );

  return evals.map((entry) => {
    const tokens = [entry.id];

    return {
      ...entry,
      tokens,
      candidateFiles: [...sources]
        .filter(([, source]) => tokens.some((token) => containsToken(source, token)))
        .map(([file]) => file),
    };
  });
}

function runVitestFiles(root, candidateRows) {
  const files = [
    ...new Set(
      candidateRows
        .flatMap((row) => row.candidateFiles)
        .filter((file) => file.startsWith("src/") && TEST_FILE_PATTERN.test(file)),
    ),
  ];
  if (files.length === 0) {
    return { files, passed: true, output: "", assertions: [] };
  }

  const vitestPath = path.join(root, "node_modules/vitest/vitest.mjs");
  if (!fs.existsSync(vitestPath)) {
    return {
      files,
      passed: false,
      output: `Vitest executable not found: ${vitestPath}`,
      assertions: [],
    };
  }

  const result = spawnSync(
    process.execPath,
    [vitestPath, "run", ...files, "--reporter=json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: TEST_TIMEOUT_MS,
    },
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

  if (result.error) {
    return {
      files,
      passed: false,
      output: `${result.error.message}\n${output}`.trim(),
      assertions: [],
    };
  }

  try {
    const report = JSON.parse(result.stdout);
    const assertions = (report.testResults ?? []).flatMap((testResult) =>
      (testResult.assertionResults ?? []).map((assertion) => ({
        file: path.relative(root, testResult.name),
        fullName: assertion.fullName,
        status: assertion.status,
      })),
    );
    return {
      files,
      passed: result.status === 0 && report.success === true,
      output,
      assertions,
    };
  } catch (error) {
    return {
      files,
      passed: false,
      output: `Could not parse Vitest JSON report: ${error instanceof Error ? error.message : String(error)}\n${output}`,
      assertions: [],
    };
  }
}

function runPlaywrightList(root, candidateRows) {
  const files = [
    ...new Set(
      candidateRows
        .flatMap((row) => row.candidateFiles)
        .filter((file) => file.startsWith("e2e/") && TEST_FILE_PATTERN.test(file)),
    ),
  ];
  if (files.length === 0) {
    return { files, passed: true, output: "", assertions: [] };
  }

  const playwrightPath = path.join(root, "node_modules/@playwright/test/cli.js");
  if (!fs.existsSync(playwrightPath)) {
    return {
      files,
      passed: false,
      output: `Playwright executable not found: ${playwrightPath}`,
      assertions: [],
    };
  }

  const result = spawnSync(
    process.execPath,
    [playwrightPath, "test", "--list", "--reporter=json", ...files],
    {
      cwd: root,
      encoding: "utf8",
      timeout: TEST_TIMEOUT_MS,
    },
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error) {
    return {
      files,
      passed: false,
      output: `${result.error.message}\n${output}`.trim(),
      assertions: [],
    };
  }

  try {
    const report = JSON.parse(result.stdout);
    const assertions = [];
    const visitSuite = (suite, ancestors = []) => {
      const titles = suite.title ? [...ancestors, suite.title] : ancestors;
      for (const spec of suite.specs ?? []) {
        const expectedStatuses = (spec.tests ?? []).map((test) => test.expectedStatus);
        assertions.push({
          file: path.join("e2e", spec.file),
          fullName: [...titles, spec.title].join(" "),
          status: expectedStatuses.some((status) => status !== "skipped")
            ? "active"
            : "skipped",
        });
      }
      for (const child of suite.suites ?? []) visitSuite(child, titles);
    };
    for (const suite of report.suites ?? []) visitSuite(suite);

    return {
      files,
      passed: result.status === 0 && (report.errors ?? []).length === 0,
      output,
      assertions,
    };
  } catch (error) {
    return {
      files,
      passed: false,
      output: `Could not parse Playwright JSON report: ${error instanceof Error ? error.message : String(error)}\n${output}`,
      assertions: [],
    };
  }
}

export function classifyReferences(candidateRows, vitestAssertions, playwrightAssertions) {
  return candidateRows.map((entry) => {
    const activeAssertions = vitestAssertions.filter(
      (assertion) =>
        containsToken(assertion.fullName, entry.id) &&
        ["passed", "failed"].includes(assertion.status),
    );
    const skippedAssertions = vitestAssertions.filter(
      (assertion) =>
        containsToken(assertion.fullName, entry.id) &&
        !["passed", "failed"].includes(assertion.status),
    );
    const activeE2eAssertions = playwrightAssertions.filter(
      (assertion) =>
        containsToken(assertion.fullName, entry.id) &&
        assertion.status === "active",
    );
    const skippedE2eAssertions = playwrightAssertions.filter(
      (assertion) =>
        containsToken(assertion.fullName, entry.id) &&
        assertion.status === "skipped",
    );
    const files = [...new Set(activeAssertions.map((assertion) => assertion.file))];
    const declaredFiles = [
      ...new Set(activeE2eAssertions.map((assertion) => assertion.file)),
    ];
    const skippedFiles = [
      ...new Set([
        ...skippedAssertions.map((assertion) => assertion.file),
        ...skippedE2eAssertions.map((assertion) => assertion.file),
      ]),
    ];

    return {
      id: entry.id,
      slice: entry.slice,
      tag: entry.tag,
      files,
      declaredFiles,
      skippedFiles,
      status: files.length > 0
        ? "IMPLEMENTED"
        : declaredFiles.length > 0
          ? "DECLARED"
          : "PENDING",
    };
  });
}

function printTable(rows) {
  const headers = ["EV id", "Slice", "Status"];
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => [row.id, row.slice, row.status][index].length),
    ),
  );
  const format = (values) =>
    values.map((value, index) => value.padEnd(widths[index])).join(" | ");

  console.log(format(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("-|-"));
  rows.forEach((row) => console.log(format([row.id, row.slice, row.status])));
}

export function runVwpEvals(root = process.cwd()) {
  const source = fs.readFileSync(path.join(root, EVALS_PATH), "utf8");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, PACKAGE_PATH), "utf8"),
  );
  const validation = parseAndValidateVwpEvalSpec(source, packageJson);
  const candidates = findReferenceCandidates(root, validation.evals);
  const violations = [...validation.violations];
  const testRun = runVitestFiles(root, candidates);
  const playwrightList = runPlaywrightList(root, candidates);
  const rows = classifyReferences(
    candidates,
    testRun.assertions,
    playwrightList.assertions,
  );

  rows.forEach((row) => {
    if (row.status === "PENDING" && row.skippedFiles.length > 0) {
      violations.push(
        `${row.id} is referenced only by skipped tests: ${row.skippedFiles.join(", ")}`,
      );
    }
  });

  if (!testRun.passed) {
    violations.push(
      `implemented eval test run failed (${testRun.files.join(", ")})\n${testRun.output}`,
    );
  }
  if (!playwrightList.passed) {
    violations.push(
      `Playwright eval discovery failed (${playwrightList.files.join(", ")})\n${playwrightList.output}`,
    );
  }

  printTable(rows);
  const implemented = rows.filter((row) => row.status === "IMPLEMENTED").length;
  const declared = rows.filter((row) => row.status === "DECLARED").length;
  const pending = rows.length - implemented - declared;
  console.log("");
  console.log(
    `Summary: ${implemented} IMPLEMENTED · ${declared} DECLARED · ${pending} PENDING · ${rows.length} TOTAL`,
  );
  console.log(
    `Executable Vitest files: ${testRun.files.length} ${testRun.passed ? "PASS" : "FAIL"}`,
  );
  console.log(
    `Playwright trace files: ${playwrightList.files.length} ${playwrightList.passed ? "DISCOVERED" : "FAIL"}`,
  );

  if (violations.length > 0) {
    console.error("");
    console.error("Violations:");
    violations.forEach((violation) => console.error(`- ${violation}`));
  }

  return { rows, violations, testRun, playwrightList };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runVwpEvals();
    process.exitCode = result.violations.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(
      `VWP eval runner failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
