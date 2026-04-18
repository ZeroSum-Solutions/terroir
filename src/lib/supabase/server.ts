import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client for Server Components, Server Actions,
 * and Route Handlers. Creates a fresh client per request.
 *
 * In Server Components, cookie writes from token refresh are no-ops
 * (the proxy handles session refresh on navigation). In Actions /
 * Route Handlers, setAll forwards the refreshed cookies to the response.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — cookie writes are not allowed
            // here. The proxy refreshes the session on the next navigation.
          }
        },
      },
    },
  );
}
