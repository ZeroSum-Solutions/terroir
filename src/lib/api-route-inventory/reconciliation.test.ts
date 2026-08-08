import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  operationIdFor,
  validateInventoryShape,
} from "../../../scripts/generate-api-route-inventory.mjs";
import { validateJsonSchema } from "../../../scripts/verify-api-contract.mjs";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

interface LedgerItem {
  id: string;
  actor: string;
  status: string;
}

interface InventoryOperation {
  operationId: string;
  method: Method;
  path: string;
  sourceRequirementIds?: string[];
}

interface Inventory {
  discoveredOperations: InventoryOperation[];
  plannedOperations: InventoryOperation[];
}

interface ConcreteRequirement {
  requirementId: string;
  method: Method;
  path: string;
  operationId: string;
  realization: "discovered_exact_path" | "planned_exact_path";
  implementationLeaf: "TER-020E" | null;
}

interface AliasContext {
  requirementId: string;
  relationship: "path_variant" | "partial_projection" | "specialized_export";
  note: string;
}

interface DiscoveredClassification {
  operationId: string;
  classification: "exact" | "extension";
  concreteRequirementId: string | null;
  semanticAliasContext: AliasContext[];
}

interface CrossCuttingRequirement {
  requirementId: string;
  scope: "write_operations" | "all_operations";
  ownerLeaf: "TER-020B" | "TER-020C" | "TER-020D";
}

interface Reconciliation {
  schemaVersion: number;
  inventorySchemaVersion: number;
  sourceInventory: string;
  featureLedger: string;
  completionPlan: string;
  summary: Record<string, number>;
  planLeaves: Array<{ id: string; heading: string }>;
  concreteRequirements: ConcreteRequirement[];
  discoveredClassifications: DiscoveredClassification[];
  crossCuttingRequirements: CrossCuttingRequirement[];
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(file), "utf8")) as T;
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const entries = items.map((item) => [key(item), item] as const);
  expect(new Set(entries.map(([id]) => id)).size).toBe(entries.length);
  return new Map(entries);
}

function apiActor(item: LedgerItem) {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/api\/\S+)$/.exec(
    item.actor,
  );
  expect(match, `${item.id} must have a concrete API actor`).not.toBeNull();
  return { method: match![1] as Method, path: match![2] };
}

function collectKeys(value: unknown, keys = new Set<string>()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      keys.add(key);
      collectKeys(item, keys);
    });
  }
  return keys;
}

const ledger = readJson<{ items: LedgerItem[] }>("docs/feature-ledger.json");
const inventory = readJson<Inventory>("docs/api-route-inventory.json");
const reconciliation = readJson<Reconciliation>(
  "docs/api-route-reconciliation.json",
);
const reconciliationSchema = readJson<Record<string, unknown>>(
  "docs/api-route-reconciliation.schema.json",
);
const completionPlan = readFileSync(
  resolve("docs/plans/2026-07-20-terroir-completion-spec.md"),
  "utf8",
);

describe("TER-020Ab active API requirement reconciliation", () => {
  it("keeps all 269 requirements active and maps TER-CF-180..211 once", () => {
    expect(ledger.items).toHaveLength(269);
    expect(ledger.items.every((item) => item.status === "active")).toBe(true);

    const concreteLedger = ledger.items.filter((item) => {
      const order = Number(item.id.slice("TER-CF-".length));
      return order >= 180 && order <= 211;
    });
    expect(concreteLedger).toHaveLength(32);

    const mapped = uniqueBy(
      reconciliation.concreteRequirements,
      (item) => item.requirementId,
    );
    expect(mapped.size).toBe(32);
    for (const requirement of concreteLedger) {
      const mapping = mapped.get(requirement.id);
      expect(mapping, `${requirement.id} must be mapped`).toBeDefined();
      const actor = apiActor(requirement);
      expect(mapping).toMatchObject(actor);
      expect(mapping!.operationId).toBe(
        operationIdFor(actor.method, actor.path),
      );
    }
  });

  it("classifies every discovered and planned operation exactly once", () => {
    expect(validateInventoryShape(inventory).valid).toBe(true);

    const classifications = uniqueBy(
      reconciliation.discoveredClassifications,
      (item) => item.operationId,
    );
    const discovered = uniqueBy(
      inventory.discoveredOperations,
      (item) => item.operationId,
    );
    expect(classifications.size).toBe(discovered.size);
    expect([...classifications.keys()]).toEqual([...discovered.keys()]);
    const exactCount = reconciliation.discoveredClassifications.filter(
      (item) => item.classification === "exact",
    ).length;
    const extensionCount =
      reconciliation.discoveredClassifications.length - exactCount;
    expect(exactCount + extensionCount).toBe(inventory.discoveredOperations.length);

    const concreteByOperation = uniqueBy(
      reconciliation.concreteRequirements,
      (item) => item.operationId,
    );
    for (const classification of reconciliation.discoveredClassifications) {
      if (classification.classification === "exact") {
        expect(classification.concreteRequirementId).not.toBeNull();
        expect(classification.semanticAliasContext).toEqual([]);
        expect(
          concreteByOperation.get(classification.operationId)?.requirementId,
        ).toBe(classification.concreteRequirementId);
      } else {
        expect(classification.concreteRequirementId).toBeNull();
      }
    }

    expect(exactCount + inventory.plannedOperations.length).toBe(
      reconciliation.concreteRequirements.length,
    );
    expect(inventory.plannedOperations).toEqual(
      [...inventory.plannedOperations].sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.method.localeCompare(right.method),
      ),
    );
    for (const planned of inventory.plannedOperations) {
      const mapping = concreteByOperation.get(planned.operationId);
      expect(mapping).toMatchObject({
        realization: "planned_exact_path",
        implementationLeaf: "TER-020E",
      });
      expect(planned.sourceRequirementIds).toEqual([mapping!.requirementId]);
    }
  });

  it("keeps semantic aliases contextual and prohibits amendment dispositions", () => {
    const concreteById = uniqueBy(
      reconciliation.concreteRequirements,
      (item) => item.requirementId,
    );
    for (const classification of reconciliation.discoveredClassifications) {
      for (const context of classification.semanticAliasContext) {
        expect(classification.classification).toBe("extension");
        expect(concreteById.get(context.requirementId)).toMatchObject({
          realization: "planned_exact_path",
          implementationLeaf: "TER-020E",
        });
      }
    }

    const keys = collectKeys(reconciliation);
    for (const prohibited of [
      "disposition",
      "amendment",
      "retirement",
      "aliasOperationId",
    ]) {
      expect(keys.has(prohibited)).toBe(false);
    }
  });

  it("owns TER-CF-212..217 in the exact later leaves", () => {
    expect(reconciliation.crossCuttingRequirements).toEqual([
      {
        requirementId: "TER-CF-212",
        scope: "write_operations",
        ownerLeaf: "TER-020B",
      },
      {
        requirementId: "TER-CF-213",
        scope: "all_operations",
        ownerLeaf: "TER-020B",
      },
      {
        requirementId: "TER-CF-214",
        scope: "all_operations",
        ownerLeaf: "TER-020C",
      },
      {
        requirementId: "TER-CF-215",
        scope: "all_operations",
        ownerLeaf: "TER-020C",
      },
      {
        requirementId: "TER-CF-216",
        scope: "all_operations",
        ownerLeaf: "TER-020C",
      },
      {
        requirementId: "TER-CF-217",
        scope: "all_operations",
        ownerLeaf: "TER-020D",
      },
    ]);
  });

  it("derives summary counts and matches the eight TER-020 plan headings", () => {
    expect(reconciliation.summary).toEqual({
      activeRequirementCount: ledger.items.length,
      concreteRequirementCount: reconciliation.concreteRequirements.length,
      exactDiscoveredCount:
        reconciliation.discoveredClassifications.filter(
          (item) => item.classification === "exact",
        ).length,
      plannedPromiseCount: inventory.plannedOperations.length,
      extensionDiscoveredCount:
        reconciliation.discoveredClassifications.filter(
          (item) => item.classification === "extension",
        ).length,
      crossCuttingRequirementCount:
        reconciliation.crossCuttingRequirements.length,
      ter020LeafCount: reconciliation.planLeaves.length,
    });
    expect(reconciliation.planLeaves).toHaveLength(8);

    const ter020Section = completionPlan
      .split("### TER-020:")[1]
      .split("### TER-021:")[0];
    for (const leaf of reconciliation.planLeaves) {
      expect(ter020Section).toContain(`- \`${leaf.id}\`: ${leaf.heading}`);
    }
    expect(ter020Section).toContain("all eight children");
    expect(ter020Section).not.toContain("exist or are explicitly amended");
    expect(ter020Section).not.toContain("approval for amendments");
  });

  it("publishes a strict reconciliation schema with no disposition field", () => {
    expect(reconciliation.schemaVersion).toBe(1);
    expect(reconciliation.inventorySchemaVersion).toBe(1);
    expect(reconciliation.sourceInventory).toBe(
      "docs/api-route-inventory.json",
    );
    expect(reconciliation.featureLedger).toBe("docs/feature-ledger.json");
    expect(reconciliation.completionPlan).toBe(
      "docs/plans/2026-07-20-terroir-completion-spec.md",
    );
    expect(reconciliationSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    });
    expect(
      validateJsonSchema(reconciliationSchema, reconciliation, "reconciliation"),
    ).toEqual([]);

    const extraProperty = structuredClone(reconciliation) as Reconciliation & {
      disposition?: string;
    };
    extraProperty.disposition = "alias";
    expect(
      validateJsonSchema(reconciliationSchema, extraProperty, "reconciliation")
        .join("\n"),
    ).toContain("must NOT have additional properties");

    const invalidLeaf = structuredClone(reconciliation);
    const discovered = invalidLeaf.concreteRequirements.find(
      (item) => item.realization === "discovered_exact_path",
    )!;
    discovered.implementationLeaf = "TER-020E";
    expect(
      validateJsonSchema(reconciliationSchema, invalidLeaf, "reconciliation")
        .join("\n"),
    ).toContain("must be null");
    expect(collectKeys(reconciliationSchema).has("disposition")).toBe(false);
  });
});
