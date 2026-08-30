import { describe, expect, it } from "vitest";
import { fetchSnoozedAlerts } from "./snoozed-alerts";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";

type WineRow = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  alert_snoozed_until: string | null;
  pricing_dismissed_until: string | null;
};

function makeSupabase(wines: WineRow[] | undefined) {
  const from = (table: string) => {
    if (table !== "wines") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: () => ({
          or: async () => ({ data: wines, error: null }),
        }),
      }),
    };
  };
  return { from } as never;
}

const FUTURE = new Date(Date.now() + 1000 * 60 * 60).toISOString();
const PAST = new Date(Date.now() - 1000 * 60 * 60).toISOString();

describe("fetchSnoozedAlerts", () => {
  it("returns an empty array when the query yields no rows", async () => {
    const supabase = makeSupabase(undefined);
    await expect(fetchSnoozedAlerts(supabase, RESTAURANT_ID)).resolves.toEqual([]);
  });

  it("filters out rows whose snooze has already expired (defense against .or() semantics)", async () => {
    const supabase = makeSupabase([
      {
        id: "w1",
        name: "Wine A",
        producer: "Producer A",
        vintage: 2010,
        alert_snoozed_until: PAST,
        pricing_dismissed_until: null,
      },
    ]);
    await expect(fetchSnoozedAlerts(supabase, RESTAURANT_ID)).resolves.toEqual([]);
  });

  it("reports which kind(s) of snooze are active per wine", async () => {
    const supabase = makeSupabase([
      {
        id: "w1",
        name: "Wine A",
        producer: "Producer A",
        vintage: 2010,
        alert_snoozed_until: FUTURE,
        pricing_dismissed_until: null,
      },
      {
        id: "w2",
        name: "Wine B",
        producer: "Producer B",
        vintage: 2012,
        alert_snoozed_until: null,
        pricing_dismissed_until: FUTURE,
      },
    ]);

    const rows = await fetchSnoozedAlerts(supabase, RESTAURANT_ID);

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          wine_id: "w1",
          drinkWindowSnoozedUntil: FUTURE,
          pricingDismissedUntil: null,
        }),
        expect.objectContaining({
          wine_id: "w2",
          drinkWindowSnoozedUntil: null,
          pricingDismissedUntil: FUTURE,
        }),
      ]),
    );
  });

  it("sorts by soonest-expiring snooze, then alphabetically by producer", async () => {
    const soon = new Date(Date.now() + 1000 * 60).toISOString();
    const later = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    const supabase = makeSupabase([
      {
        id: "w1",
        name: "Wine A",
        producer: "Zeta",
        vintage: 2010,
        alert_snoozed_until: later,
        pricing_dismissed_until: null,
      },
      {
        id: "w2",
        name: "Wine B",
        producer: "Alpha",
        vintage: 2011,
        alert_snoozed_until: soon,
        pricing_dismissed_until: null,
      },
    ]);

    const rows = await fetchSnoozedAlerts(supabase, RESTAURANT_ID);
    expect(rows.map((r) => r.wine_id)).toEqual(["w2", "w1"]);
  });

  it("ranks a pricing-only snooze against a drink-window-only snooze by whichever expires first", async () => {
    // Covers the Infinity fallbacks in the sort comparator: each row has
    // exactly one of the two snooze fields set, so the other side of every
    // ternary is the branch under test. Without this the comparator's null
    // handling is only ever exercised on one field at a time.
    const soon = new Date(Date.now() + 1000 * 60).toISOString();
    const later = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    const supabase = makeSupabase([
      {
        id: "drink-window-later",
        name: "Wine A",
        producer: "Alpha",
        vintage: 2010,
        alert_snoozed_until: later,
        pricing_dismissed_until: null,
      },
      {
        id: "pricing-sooner",
        name: "Wine B",
        producer: "Zeta",
        vintage: 2011,
        alert_snoozed_until: null,
        pricing_dismissed_until: soon,
      },
    ]);

    const rows = await fetchSnoozedAlerts(supabase, RESTAURANT_ID);
    expect(rows.map((r) => r.wine_id)).toEqual(["pricing-sooner", "drink-window-later"]);
  });

  it("falls back to producer order when two snoozes expire at the same instant", async () => {
    const same = new Date(Date.now() + 1000 * 60 * 30).toISOString();
    const supabase = makeSupabase([
      {
        id: "zeta",
        name: "Wine A",
        producer: "Zeta",
        vintage: 2010,
        alert_snoozed_until: same,
        pricing_dismissed_until: null,
      },
      {
        id: "alpha",
        name: "Wine B",
        producer: "Alpha",
        vintage: 2011,
        alert_snoozed_until: same,
        pricing_dismissed_until: null,
      },
    ]);

    const rows = await fetchSnoozedAlerts(supabase, RESTAURANT_ID);
    expect(rows.map((r) => r.wine_id)).toEqual(["alpha", "zeta"]);
  });
});
