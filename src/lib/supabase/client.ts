import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database";
import { requireSupabasePublicConfig } from "@/lib/supabase/config";

export function createClient() {
  const config = requireSupabasePublicConfig();

  return createBrowserClient<Database>(
    config.url,
    config.publishableKey,
  );
}
