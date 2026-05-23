import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MagicLinkSubmit } from "./magic-link-submit";

export const metadata: Metadata = { title: "Sign in" };

type SearchParams = Promise<{
  sent?: string;
  error?: string;
  next?: string;
  /** When "1", show the forgot-password form instead of sign-in */
  forgot?: string;
  /** When "1", forgot-password reset email was sent successfully */
  reset?: string;
  /** When "1", password was successfully reset; user can now sign in */
  reset_done?: string;
}>;

async function sendMagicLink(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = String(formData.get("next") ?? "/");

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

async function sendPasswordReset(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  if (!email) redirect(`/login?forgot=1&error=${encodeURIComponent("Enter your email.")}`);

  const hdrs = await headers();
  const origin =
    hdrs.get("origin") ??
    (hdrs.get("host") ? `https://${hdrs.get("host")}` : "http://localhost:3000");

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback`,
  });

  // Per security best-practice, always show a success message regardless of
  // whether the email exists. This prevents account enumeration.
  if (error) {
    // Log server-side for observability, but show generic success to user
    console.error("Password reset request failed:", error.message);
  }
  redirect(`/login?reset=1`);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { sent, error, next, forgot, reset, reset_done } = await searchParams;
  // Server-only env var (no NEXT_PUBLIC_ prefix) — reading it here is fine
  // because LoginPage is a Server Component and the value never reaches the
  // client bundle. The value is only used to decide whether to render the
  // dev-bypass button.
  const devBypassEmail =
    process.env.NODE_ENV !== "production"
      ? process.env.DEV_BYPASS_EMAIL
      : undefined;

  const isForgotPassword = forgot === "1";

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
            {isForgotPassword ? "Reset your password" : "Sign in"}
          </h1>
          <p className="mt-xs text-[14px] text-ink-muted">
            {isForgotPassword
              ? "We&rsquo;ll email you a reset link."
              : "We&rsquo;ll email you a magic link."}
          </p>
        </div>

        {reset_done === "1" ? (
          <div className="rounded-md border border-success/30 bg-success-soft p-lg text-[14px] text-success">
            Password updated. Sign in with a magic link or your new password.
          </div>
        ) : sent ? (
          <div className="rounded-md border border-success/30 bg-success-soft p-lg text-[14px] text-success">
            Check <span className="font-medium">{sent}</span> for a sign-in link.
            You can close this tab.
          </div>
        ) : reset === "1" ? (
          <div className="rounded-md border border-success/30 bg-success-soft p-lg text-[14px] text-success">
            If that email is registered, we&rsquo;ve sent a password reset link.
            Check your inbox.
          </div>
        ) : isForgotPassword ? (
          <form action={sendPasswordReset} className="flex flex-col gap-md">
            <label htmlFor="reset-email" className="flex flex-col gap-xs">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                Work email
              </span>
              <input
                id="reset-email"
                type="email"
                name="email"
                autoComplete="email"
                required
                aria-describedby={error ? "reset-error" : undefined}
                placeholder="you@restaurant.com…"
                className="h-[38px] rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
              />
            </label>
            {error && (
              <div id="reset-error" role="alert" className="text-[13px] text-danger">{error}</div>
            )}
            <button
              type="submit"
              className="flex h-[38px] items-center justify-center rounded-sm bg-accent px-md text-[14px] font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            >
              Send reset link
            </button>
            <a
              href="/login"
              className="text-center text-[13px] text-ink-muted hover:text-ink"
            >
              Back to sign in
            </a>
          </form>
        ) : (
          <form action={sendMagicLink} className="flex flex-col gap-md">
            <input type="hidden" name="next" value={next ?? "/"} />
            <label htmlFor="login-email" className="flex flex-col gap-xs">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                Work email
              </span>
              <input
                id="login-email"
                type="email"
                name="email"
                autoComplete="email"
                required
                aria-describedby={error ? "login-error" : undefined}
                placeholder="you@restaurant.com…"
                className="h-[38px] rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
              />
            </label>
            {error && (
              <div id="login-error" role="alert" className="text-[13px] text-danger">{error}</div>
            )}
            <MagicLinkSubmit />
            <a
              href="/login?forgot=1"
              className="text-center text-[13px] text-ink-muted hover:text-ink"
            >
              Forgot password?
            </a>
          </form>
        )}

        {devBypassEmail && !sent && reset !== "1" && reset_done !== "1" && (
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
