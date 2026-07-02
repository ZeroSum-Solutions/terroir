import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schema = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/schema.snapshot.sql",
  ),
  "utf8",
);

describe("database security contracts", () => {
  it("keeps public wine-list read policies explicit and narrow", () => {
    for (const table of [
      "wine_lists",
      "wine_list_sections",
      "wine_list_items",
      "wines",
      "restaurants",
    ]) {
      expect(schema).toContain(
        `alter table public.${table} enable row level security;`,
      );
    }

    expect(schema).toContain('create policy "published wine lists are public"');
    expect(schema).toContain('create policy "published list sections are public"');
    expect(schema).toContain('create policy "published list items are public"');
    expect(schema).toContain('create policy "public can read wines in published lists"');
    expect(schema).toContain('create policy "public can read restaurants with published lists"');
  });

  it("keeps transactional pour and reconcile writes behind role-checked RPCs", () => {
    expect(schema).toMatch(
      /create or replace function public\.record_pour\([\s\S]*?security definer[\s\S]*?is_member_with_role\(v_restaurant_id, 'staff'\)/,
    );
    expect(schema).toMatch(
      /create or replace function public\.undo_last_pour\([\s\S]*?security definer[\s\S]*?is_member_with_role\(v_restaurant_id, 'staff'\)/,
    );
    expect(schema).toMatch(
      /create or replace function public\.reconcile_open_bottles_batch\([\s\S]*?security definer[\s\S]*?is_member_with_role\(v_restaurant_id, 'manager'\)/,
    );
  });

  it("keeps direct read policies for pour state separate from write RPCs", () => {
    expect(schema).toContain('create policy "members can read open_bottles"');
    expect(schema).toContain('create policy "members can read pour_events"');
    expect(schema).not.toContain('create policy "members can insert pour_events"');
    expect(schema).not.toContain('create policy "members can update open_bottles"');
  });

  it("keeps retryable job records scoped by restaurant membership", () => {
    expect(schema).toContain("create table public.background_jobs");
    expect(schema).toContain(
      "job_type in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf')",
    );
    expect(schema).toContain(
      "status in ('queued', 'processing', 'retrying', 'succeeded', 'failed', 'cancelled')",
    );
    expect(schema).toContain('create policy "members can read background jobs"');
    expect(schema).toContain('create policy "members can create own background jobs"');
    expect(schema).not.toContain('create policy "members can update background jobs"');
    expect(schema).not.toContain('create policy "members can delete background jobs"');
  });
});
