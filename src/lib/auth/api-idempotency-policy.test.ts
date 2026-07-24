import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  API_ABUSE_POLICY,
  type ApiOperationId,
} from "./api-abuse-policy";
import {
  API_IDEMPOTENCY_IMPLEMENTATIONS,
  type ApiIdempotencyImplementation,
} from "./api-idempotency-policy";

type InventoryOperation = {
  operationId: ApiOperationId;
  source: { file: string; localName: string };
};

type Inventory = {
  discoveredOperations: InventoryOperation[];
};

const inventory = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "docs/api-route-inventory.json"),
    "utf8",
  ),
) as Inventory;

const EXPECTED_PENDING_DISCOVERED = [
  "api:DELETE:/api/cellar/{param}",
  "api:DELETE:/api/restaurant/{param}",
  "api:DELETE:/api/team/invite/{param}",
  "api:DELETE:/api/team/members/{param}",
  "api:DELETE:/api/wine-list-items/{param}",
  "api:DELETE:/api/wine-list-sections/{param}",
  "api:DELETE:/api/wine-lists/{param}",
  "api:DELETE:/api/wine-lists/{param}/publish",
  "api:DELETE:/api/wines/{param}/image",
  "api:PATCH:/api/cellar/config",
  "api:PATCH:/api/cellar/{param}",
  "api:PATCH:/api/cellar/{param}/section",
  "api:PATCH:/api/scans/{param}",
  "api:PATCH:/api/team/members/{param}",
  "api:PATCH:/api/wine-list-items/reorder",
  "api:PATCH:/api/wine-list-items/{param}",
  "api:PATCH:/api/wine-list-sections/reorder",
  "api:PATCH:/api/wine-list-sections/{param}",
  "api:PATCH:/api/wine-lists/{param}",
  "api:PATCH:/api/wines/{param}",
  "api:PATCH:/api/wines/{param}/availability",
  "api:PATCH:/api/wines/{param}/pricing-targets",
  "api:POST:/api/cellar",
  "api:POST:/api/cellar/batch-section",
  "api:POST:/api/cellar/config",
  "api:POST:/api/open-bottles/{param}/close",
  "api:POST:/api/pour",
  "api:POST:/api/pour/undo",
  "api:POST:/api/reconcile",
  "api:POST:/api/scan-bottle",
  "api:POST:/api/scan-bottle/confirm",
  "api:POST:/api/scans/{param}/commit",
  "api:POST:/api/scans/{param}/re-extract",
  "api:POST:/api/team/invite",
  "api:POST:/api/team/invite/{param}/resend",
  "api:POST:/api/wine-list-items",
  "api:POST:/api/wine-list-sections",
  "api:POST:/api/wine-lists",
  "api:POST:/api/wine-lists/{param}/clone",
  "api:POST:/api/wine-lists/{param}/publish",
  "api:POST:/api/wines/create-from-lwin",
  "api:POST:/api/wines/enrich",
  "api:POST:/api/wines/refresh-retail-batch",
  "api:POST:/api/wines/{param}/dismiss-pricing-alert",
  "api:POST:/api/wines/{param}/enrich",
  "api:POST:/api/wines/{param}/image",
  "api:POST:/api/wines/{param}/overpaid",
  "api:POST:/api/wines/{param}/refresh-retail",
  "api:POST:/api/wines/{param}/snooze-alert",
  "api:PUT:/api/restaurant/{param}",
] as const satisfies readonly ApiOperationId[];

const EXPECTED_PLANNED = [
  "api:DELETE:/api/team/{param}",
  "api:PATCH:/api/restaurant",
  "api:POST:/api/team",
] as const satisfies readonly ApiOperationId[];

describe("API idempotency implementation ledger", () => {
  it("partitions every supported operation into implemented, pending, or planned", () => {
    const discovered = new Set(
      inventory.discoveredOperations.map(({ operationId }) => operationId),
    );
    const supported = Object.entries(API_ABUSE_POLICY)
      .filter(([, policy]) => policy.idempotency === "supported")
      .map(([operationId]) => operationId as ApiOperationId)
      .sort();
    const implemented = Object.keys(
      API_IDEMPOTENCY_IMPLEMENTATIONS,
    ).sort() as ApiOperationId[];
    const pending = supported.filter(
      (operationId) =>
        discovered.has(operationId) && !implemented.includes(operationId),
    );
    const planned = supported.filter(
      (operationId) => !discovered.has(operationId),
    );

    expect(implemented).toHaveLength(6);
    expect(pending).toEqual([...EXPECTED_PENDING_DISCOVERED].sort());
    expect(planned).toEqual([...EXPECTED_PLANNED].sort());
    expect(
      [...implemented, ...pending, ...planned].sort(),
    ).toEqual(supported);
  });

  it("proves every implemented route reaches its exact declared boundary", () => {
    for (const operation of inventory.discoveredOperations) {
      const implementation =
        API_IDEMPOTENCY_IMPLEMENTATIONS[
          operation.operationId as keyof typeof API_IDEMPOTENCY_IMPLEMENTATIONS
        ];
      const calls = collectIdempotencyCalls(
        operation.source.file,
        operation.source.localName,
      );

      if (!implementation) {
        expect(calls, operation.operationId).toEqual([]);
        continue;
      }

      if (implementation.boundary.kind === "generic-wrapper") {
        const binaryMode = implementation.identity
          .binary as ApiIdempotencyImplementation["identity"]["binary"];
        expect(calls, operation.operationId).toHaveLength(
          implementation.boundary.count,
        );
        expect(
          calls.every(
            (call) =>
              call.routeBoundary === "generic-wrapper" &&
              call.operationId === operation.operationId &&
              call.hasCanonicalHash,
          ),
          operation.operationId,
        ).toBe(true);
        if (binaryMode === "none") {
          expect(
            calls.every((call) => !call.hasBinaryParts),
            operation.operationId,
          ).toBe(true);
        } else if (binaryMode === "required") {
          expect(
            calls.every((call) => call.hasBinaryParts),
            operation.operationId,
          ).toBe(true);
        } else {
          expect(
            calls.some((call) => call.hasBinaryParts),
            operation.operationId,
          ).toBe(true);
        }
        if (implementation.execution.kind === "fail-closed") {
          expect(
            calls.every((call) => call.releaseOnError !== true),
            operation.operationId,
          ).toBe(true);
        } else {
          const routeSource = readFileSync(
            resolve(process.cwd(), operation.source.file),
            "utf8",
          );
          expect(routeSource, operation.operationId).toContain(
            implementation.execution.rpc,
          );
        }
      } else {
        expect(calls, operation.operationId).toEqual([
          expect.objectContaining({
            routeBoundary: "dedicated-rpc",
            rpc: implementation.boundary.rpc,
          }),
        ]);
        const routeSource = readFileSync(
          resolve(process.cwd(), operation.source.file),
          "utf8",
        );
        expect(routeSource, operation.operationId).toContain(
          "p_idempotency_key",
        );
        expect(routeSource, operation.operationId).toContain(
          "p_request_hash",
        );
      }

      const clientConfig =
        implementation.client as ApiIdempotencyImplementation["client"];
      if (
        clientConfig.lifecycle === "no-first-party-caller"
      ) {
        expect(clientConfig.sources).toEqual([]);
        continue;
      }
      expect(
        clientConfig.sources.length,
        operation.operationId,
      ).toBeGreaterThan(0);
      for (const clientSource of clientConfig.sources) {
        const client = readFileSync(
          resolve(process.cwd(), clientSource),
          "utf8",
        );
        expect(client, `${operation.operationId}: ${clientSource}`).toContain(
          "createIdempotentCommandStore",
        );
        if (!operation.operationId.includes("{param}")) {
          expect(
            client,
            `${operation.operationId}: ${clientSource}`,
          ).toContain(operation.operationId.split(":").slice(2).join(":"));
        }
        if (
          clientConfig.lifecycle === "session-persistent"
        ) {
          expect(
            client,
            `${operation.operationId}: ${clientSource}`,
          ).toContain("createSessionCommandPersistence");
        }
      }
    }
  });
});

type IdempotencyCall = {
  routeBoundary: "generic-wrapper" | "dedicated-rpc";
  operationId: string | null;
  rpc: string | null;
  hasCanonicalHash: boolean;
  hasBinaryParts: boolean;
  releaseOnError: boolean | null;
};

function collectIdempotencyCalls(
  file: string,
  exportedName: string,
): IdempotencyCall[] {
  const sourceText = readFileSync(resolve(process.cwd(), file), "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const functions = new Map<string, ts.FunctionLikeDeclaration>();

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
    }
  }

  const calls: IdempotencyCall[] = [];
  const visited = new Set<string>();

  function visitFunction(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    const fn = functions.get(name);
    if (fn?.body) visit(fn.body);
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "withIdempotency" ||
          node.expression.text === "idempotentMutationResponse")
      ) {
        const sharedBoundary =
          node.expression.text === "idempotentMutationResponse";
        calls.push({
          routeBoundary: "generic-wrapper",
          operationId: objectLiteralProperty(
            node.arguments[0],
            "operationId",
          ),
          rpc: null,
          hasCanonicalHash: sharedBoundary
            ? hasObjectLiteralProperty(node.arguments[0], "payload")
            : objectLiteralPropertyContainsCall(
                node.arguments[0],
                "requestHash",
                "createIdempotencyRequestHash",
              ),
          hasBinaryParts: sharedBoundary
            ? hasObjectLiteralProperty(
                node.arguments[0],
                "binaryParts",
              )
            : canonicalHashHasBinaryParts(node.arguments[0]),
          releaseOnError: objectLiteralBooleanProperty(
            node.arguments[0],
            "releaseOnError",
          ),
        });
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "rpc" &&
        literalText(node.arguments[0])?.endsWith("_idempotent")
      ) {
        calls.push({
          routeBoundary: "dedicated-rpc",
          operationId: null,
          rpc: literalText(node.arguments[0]),
          hasCanonicalHash: false,
          hasBinaryParts: false,
          releaseOnError: null,
        });
      } else if (
        ts.isIdentifier(node.expression) &&
        functions.has(node.expression.text)
      ) {
        visitFunction(node.expression.text);
      }

      for (const argument of node.arguments) {
        if (
          ts.isIdentifier(argument) &&
          functions.has(argument.text)
        ) {
          visitFunction(argument.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visitFunction(exportedName);
  return calls;
}

function hasObjectLiteralProperty(
  node: ts.Node | undefined,
  propertyName: string,
): boolean {
  return (
    objectLiteralPropertyInitializer(node, propertyName) !== undefined
  );
}

function objectLiteralPropertyContainsCall(
  node: ts.Node | undefined,
  propertyName: string,
  functionName: string,
): boolean {
  const initializer = objectLiteralPropertyInitializer(node, propertyName);
  let found = false;
  if (initializer) {
    function visit(candidate: ts.Node): void {
      if (
        ts.isCallExpression(candidate) &&
        ts.isIdentifier(candidate.expression) &&
        candidate.expression.text === functionName
      ) {
        found = true;
      }
      ts.forEachChild(candidate, visit);
    }
    visit(initializer);
  }
  return found;
}

function canonicalHashHasBinaryParts(
  node: ts.Node | undefined,
): boolean {
  const initializer = objectLiteralPropertyInitializer(node, "requestHash");
  let hasBinaryParts = false;
  if (initializer) {
    function visit(candidate: ts.Node): void {
      if (
        ts.isCallExpression(candidate) &&
        ts.isIdentifier(candidate.expression) &&
        candidate.expression.text ===
          "createIdempotencyRequestHash" &&
        candidate.arguments.length > 1
      ) {
        hasBinaryParts = true;
      }
      ts.forEachChild(candidate, visit);
    }
    visit(initializer);
  }
  return hasBinaryParts;
}

function literalText(node: ts.Node | undefined): string | null {
  return node &&
    (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function objectLiteralProperty(
  node: ts.Node | undefined,
  propertyName: string,
): string | null {
  return literalText(
    objectLiteralPropertyInitializer(node, propertyName),
  );
}

function objectLiteralPropertyInitializer(
  node: ts.Node | undefined,
  propertyName: string,
): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const property = node.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === propertyName,
  );
  return property?.initializer;
}

function objectLiteralBooleanProperty(
  node: ts.Node | undefined,
  propertyName: string,
): boolean | null {
  const initializer = objectLiteralPropertyInitializer(
    node,
    propertyName,
  );
  if (initializer?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (initializer?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}
