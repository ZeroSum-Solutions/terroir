import type { Metadata } from "next";
import { safeNext } from "@/lib/api/safe-redirect";
import { authErrorMessage } from "@/lib/auth/redirects";
import {
  sendMagicLink,
  sendPasswordReset,
  signInWithPassword,
  signUpWithPassword,
} from "./actions";
import {
  MagicLinkSubmit,
  PasswordSubmit,
  ResetPasswordSubmit,
} from "./magic-link-submit";

export const metadata: Metadata = { title: "Sign in" };

type SearchParams = Promise<{
  error?: string;
  mode?: string;
  next?: string;
  forgot?: string;
  sent?: string;
  signup?: string;
  reset?: string;
  reset_done?: string;
}>;

type LoginMode = "magic" | "password" | "signup";

function loginHref(mode: LoginMode, next: string): string {
  const params = new URLSearchParams({ mode });
  if (next !== "/") params.set("next", next);
  return `/login?${params.toString()}`;
}

function inputClassName() {
  return "h-[38px] rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft";
}

function EmailField({ error }: { error?: string }) {
  return (
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
        className={inputClassName()}
      />
    </label>
  );
}

function PasswordFields({
  error,
  confirmation = false,
}: {
  error?: string;
  confirmation?: boolean;
}) {
  return (
    <>
      <label htmlFor="login-password" className="flex flex-col gap-xs">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
          Password
        </span>
        <input
          id="login-password"
          type="password"
          name="password"
          autoComplete={confirmation ? "new-password" : "current-password"}
          required
          minLength={6}
          maxLength={256}
          aria-describedby={error ? "login-error" : undefined}
          placeholder="At least 6 characters"
          className={inputClassName()}
        />
      </label>
      {confirmation && (
        <label htmlFor="login-password-confirm" className="flex flex-col gap-xs">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            Confirm password
          </span>
          <input
            id="login-password-confirm"
            type="password"
            name="confirm"
            autoComplete="new-password"
            required
            minLength={6}
            maxLength={256}
            aria-describedby={error ? "login-error" : undefined}
            placeholder="Enter the same password"
            className={inputClassName()}
          />
        </label>
      )}
    </>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { error: errorCode, mode, next, forgot, sent, signup, reset, reset_done } =
    await searchParams;
  const safePostLoginPath = safeNext(next, "/");
  const error = authErrorMessage(errorCode);
  const isForgotPassword = forgot === "1";
  const loginMode: LoginMode =
    mode === "password" || mode === "signup" ? mode : "magic";

  const title = isForgotPassword
    ? "Reset your password"
    : loginMode === "signup"
      ? "Create your account"
      : loginMode === "password"
        ? "Sign in with password"
        : "Sign in";
  const description = isForgotPassword
    ? "We’ll email you a reset link."
    : loginMode === "signup"
      ? "Use your work email to create an account."
      : loginMode === "password"
        ? "Use your work email and password."
        : "We’ll email you a magic link.";

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
          <h1 className="font-serif text-[28px] leading-tight text-ink">{title}</h1>
          <p className="mt-xs text-[14px] text-ink-muted">{description}</p>
        </div>

        {reset_done === "1" ? (
          <StatusMessage>
            Password updated. Sign in with a magic link or your new password.
          </StatusMessage>
        ) : sent === "1" ? (
          <StatusMessage>Check your inbox for a sign-in link.</StatusMessage>
        ) : signup === "1" ? (
          <StatusMessage>Check your inbox to continue creating your account.</StatusMessage>
        ) : reset === "1" ? (
          <StatusMessage>
            If that email is registered, we’ve sent a password reset link. Check your inbox.
          </StatusMessage>
        ) : isForgotPassword ? (
          <form action={sendPasswordReset} className="flex flex-col gap-md">
            <EmailField error={error} />
            <ErrorMessage error={error} />
            <ResetPasswordSubmit />
            <a
              href={loginHref("magic", safePostLoginPath)}
              className="text-center text-[13px] text-ink-muted hover:text-ink"
            >
              Back to sign in
            </a>
          </form>
        ) : loginMode === "password" ? (
          <form action={signInWithPassword} className="flex flex-col gap-md">
            <input type="hidden" name="next" value={safePostLoginPath} />
            <EmailField error={error} />
            <PasswordFields error={error} />
            <ErrorMessage error={error} />
            <PasswordSubmit label="Sign in" />
            <a
              href={`/login?forgot=1`}
              className="text-center text-[13px] text-ink-muted hover:text-ink"
            >
              Forgot password?
            </a>
            <a
              href={loginHref("magic", safePostLoginPath)}
              className="text-center text-[13px] text-ink-muted hover:text-ink"
            >
              Sign in with a magic link
            </a>
          </form>
        ) : loginMode === "signup" ? (
          <form action={signUpWithPassword} className="flex flex-col gap-md">
            <input type="hidden" name="next" value={safePostLoginPath} />
            <EmailField error={error} />
            <PasswordFields error={error} confirmation />
            <ErrorMessage error={error} />
            <PasswordSubmit label="Create account" />
            <a
              href={loginHref("password", safePostLoginPath)}
              className="text-center text-[13px] text-ink-muted hover:text-ink"
            >
              Already have an account? Sign in
            </a>
          </form>
        ) : (
          <form action={sendMagicLink} className="flex flex-col gap-md">
            <input type="hidden" name="next" value={safePostLoginPath} />
            <EmailField error={error} />
            <ErrorMessage error={error} />
            <MagicLinkSubmit />
            <a
              href={`/login?forgot=1`}
              className="text-center text-[13px] text-ink-muted hover:text-ink"
            >
              Forgot password?
            </a>
            <a
              href={loginHref("password", safePostLoginPath)}
              className="text-center text-[13px] text-ink-muted hover:text-ink"
            >
              Sign in with password
            </a>
            <a
              href={loginHref("signup", safePostLoginPath)}
              className="text-center text-[13px] text-ink-muted hover:text-ink"
            >
              Create an account
            </a>
          </form>
        )}
      </div>
    </main>
  );
}

function ErrorMessage({ error }: { error?: string }) {
  return error ? (
    <div id="login-error" role="alert" className="text-[13px] text-danger">
      {error}
    </div>
  ) : null;
}

function StatusMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-success/30 bg-success-soft p-lg text-[14px] text-success"
    >
      {children}
    </div>
  );
}
