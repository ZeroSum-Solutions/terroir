import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  API_ABUSE_POLICY,
  PLANNED_API_OPERATION_IDS,
} from "./api-abuse-policy";
import { API_AUTHORIZATION } from "./api-authorization";
import { CAPABILITIES, CAPABILITY_ROLES } from "./capabilities";

type Inventory = {
  discoveredOperations: Array<{
    operationId: string;
    source: { file: string; localName: string };
  }>;
};

const inventory = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "docs/api-route-inventory.json"),
    "utf8",
  ),
) as Inventory;

describe("API authorization manifest", () => {
  it("classifies every discovered operation with no stale entries", () => {
    const discoveredIds = inventory.discoveredOperations
      .map(({ operationId }) => operationId)
      .sort();
    const classifiedIds = Object.keys(API_AUTHORIZATION).sort();

    expect(classifiedIds).toEqual(discoveredIds);
  });

  it("keeps only health and the login bootstrap public", () => {
    const publicIds = Object.entries(API_AUTHORIZATION)
      .filter(([, policy]) => policy.access === "public")
      .map(([operationId]) => operationId)
      .sort();

    expect(publicIds).toEqual([
      "api:GET:/api/dev-login",
      "api:GET:/api/health",
    ]);
  });

  it("requires a session without an existing membership only for invite acceptance", () => {
    const authenticatedIds = Object.entries(API_AUTHORIZATION)
      .filter(([, policy]) => policy.access === "authenticated")
      .map(([operationId]) => operationId);

    expect(authenticatedIds).toEqual(["api:POST:/api/team/accept-invite"]);
  });

  it("uses only declared capabilities for membership operations", () => {
    const declared = new Set<string>(CAPABILITIES);

    for (const policy of Object.values(API_AUTHORIZATION)) {
      if (policy.access === "membership") {
        expect(declared.has(policy.capability)).toBe(true);
      }
    }
  });

  it("keeps route enforcement aligned with each declared policy", () => {
    for (const operation of inventory.discoveredOperations) {
      const policy =
        API_AUTHORIZATION[
          operation.operationId as keyof typeof API_AUTHORIZATION
        ];
      const calls = collectAuthCalls(
        operation.source.file,
        operation.source.localName,
      );

      if (policy.access === "public") {
        expect(calls, operation.operationId).toEqual([]);
        continue;
      }

      if (policy.access === "authenticated") {
        expect(calls, operation.operationId).toContainEqual(
          expect.objectContaining({
            helper: "requireAuth",
            roles: null,
          }),
        );
        continue;
      }

      const expectedRoles = [...CAPABILITY_ROLES[policy.capability]].sort();
      const aligned = calls.some((call) => {
        if (call.helper === "requireCapability") {
          return call.capability === policy.capability;
        }
        if (call.helper === "requireMembership") {
          return expectedRoles.join(",") === "manager,owner,staff";
        }
        if (call.helper === "requireOwner") {
          return expectedRoles.join(",") === "owner";
        }
        if (call.helper === "requireRole") {
          return call.roles?.sort().join(",") === expectedRoles.join(",");
        }
        return false;
      });

      // Restaurant GET/PUT authenticate first, then enforce membership against
      // the explicit restaurant ID instead of the active membership.
      const explicitRestaurantAuth =
        (operation.operationId === "api:GET:/api/restaurant/{param}" ||
          operation.operationId === "api:PUT:/api/restaurant/{param}") &&
        calls.some((call) => call.helper === "requireAuth");

      expect(
        aligned || explicitRestaurantAuth,
        `${operation.operationId}: ${JSON.stringify(calls)}`,
      ).toBe(true);
    }
  });

  it("classifies the full discovered and planned operation union for rate limiting", () => {
    const operationIds = [
      ...inventory.discoveredOperations.map(({ operationId }) => operationId),
      ...PLANNED_API_OPERATION_IDS,
    ].sort();

    expect(Object.keys(API_ABUSE_POLICY).sort()).toEqual(operationIds);
    expect(API_ABUSE_POLICY["api:GET:/api/health"]).toEqual({
      access: "public",
      rateLimit: "platform-health",
      idempotency: "none",
    });
    expect(API_ABUSE_POLICY["api:GET:/api/dev-login"]).toEqual({
      access: "public",
      rateLimit: "public-bootstrap",
      idempotency: "none",
    });
  });

  it("classifies the exact idempotency support set", () => {
    const none = Object.entries(API_ABUSE_POLICY)
      .filter(([, policy]) => policy.idempotency === "none")
      .map(([operationId]) => operationId)
      .sort();
    const supported = Object.entries(API_ABUSE_POLICY)
      .filter(([, policy]) => policy.idempotency === "supported")
      .map(([operationId]) => operationId)
      .sort();

    expect(none).toHaveLength(33);
    expect(supported).toHaveLength(59);
    expect(none).toContain("api:POST:/api/pdf");
    expect(
      none.filter((operationId) => !operationId.startsWith("api:GET:")),
    ).toEqual(["api:POST:/api/pdf"]);
    expect(
      supported.some((operationId) => operationId.startsWith("api:GET:")),
    ).toBe(false);
  });

  it("keeps every discovered route aligned with its declared risk class", () => {
    const mismatches: string[] = [];
    for (const operation of inventory.discoveredOperations) {
      const policy =
        API_ABUSE_POLICY[
          operation.operationId as keyof typeof API_ABUSE_POLICY
        ];
      if (policy.access === "public") continue;

      const calls = collectAuthCalls(
        operation.source.file,
        operation.source.localName,
      );
      const aligned = calls.some(
        (call) => effectiveRateLimit(call) === policy.rateLimit,
      );
      if (!aligned) {
        mismatches.push(
          `${operation.operationId}: expected ${policy.rateLimit}, got ${JSON.stringify(calls)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});

type AuthCall =
  | {
      helper: "requireAuth" | "requireMembership" | "requireOwner";
      roles: null;
      rateLimit: string | null;
    }
  | { helper: "requireRole"; roles: string[]; rateLimit: string | null }
  | {
      helper: "requireCapability";
      capability: string;
      roles: null;
      rateLimit: string | null;
    };

function collectAuthCalls(file: string, exportedName: string): AuthCall[] {
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

  const calls: AuthCall[] = [];
  const visited = new Set<string>();

  function visitFunction(name: string) {
    if (visited.has(name)) return;
    visited.add(name);
    const fn = functions.get(name);
    if (!fn?.body) return;
    visit(fn.body);
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "requireAuth" || name === "requireMembership" || name === "requireOwner") {
        calls.push({
          helper: name,
          roles: null,
          rateLimit: objectLiteralProperty(node.arguments[0], "rateLimit"),
        });
      } else if (name === "requireCapability") {
        const capability = literalText(node.arguments[0]);
        calls.push({
          helper: "requireCapability",
          capability: capability ?? "",
          roles: null,
          rateLimit: objectLiteralProperty(node.arguments[1], "rateLimit"),
        });
      } else if (name === "requireRole") {
        const argument = node.arguments[0];
        const roles =
          argument && ts.isArrayLiteralExpression(argument)
            ? argument.elements
                .map(literalText)
                .filter((value): value is string => value !== null)
            : [];
        calls.push({
          helper: "requireRole",
          roles,
          rateLimit: objectLiteralProperty(node.arguments[1], "rateLimit"),
        });
      } else if (functions.has(name)) {
        visitFunction(name);
      }
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument) && functions.has(argument.text)) {
          visitFunction(argument.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visitFunction(exportedName);
  return calls;
}

function literalText(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function objectLiteralProperty(
  node: ts.Node | undefined,
  propertyName: string,
): string | null {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  const property = node.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === propertyName,
  );
  return property ? literalText(property.initializer) : null;
}

function effectiveRateLimit(call: AuthCall): string {
  if (call.rateLimit) return call.rateLimit;
  if (call.helper === "requireOwner" || call.helper === "requireRole") {
    return "mutation";
  }
  if (call.helper === "requireCapability") {
    return call.capability.endsWith(":view") ||
      call.capability === "export:read"
      ? "standard"
      : "mutation";
  }
  return "standard";
}
