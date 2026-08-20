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

// Wave 0 (top-10 build): F-1 reason codes, F-2/OPP-1 vintage lineage.
// Spec: docs/evals/top10-evals.yaml (EV-F1.1, EV-F2.1, EV-1.2, EV-1.3).
describe("wave-0 lineage and reason-code contracts", () => {
  it("EV-F1.1: reason_codes exist, are seeded on signup, and are backfilled", () => {
    expect(schema).toContain("create table public.reason_codes");
    expect(schema).toContain(
      "category in ('comp', 'spill', 'training', 'spoilage', 'adjustment', 'other')",
    );
    // One code namespace per restaurant.
    expect(schema).toMatch(
      /create unique index reason_codes_restaurant_code_idx\s+on public\.reason_codes \(restaurant_id, code\)/,
    );
    expect(schema).toContain('create policy "members can read reason_codes"');
    // Seeding: a dedicated function, called from the signup trigger, plus a
    // one-time backfill for restaurants that existed before this migration.
    expect(schema).toMatch(
      /create or replace function public\.seed_reason_codes\(p_restaurant_id uuid\)/,
    );
    expect(schema).toContain("perform public.seed_reason_codes(new_restaurant_id);");
    expect(schema).toContain("-- Backfill: seed reason codes for existing restaurants");
  });

  it("EV-F2.1: wine_lineages exist with one identity per key, and wines carry lineage_id", () => {
    expect(schema).toContain("create table public.wine_lineages");
    // LWIN7-keyed lineages and name-keyed lineages are each unique per restaurant.
    expect(schema).toMatch(
      /create unique index wine_lineages_lwin7_idx\s+on public\.wine_lineages \(restaurant_id, lwin7\)\s+where lwin7 is not null/,
    );
    expect(schema).toMatch(
      /create unique index wine_lineages_name_idx\s+on public\.wine_lineages \(restaurant_id, producer_norm, cuvee_norm\)\s+where lwin7 is null/,
    );
    expect(schema).toMatch(
      /alter table public\.wines\s+add column lineage_id uuid references public\.wine_lineages\(id\) on delete set null/,
    );
    // Derivation is a trigger so every creation path (cellar add, scan commit,
    // create-from-lwin) gets a lineage without app-side coordination.
    expect(schema).toMatch(
      /create trigger wines_derive_lineage\s+before insert or update of lwin_id, producer, name\s+on public\.wines/,
    );
  });

  it("EV-1.3: merge_wines is a role-checked RPC that refuses cross-vintage merges", () => {
    expect(schema).toMatch(
      /create or replace function public\.merge_wines\([\s\S]*?security definer[\s\S]*?is_member_with_role\(v_restaurant_id, 'manager'\)/,
    );
    // The vintage/format/lineage guards live in the RPC itself — the UI hiding
    // the button is not the enforcement layer.
    expect(schema).toContain("cross_vintage_merge");
    expect(schema).toContain("format_mismatch_merge");
    expect(schema).toContain("lineage_mismatch_merge");
  });

  it("wave-0 verify fixes stay in place (0055/0056)", () => {
    // V1 — the actual upgrade statement, not its comment: a name-keyed
    // lineage is claimed in place when LWIN arrives.
    expect(schema).toMatch(
      /update public\.wine_lineages\s+set lwin7 = v_lwin7\s+where restaurant_id = new\.restaurant_id\s+and lwin7 is null/,
    );
    // V2 — the actual dedupe DELETE before the list repoint.
    expect(schema).toMatch(
      /delete from public\.wine_list_items s\s+where s\.wine_id = p_source_wine_id\s+and exists/,
    );
    expect(schema).toContain("'deduped_wine_list_items',   v_deduped_list_items");
    // V6 — seeding is infrastructure, not a client-callable RPC.
    expect(schema).toMatch(
      /revoke execute on function public\.seed_reason_codes\(uuid\)\s+from public, anon, authenticated/,
    );
    // S3 — lineage_id is derivation-owned: the trigger watches it, so a
    // client-supplied value is always recomputed.
    expect(schema).toMatch(
      /before insert or update of lwin_id, producer, name, lineage_id\s+on public\.wines/,
    );
    // S1 — per-identity advisory lock serializes cross-path derivation.
    expect(schema).toContain("pg_advisory_xact_lock");
  });
});

describe("wave-2 health, reconcile, and close-out contracts", () => {

  it("EV-2.1/2.4: cellar_health partitions segments; thresholds live on cellar_config", () => {
    expect(schema).toContain(
      "segment in ('window_risk', 'hold', 'dead_stock', 'cash_trap', 'healthy')",
    );
    expect(schema).toContain("unique (restaurant_id, wine_id)");
    expect(schema).toContain("health_dead_stock_days");
    expect(schema).toContain("health_cash_trap_floor");
    expect(schema).toContain("health_appreciation_threshold");
    expect(schema).toContain(
      "job_type in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf', 'cellar_health')",
    );
    expect(schema).toContain(
      "revoke insert, update, delete on public.cellar_health from authenticated, anon;",
    );
  });

  it("EV-5.4: reconcile actions snapshot prior/new state and are immutable", () => {
    expect(schema).toContain("create table public.reconcile_batches");
    expect(schema).toContain("prior_state    jsonb       not null");
    expect(schema).toContain("new_state      jsonb       not null");
    expect(schema).toContain(
      "revoke update, delete on public.reconcile_actions from authenticated;",
    );
  });

  it("EV-10.1/10.2: preservation method on open_bottles; write-off requires a reason code", () => {
    expect(schema).toContain(
      "preservation_method in ('coravin', 'argon', 'vacuum', 'none')",
    );
    expect(schema).toContain(
      "written_off_ml = 0 or reason_code_id is not null",
    );
    expect(schema).toContain(
      "(actual_remaining_ml - theoretical_remaining_ml) stored",
    );
    expect(schema).toContain(
      "revoke update, delete on public.bottle_closeouts from authenticated;",
    );
  });
});
