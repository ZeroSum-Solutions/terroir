import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type SearchParams = Promise<{ sent?: string; error?: string; next?: string }>;

async function sendMagicLink(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = String(formData.get("next") ?? "/scanner");

  if (!email) redirect(`/login?error=${encodeURIComponent("Enter your email.")}`);

  const hdrs = await headers();
  const origin =
    hdrs.get("origin") ??
    (hdrs.get("host") ? `https://${hdrs.get("host")}` : "http://localhost:3000");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      shouldCreateUser: true,
    },
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  redirect(`/login?sent=${encodeURIComponent(email)}`);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { sent, error, next } = await searchParams;
  // Server-only env var (no NEXT_PUBLIC_ prefix) — reading it here is fine
  // because LoginPage is a Server Component and the value never reaches the
  // client bundle. The value is only used to decide whether to render the
  // dev-bypass button.
  const devBypassEmail =
    process.env.NODE_ENV !== "production"
      ? process.env.DEV_BYPASS_EMAIL
      : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center px-lg">
      <div className="w-full max-w-[420px]">
        <div className="mb-xl text-center">
          <div
            className="mb-sm font-serif text-[22px] tracking-tight text-accent"
            style={{ fontWeight: 500 }}
          >
            Terroir
          </div>
          <h1 className="font-serif text-[28px] leading-tight text-ink">
            Sign in
          </h1>
          <p className="mt-xs text-[14px] text-ink-muted">
            We&rsquo;ll email you a magic link.
          </p>
        </div>

        {sent ? (
          <div className="rounded-md border border-success/30 bg-success-soft p-lg text-[14px] text-success">
            Check <span className="font-medium">{sent}</span> for a sign-in link.
            You can close this tab.
          </div>
        ) : (
          <form action={sendMagicLink} className="flex flex-col gap-md">
            <input type="hidden" name="next" value={next ?? "/scanner"} />
            <label className="flex flex-col gap-xs">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                Work email
              </span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                placeholder="you@restaurant.com…"
                className="h-[38px] rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
              />
            </label>
            {error && (
              <div className="text-[13px] text-danger">{error}</div>
            )}
            <button
              type="submit"
              className="h-[38px] rounded-sm bg-accent px-md text-[14px] font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Send magic link
            </button>
          </form>
        )}

        {devBypassEmail && !sent && (
          <div className="mt-lg border-t border-dashed border-border pt-lg">
            <p className="mb-sm text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
              Dev only
            </p>
            <a
              href="/api/dev-login"
              className="flex h-[38px] items-center justify-center rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted"
            >
              Sign in as {devBypassEmail}
            </a>
            <p className="mt-xs text-[11px] text-ink-subtle">
              Skips email. Disabled in production (no DEV_BYPASS_EMAIL set).
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
