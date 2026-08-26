// V2-import audit harness — shared helpers.
// Run with: npx tsx scripts/audit/v2-scratch/<file>.ts   (from repo root)

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
config({ path: path.join(REPO_ROOT, ".env.local") });

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
export const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const SEED_PASSWORD = process.env.LOCAL_SEED_USER_PASSWORD ?? "Terroir-audit-local-123!";

if (!/^http:\/\/127\.0\.0\.1:|^http:\/\/localhost:/.test(SUPABASE_URL)) {
  throw new Error(`REFUSING — SUPABASE_URL is not local: ${SUPABASE_URL}`);
}

export const tenantIds = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "scripts/audit/tenant-ids.json"), "utf8"),
) as {
  userA: string;
  userB: string;
  restaurantA: string;
  restaurantB: string;
  wineA_ids: string[];
  wineA_inventory_id: string;
  inventoryA_id: string;
};

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export async function tenantClient(email: string): Promise<SupabaseClient> {
  const throwaway = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await throwaway.auth.signInWithPassword({ email, password: SEED_PASSWORD });
  if (error || !data.session) throw error ?? new Error(`sign-in failed for ${email}`);
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

export function log(...args: unknown[]) {
  console.log(...args);
}
