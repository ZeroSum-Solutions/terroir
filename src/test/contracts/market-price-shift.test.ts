import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/0085_market_price_shift_observations.sql",
  "utf8",
);
const down = readFileSync(
  "supabase/migrations/down/0085_market_price_shift_observations.down.sql",
  "utf8",
);
const acceptance = readFileSync(
  "supabase/tests/0085_market_price_shift_observations.sql",
  "utf8",
);

describe("market price shift observations", () => {
  it("retains the immediately previous market median and observation time", () => {
    expect(migration).toContain("retail_previous_median numeric(10,2)");
    expect(migration).toContain("retail_previous_refreshed_at timestamptz");
    expect(migration).toContain("before update of retail_median on public.wines");
    expect(migration).toContain("new.retail_previous_median := old.retail_median");
    expect(migration).toContain(
      "new.retail_previous_refreshed_at := old.retail_refreshed_at",
    );
    expect(migration).toContain(
      "new.retail_median is distinct from old.retail_median",
    );
  });

  it("does not broaden wine table privileges or bypass existing RLS", () => {
    expect(migration).not.toMatch(/security\s+definer/i);
    expect(migration).not.toMatch(/grant\s+/i);
    expect(migration).not.toMatch(/disable\s+row\s+level\s+security/i);
  });

  it("reverses only the trigger, function, and added observation columns", () => {
    expect(down).toContain(
      "drop trigger if exists wines_capture_previous_retail_median on public.wines",
    );
    expect(down).toContain(
      "drop function if exists public.capture_previous_retail_median()",
    );
    expect(down).toContain("drop column if exists retail_previous_median");
    expect(down).toContain("drop column if exists retail_previous_refreshed_at");
  });

  it("proves first observation, changed observation, unchanged refresh, and rollback", () => {
    expect(acceptance).toContain("first observation unexpectedly has a previous median");
    expect(acceptance).toContain("changed observation did not retain the prior median");
    expect(acceptance).toContain("unchanged observation replaced the prior median");
    expect(acceptance).toContain("rollback;");
  });
});
