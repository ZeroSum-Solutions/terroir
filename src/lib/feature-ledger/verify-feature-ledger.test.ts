import { describe, expect, it } from "vitest";

import {
  createInitialLedger,
  parseCoreFeatures,
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

describe("createInitialLedger", () => {
  it("assigns deterministic permanent IDs and active placeholders", () => {
    expect(createInitialLedger(SPEC)).toMatchObject({
      featureCount: 3,
      items: [
        {
          id: "TER-CF-001",
          domain: "authentication_and_session",
          sourceOrder: 1,
          sourceText: "User can sign in",
          status: "active",
          evidenceOwner: "unassigned",
        },
        {
          id: "TER-CF-002",
          sourceOrder: 2,
          status: "active",
          evidenceOwner: "unassigned",
        },
        {
          id: "TER-CF-003",
          sourceOrder: 3,
          status: "active",
          evidenceOwner: "unassigned",
        },
      ],
    });
  });
});

describe("verifyFeatureLedger", () => {
  it("accepts a complete ledger that matches its source", () => {
    expect(verifyFeatureLedger(SPEC, createInitialLedger(SPEC))).toEqual([]);
  });

  it.each([
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
  ])("rejects $name", ({ mutate, expected }) => {
    const ledger = createInitialLedger(SPEC);
    mutate(ledger);

    expect(verifyFeatureLedger(SPEC, ledger).join("\n")).toContain(expected);
  });
});
