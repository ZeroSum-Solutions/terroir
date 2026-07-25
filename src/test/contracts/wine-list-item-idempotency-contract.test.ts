import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const atomicCreate = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/0064_create_wine_list_item_idempotency.sql",
  ),
  "utf8",
).toLowerCase();
const atomicReorder = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/0013_reorder_wine_list_items_rpc.sql",
  ),
  "utf8",
).toLowerCase();

describe("wine-list item transactional idempotency contracts", () => {
  it("keeps create, response completion, and position allocation atomic", () => {
    expect(atomicCreate).toContain(
      "create or replace function public.create_wine_list_item_idempotent",
    );
    expect(atomicCreate).toContain("security definer");
    expect(atomicCreate).toContain("set search_path = ''");
    expect(atomicCreate).toContain(
      "public.is_member_with_role(p_restaurant_id, 'manager')",
    );
    expect(atomicCreate).toContain(
      "list.restaurant_id = p_restaurant_id",
    );
    expect(atomicCreate).toContain(
      "wine.restaurant_id = p_restaurant_id",
    );
    expect(atomicCreate).toContain("for update of section");
    expect(atomicCreate).toMatch(
      /for update of section;[\s\S]*?max\(item\.position\)[\s\S]*?insert into public\.wine_list_items[\s\S]*?update public\.api_idempotency[\s\S]*?state = 'completed'/,
    );
    expect(atomicCreate).toContain(
      "message = 'idempotency completion changed concurrently'",
    );
    expect(atomicCreate).not.toMatch(/^\s*execute\s/mi);
    expect(atomicCreate).not.toContain("set role");
  });

  it("keeps reorder one transactional and convergent update", () => {
    expect(atomicReorder).toContain("security invoker");
    expect(atomicReorder).toContain(
      "update public.wine_list_items",
    );
    expect(atomicReorder).toContain(
      "from unnest(p_ordered_ids) with ordinality",
    );
    expect(
      atomicReorder.match(/update public\.wine_list_items/g),
    ).toHaveLength(1);
    expect(atomicReorder).not.toMatch(/^\s*commit\s*;/mi);
  });
});
