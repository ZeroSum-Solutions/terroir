import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MagicLinkSubmit, ResetPasswordSubmit } from "./magic-link-submit";

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
    <main className="dawn-gradient flex min-h-screen items-center justify-center px-lg py-xl">
      <div className="w-full max-w-[420px] rounded-card border border-hairline bg-canvas p-xl">
        <div className="mb-xl text-center">
          <div className="mb-sm font-sans text-[13px] font-medium uppercase tracking-[0.22em] text-ink">
            TERR<span className="text-primary">OIR</span>
          </div>
          <h1 className="font-serif text-heading-sm leading-tight text-ink">
            {isForgotPassword ? (
              <>Reset your <em className="text-primary font-normal italic">password</em></>
            ) : (
              <>Sign <em className="text-primary font-normal italic">in</em></>
            )}
          </h1>
          <p className="mt-xs text-[14px] font-light text-grey">
            {isForgotPassword
              ? "We&rsquo;ll email you a reset link."
              : "We&rsquo;ll email you a magic link."}
          </p>
        </div>

        {reset_done === "1" ? (
          <div
            role="status"
            aria-live="polite"
            className="rounded-md border border-sage-ink/30 bg-sage-wash p-lg text-[14px] text-sage-ink"
          >
            Password updated. Sign in with a magic link or your new password.
          </div>
        ) : sent ? (
          <div
            role="status"
            aria-live="polite"
            className="rounded-md border border-sage-ink/30 bg-sage-wash p-lg text-[14px] text-sage-ink"
          >
            Check <span className="font-medium">{sent}</span> for a sign-in link.
            You can close this tab.
          </div>
        ) : reset === "1" ? (
          <div
            role="status"
            aria-live="polite"
            className="rounded-md border border-sage-ink/30 bg-sage-wash p-lg text-[14px] text-sage-ink"
          >
            If that email is registered, we&rsquo;ve sent a password reset link.
            Check your inbox.
          </div>
        ) : isForgotPassword ? (
          <form action={sendPasswordReset} className="flex flex-col gap-md">
            <label htmlFor="reset-email" className="flex flex-col gap-xs">
              <span className="text-caption font-medium uppercase text-grey">
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
                className="h-[42px] rounded-pill border border-hairline bg-white px-md text-[14px] text-ink outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-blush-wash"
              />
            </label>
            {error && (
              <div id="reset-error" role="alert" className="text-[13px] text-primary">{error}</div>
            )}
            <ResetPasswordSubmit />
            <a
              href="/login"
              className="text-center text-[13px] text-grey hover:text-ink"
            >
              Back to sign in
            </a>
          </form>
        ) : (
          <form action={sendMagicLink} className="flex flex-col gap-md">
            <input type="hidden" name="next" value={next ?? "/"} />
            <label htmlFor="login-email" className="flex flex-col gap-xs">
              <span className="text-caption font-medium uppercase text-grey">
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
                className="h-[42px] rounded-pill border border-hairline bg-white px-md text-[14px] text-ink outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-blush-wash"
              />
            </label>
            {error && (
              <div id="login-error" role="alert" className="text-[13px] text-primary">{error}</div>
            )}
            <MagicLinkSubmit />
            <a
              href="/login?forgot=1"
              className="text-center text-[13px] text-grey hover:text-ink"
            >
              Forgot password?
            </a>
          </form>
        )}

        {devBypassEmail && !sent && reset !== "1" && reset_done !== "1" && (
          <div className="mt-lg border-t border-hairline pt-lg">
            <p className="mb-sm text-caption font-medium uppercase text-grey">
              Dev only
            </p>
            <a
              href="/api/dev-login"
              className="flex h-[42px] items-center justify-center rounded-pill border border-beige-deep bg-white px-md text-[13px] font-medium text-ink hover:bg-bridge-surface"
            >
              Sign in as {devBypassEmail}
            </a>
            <p className="mt-xs text-[11px] text-grey">
              Skips email. Disabled in production (no DEV_BYPASS_EMAIL set).
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
