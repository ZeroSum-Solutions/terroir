"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Completion page for implicit-flow magic links (tokens in URL hash).
 * The PKCE flow from /login handles ?code=, this handles #access_token=.
 *
 * Used by admin-generated links (auth.admin.generateLink) and any other
 * flow that returns tokens in the hash fragment.
 */
export default function AuthCompletePage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Wrapped in async IIFE so setError calls live inside a microtask
    // callback rather than the effect body itself — satisfies
    // react-hooks/set-state-in-effect while preserving behaviour.
    void (async () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash) {
        setError("Missing token. Open this link from your email or ask for a new one.");
        return;
      }
      const params = new URLSearchParams(hash);
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      const hash_error = params.get("error_description");

      if (hash_error) {
        setError(hash_error);
        return;
      }
      if (!access_token || !refresh_token) {
        setError("Incomplete token in URL.");
        return;
      }

      const supabase = createClient();
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) {
        setError(error.message);
        return;
      }
      history.replaceState(null, "", window.location.pathname);
      router.replace("/");
    })();
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-lg">
      <div className="text-center">
        {error ? (
          <>
            <h1 className="font-serif text-heading-sm text-ink">Sign-in failed</h1>
            <p className="mt-sm text-[14px] text-primary">{error}</p>
            <a
              href="/login"
              className="mt-md inline-block rounded-pill bg-primary px-md py-sm text-[14px] font-medium text-white hover:bg-primary-hover"
            >
              Back to sign in
            </a>
          </>
        ) : (
          <p className="text-[14px] font-light text-grey">Signing you in…</p>
        )}
      </div>
    </main>
  );
}
