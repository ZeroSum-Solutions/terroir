import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Insert a `lwin_catalog` row under a 7-digit `lwin_id` that is genuinely
 * free, and return the id used.
 *
 * Live-DB suites used to derive the id from the clock — `Date.now() % N` — and
 * insert it directly. The local catalogue holds 211,512 seeded rows, so that
 * collided on roughly one run in forty and raised a `23505` unique violation.
 * The visible symptom was the MANDATORY cross-tenant containment suite failing
 * for a reason with nothing to do with containment, which is the worst kind of
 * flake: it teaches people to re-run a security test until it goes green.
 *
 * Retries ONLY on `23505`. Any other error is a real failure and is thrown
 * rather than retried away, so a broken connection or a policy change cannot
 * hide behind the retry loop.
 *
 * Callers must delete the returned id in their own teardown; this helper takes
 * no ownership of cleanup because the suites that use it already have an
 * `afterAll` that knows what else to remove alongside it.
 */
export async function reserveLwinCatalogRow(
  admin: SupabaseClient<Database>,
  row: { display_name: string; producer: string },
  attempts = 50,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = String(1000000 + Math.floor(Math.random() * 8999999))
      .padStart(7, "0")
      .slice(0, 7);
    const { error } = await admin
      .from("lwin_catalog")
      .insert({ lwin_id: candidate, ...row } as never);
    if (!error) return candidate;
    if (error.code !== "23505") throw error;
  }
  throw new Error(
    `could not reserve a free lwin_id after ${attempts} attempts`,
  );
}
