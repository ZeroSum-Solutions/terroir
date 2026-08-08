import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath =
  "supabase/migrations/0086_background_job_enqueue_authorization.sql";
const downPath =
  "supabase/migrations/down/0086_background_job_enqueue_authorization.down.sql";
const acceptancePath =
  "supabase/tests/0086_background_job_enqueue_authorization.sql";

describe("background-job enqueue authorization hardening", () => {
  it("requires manager authority for wine enrichment at the RPC boundary", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toContain("p_job_type = 'wine_enrichment'");
    expect(sql).toContain(
      "not public.is_member_with_role(p_restaurant_id, 'manager')",
    );
    expect(sql).toContain(
      "not public.is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(sql).toContain("message = 'background job access denied'");
  });

  it("ships rollback and SQL acceptance for manager success and staff denial", () => {
    const down = readFileSync(downPath, "utf8");
    const acceptance = readFileSync(acceptancePath, "utf8");

    expect(down).toContain("create or replace function public.enqueue_background_job(");
    expect(down).toContain(
      "not public.is_member_with_role(p_restaurant_id, 'staff')",
    );
    expect(acceptance).toContain("staff wine enrichment enqueue unexpectedly succeeded");
    expect(acceptance).toContain("manager wine enrichment enqueue did not persist");
    expect(acceptance).toContain("staff invoice OCR enqueue did not remain allowed");
  });
});
