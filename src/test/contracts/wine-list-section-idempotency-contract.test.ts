import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/0068_reorder_wine_list_sections.sql",
  ),
  "utf8",
).toLowerCase();

describe("wine-list section transactional contracts", () => {
  it("shares one parent lock across atomic create and reorder", () => {
    expect(migration).toContain(
      "create or replace function public.create_wine_list_section",
    );
    expect(migration).toContain(
      "create or replace function public.reorder_wine_list_sections",
    );
    expect(migration).toContain("security invoker");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain(
      "public.is_member_with_role(v_restaurant_id, 'manager')",
    );
    expect(migration).toContain(
      "public.is_member_with_role(p_restaurant_id, 'manager')",
    );
    expect(migration).toMatch(
      /create_wine_list_section[\s\S]*?from public\.wine_lists[\s\S]*?for update[\s\S]*?max\(section\.position\)[\s\S]*?insert into public\.wine_list_sections/,
    );
    expect(migration).toMatch(
      /reorder_wine_list_sections[\s\S]*?for update of list[\s\S]*?order by section\.id[\s\S]*?for update[\s\S]*?update public\.wine_list_sections/,
    );
    expect(migration).toContain("order by section.id");
    expect(migration).toContain("for update");
    expect(migration).toContain(
      "ordered section ids must include the complete wine list",
    );
    expect(migration).toContain(
      "from unnest(p_ordered_ids) with ordinality",
    );
    expect(
      migration.match(/update public\.wine_list_sections/g),
    ).toHaveLength(1);
    expect(migration).toContain(
      "grant execute on function public.reorder_wine_list_sections(uuid[])",
    );
    expect(migration).toContain(
      "grant execute on function public.create_wine_list_section",
    );
    expect(migration).not.toMatch(
      /errcode = '(?:P0001|22023|40001|42501)'/,
    );
    expect(migration).not.toMatch(/^\s*commit\s*;/mi);
  });
});
