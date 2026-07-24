import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInventory,
  discoverRouteOperations,
  extractHttpExports,
  operationIdFor,
  routePathFromFile,
  validateInventoryShape,
  writeInventory,
} from "../../../scripts/generate-api-route-inventory.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "terroir-api-inventory-"));
  temporaryRoots.push(root);
  return root;
}

function writeFixture(root: string, file: string, source: string) {
  const absolutePath = join(root, file);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

describe("API route inventory operation identities", () => {
  it("keeps an operation stable when a dynamic parameter is renamed", () => {
    expect(operationIdFor("GET", "/api/wines/[id]")).toBe(
      "api:GET:/api/wines/{param}",
    );
    expect(operationIdFor("GET", "/api/wines/[wineId]")).toBe(
      "api:GET:/api/wines/{param}",
    );
    expect(operationIdFor("GET", "/api/files/[...path]")).toBe(
      "api:GET:/api/files/{catchall}",
    );
    expect(operationIdFor("GET", "/api/files/[[...path]]")).toBe(
      "api:GET:/api/files/{optional-catchall}",
    );
  });
});

describe("Next.js route path extraction", () => {
  it("normalizes route groups and platform separators", () => {
    expect(
      routePathFromFile(
        "src\\app\\api\\(internal)\\wines\\[id]\\route.ts",
      ),
    ).toBe("/api/wines/[id]");
  });

  it.each([
    ["src/app/api/_private/route.ts", "APIINV001"],
    ["src/app/api/@slot/route.ts", "APIINV001"],
    ["src/app/api/(.)intercept/route.ts", "APIINV001"],
    ["src/app/api/wines/not-route.ts", "APIINV001"],
  ])("rejects unsupported route file %s", (file, code) => {
    expect(() => routePathFromFile(file)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});

describe("HTTP export extraction", () => {
  it("recognizes supported function, variable, and named export forms", () => {
    const exports = extractHttpExports(
      `
        export async function GET() {}
        export const POST = handler;
        const remove = handler;
        export { remove as DELETE };
        export { update as PATCH } from "./handlers";
        export const runtime = "nodejs";
        export type { Example };
      `,
      "src/app/api/example/route.ts",
    );

    expect(exports).toEqual([
      {
        method: "GET",
        source: {
          exportKind: "function-declaration",
          localName: "GET",
          moduleSpecifier: null,
        },
      },
      {
        method: "POST",
        source: {
          exportKind: "variable-declaration",
          localName: "POST",
          moduleSpecifier: null,
        },
      },
      {
        method: "DELETE",
        source: {
          exportKind: "named-export",
          localName: "remove",
          moduleSpecifier: null,
        },
      },
      {
        method: "PATCH",
        source: {
          exportKind: "named-reexport",
          localName: "update",
          moduleSpecifier: "./handlers",
        },
      },
    ]);
  });

  it.each([
    ['export * from "./handlers";', "APIINV002"],
    ["export default function handler() {}", "APIINV002"],
    ["export const { GET } = handlers;", "APIINV002"],
    ["export function GET() {} export const GET = handler;", "APIINV003"],
    ["export const runtime = 'nodejs';", "APIINV006"],
    ["export function GET( {}", "APIINV005"],
  ])("fails unsupported source with %s", (source, code) => {
    expect(() =>
      extractHttpExports(source, "src/app/api/example/route.ts"),
    ).toThrow(expect.objectContaining({ code }));
  });
});

describe("route operation discovery", () => {
  it("discovers and deterministically sorts operations from a fixture tree", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "src/app/api/wines/[wineId]/route.ts",
      "export async function PATCH() {}",
    );
    writeFixture(
      root,
      "src/app/api/health/route.ts",
      "export function GET() {} export const POST = handler;",
    );

    expect(discoverRouteOperations({ projectRoot: root })).toEqual({
      routeFileCount: 2,
      operations: [
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
        {
          operationId: "api:POST:/api/health",
          method: "POST",
          path: "/api/health",
          source: {
            file: "src/app/api/health/route.ts",
            exportKind: "variable-declaration",
            localName: "POST",
            moduleSpecifier: null,
          },
        },
        {
          operationId: "api:PATCH:/api/wines/{param}",
          method: "PATCH",
          path: "/api/wines/[wineId]",
          source: {
            file: "src/app/api/wines/[wineId]/route.ts",
            exportKind: "function-declaration",
            localName: "PATCH",
            moduleSpecifier: null,
          },
        },
      ],
    });
  });

  it("rejects two files that normalize to the same route operation", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "src/app/api/(first)/health/route.ts",
      "export function GET() {}",
    );
    writeFixture(
      root,
      "src/app/api/(second)/health/route.ts",
      "export function GET() {}",
    );

    expect(() => discoverRouteOperations({ projectRoot: root })).toThrow(
      expect.objectContaining({ code: "APIINV004" }),
    );
  });

  it("rejects symlinked filesystem entries", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "outside/route.ts",
      "export function GET() {}",
    );
    mkdirSync(join(root, "src/app/api"), { recursive: true });
    symlinkSync(
      join(root, "outside"),
      join(root, "src/app/api/symlinked"),
      "dir",
    );

    expect(() => discoverRouteOperations({ projectRoot: root })).toThrow(
      expect.objectContaining({ code: "APIINV007" }),
    );
  });
});

describe("inventory schema shape", () => {
  const validInventory = {
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
        operationId: "api:GET:/api/wines",
        method: "GET",
        path: "/api/wines",
        sourceRequirementIds: ["TER-CF-183"],
      },
    ],
  };

  it("accepts minimal discovered and planned operations", () => {
    expect(validateInventoryShape(validInventory)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("rejects unknown fields and source data on planned operations", () => {
    const invalid = structuredClone(validInventory) as typeof validInventory & {
      unexpected?: boolean;
    };
    invalid.unexpected = true;
    (
      invalid.plannedOperations[0] as typeof invalid.plannedOperations[0] & {
        source?: object;
      }
    ).source = {};

    const result = validateInventoryShape(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "$: unexpected property unexpected",
        "$.plannedOperations[0]: unexpected property source",
      ]),
    );
  });

  it("defers discovered/planned overlap to the TER-020Ac parity verifier", () => {
    const transitional = structuredClone(validInventory);
    transitional.plannedOperations[0] = {
      operationId: "api:GET:/api/health",
      method: "GET",
      path: "/api/health",
      sourceRequirementIds: ["TER-CF-183"],
    };

    expect(validateInventoryShape(transitional)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("requires identifiers and direct bindings that match their method", () => {
    const missingName = structuredClone(validInventory);
    missingName.discoveredOperations[0].source.localName = null as never;
    expect(validateInventoryShape(missingName).valid).toBe(false);

    const mismatchedName = structuredClone(validInventory);
    mismatchedName.discoveredOperations[0].source.localName = "handler";
    expect(validateInventoryShape(mismatchedName).valid).toBe(false);

    const namedExport = structuredClone(validInventory);
    namedExport.discoveredOperations[0].source.exportKind = "named-export";
    namedExport.discoveredOperations[0].source.localName = "handler";
    expect(validateInventoryShape(namedExport).valid).toBe(true);
  });

  it.each(["/api/./health", "/api/../health"])(
    "rejects literal dot segment in %s",
    (path) => {
      const invalid = structuredClone(validInventory);
      invalid.discoveredOperations[0].path = path;
      invalid.discoveredOperations[0].operationId = `api:GET:${path}`;
      expect(validateInventoryShape(invalid).valid).toBe(false);
    },
  );
});

describe("inventory generation", () => {
  it("preserves planned operations and writes deterministic JSON atomically", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "src/app/api/health/route.ts",
      "export function GET() {}",
    );
    writeFixture(
      root,
      "docs/api-route-inventory.json",
      `${JSON.stringify({
        schemaVersion: 1,
        generatorVersion: 1,
        sourceRoot: "src/app/api",
        routeFileCount: 0,
        discoveredOperationCount: 0,
        discoveredOperations: [],
        plannedOperations: [
          {
            operationId: "api:GET:/api/health",
            method: "GET",
            path: "/api/health",
            sourceRequirementIds: ["TER-CF-183"],
          },
        ],
      })}\n`,
    );

    const first = writeInventory({ projectRoot: root });
    const firstBytes = readFileSync(
      join(root, "docs/api-route-inventory.json"),
      "utf8",
    );
    const second = writeInventory({ projectRoot: root });
    const secondBytes = readFileSync(
      join(root, "docs/api-route-inventory.json"),
      "utf8",
    );

    expect(first).toEqual(second);
    expect(first.plannedOperations).toHaveLength(1);
    expect(first.discoveredOperationCount).toBe(1);
    expect(firstBytes).toBe(secondBytes);
    expect(firstBytes.endsWith("\n")).toBe(true);
    expect(
      readdirSync(join(root, "docs")).filter((file) => file.includes(".tmp")),
    ).toEqual([]);
  });

  it("does not mutate an existing inventory when discovery fails", () => {
    const root = fixtureRoot();
    writeFixture(
      root,
      "src/app/api/health/route.ts",
      'export * from "./handlers";',
    );
    const existing = `${JSON.stringify(
      createInventory({
        routeFileCount: 0,
        operations: [],
        plannedOperations: [],
      }),
      null,
      2,
    )}\n`;
    writeFixture(root, "docs/api-route-inventory.json", existing);

    expect(() => writeInventory({ projectRoot: root })).toThrow(
      expect.objectContaining({ code: "APIINV002" }),
    );
    expect(
      readFileSync(join(root, "docs/api-route-inventory.json"), "utf8"),
    ).toBe(existing);
  });
});
