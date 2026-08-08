import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/0082_bottle_scan_inventory_provenance.sql",
  "utf8",
);
const down = readFileSync(
  "supabase/migrations/down/0082_bottle_scan_inventory_provenance.down.sql",
  "utf8",
);
const acceptance = readFileSync(
  "supabase/tests/0082_bottle_scan_provenance.sql",
  "utf8",
);

describe("bottle scan inventory provenance migration", () => {
  it("keeps scanned-bottle insertion inside the hardened atomic confirmation RPC", () => {
    expect(migration).toContain(
      "create or replace function public.confirm_bottle_scan_idempotent(",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain(
      "is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(migration).toContain("insert into public.inventory_items");
    expect(migration).toContain("'bottle_scan'::public.added_via");
    expect(migration).not.toMatch(/\n\s*'manual'\s*\n\s*\)/);
  });

  it("restores the prior provenance behavior when reversed", () => {
    expect(down).toContain(
      "create or replace function public.confirm_bottle_scan_idempotent(",
    );
    expect(down).toMatch(/\n\s*'manual'\s*\n\s*\)/);
    expect(down).not.toContain("'bottle_scan'::public.added_via");
  });

  it("locks the created row's quantity, cost, location, and provenance in live SQL acceptance", () => {
    expect(acceptance).toContain("v_item.quantity <> 1");
    expect(acceptance).toContain("v_item.unit_cost <> 0");
    expect(acceptance).toContain("v_item.section <> 'Reserve'");
    expect(acceptance).toContain("v_item.bin_location <> 'R-82'");
    expect(acceptance).toContain(
      "v_item.added_via <> 'bottle_scan'::public.added_via",
    );
    expect(acceptance).toContain("rollback;");
  });
});
