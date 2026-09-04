import { afterEach, describe, expect, it } from "vitest";
import { cleanup, click, mount } from "@/test/render";
import { OperationalBadges } from "./operational-badges";

afterEach(cleanup);

const BADGES = {
  value: [
    {
      kind: "slow_mover" as const,
      label: "Slow mover",
      rule: "Nothing has sold since it was put away 200 days ago; your dead-stock threshold is 90.",
    },
    { kind: "last_bottle" as const, label: "Last bottle", rule: "One left on hand." },
  ],
  basis: { kind: "measured" as const, asOf: "2026-09-01" },
};

describe("OperationalBadges", () => {
  it("renders every badge with the records basis", async () => {
    const el = await mount(<OperationalBadges badges={BADGES} />);
    expect(el.textContent).toContain("Slow mover");
    expect(el.textContent).toContain("Last bottle");
    expect(el.textContent).toMatch(/your own records/i);
  });

  it("states a badge's rule when it is opened", async () => {
    // A badge that cannot say why it fired is a badge nobody trusts twice.
    const el = await mount(<OperationalBadges badges={BADGES} />);
    expect(el.textContent).not.toMatch(/dead-stock threshold is 90/);
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Slow mover"))!;
    await click(button);
    expect(el.textContent).toMatch(/dead-stock threshold is 90/);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders nothing when no badge fired", async () => {
    const el = await mount(<OperationalBadges badges={{ ...BADGES, value: [] }} />);
    expect(el.textContent).toBe("");
  });
});
