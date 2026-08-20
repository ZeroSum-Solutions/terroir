#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  discoverRouteOperations,
  operationIdFor,
} from "./generate-api-route-inventory.mjs";

const LEDGER = "docs/feature-ledger.json";
const OUTPUT = "docs/product-contract-conformance.json";
const FIRST = 180;
const LAST = 217;
const ACTIVE_COUNT = 269;
const requirementIds = Array.from(
  { length: LAST - FIRST + 1 },
  (_, index) => `TER-CF-${FIRST + index}`,
);
const activeIds = Array.from(
  { length: ACTIVE_COUNT },
  (_, index) => `TER-CF-${String(index + 1).padStart(3, "0")}`,
);
const routeActor = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/api\/\S+)$/;

function readLedger(projectRoot) {
  const ledger = JSON.parse(
    fs.readFileSync(path.join(projectRoot, LEDGER), "utf8"),
  );
  const active = Array.isArray(ledger.items)
    ? ledger.items.filter((item) => item?.status === "active")
    : [];
  const actualIds = new Set(active.map((item) => item.id));
  if (
    ledger.featureCount !== ACTIVE_COUNT ||
    active.length !== ACTIVE_COUNT ||
    actualIds.size !== ACTIVE_COUNT ||
    activeIds.some((id) => !actualIds.has(id))
  ) {
    throw new Error(
      "active feature ledger IDs must remain TER-CF-001 through TER-CF-269",
    );
  }
  const byId = new Map(active.map((item) => [item.id, item]));
  for (const id of requirementIds) {
    const item = byId.get(id);
    if (
      !item ||
      typeof item.actor !== "string" ||
      typeof item.sourceText !== "string"
    ) {
      throw new Error(`${id} is missing its active ledger claim`);
    }
  }
  return { active, byId };
}

function routeRequirement(item) {
  const match = routeActor.exec(item.actor);
  return match ? { method: match[1], path: match[2] } : null;
}

function createConformanceStatus({ projectRoot }) {
  const ledger = readLedger(projectRoot);
  const currentRoutes = discoverRouteOperations({
    projectRoot,
    sourceRoot: "src/app/api",
  }).operations;
  const routesByOperationId = new Map(
    currentRoutes.map((operation) => [
      operation.operationId,
      operation,
    ]),
  );
  const requirements = requirementIds.map((requirementId) => {
    const claim = ledger.byId.get(requirementId);
    const expectedRoute = routeRequirement(claim);
    if (!expectedRoute) {
      return {
        requirementId,
        status: "weak",
        reason: "cross_cutting_executable_proof_not_trusted",
        operationId: null,
        evidence: {
          ledgerClaim: claim.sourceText,
          scope: claim.actor,
          implementation: null,
          proofAssessment:
            "No trusted executable proof covers this quantified scope.",
        },
      };
    }
    const operationId = operationIdFor(
      expectedRoute.method,
      expectedRoute.path,
    );
    const operation = routesByOperationId.get(operationId);
    if (!operation) {
      return {
        requirementId,
        status: "unimplemented",
        reason: "current_route_not_discovered",
        operationId,
        evidence: {
          ledgerClaim: claim.sourceText,
          expectedRoute,
          implementation: null,
        },
      };
    }
    return {
      requirementId,
      status: "weak",
      reason: "route_present_executable_proof_not_trusted",
      operationId,
      evidence: {
        ledgerClaim: claim.sourceText,
        implementation: {
          method: operation.method,
          path: operation.path,
          sourceFile: operation.source.file,
          exportKind: operation.source.exportKind,
        },
        proofAssessment: "Executable behavioral proof is not yet trusted.",
      },
    };
  });
  const summary = { proved: 0, weak: 0, unimplemented: 0 };
  for (const item of requirements) summary[item.status] += 1;
  return {
    schemaVersion: 1,
    generatorVersion: 2,
    scope: {
      firstRequirementId: requirementIds[0],
      lastRequirementId: requirementIds.at(-1),
      requirementCount: requirementIds.length,
      activeFeatureLedgerCount: ledger.active.length,
    },
    inputs: {
      featureLedger: LEDGER,
      routeSourceRoot: "src/app/api",
    },
    summary,
    requirements,
  };
}

const renderConformanceStatus = (status) =>
  `${JSON.stringify(status, null, 2)}\n`;

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    output: OUTPUT,
    mode: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write" || argument === "--check") {
      if (options.mode) throw new Error("choose exactly one of --write or --check");
      options.mode = argument;
    } else if (argument === "--project-root" || argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--project-root") options.projectRoot = path.resolve(value);
      else options.output = value;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.mode) {
    throw new Error(
      "Usage: generate-product-contract-conformance [--project-root <root>] [--output <file>] (--write|--check)",
    );
  }
  return options;
}

function writeAtomically(outputPath, contents) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, outputPath);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const outputPath = path.isAbsolute(options.output)
      ? options.output
      : path.join(options.projectRoot, options.output);
    const status = createConformanceStatus({ projectRoot: options.projectRoot });
    const rendered = renderConformanceStatus(status);
    if (options.mode === "--write") {
      writeAtomically(outputPath, rendered);
      console.log(
        `Generated product conformance: 0 proved, ${status.summary.weak} weak, ${status.summary.unimplemented} unimplemented.`,
      );
    } else if (!fs.existsSync(outputPath)) {
      throw new Error("generated conformance status is missing");
    } else if (fs.readFileSync(outputPath, "utf8") !== rendered) {
      throw new Error("generated conformance status is stale");
    } else {
      console.log(
        `Product conformance verified: 0 proved, ${status.summary.weak} weak, ${status.summary.unimplemented} unimplemented.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
