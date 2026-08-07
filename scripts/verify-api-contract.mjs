#!/usr/bin/env node
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { createInventory, discoverRouteOperations, operationIdFor, validateInventoryShape } from "./generate-api-route-inventory.mjs";
const FILES = {
  inventory: "docs/api-route-inventory.json", inventorySchema: "docs/api-route-inventory.schema.json",
  reconciliation: "docs/api-route-reconciliation.json", reconciliationSchema: "docs/api-route-reconciliation.schema.json",
  ledger: "docs/feature-ledger.json",
  plan: "docs/plans/2026-07-20-terroir-completion-spec.md",
};
const CROSS_CUTTING = [
  ["TER-CF-212", "write_operations", "TER-020B"], ["TER-CF-213", "all_operations", "TER-020B"],
  ["TER-CF-214", "all_operations", "TER-020C"], ["TER-CF-215", "all_operations", "TER-020C"],
  ["TER-CF-216", "all_operations", "TER-020C"], ["TER-CF-217", "all_operations", "TER-020D"],
].map(([requirementId, scope, ownerLeaf]) => ({ requirementId, scope, ownerLeaf }));
const PLAN_LEAVES = ["TER-020Aa", "TER-020Ab", "TER-020Ac", "TER-020B", "TER-020C", "TER-020D", "TER-020E", "TER-020F"];
const readJson = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const ids = (items) => items.map((item) => item.operationId);
const same = (left, right) => isDeepStrictEqual(left, right);
function uniqueMap(items, key, label, errors) {
  const result = new Map();
  for (const item of items) {
    const id = item[key];
    if (result.has(id)) errors.push(`${label}: duplicate ${String(id)}`);
    result.set(id, item);
  }
  return result;
}
export function validateJsonSchema(schema, value, label) {
  try {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    if (validate(value)) return [];
    return (validate.errors ?? [])
      .map(
        (error) =>
          `${label} schema: ${error.instancePath || "/"} ${error.message}`,
      )
      .sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`${label} schema is invalid: ${message}`];
  }
}
export function verifyInventoryParity(projectRoot, inventory) {
  const errors = [];
  const discovered = discoverRouteOperations({
    projectRoot,
    sourceRoot: inventory.sourceRoot,
  });
  const expected = createInventory({
    routeFileCount: discovered.routeFileCount,
    operations: discovered.operations,
    plannedOperations: structuredClone(inventory.plannedOperations),
  });
  if (inventory.routeFileCount !== expected.routeFileCount) {
    errors.push(
      `source inventory drift: route file count is ${expected.routeFileCount}, committed ${inventory.routeFileCount}`,
    );
  }
  const committed = uniqueMap(
    inventory.discoveredOperations, "operationId", "committed inventory", errors,
  );
  const current = uniqueMap(
    expected.discoveredOperations, "operationId", "source inventory", errors,
  );
  for (const operationId of [...current.keys()].sort()) {
    if (!committed.has(operationId)) {
      errors.push(`source inventory drift: added ${operationId}`);
    } else if (!same(current.get(operationId), committed.get(operationId))) {
      errors.push(`source inventory drift: changed ${operationId}`);
    }
  }
  for (const operationId of [...committed.keys()].sort()) {
    if (!current.has(operationId)) {
      errors.push(`source inventory drift: removed ${operationId}`);
    }
  }
  if (
    same(ids(expected.discoveredOperations), ids(inventory.discoveredOperations)) ===
      false &&
    expected.discoveredOperations.length === inventory.discoveredOperations.length &&
    [...current.keys()].every((id) => committed.has(id))
  ) {
    errors.push("source inventory drift: operation order differs");
  }
  const discoveredIds = new Set(ids(expected.discoveredOperations));
  for (const operation of inventory.plannedOperations) {
    if (discoveredIds.has(operation.operationId)) {
      errors.push(
        `inventory overlap: ${operation.operationId} is both discovered and planned`,
      );
    }
  }
  const sortedPlanned = [...inventory.plannedOperations].sort((left, right) =>
    left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
  if (!same(inventory.plannedOperations, sortedPlanned)) {
    errors.push("planned operations must be sorted by path and method");
  }
  return errors;
}
const ROUTE_SAFETY_EXCEPTIONS = new Set([
  "src/app/api/dev-login/route.ts",
  "src/app/api/health/route.ts",
]);

function routeSafetyError(file, message) {
  return `${file}: ${message}`;
}

/**
 * Enforce the boundary conventions that make TER-CF-212 and TER-CF-213
 * mechanically reviewable for every discovered route. Health is an
 * operational 200-status probe, and dev-login deliberately returns an opaque
 * plaintext 404 before it is enabled; their focused route tests own those
 * exceptional response semantics.
 */
export function verifyApiRouteSafety(projectRoot, inventory) {
  const errors = [];
  const files = new Set(
    inventory.discoveredOperations.map((operation) => operation.source.file),
  );

  for (const file of [...files].sort()) {
    let source;
    try {
      source = fs.readFileSync(path.join(projectRoot, file), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(routeSafetyError(file, `could not read route source: ${message}`));
      continue;
    }
    if (ROUTE_SAFETY_EXCEPTIONS.has(file)) continue;

    if (!/\bwithApiHandler\s*\(/.test(source)) {
      errors.push(
        routeSafetyError(file, "active handlers must use withApiHandler"),
      );
    }
    if (/\brequest\s*\.\s*(?:json|formData)\s*\(/.test(source)) {
      errors.push(
        routeSafetyError(
          file,
          "request body must be parsed through parseJson or parseMultipart",
        ),
      );
    }
    if (
      /\brequest\s*\.\s*nextUrl\s*\.\s*searchParams\s*\.\s*(?:get|getAll|has|entries|keys|values|forEach)\s*\(/.test(
        source,
      )
    ) {
      errors.push(
        routeSafetyError(file, "query input must be parsed through parseQuery"),
      );
    }
    if (file.includes("[") && !/\bparseParams\s*\(/.test(source)) {
      errors.push(
        routeSafetyError(file, "dynamic route params must be parsed through parseParams"),
      );
    }
    if (/(?:Next)?Response\.json\s*\(\s*\{\s*error\s*:/.test(source)) {
      errors.push(
        routeSafetyError(file, "raw error response must use shared Errors/apiError"),
      );
    }
    if (/new\s+(?:Next)?Response\s*\([^)]*,\s*\{[\s\S]*?\bstatus\s*:\s*[45]\d\d/.test(source)) {
      errors.push(
        routeSafetyError(file, "raw error response must use shared Errors/apiError"),
      );
    }
  }

  return errors;
}
function actorIdentity(item) {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/api\/\S+)$/.exec(item.actor);
  return match
    ? {
        method: match[1], path: match[2],
        operationId: operationIdFor(match[1], match[2]),
      }
    : null;
}
export function validateReconciliationSemantics({
  inventory,
  reconciliation,
  ledger,
  completionPlan,
}) {
  const errors = [];
  const discovered = uniqueMap(
    inventory.discoveredOperations, "operationId", "discovered operations", errors,
  );
  const planned = uniqueMap(
    inventory.plannedOperations, "operationId", "planned operations", errors,
  );
  const classifications = uniqueMap(
    reconciliation.discoveredClassifications,
    "operationId", "discovered classifications", errors,
  );
  const concreteById = uniqueMap(
    reconciliation.concreteRequirements,
    "requirementId", "concrete requirements", errors,
  );
  const concreteByOperation = uniqueMap(
    reconciliation.concreteRequirements, "operationId",
    "concrete requirement operations", errors,
  );
  if (
    !same(
      ids(reconciliation.discoveredClassifications),
      ids(inventory.discoveredOperations),
    )
  ) {
    errors.push(
      "discovered classifications must match inventory operations in order",
    );
  }
  const ledgerById = new Map(ledger.items.map((item) => [item.id, item]));
  if (ledger.items.length !== 269 || ledger.items.some((item) => item.status !== "active")) {
    errors.push("all 269 feature-ledger requirements must remain active");
  }
  for (let order = 180; order <= 211; order += 1) {
    const requirementId = `TER-CF-${order}`;
    const ledgerItem = ledgerById.get(requirementId);
    const mapping = concreteById.get(requirementId);
    const actor = ledgerItem && actorIdentity(ledgerItem);
    if (!mapping || !actor || ledgerItem.status !== "active") {
      errors.push(`${requirementId} must be an active concrete API requirement`);
      continue;
    }
    if (
      mapping.method !== actor.method ||
      mapping.path !== actor.path ||
      mapping.operationId !== actor.operationId
    ) {
      errors.push(`${requirementId} mapping must match its ledger actor`);
    }
    const classification = classifications.get(mapping.operationId);
    if (mapping.realization === "discovered_exact_path") {
      if (
        !discovered.has(mapping.operationId) ||
        classification?.classification !== "exact" ||
        classification?.concreteRequirementId !== requirementId ||
        mapping.implementationLeaf !== null
      ) {
        errors.push(`${requirementId} discovered realization is inconsistent`);
      }
    } else {
      const promise = planned.get(mapping.operationId);
      if (
        !promise ||
        !same(promise.sourceRequirementIds, [requirementId]) ||
        mapping.implementationLeaf !== "TER-020E"
      ) {
        errors.push(`${requirementId} planned realization is inconsistent`);
      }
    }
  }
  for (const classification of reconciliation.discoveredClassifications) {
    if (classification.classification === "exact") {
      if (classification.semanticAliasContext.length) {
        errors.push("exact classifications cannot carry semantic aliases");
      }
      const mapping = concreteById.get(classification.concreteRequirementId);
      if (
        mapping?.operationId !== classification.operationId ||
        mapping?.realization !== "discovered_exact_path"
      ) {
        errors.push(`${classification.operationId} exact classification is inconsistent`);
      }
    } else {
      if (classification.concreteRequirementId !== null) {
        errors.push(
          `${classification.operationId} extension cannot satisfy a requirement`,
        );
      }
      for (const context of classification.semanticAliasContext) {
        if (
          concreteById.get(context.requirementId)?.realization !==
          "planned_exact_path"
        ) {
          errors.push(
            `${classification.operationId} alias must reference a planned promise`,
          );
        }
      }
    }
  }
  for (const promise of inventory.plannedOperations) {
    const mapping = concreteByOperation.get(promise.operationId);
    if (
      mapping?.realization !== "planned_exact_path" ||
      mapping?.implementationLeaf !== "TER-020E" ||
      !same(promise.sourceRequirementIds, [mapping?.requirementId])
    ) {
      errors.push(`${promise.operationId} planned promise is unmapped`);
    }
  }
  const exactCount = reconciliation.discoveredClassifications
    .filter((item) => item.classification === "exact").length;
  const extensionCount =
    reconciliation.discoveredClassifications.length - exactCount;
  const expectedSummary = {
    activeRequirementCount: ledger.items.length,
    concreteRequirementCount: reconciliation.concreteRequirements.length,
    exactDiscoveredCount: exactCount,
    plannedPromiseCount: inventory.plannedOperations.length,
    extensionDiscoveredCount: extensionCount,
    crossCuttingRequirementCount:
      reconciliation.crossCuttingRequirements.length,
    ter020LeafCount: reconciliation.planLeaves.length,
  };
  if (!same(reconciliation.summary, expectedSummary)) {
    errors.push("reconciliation summary must be derived from contract documents");
  }
  if (!same(reconciliation.crossCuttingRequirements, CROSS_CUTTING) ||
      CROSS_CUTTING.some((item) => ledgerById.get(item.requirementId)?.status !== "active")) {
    errors.push("cross-cutting API requirements have incorrect ownership");
  }
  const planSection = completionPlan.split("### TER-020:")[1]?.split("### TER-021:")[0] ?? "";
  if (!same(reconciliation.planLeaves.map((leaf) => leaf.id), PLAN_LEAVES)) {
    errors.push("TER-020 plan leaf IDs must be unique, exact, and ordered");
  }
  for (const leaf of reconciliation.planLeaves) {
    if (!planSection.includes(`- \`${leaf.id}\`: ${leaf.heading}`)) {
      errors.push(`${leaf.id} heading is absent from the completion plan`);
    }
  }
  return errors;
}
export function verifyApiContract(projectRoot = process.cwd()) {
  try {
    const inventory = readJson(projectRoot, FILES.inventory);
    const reconciliation = readJson(projectRoot, FILES.reconciliation);
    const ledger = readJson(projectRoot, FILES.ledger);
    const completionPlan = fs.readFileSync(path.join(projectRoot, FILES.plan), "utf8");
    const inventoryErrors = [
      ...validateJsonSchema(
        readJson(projectRoot, FILES.inventorySchema), inventory, "inventory",
      ),
      ...validateInventoryShape(inventory).errors.map(
        (error) => `inventory semantics: ${error}`,
      ),
    ];
    const reconciliationErrors = validateJsonSchema(
      readJson(projectRoot, FILES.reconciliationSchema),
      reconciliation, "reconciliation",
    );
    const errors = [...inventoryErrors, ...reconciliationErrors];
    if (!inventoryErrors.length) {
      errors.push(...verifyInventoryParity(projectRoot, inventory));
      errors.push(...verifyApiRouteSafety(projectRoot, inventory));
    }
    if (!inventoryErrors.length && !reconciliationErrors.length) {
      errors.push(
        ...validateReconciliationSemantics({
          inventory,
          reconciliation,
          ledger,
          completionPlan,
        }),
      );
    }
    return {
      errors,
      summary: {
        discoveredOperationCount: inventory.discoveredOperations?.length ?? 0,
        plannedOperationCount: inventory.plannedOperations?.length ?? 0,
        classificationCount:
          reconciliation.discoveredClassifications?.length ?? 0,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      errors: [`API contract input failed: ${message}`],
      summary: { discoveredOperationCount: 0, plannedOperationCount: 0, classificationCount: 0 },
    };
  }
}
const main = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (main) {
  const result = verifyApiContract();
  if (result.errors.length) {
    console.error(`API contract verification failed (${result.errors.length}):`);
    [...result.errors].sort().forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  } else {
    console.log(`API contract verified: ${result.summary.discoveredOperationCount} discovered operations, ${result.summary.plannedOperationCount} planned promises, ${result.summary.classificationCount} classifications.`);
  }
}
