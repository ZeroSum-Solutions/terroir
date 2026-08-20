import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Supabase service-role client is not configured.");
    return null;
  }
  try {
    return createClient<Database>(url, key, { auth: { persistSession: false } });
  } catch {
    console.error("Supabase service-role client configuration is invalid.");
    return null;
  }
}
