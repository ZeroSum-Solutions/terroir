import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createInitialLedger,
  deriveCriterion,
  metadataForRequirement,
  parseCoreFeatures,
  validateCompletionRules,
  verifyFeatureLedger,
} from "../../../scripts/verify-feature-ledger.mjs";

const SPEC = `<project_specification>
  <prerequisites>
    - This bullet is outside the ledger
  </prerequisites>
  <core_features>
    <authentication_and_session>
      - User can sign in
      - API returns 401 without a session
    </authentication_and_session>
    <cellar_and_inventory>
      - User can view inventory
    </cellar_and_inventory>
  </core_features>
</project_specification>`;

const PLAN = "### TER-010: Complete authentication";
const TEST_COMPLETION_RULES = [[1, 3, "TER-010", "identity"]];
const createTestLedger = () => createInitialLedger(SPEC, 3);
const verifyTestLedger = (
  ledger: ReturnType<typeof createInitialLedger>,
  plan = PLAN,
) =>
  verifyFeatureLedger(SPEC, ledger, plan, {
    approvedFeatureCount: 3,
    completionRules: TEST_COMPLETION_RULES,
  });

describe("parseCoreFeatures", () => {
  it("extracts core bullets in source order without rewriting their text", () => {
    expect(parseCoreFeatures(SPEC)).toEqual([
      {
        domain: "authentication_and_session",
        sourceOrder: 1,
        sourceText: "User can sign in",
      },
      {
        domain: "authentication_and_session",
        sourceOrder: 2,
        sourceText: "API returns 401 without a session",
      },
      {
        domain: "cellar_and_inventory",
        sourceOrder: 3,
        sourceText: "User can view inventory",
      },
    ]);
  });
});

describe("deriveCriterion", () => {
  it.each([
    ["User can sign in", "User", "can sign in"],
    [
      "GET /api/health returns 200 with JSON",
      "GET /api/health",
      "returns 200 with JSON",
    ],
    [
      "record_pour is the canonical write path",
      "record_pour",
      "is the canonical write path",
    ],
    [
      "Dev login route bypasses email auth in non-production environments only",
      "Dev login route",
      "bypasses email auth in non-production environments only",
    ],
    [
      "System auto-removes 86'd wines from published lists (or marks them gray, configurable)",
      "System",
      "auto-removes 86'd wines from published lists (or marks them gray, configurable)",
    ],
    [
      "cleanup_scan_idempotency periodically clears stale idempotency keys",
      "cleanup_scan_idempotency",
      "periodically clears stale idempotency keys",
    ],
  ])("losslessly splits %s", (sourceText, actor, action) => {
    expect(deriveCriterion(sourceText)).toEqual({
      actor,
      action,
      observableOutcome: sourceText,
      negativeCase: `Assertion is not observed: ${sourceText}`,
    });
  });

  it("rejects grammar outside the current app_spec contract", () => {
    expect(() => deriveCriterion("An unknown grammar shape")).toThrow(
      "unsupported feature assertion grammar",
    );
  });
});

describe("metadataForRequirement", () => {
  it.each([
    [1, "TER-010", "identity"],
    [57, "TER-028", "bottle-scanning"],
    [180, "TER-023", "operations"],
    [269, "TER-005", "quality-engineering"],
  ])("maps TER-CF-%s to its completion contract", (order, spec, owner) => {
    expect(metadataForRequirement(order)).toEqual({
      completionSpec: spec,
      evidenceOwner: owner,
    });
  });

  it("rejects requirements outside the authoritative 269", () => {
    expect(() => metadataForRequirement(270)).toThrow(
      "no completion metadata",
    );
  });
});

describe("validateCompletionRules", () => {
  it("detects a gap in a completion-rule partition", () => {
    expect(
      validateCompletionRules(
        [
          [1, 1, "TER-001", "first"],
          [3, 3, "TER-003", "third"],
        ],
        3,
      ),
    ).toContain("completion-rule gap at source order 2");
  });

  it("detects an overlap in a completion-rule partition", () => {
    expect(
      validateCompletionRules(
        [
          [1, 2, "TER-001", "first"],
          [2, 3, "TER-002", "second"],
        ],
        3,
      ),
    ).toContain("completion-rule overlap at source order 2");
  });
});

describe("createInitialLedger", () => {
  it("assigns deterministic IDs, criteria, and completion ownership", () => {
    expect(createTestLedger()).toMatchObject({
      schemaVersion: 2,
      featureCount: 3,
      budgetResolution: {
        previousMaximum: 200,
        approvedActiveCount: 3,
        decision: "all_enumerated_features_active",
        approvedBy: "product_owner",
        approvedOn: "2026-07-23",
      },
      items: [
        {
          id: "TER-CF-001",
          domain: "authentication_and_session",
          sourceOrder: 1,
          sourceText: "User can sign in",
          actor: "User",
          action: "can sign in",
          observableOutcome: "User can sign in",
          negativeCase: "Assertion is not observed: User can sign in",
          status: "active",
          completionSpec: "TER-010",
          evidenceOwner: "identity",
        },
        {
          id: "TER-CF-002",
          sourceOrder: 2,
          status: "active",
          completionSpec: "TER-010",
          evidenceOwner: "identity",
        },
        {
          id: "TER-CF-003",
          sourceOrder: 3,
          status: "active",
          completionSpec: "TER-010",
          evidenceOwner: "identity",
        },
      ],
    });
  });
});

describe("verifyFeatureLedger", () => {
  it("accepts a complete ledger that matches its source", () => {
    expect(verifyTestLedger(createTestLedger())).toEqual([]);
  });

  it("keeps 269 as the default approved source count", () => {
    expect(
      verifyFeatureLedger(SPEC, createTestLedger(), PLAN).join("\n"),
    ).toContain("source feature count must remain 269");
  });

  it.each([
    {
      name: "schema version drift",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.schemaVersion = 1;
      },
      expected: "schemaVersion must be 2",
    },
    {
      name: "budget resolution drift",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.budgetResolution.approvedActiveCount = 200;
      },
      expected: "budgetResolution.approvedActiveCount",
    },
    {
      name: "source file drift",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.sourceFile = "other-spec.txt";
      },
      expected: "sourceFile must be app_spec.txt",
    },
    {
      name: "count drift",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items.pop();
      },
      expected: "featureCount",
    },
    {
      name: "duplicate IDs",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[1].id = ledger.items[0].id;
      },
      expected: "duplicate ID TER-CF-001",
    },
    {
      name: "stable ID drift",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[1].id = "TER-CF-999";
      },
      expected: "id must remain TER-CF-002",
    },
    {
      name: "missing required fields",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[0].evidenceOwner = "";
      },
      expected: "evidenceOwner",
    },
    {
      name: "criterion drift",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[0].negativeCase = "Something else";
      },
      expected: "negativeCase",
    },
    {
      name: "completion spec drift",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[0].completionSpec = "TER-999";
      },
      expected: "completionSpec",
    },
    {
      name: "evidence owner drift",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[0].evidenceOwner = "unassigned";
      },
      expected: "evidenceOwner",
    },
    {
      name: "source text mismatch",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[1].sourceText = "Rewritten text";
      },
      expected: "sourceText",
    },
    {
      name: "domain mismatch",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[2].domain = "wrong_domain";
      },
      expected: "domain",
    },
    {
      name: "source order mismatch",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[0].sourceOrder = 2;
      },
      expected: "sourceOrder",
    },
    {
      name: "unknown statuses",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[0].status = "done";
      },
      expected: "status",
    },
    {
      name: "recognized but non-active current statuses",
      mutate: (ledger: ReturnType<typeof createInitialLedger>) => {
        ledger.items[0].status = "amended";
      },
      expected: "status must remain active",
    },
  ])("rejects $name", ({ mutate, expected }) => {
    const ledger = createTestLedger();
    mutate(ledger);

    expect(verifyTestLedger(ledger).join("\n")).toContain(expected);
  });

  it("rejects a completion spec missing from the plan", () => {
    expect(verifyTestLedger(createTestLedger(), "").join("\n")).toContain(
      "completionSpec TER-010 is absent",
    );
  });
});

describe("checked-in feature ledger", () => {
  const source = fs.readFileSync(path.resolve("app_spec.txt"), "utf8");
  const plan = fs.readFileSync(
    path.resolve("docs/plans/2026-07-20-terroir-completion-spec.md"),
    "utf8",
  );
  const ledger = JSON.parse(
    fs.readFileSync(path.resolve("docs/feature-ledger.json"), "utf8"),
  );

  it("accounts for all 269 real features without verifier errors", () => {
    expect(ledger.items).toHaveLength(269);
    expect(verifyFeatureLedger(source, ledger, plan)).toEqual([]);
  });

  it("keeps every current requirement active and losslessly structured", () => {
    expect(new Set(ledger.items.map((item: { status: string }) => item.status))).toEqual(
      new Set(["active"]),
    );

    for (const item of ledger.items) {
      expect(deriveCriterion(item.sourceText).actor).toBe(item.actor);
      expect(`${item.actor} ${item.action}`).toBe(item.sourceText);
      expect(item.observableOutcome).toBe(item.sourceText);
      expect(item.evidenceOwner).not.toBe("unassigned");
    }
  });

  it("matches the reviewed completion-spec distribution", () => {
    const counts = Object.fromEntries(
      [...new Set<string>(ledger.items.map((item: { completionSpec: string }) => item.completionSpec))]
        .sort()
        .map((spec) => [
          spec,
          ledger.items.filter(
            (item: { completionSpec: string }) => item.completionSpec === spec,
          ).length,
        ]),
    );

    expect(counts).toEqual({
      "TER-005": 13,
      "TER-010": 13,
      "TER-012": 1,
      "TER-013": 2,
      "TER-014": 4,
      "TER-015": 7,
      "TER-020": 49,
      "TER-023": 7,
      "TER-025": 27,
      "TER-026": 11,
      "TER-027": 15,
      "TER-028": 7,
      "TER-032": 1,
      "TER-033": 1,
      "TER-034": 1,
      "TER-035": 2,
      "TER-040": 28,
      "TER-041": 25,
      "TER-042": 37,
      "TER-043": 3,
      "TER-044": 15,
    });
  });

  it("marks the old progress counter as historical", () => {
    const progress = fs.readFileSync(path.resolve("claude-progress.txt"), "utf8");

    expect(progress.startsWith("# Historical progress diary")).toBe(true);
    expect(progress).toContain(
      "docs/feature-ledger.json is the authoritative completion ledger",
    );
  });

  it("still parses exactly the checked-in source bullets", () => {
    const source = fs.readFileSync(path.resolve("app_spec.txt"), "utf8");

    expect(parseCoreFeatures(source).map((item) => item.sourceText)).toEqual(
      ledger.items.map((item: { sourceText: string }) => item.sourceText),
    );
  });
});
