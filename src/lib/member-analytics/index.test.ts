import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMemberAnalytics } from ".";

const members = ["a", "b", "c"].map((userId) => ({
  memberId: `member-${userId}`,
  userId,
  role: "staff" as const,
}));

describe("buildMemberAnalytics", () => {
  it("EV-7.3: reports pour totals and comp rate against the house median", () => {
    const result = buildMemberAnalytics({
      members,
      pours: [
        { actorUserId: "a", mlDelta: 150, kind: "pour" },
        { actorUserId: "a", mlDelta: 100, kind: "pour" },
        { actorUserId: "b", mlDelta: 125, kind: "pour" },
      ],
      adjustments: [
        { actingUserId: "a", kind: "comp" },
        { actingUserId: "b", kind: "adjustment" },
      ],
      closeouts: [
        { closedBy: "a", varianceMl: -20 },
        { closedBy: "a", varianceMl: 5 },
      ],
    });

    // House median covers ACTIVE members only (a: 1/3, b: 0 → 1/6);
    // c has no events, so their rate is null and excluded.
    expect(result.houseMedianCompRate).toBeCloseTo(1 / 6, 10);
    expect(result.members.find((m) => m.userId === "c")?.compRate).toBeNull();
    expect(result.members).toEqual([
      expect.objectContaining({
        userId: "a",
        pourCount: 2,
        pourMl: 250,
        compCount: 1,
        compRate: 1 / 3,
        closeoutCount: 2,
        closeoutVarianceMl: -15,
      }),
      expect.objectContaining({
        userId: "b",
        pourCount: 1,
        pourMl: 125,
        compCount: 0,
        compRate: 0,
      }),
      expect.objectContaining({ userId: "c", compRate: null }),
    ]);
    expect(result.members[0].compRateZScore).toBeCloseTo(1, 10);
  });

  it("gives every member a zero z-score when comp rates are uniform", () => {
    for (let size = 1; size <= 40; size += 1) {
      const uniformMembers = Array.from({ length: size }, (_, index) => ({
        memberId: `m-${index}`,
        userId: `u-${index}`,
        role: "staff" as const,
      }));
      const pours = uniformMembers.flatMap((member) =>
        Array.from({ length: 3 }, () => ({
          actorUserId: member.userId,
          mlDelta: 150,
          kind: "pour",
        })),
      );
      const adjustments = uniformMembers.map((member) => ({
        actingUserId: member.userId,
        kind: "comp",
      }));

      const result = buildMemberAnalytics({
        members: uniformMembers,
        pours,
        adjustments,
        closeouts: [],
      });

      expect(result.members.every((member) => Math.abs(member.compRateZScore ?? 0) < 1e-12)).toBe(true);
    }
  });

  it("keeps the house median invariant when one outlier member is added", () => {
    const baseline = buildMemberAnalytics({
      members,
      pours: members.flatMap((member) => [
        { actorUserId: member.userId, mlDelta: 125, kind: "pour" },
        { actorUserId: member.userId, mlDelta: 125, kind: "pour" },
      ]),
      adjustments: [],
      closeouts: [],
    });
    const withOutlier = buildMemberAnalytics({
      members: [
        ...members,
        { memberId: "member-outlier", userId: "outlier", role: "staff" },
      ],
      pours: members.flatMap((member) => [
        { actorUserId: member.userId, mlDelta: 125, kind: "pour" },
        { actorUserId: member.userId, mlDelta: 125, kind: "pour" },
      ]),
      adjustments: Array.from({ length: 20 }, () => ({
        actingUserId: "outlier",
        kind: "comp",
      })),
      closeouts: [],
    });

    expect(withOutlier.houseMedianCompRate).toBe(baseline.houseMedianCompRate);
  });

  it("EV-7.3/7.4: keeps forbidden benchmark and accusatory language out of new sources", () => {
    const files = [
      "src/lib/member-analytics/index.ts",
      "src/app/api/member-analytics/route.ts",
      "src/app/api/stock-adjustments/route.ts",
      "src/app/(app)/team/member-analytics-section.tsx",
      "src/app/(app)/cellar/stock-adjustment-form.tsx",
    ];
    const source = files.map((file) => readFileSync(resolve(file), "utf8")).join("\n");

    expect(source.toLowerCase()).not.toContain(["industry", "average"].join(" "));
    expect(source.toLowerCase()).not.toContain(["industry", "benchmark"].join(" "));
    expect(source.toLowerCase()).not.toMatch(/\b(accus|theft|steal|stole|dishonest)/);
  });
});
