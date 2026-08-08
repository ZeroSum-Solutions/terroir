import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/0080_audited_cellar_quantity_adjustments.sql",
  "utf8",
);
const down = readFileSync(
  "supabase/migrations/down/0080_audited_cellar_quantity_adjustments.down.sql",
  "utf8",
);

describe("audited cellar quantity adjustment migration", () => {
  it("keeps authorization, tenant locking, inventory mutation, and audit insertion in one function", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("auth.uid()");
    expect(migration).toContain("is_member_with_role(p_restaurant_id, 'manager')");
    expect(migration).toContain("where id = p_wine_id and restaurant_id = p_restaurant_id");
    expect(migration).toContain("where wine_id = p_wine_id and restaurant_id = p_restaurant_id");
    expect(migration).toContain("for update");
    expect(migration).toContain("'adjustment', p_quantity - v_current, v_user_id, p_reason");
  });

  it("requires a bounded reason, forbids negative quantities, and records no no-op event", () => {
    expect(migration).toContain("p_quantity not between 0 and 100000");
    expect(migration).toContain("char_length(p_reason) not between 1 and 500");
    expect(migration).toContain("if p_quantity <> v_current then");
  });

  it("atomically claims and completes the exact idempotency identity", () => {
    expect(migration).toContain("api:PATCH:/api/cellar/{param}/quantity");
    expect(migration).toContain("claim_api_idempotency");
    expect(migration).toContain("complete_api_idempotency");
    expect(migration).toContain("request hash does not match the canonical quantity adjustment identity");
  });

  it("provides a fail-closed reverse migration that preserves existing audit history", () => {
    expect(down).toContain("where direction = 'adjustment'");
    expect(down).toContain("cannot reverse 0080 while quantity adjustment audit events exist");
    expect(down).toContain("drop function if exists public.adjust_cellar_quantity_idempotent");
  });
});
