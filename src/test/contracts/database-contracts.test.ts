import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const schema = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/schema.snapshot.sql",
  ),
  "utf8",
);

const tenantHardening = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0054_tenant_rpc_hardening.sql",
  ),
  "utf8",
);

const apiRateLimits = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0055_api_rate_limits.sql",
  ),
  "utf8",
);

const apiIdempotency = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0056_api_idempotency.sql",
  ),
  "utf8",
);

const atomicIdempotentCommands = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0057_atomic_idempotent_commands.sql",
  ),
  "utf8",
);

const atomicOpenBottleIdempotency = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0058_open_bottle_idempotency.sql",
  ),
  "utf8",
);

const atomicCloseBottleIdempotency = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0059_close_open_bottle_idempotency.sql",
  ),
  "utf8",
);

const atomicRecordPourIdempotency = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0060_record_pour_idempotency.sql",
  ),
  "utf8",
);

const atomicUndoLastPourIdempotency = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0061_undo_last_pour_idempotency.sql",
  ),
  "utf8",
);

const atomicReconcileIdempotency = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0062_reconcile_idempotency.sql",
  ),
  "utf8",
);

const atomicTeamMemberIdempotency = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0063_team_member_idempotency.sql",
  ),
  "utf8",
);

const atomicInvoiceScanCommitIdempotency = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0065_invoice_scan_commit_idempotency.sql",
  ),
  "utf8",
);

const atomicInvoiceScanCommitAcceptance = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/tests/0065_invoice_scan_commit_idempotency.sql",
  ),
  "utf8",
);

const atomicBottleConfirmationIdempotency = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0066_confirm_bottle_scan_idempotency.sql",
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
    for (const signature of [
      "record_pour(\n  p_restaurant_id uuid,",
      "undo_last_pour(\n  p_restaurant_id uuid,",
      "reconcile_open_bottle(\n  p_restaurant_id",
      "reconcile_open_bottles_batch(\n  p_restaurant_id",
    ]) {
      expect(tenantHardening).toContain(signature);
    }

    expect(tenantHardening).toMatch(
      /record_pour\([\s\S]*?is_member_with_role\(p_restaurant_id, 'staff'\)[\s\S]*?where id = p_wine_id[\s\S]*?and restaurant_id = p_restaurant_id/,
    );
    expect(tenantHardening).toMatch(
      /undo_last_pour\([\s\S]*?is_member_with_role\(p_restaurant_id, 'staff'\)[\s\S]*?where id = p_wine_id[\s\S]*?and restaurant_id = p_restaurant_id/,
    );
    expect(tenantHardening).toMatch(
      /reconcile_open_bottle\([\s\S]*?is_member_with_role\(p_restaurant_id, 'manager'\)[\s\S]*?where id = p_wine_id[\s\S]*?and restaurant_id = p_restaurant_id/,
    );
  });

  it("atomically binds ordered reconcile batches to database-verified hashes", () => {
    expect(atomicReconcileIdempotency).toContain(
      "create or replace function public.reconcile_open_bottles_idempotent(",
    );
    expect(atomicReconcileIdempotency).toContain("security definer");
    expect(atomicReconcileIdempotency).toContain("set search_path = ''");
    expect(atomicReconcileIdempotency).toContain(
      "is_member_with_role(p_restaurant_id, 'manager')",
    );
    expect(atomicReconcileIdempotency).toContain(
      "from jsonb_array_elements(p_entries)",
    );
    expect(atomicReconcileIdempotency).toContain(
      "extensions.digest(",
    );
    expect(atomicReconcileIdempotency).toContain(
      "p_request_hash <> v_computed_hash",
    );
    expect(atomicReconcileIdempotency).toContain(
      "v_updated := public.reconcile_open_bottles_batch(",
    );
    expect(atomicReconcileIdempotency).toContain(
      "set state = 'completed'",
    );
    expect(atomicReconcileIdempotency.indexOf(
      "v_updated := public.reconcile_open_bottles_batch(",
    )).toBeLessThan(
      atomicReconcileIdempotency.indexOf("set state = 'completed'"),
    );
    expect(atomicReconcileIdempotency).not.toMatch(/\n\s*execute\s+/i);
    expect(atomicReconcileIdempotency).not.toMatch(/\n\s*set\s+role\s+/i);
  });

  it("atomically binds bottle confirmation to a database-verified identity", () => {
    expect(atomicBottleConfirmationIdempotency).toContain(
      "create or replace function public.confirm_bottle_scan_idempotent(",
    );
    expect(atomicBottleConfirmationIdempotency).toContain(
      "security definer",
    );
    expect(atomicBottleConfirmationIdempotency).toContain(
      "set search_path = ''",
    );
    expect(atomicBottleConfirmationIdempotency).toContain(
      "is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(atomicBottleConfirmationIdempotency).toContain(
      "p_request_hash <> v_computed_hash",
    );
    expect(atomicBottleConfirmationIdempotency).toContain(
      "insert into public.inventory_items",
    );
    expect(atomicBottleConfirmationIdempotency).toContain(
      "set state = 'completed'",
    );
    expect(
      atomicBottleConfirmationIdempotency.indexOf(
        "insert into public.inventory_items",
      ),
    ).toBeLessThan(
      atomicBottleConfirmationIdempotency.indexOf(
        "set state = 'completed'",
      ),
    );
    expect(atomicBottleConfirmationIdempotency).toContain(
      "wines.restaurant_id = p_restaurant_id",
    );
    expect(atomicBottleConfirmationIdempotency).not.toMatch(
      /\n\s*execute\s+/i,
    );
    expect(atomicBottleConfirmationIdempotency).not.toMatch(
      /\n\s*set\s+role\s+/i,
    );
  });

  it("removes legacy tenant-implicit RPC overloads and public execution", () => {
    for (const legacySignature of [
      "record_pour(uuid, int, text, text)",
      "undo_last_pour(uuid)",
      "reconcile_open_bottle(uuid, int, text)",
      "reconcile_open_bottles_batch(jsonb)",
      "match_lwin_batch(uuid[])",
    ]) {
      expect(tenantHardening).toContain(
        `revoke all on function public.${legacySignature}`,
      );
      expect(tenantHardening).toContain(
        `drop function public.${legacySignature}`,
      );
    }

    for (const signature of [
      "record_pour(uuid, uuid, int, text, text)",
      "undo_last_pour(uuid, uuid)",
      "reconcile_open_bottle(uuid, uuid, int, text)",
      "reconcile_open_bottles_batch(uuid, jsonb)",
      "find_or_create_wine(uuid, text, text, int, text, text, text, int)",
      "find_or_create_wines_batch(uuid, jsonb)",
      "match_lwin_batch(uuid, uuid[])",
      "list_open_bottle_items(uuid)",
      "wine_published_list_slugs(uuid, uuid)",
    ]) {
      expect(tenantHardening).toContain(
        `revoke all on function public.${signature} from public;`,
      );
    }

    expect(tenantHardening).toContain(
      "alter function public.list_open_bottle_items(uuid)\n  set search_path = '';",
    );
    expect(tenantHardening).toContain(
      "alter function public.wine_published_list_slugs(uuid, uuid)\n  set search_path = '';",
    );
  });

  it("keeps definer wine mutations membership-checked and tenant-scoped", () => {
    expect(tenantHardening).not.toContain("set search_path = public");
    expect(
      tenantHardening.match(/security definer/g)?.length,
    ).toBeLessThanOrEqual(
      tenantHardening.match(/set search_path = ''/g)?.length ?? 0,
    );

    expect(tenantHardening).toMatch(
      /find_or_create_wine\([\s\S]*?is_member_with_role\(p_restaurant_id, 'staff'\)/,
    );
    expect(tenantHardening).toMatch(
      /find_or_create_wines_batch\([\s\S]*?is_member_with_role\(p_restaurant_id, 'staff'\)/,
    );
    expect(tenantHardening).toMatch(
      /match_lwin_batch\([\s\S]*?is_member_with_role\(p_restaurant_id, 'staff'\)[\s\S]*?wines\.restaurant_id = p_restaurant_id/,
    );
  });

  it("preflights and enforces same-tenant relational invariants", () => {
    expect(tenantHardening).toContain("tenant_hardening_preflight_failed:");

    for (const constraint of [
      "inventory_items_wine_tenant_fkey",
      "inventory_items_scan_tenant_fkey",
      "availability_events_wine_tenant_fkey",
      "open_bottles_wine_tenant_fkey",
      "open_bottles_source_inventory_tenant_fkey",
      "pour_events_wine_tenant_fkey",
      "pour_events_open_bottle_tenant_fkey",
    ]) {
      expect(tenantHardening).toContain(`constraint ${constraint}`);
    }

    for (const replacedConstraint of [
      "inventory_items_wine_id_fkey",
      "inventory_items_invoice_scan_id_fkey",
      "availability_events_wine_id_fkey",
      "open_bottles_wine_id_fkey",
      "open_bottles_source_inventory_item_id_fkey",
      "pour_events_wine_id_fkey",
      "pour_events_open_bottle_id_fkey",
    ]) {
      expect(tenantHardening).toContain(
        `drop constraint ${replacedConstraint}`,
      );
    }

    expect(tenantHardening).toContain(
      "create trigger wine_list_items_enforce_tenant",
    );
    expect(tenantHardening).toContain(
      "execute function public.assert_wine_list_item_tenant()",
    );
    expect(tenantHardening).toContain(
      "create trigger wine_list_sections_parent_key_immutable",
    );
  });

  it("makes tenant ownership keys immutable", () => {
    expect(tenantHardening).toContain(
      "create or replace function public.prevent_tenant_key_update()",
    );

    for (const table of [
      "memberships",
      "invitations",
      "wines",
      "invoice_scans",
      "inventory_items",
      "wine_lists",
      "cellar_config",
      "scan_idempotency",
      "availability_events",
      "open_bottles",
      "pour_events",
      "background_jobs",
    ]) {
      expect(tenantHardening).toContain(
        `create trigger ${table}_tenant_key_immutable`,
      );
    }
  });

  it("lets owners and managers manage invitations while staff stays denied", () => {
    expect(tenantHardening).toContain(
      'drop policy "owners can manage invitations" on public.invitations;',
    );
    expect(tenantHardening).toContain(
      'drop policy "managers can read invitations" on public.invitations;',
    );
    expect(tenantHardening).toMatch(
      /create policy "owners and managers can manage invitations"[\s\S]*?for all to authenticated[\s\S]*?using \(public\.is_member_with_role\(restaurant_id, 'manager'\)\)[\s\S]*?with check \(public\.is_member_with_role\(restaurant_id, 'manager'\)\)/,
    );
  });

  it("keeps direct read policies for pour state separate from write RPCs", () => {
    expect(schema).toContain('create policy "members can read open_bottles"');
    expect(schema).toContain('create policy "members can read pour_events"');
    expect(schema).not.toContain('create policy "members can insert pour_events"');
    expect(schema).not.toContain('create policy "members can update open_bottles"');
  });

  it("passes the active restaurant to every tenant-sensitive RPC call site", () => {
    const sensitiveRpcs = new Set([
      "record_pour",
      "undo_last_pour",
      "reconcile_open_bottle",
      "reconcile_open_bottles_batch",
      "match_lwin_batch",
      "close_open_bottle_idempotent",
    ]);
    const calls = collectProductionRpcCalls(
      resolve(process.cwd(), "src"),
      sensitiveRpcs,
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(
        call.argumentNames,
        `${call.file}:${call.line} ${call.rpc}`,
      ).toContain("p_restaurant_id");
    }
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

  it("keeps API rate limits server-owned and inaccessible to clients", () => {
    expect(apiRateLimits).toContain(
      "v_user_id uuid := auth.uid();",
    );
    expect(apiRateLimits).toContain(
      "security definer\nset search_path = ''",
    );
    expect(apiRateLimits).toContain(
      "revoke all on table public.api_rate_limit_buckets from authenticated;",
    );
    expect(apiRateLimits).toContain(
      "revoke all on function public.consume_api_rate_limit(text) from anon;",
    );
    expect(apiRateLimits).toContain(
      "grant execute on function public.consume_api_rate_limit(text) to authenticated;",
    );
    expect(apiRateLimits).not.toMatch(
      /consume_api_rate_limit\([\s\S]*?p_(?:limit|window|user_id)/,
    );
  });

  it("keeps API risk classes and ceilings hardcoded in the database", () => {
    for (const [riskClass, limit, windowSeconds] of [
      ["standard", 120, 60],
      ["mutation", 60, 60],
      ["expensive", 10, 60],
      ["sensitive", 10, 3600],
    ] as const) {
      expect(apiRateLimits).toMatch(
        new RegExp(
          `when '${riskClass}' then[\\s\\S]*?v_class_limit := ${limit};[\\s\\S]*?v_class_window_seconds := ${windowSeconds};`,
        ),
      );
    }

    expect(apiRateLimits).toContain(
      "v_global_limit constant integer := 600;",
    );
    expect(apiRateLimits).toContain(
      "v_global_window_seconds constant integer := 60;",
    );
    expect(apiRateLimits).toMatch(
      /v_allowed :=[\s\S]*?v_global_count <= v_global_limit[\s\S]*?and v_class_count <= v_class_limit/,
    );
  });

  it("keeps request idempotency server-owned and caller-bound", () => {
    expect(apiIdempotency).toContain(
      "primary key (user_id, idempotency_key)",
    );
    expect(apiIdempotency).toContain(
      "revoke all on table public.api_idempotency from authenticated;",
    );
    expect(apiIdempotency).toContain(
      "v_user_id uuid := auth.uid();",
    );
    expect(apiIdempotency).toMatch(
      /v_claim\.restaurant_id <> p_restaurant_id[\s\S]*?v_claim\.operation_id <> p_operation_id[\s\S]*?v_claim\.request_hash <> p_request_hash[\s\S]*?'mismatch'/,
    );
    expect(apiIdempotency).toMatch(
      /from public\.memberships[\s\S]*?memberships\.restaurant_id = p_restaurant_id[\s\S]*?memberships\.user_id = v_user_id/,
    );
  });

  it("keeps every idempotency transition behind a hardened RPC", () => {
    for (const signature of [
      "claim_api_idempotency(\n  uuid,\n  text,\n  text,\n  text\n)",
      "complete_api_idempotency(\n  uuid,\n  text,\n  text,\n  text,\n  integer,\n  jsonb,\n  jsonb\n)",
      "fail_api_idempotency(\n  uuid,\n  text,\n  text,\n  text\n)",
      "release_api_idempotency(\n  uuid,\n  text,\n  text,\n  text\n)",
    ]) {
      expect(apiIdempotency).toContain(
        `revoke all on function public.${signature} from anon;`,
      );
      expect(apiIdempotency).toContain(
        `grant execute on function public.${signature} to authenticated;`,
      );
    }

    expect(
      apiIdempotency.match(/security definer/g)?.length,
    ).toBeLessThanOrEqual(
      apiIdempotency.match(/set search_path = ''/g)?.length ?? 0,
    );
    expect(apiIdempotency).toContain(
      "grant execute on function public.cleanup_api_idempotency()\n  to service_role;",
    );
    expect(apiIdempotency).toContain(
      "revoke all on function public.cleanup_api_idempotency()\n  from authenticated;",
    );
  });

  it("retains ambiguous and expired idempotency outcomes safely", () => {
    expect(apiIdempotency).toContain(
      "state in ('in_progress', 'completed', 'failed_unknown')",
    );
    expect(apiIdempotency).toMatch(
      /v_claim\.updated_at < clock_timestamp\(\) - interval '24 hours'[\s\S]*?'expired'/,
    );
    expect(apiIdempotency).toMatch(
      /v_claim\.state = 'failed_unknown'[\s\S]*?'outcome_unknown'/,
    );
    expect(apiIdempotency).toContain(
      "where updated_at < clock_timestamp() - interval '25 hours';",
    );
  });

  it("opens sealed inventory and bottle state in one tenant-checked RPC", () => {
    expect(atomicIdempotentCommands).toMatch(
      /open_bottle_from_inventory\([\s\S]*?security definer[\s\S]*?set search_path = ''/,
    );
    expect(atomicIdempotentCommands).toContain(
      "public.is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(atomicIdempotentCommands).toMatch(
      /from public\.open_bottles[\s\S]*?for update;[\s\S]*?from public\.inventory_items[\s\S]*?order by inventory_items\.added_at, inventory_items\.id[\s\S]*?for update;/,
    );
    expect(atomicIdempotentCommands).toContain(
      "source_inventory_item_id = excluded.source_inventory_item_id",
    );
    expect(atomicIdempotentCommands).toContain(
      "on conflict on constraint open_bottles_wine_id_restaurant_id_key",
    );
    expect(atomicIdempotentCommands).toContain(
      "revoke all on function public.open_bottle_from_inventory(uuid, uuid)\n  from anon;",
    );
  });

  it("commits open-bottle responses in the same transaction as inventory", () => {
    expect(atomicOpenBottleIdempotency).toMatch(
      /open_bottle_from_inventory_idempotent\([\s\S]*?security definer[\s\S]*?set search_path = ''/,
    );
    expect(atomicOpenBottleIdempotency).toContain(
      "public.is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(atomicOpenBottleIdempotency).toMatch(
      /pg_advisory_xact_lock\([\s\S]*?insert into public\.api_idempotency[\s\S]*?from public\.open_bottle_from_inventory\([\s\S]*?update public\.api_idempotency[\s\S]*?state = 'completed'/,
    );
    expect(atomicOpenBottleIdempotency).toContain(
      "message = 'idempotency completion changed concurrently'",
    );
    expect(atomicOpenBottleIdempotency).toContain(
      "v_claim.restaurant_id <> p_restaurant_id",
    );
    expect(atomicOpenBottleIdempotency).toContain(
      "revoke all on function public.open_bottle_from_inventory_idempotent(\n  uuid,\n  uuid,\n  text,\n  text\n) from anon;",
    );
    expect(atomicOpenBottleIdempotency).toContain(
      "grant execute on function public.open_bottle_from_inventory_idempotent(\n  uuid,\n  uuid,\n  text,\n  text\n) to authenticated;",
    );
  });

  it("commits exact-generation bottle closes with their stored response", () => {
    expect(atomicCloseBottleIdempotency).toMatch(
      /close_open_bottle_idempotent\([\s\S]*?security definer[\s\S]*?set search_path = ''/,
    );
    expect(atomicCloseBottleIdempotency).toContain(
      "public.is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(atomicCloseBottleIdempotency).toMatch(
      /from public\.wines[\s\S]*?for update;[\s\S]*?from public\.open_bottles[\s\S]*?for update;/,
    );
    expect(atomicCloseBottleIdempotency).toMatch(
      /v_bottle\.opened_at <> p_expected_opened_at[\s\S]*?v_bottle\.closed_at is not null/,
    );
    expect(atomicCloseBottleIdempotency).toMatch(
      /insert into public\.pour_events[\s\S]*?v_bottle\.remaining_ml[\s\S]*?'spill'[\s\S]*?v_user_id[\s\S]*?'Bottle closed \(discard remaining\)'[\s\S]*?v_bottle\.id/,
    );
    expect(atomicCloseBottleIdempotency).toMatch(
      /pg_advisory_xact_lock\([\s\S]*?insert into public\.api_idempotency[\s\S]*?insert into public\.pour_events[\s\S]*?update public\.api_idempotency[\s\S]*?state = 'completed'/,
    );
    expect(atomicCloseBottleIdempotency).toContain(
      "'api:POST:/api/open-bottles/{param}/close'",
    );
    expect(atomicCloseBottleIdempotency).toContain(
      "revoke all on function public.close_open_bottle_idempotent(\n  uuid,\n  uuid,\n  timestamptz,\n  text,\n  text\n) from anon;",
    );
    expect(atomicCloseBottleIdempotency).toContain(
      "grant execute on function public.close_open_bottle_idempotent(\n  uuid,\n  uuid,\n  timestamptz,\n  text,\n  text\n) to authenticated;",
    );
  });

  it("commits pour responses in the same transaction as every business effect", () => {
    expect(atomicRecordPourIdempotency).toContain(
      "create extension if not exists pgcrypto with schema extensions;",
    );
    expect(atomicRecordPourIdempotency).toMatch(
      /record_pour_idempotent\([\s\S]*?security definer[\s\S]*?set search_path = ''/,
    );
    expect(atomicRecordPourIdempotency).toContain(
      "public.is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(atomicRecordPourIdempotency).toMatch(
      /pg_advisory_xact_lock\([\s\S]*?insert into public\.api_idempotency[\s\S]*?from public\.record_pour\([\s\S]*?update public\.api_idempotency[\s\S]*?state = 'completed'/,
    );
    expect(atomicRecordPourIdempotency).not.toContain("execute format");
    expect(atomicRecordPourIdempotency).not.toContain("set local role");
    expect(atomicRecordPourIdempotency).toContain(
      "v_note text := nullif(btrim(p_note), '')",
    );
    expect(atomicRecordPourIdempotency).toContain(
      "v_started_at timestamptz := now()",
    );
    expect(atomicRecordPourIdempotency).toContain(
      "message = 'idempotency completion changed concurrently'",
    );
    expect(atomicRecordPourIdempotency).toContain(
      "v_claim.restaurant_id <> p_restaurant_id",
    );
    expect(atomicRecordPourIdempotency).toContain(
      "revoke all on function public.record_pour_idempotent(\n  uuid,\n  uuid,\n  int,\n  text,\n  text,\n  text,\n  text\n) from anon;",
    );
    expect(atomicRecordPourIdempotency).toContain(
      "grant execute on function public.record_pour_idempotent(\n  uuid,\n  uuid,\n  int,\n  text,\n  text,\n  text,\n  text\n) to authenticated;",
    );
  });

  it("commits pour-undo responses in the same transaction as the undo", () => {
    expect(atomicUndoLastPourIdempotency).toMatch(
      /undo_last_pour_idempotent\([\s\S]*?security definer[\s\S]*?set search_path = ''/,
    );
    expect(atomicUndoLastPourIdempotency).toContain(
      "public.is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(atomicUndoLastPourIdempotency).toContain(
      "create extension if not exists pgcrypto with schema extensions;",
    );
    expect(atomicUndoLastPourIdempotency).toMatch(
      /v_identity :=[\s\S]*?extensions\.digest\([\s\S]*?pg_catalog\.int8send\([\s\S]*?p_request_hash <> v_request_hash/,
    );
    expect(atomicUndoLastPourIdempotency).toMatch(
      /pg_advisory_xact_lock\([\s\S]*?insert into public\.api_idempotency[\s\S]*?from public\.undo_last_pour\([\s\S]*?update public\.api_idempotency[\s\S]*?state = 'completed'/,
    );
    expect(atomicUndoLastPourIdempotency).toContain(
      "message = 'idempotency completion changed concurrently'",
    );
    expect(atomicUndoLastPourIdempotency).toContain(
      "v_claim.restaurant_id <> p_restaurant_id",
    );
    expect(atomicUndoLastPourIdempotency).not.toMatch(/^\s*execute\s/mi);
    expect(atomicUndoLastPourIdempotency).not.toContain("set role");
    expect(atomicUndoLastPourIdempotency).toContain(
      "revoke all on function public.undo_last_pour_idempotent(\n  uuid,\n  uuid,\n  text,\n  text\n) from anon;",
    );
    expect(atomicUndoLastPourIdempotency).toContain(
      "grant execute on function public.undo_last_pour_idempotent(\n  uuid,\n  uuid,\n  text,\n  text\n) to authenticated;",
    );
  });

  it("serializes team ownership invariants with each stored response", () => {
    for (const rpc of [
      "update_team_member_role_idempotent",
      "remove_team_member_idempotent",
    ]) {
      expect(atomicTeamMemberIdempotency).toMatch(
        new RegExp(
          `${rpc}\\([\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`,
        ),
      );
      expect(atomicTeamMemberIdempotency).toContain(
        `grant execute on function public.${rpc}(`,
      );
    }
    expect(atomicTeamMemberIdempotency).toContain(
      "public.is_member_with_role(p_restaurant_id, 'owner')",
    );
    expect(atomicTeamMemberIdempotency).toMatch(
      /from public\.memberships[\s\S]*?where restaurant_id = p_restaurant_id[\s\S]*?order by id[\s\S]*?for update;/,
    );
    expect(atomicTeamMemberIdempotency).toMatch(
      /v_target\.role = 'owner'[\s\S]*?select count\(\*\)[\s\S]*?role = 'owner'[\s\S]*?<= 1/,
    );
    expect(atomicTeamMemberIdempotency).toContain(
      "v_target.user_id = v_user_id",
    );
    expect(atomicTeamMemberIdempotency).toMatch(
      /pg_advisory_xact_lock\([\s\S]*?insert into public\.api_idempotency[\s\S]*?update public\.memberships[\s\S]*?update public\.api_idempotency[\s\S]*?state = 'completed'/,
    );
    expect(atomicTeamMemberIdempotency).toMatch(
      /pg_advisory_xact_lock\([\s\S]*?insert into public\.api_idempotency[\s\S]*?delete from public\.memberships[\s\S]*?update public\.api_idempotency[\s\S]*?state = 'completed'/,
    );
    expect(atomicTeamMemberIdempotency).not.toMatch(/^\s*execute\s/mi);
    expect(atomicTeamMemberIdempotency).not.toMatch(
      /^\s*set\s+(?:local\s+)?role\s+(?!=)/mi,
    );
    expect(atomicTeamMemberIdempotency).toContain(
      "message = 'idempotency completion changed concurrently'",
    );
  });

  it("commits invoice inventory and the exact response atomically", () => {
    expect(atomicInvoiceScanCommitIdempotency).toMatch(
      /commit_invoice_scan_idempotent\([\s\S]*?security definer[\s\S]*?set search_path = ''/,
    );
    expect(atomicInvoiceScanCommitIdempotency).toContain(
      "public.is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(atomicInvoiceScanCommitIdempotency).toMatch(
      /v_identity :=[\s\S]*?extensions\.digest\([\s\S]*?p_request_hash is null or p_request_hash <> v_computed_hash/,
    );
    expect(atomicInvoiceScanCommitIdempotency).toMatch(
      /from public\.claim_api_idempotency\([\s\S]*?from public\.invoice_scans[\s\S]*?for update;[\s\S]*?public\.find_or_create_wines_batch\([\s\S]*?insert into public\.inventory_items[\s\S]*?public\.complete_api_idempotency\(/,
    );
    expect(atomicInvoiceScanCommitIdempotency).toContain(
      "'api:POST:/api/scans/{param}/commit'",
    );
    expect(atomicInvoiceScanCommitIdempotency).toContain(
      "message = 'idempotency completion changed concurrently'",
    );
    expect(atomicInvoiceScanCommitIdempotency).not.toMatch(
      /^\s*execute\s/mi,
    );
    expect(atomicInvoiceScanCommitIdempotency).not.toMatch(
      /^\s*set\s+(?:local\s+)?role\s+(?!=)/mi,
    );
    expect(atomicInvoiceScanCommitIdempotency).toContain(
      "grant execute on function public.commit_invoice_scan_idempotent(",
    );
    expect(atomicInvoiceScanCommitAcceptance).toContain(
      createIdempotencyRequestHash({
        id: "64100000-0000-4000-8000-000000000001",
      }),
    );
  });

  it("accepts invitations without trusting caller-supplied identity or tenant data", () => {
    expect(atomicIdempotentCommands).toContain(
      "atomic_invitation_preflight_failed:",
    );
    expect(atomicIdempotentCommands).toContain(
      "constraint invitations_invitable_role_check",
    );
    expect(atomicIdempotentCommands).toMatch(
      /accept_invitation_idempotent\([\s\S]*?v_user_id uuid := auth\.uid\(\)[\s\S]*?from auth\.users[\s\S]*?lower\(btrim\(invitations\.email\)\) = v_user_email/,
    );
    expect(atomicIdempotentCommands).toMatch(
      /insert into public\.memberships[\s\S]*?on conflict \(user_id, restaurant_id\) do nothing;[\s\S]*?update public\.invitations[\s\S]*?accepted_at is null;/,
    );
    expect(atomicIdempotentCommands).toContain(
      "'api:POST:/api/team/accept-invite'",
    );
    expect(atomicIdempotentCommands).toContain(
      "revoke all on function public.accept_invitation_idempotent(text, text, text)\n  from anon;",
    );
    expect(atomicIdempotentCommands).not.toMatch(
      /accept_invitation_idempotent\(\s*p_(?:restaurant|user|email|role)/,
    );
  });
});

function collectProductionRpcCalls(
  root: string,
  targetRpcs: ReadonlySet<string>,
) {
  const calls: Array<{
    file: string;
    line: number;
    rpc: string;
    argumentNames: string[];
  }> = [];

  for (const file of walkTypeScriptFiles(root)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const sourceText = readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "rpc" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        targetRpcs.has(node.arguments[0].text)
      ) {
        const args = node.arguments[1];
        const argumentNames =
          args && ts.isObjectLiteralExpression(args)
            ? args.properties.flatMap((property) => {
                if (
                  ts.isPropertyAssignment(property) ||
                  ts.isShorthandPropertyAssignment(property)
                ) {
                  return [property.name.getText(source)];
                }
                return [];
              })
            : [];
        calls.push({
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          rpc: node.arguments[0].text,
          argumentNames,
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  return calls;
}

function* walkTypeScriptFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkTypeScriptFiles(path);
    } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
      yield path;
    }
  }
}
