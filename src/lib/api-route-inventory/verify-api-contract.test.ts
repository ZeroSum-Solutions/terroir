import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateJsonSchema,
  validateReconciliationSemantics,
  verifyApiContract,
  verifyInventoryParity,
} from "../../../scripts/verify-api-contract.mjs";

interface ContractDocuments {
  inventory: {
    discoveredOperations: Array<Record<string, unknown>>;
    plannedOperations: Array<Record<string, unknown>>;
  };
  reconciliation: {
    summary: Record<string, number>;
    concreteRequirements: Array<Record<string, unknown>>;
    discoveredClassifications: Array<Record<string, unknown>>;
    planLeaves: Array<Record<string, unknown>>;
  };
  ledger: { items: Array<Record<string, unknown>> };
  completionPlan: string;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "terroir-api-contract-"));
  temporaryRoots.push(root);
  return root;
}

function writeFixture(root: string, file: string, source: string) {
  const absolute = join(root, file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
}

function fixtureInventory() {
  return {
    schemaVersion: 1,
    generatorVersion: 1,
    sourceRoot: "src/app/api",
    routeFileCount: 1,
    discoveredOperationCount: 1,
    discoveredOperations: [
      {
        operationId: "api:GET:/api/health",
        method: "GET",
        path: "/api/health",
        source: {
          file: "src/app/api/health/route.ts",
          exportKind: "function-declaration",
          localName: "GET",
          moduleSpecifier: null,
        },
      },
    ],
    plannedOperations: [
      {
        operationId: "api:POST:/api/wines",
        method: "POST",
        path: "/api/wines",
        sourceRequirementIds: ["TER-CF-185"],
      },
    ],
  };
}

function readContractDocuments(): ContractDocuments {
  return {
    inventory: JSON.parse(
      readFileSync(resolve("docs/api-route-inventory.json"), "utf8"),
    ),
    reconciliation: JSON.parse(
      readFileSync(resolve("docs/api-route-reconciliation.json"), "utf8"),
    ),
    ledger: JSON.parse(
      readFileSync(resolve("docs/feature-ledger.json"), "utf8"),
    ),
    completionPlan: readFileSync(
      resolve("docs/plans/2026-07-20-terroir-completion-spec.md"),
      "utf8",
    ),
  };
}

describe("source inventory parity", () => {
  it("discovers in memory without mutating planned operations", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "src/app/api/health/route.ts",
      "export function GET() {}",
    );
    const inventory = fixtureInventory();
    const before = structuredClone(inventory);

    expect(verifyInventoryParity(root, inventory)).toEqual([]);
    expect(inventory).toEqual(before);
  });

  it("reports deterministic source drift without rewriting the inventory", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "src/app/api/health/route.ts",
      "export function GET() {} export function POST() {}",
    );
    const inventory = fixtureInventory();
    const committed = `${JSON.stringify(inventory, null, 2)}\n`;
    writeFixture(root, "docs/api-route-inventory.json", committed);

    expect(verifyInventoryParity(root, inventory)).toEqual([
      "source inventory drift: added api:POST:/api/health",
    ]);
    expect(readFileSync(join(root, "docs/api-route-inventory.json"), "utf8")).toBe(
      committed,
    );
    expect(inventory.plannedOperations).toEqual(
      fixtureInventory().plannedOperations,
    );
  });

  it("detects removed and changed exports plus route-file count drift", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "src/app/api/health/route.ts",
      "export const GET = handler;",
    );
    const inventory = fixtureInventory();
    inventory.routeFileCount = 2;
    inventory.discoveredOperations.push({
      operationId: "api:POST:/api/health",
      method: "POST",
      path: "/api/health",
      source: {
        file: "src/app/api/health/route.ts",
        exportKind: "function-declaration",
        localName: "POST",
        moduleSpecifier: null,
      },
    });
    inventory.discoveredOperationCount = 2;

    expect(verifyInventoryParity(root, inventory)).toEqual([
      "source inventory drift: route file count is 1, committed 2",
      "source inventory drift: changed api:GET:/api/health",
      "source inventory drift: removed api:POST:/api/health",
    ]);
  });

  it("rejects discovered and planned overlap", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "src/app/api/health/route.ts",
      "export function GET() {}",
    );
    const inventory = fixtureInventory();
    inventory.plannedOperations[0] = {
      operationId: "api:GET:/api/health",
      method: "GET",
      path: "/api/health",
      sourceRequirementIds: ["TER-CF-185"],
    };

    expect(verifyInventoryParity(root, inventory)).toContain(
      "inventory overlap: api:GET:/api/health is both discovered and planned",
    );
  });

  it("detects overlap against fresh source before inventory regeneration", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "src/app/api/health/route.ts",
      "export function GET() {}",
    );
    writeFixture(
      root,
      "src/app/api/wines/route.ts",
      "export function POST() {}",
    );

    expect(verifyInventoryParity(root, fixtureInventory())).toEqual([
      "source inventory drift: route file count is 2, committed 1",
      "source inventory drift: added api:POST:/api/wines",
      "inventory overlap: api:POST:/api/wines is both discovered and planned",
    ]);
  });
});

describe("reconciliation semantics", () => {
  it("rejects a missing classification", () => {
    const documents = readContractDocuments();
    documents.reconciliation.discoveredClassifications.pop();

    expect(
      validateReconciliationSemantics(documents).join("\n"),
    ).toContain("discovered classifications must match inventory operations");
  });

  it("rejects a semantic alias that attempts to satisfy an exact promise", () => {
    const documents = readContractDocuments();
    const exact = documents.reconciliation.discoveredClassifications.find(
      (item) => item.classification === "exact",
    )!;
    exact.semanticAliasContext = [
      {
        requirementId: "TER-CF-181",
        relationship: "path_variant",
        note: "invalid exact alias",
      },
    ];

    expect(
      validateReconciliationSemantics(documents).join("\n"),
    ).toContain("exact classifications cannot carry semantic aliases");
  });

  it("rejects an exact classification mapped to a planned requirement", () => {
    const documents = readContractDocuments();
    const extension = documents.reconciliation.discoveredClassifications.find(
      (item) => item.classification === "extension",
    )!;
    extension.classification = "exact";
    extension.concreteRequirementId = "TER-CF-181";
    extension.semanticAliasContext = [];

    expect(
      validateReconciliationSemantics(documents).join("\n"),
    ).toContain(`${extension.operationId} exact classification is inconsistent`);
  });

  it("rejects an extra planned operation without a concrete mapping", () => {
    const documents = readContractDocuments();
    documents.inventory.plannedOperations.push({
      operationId: "api:GET:/api/unmapped",
      method: "GET",
      path: "/api/unmapped",
      sourceRequirementIds: ["TER-CF-181"],
    });

    expect(
      validateReconciliationSemantics(documents).join("\n"),
    ).toContain("api:GET:/api/unmapped planned promise is unmapped");
  });

  it("rejects incorrect realization, summary, ledger, and plan leaf state", () => {
    const documents = readContractDocuments();
    const planned = documents.reconciliation.concreteRequirements.find(
      (item) => item.realization === "planned_exact_path",
    )!;
    planned.realization = "discovered_exact_path";
    documents.reconciliation.summary.plannedPromiseCount -= 1;
    documents.ledger.items[0].status = "amended";
    documents.reconciliation.planLeaves[0].id = "TER-020B";

    const errors = validateReconciliationSemantics(documents).join("\n");
    expect(errors).toContain("discovered realization is inconsistent");
    expect(errors).toContain(
      "reconciliation summary must be derived from contract documents",
    );
    expect(errors).toContain("all 269 feature-ledger requirements must remain active");
    expect(errors).toContain("TER-020 plan leaf IDs must be unique, exact, and ordered");
  });

  it("rejects unknown fields through the strict committed schema", () => {
    const inventory = JSON.parse(
      readFileSync(resolve("docs/api-route-inventory.json"), "utf8"),
    );
    const schema = JSON.parse(
      readFileSync(resolve("docs/api-route-inventory.schema.json"), "utf8"),
    );
    inventory.unexpected = true;

    expect(validateJsonSchema(schema, inventory, "inventory").join("\n")).toContain(
      "must NOT have additional properties",
    );
  });
});

describe("checked-in API contract gate", () => {
  it("validates the real repository and preserves committed bytes", () => {
    const paths = [
      "docs/api-route-inventory.json",
      "docs/api-route-reconciliation.json",
    ];
    const before = paths.map((file) => readFileSync(resolve(file), "utf8"));

    const result = verifyApiContract(process.cwd());

    expect(result.errors).toEqual([]);
    expect(result.summary).toEqual({
      discoveredOperationCount: 82,
      plannedOperationCount: 15,
      classificationCount: 82,
    });
    expect(paths.map((file) => readFileSync(resolve(file), "utf8"))).toEqual(
      before,
    );
  });
});
