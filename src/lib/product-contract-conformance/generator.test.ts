import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/generate-product-contract-conformance.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, file: string, value: string | object) {
  const absolute = join(root, file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "terroir-conformance-"));
  roots.push(root);
  const actors = new Map([
    [180, "GET /api/health"],
    [181, "GET /api/cellar"],
    [182, "POST /api/cellar"],
    [183, "PATCH /api/cellar/[id]"],
    [212, "All write endpoints"],
  ]);
  const items = Array.from({ length: 269 }, (_, index) => {
    const sourceOrder = index + 1;
    const id = `TER-CF-${String(sourceOrder).padStart(3, "0")}`;
    const actor =
      actors.get(sourceOrder) ??
      (sourceOrder >= 180 && sourceOrder <= 211
        ? `GET /api/planned-${sourceOrder}`
        : "System");
    return {
      id,
      sourceOrder,
      actor,
      sourceText: `${actor} requirement ${id}`,
      status: "active",
    };
  });
  write(root, "docs/feature-ledger.json", {
    schemaVersion: 2,
    featureCount: 269,
    items,
  });
  write(
    root,
    "src/app/api/health/route.ts",
    "export function GET() { return Response.json({ ok: true }); }\n",
  );
  write(
    root,
    "src/app/api/cellar/route.ts",
    "export function POST() { return new Response(null); }\n",
  );
  return root;
}

function run(root: string, mode: "--write" | "--check") {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--project-root",
      root,
      "--output",
      "docs/product-contract-conformance.json",
      mode,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

function output(root: string) {
  return JSON.parse(
    readFileSync(join(root, "docs/product-contract-conformance.json"), "utf8"),
  );
}

function requirement(root: string, id: string) {
  return output(root).requirements.find(
    (item: { requirementId: string }) => item.requirementId === id,
  );
}

describe("product contract conformance generator", () => {
  it("discovers current routes from source and records exact weak evidence", () => {
    const root = fixture();
    write(root, "docs/api-route-inventory.json", { discoveredOperations: [] });

    const result = run(root, "--write");

    expect(result.status, result.stderr).toBe(0);
    expect(requirement(root, "TER-CF-180")).toEqual({
      requirementId: "TER-CF-180",
      status: "weak",
      reason: "route_present_executable_proof_not_trusted",
      operationId: "api:GET:/api/health",
      evidence: {
        ledgerClaim: "GET /api/health requirement TER-CF-180",
        implementation: {
          method: "GET",
          path: "/api/health",
          sourceFile: "src/app/api/health/route.ts",
          exportKind: "function-declaration",
        },
        proofAssessment: "Executable behavioral proof is not yet trusted.",
      },
    });
  });

  it("keeps an absent planned route unimplemented despite recorded proof metadata", () => {
    const root = fixture();
    write(root, "docs/api-route-inventory.json", {
      plannedOperations: [{ operationId: "api:GET:/api/cellar" }],
    });
    write(root, "docs/product-contract-conformance.json", {
      requirements: [{ requirementId: "TER-CF-181", status: "proved" }],
    });

    expect(run(root, "--write").status).toBe(0);
    expect(requirement(root, "TER-CF-181")).toMatchObject({
      status: "unimplemented",
      reason: "current_route_not_discovered",
      operationId: "api:GET:/api/cellar",
      evidence: {
        ledgerClaim: "GET /api/cellar requirement TER-CF-181",
        expectedRoute: { method: "GET", path: "/api/cellar" },
        implementation: null,
      },
    });
  });

  it("matches a renamed dynamic parameter by canonical operation identity", () => {
    const root = fixture();
    write(
      root,
      "src/app/api/cellar/[wineId]/route.ts",
      "export function PATCH() { return new Response(null); }\n",
    );

    expect(run(root, "--write").status).toBe(0);
    expect(requirement(root, "TER-CF-183")).toMatchObject({
      status: "weak",
      reason: "route_present_executable_proof_not_trusted",
      operationId: "api:PATCH:/api/cellar/{param}",
      evidence: {
        implementation: {
          method: "PATCH",
          path: "/api/cellar/[wineId]",
          sourceFile: "src/app/api/cellar/[wineId]/route.ts",
        },
      },
    });
  });

  it("fails the drift check after a current route is renamed", () => {
    const root = fixture();
    expect(run(root, "--write").status).toBe(0);
    renameSync(join(root, "src/app/api/health"), join(root, "src/app/api/status"));

    const check = run(root, "--check");

    expect(check.status).toBe(1);
    expect(check.stderr).toContain("generated conformance status is stale");
    expect(run(root, "--write").status).toBe(0);
    expect(requirement(root, "TER-CF-180")).toMatchObject({
      status: "unimplemented",
      reason: "current_route_not_discovered",
    });
  });

  it("preserves the stable active ledger IDs", () => {
    const root = fixture();
    expect(run(root, "--write").status).toBe(0);
    const generated = output(root);
    expect(generated.scope.activeFeatureLedgerCount).toBe(269);
    expect(generated.requirements.map((item: { requirementId: string }) => item.requirementId)).toEqual(
      Array.from({ length: 38 }, (_, index) => `TER-CF-${180 + index}`),
    );

    const ledger = JSON.parse(readFileSync(join(root, "docs/feature-ledger.json"), "utf8"));
    ledger.items[268].id = "TER-CF-999";
    write(root, "docs/feature-ledger.json", ledger);
    const result = run(root, "--write");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("active feature ledger IDs must remain TER-CF-001 through TER-CF-269");
  });

  it("keeps cross-cutting claims weak with an explicit proof assessment", () => {
    const root = fixture();
    expect(run(root, "--write").status).toBe(0);
    expect(requirement(root, "TER-CF-212")).toEqual({
      requirementId: "TER-CF-212",
      status: "weak",
      reason: "cross_cutting_executable_proof_not_trusted",
      operationId: null,
      evidence: {
        ledgerClaim: "All write endpoints requirement TER-CF-212",
        scope: "All write endpoints",
        implementation: null,
        proofAssessment: "No trusted executable proof covers this quantified scope.",
      },
    });
  });

  it("writes a deterministic artifact with zero proved requirements", () => {
    const root = fixture();
    expect(run(root, "--write").status).toBe(0);
    const first = readFileSync(join(root, "docs/product-contract-conformance.json"), "utf8");
    expect(run(root, "--write").status).toBe(0);
    const second = readFileSync(join(root, "docs/product-contract-conformance.json"), "utf8");

    expect(second).toBe(first);
    expect(output(root).summary.proved).toBe(0);
    expect(output(root).requirements.every((item: { status: string }) => item.status !== "proved")).toBe(true);
    expect(run(root, "--check").status).toBe(0);
  });
});
