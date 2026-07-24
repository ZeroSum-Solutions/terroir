import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

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
