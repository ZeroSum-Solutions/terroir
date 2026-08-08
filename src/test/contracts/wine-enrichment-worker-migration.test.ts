import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("TER-021G worker database contract", () => {
  const forwardPath =
    "supabase/migrations/0084_wine_enrichment_worker_authority.sql";
  const downPath =
    "supabase/migrations/down/0084_wine_enrichment_worker_authority.down.sql";
  const acceptancePath =
    "supabase/tests/0084_wine_enrichment_worker_authority.sql";

  it("grants only the existing tenant-bound enrichment RPC to the service role", () => {
    const forward = source(forwardPath);

    expect(forward).toContain("auth.role() <> 'service_role'");
    expect(forward).toContain(
      "grant execute on function public.enrich_wines_batch(uuid, jsonb)\n  to authenticated, service_role;",
    );
    expect(forward).toContain(
      "grant execute on function public.match_lwin_batch(uuid, uuid[])\n  to authenticated, service_role;",
    );
    expect(forward).toContain(
      "grant execute on function public.match_lwin(text, text, float)\n  to authenticated, service_role;",
    );
    expect(forward).toContain("and w.restaurant_id = p_restaurant_id");
    expect(forward).not.toContain("to anon");
    expect(forward).not.toContain("to public");
  });

  it("ships an exact rollback and executable role/tenant acceptance proof", () => {
    const down = source(downPath);
    const acceptance = source(acceptancePath);

    expect(down).toContain(
      "revoke execute on function public.enrich_wines_batch(uuid, jsonb)\n  from service_role;",
    );
    expect(down).toContain(
      "revoke execute on function public.match_lwin_batch(uuid, uuid[])\n  from service_role;",
    );
    expect(acceptance).toContain("set local role service_role");
    expect(acceptance).toContain("staff enrichment unexpectedly succeeded");
    expect(acceptance).toContain("cross-tenant worker enrichment escaped");
    expect(acceptance).toContain("rollback");
  });
});
