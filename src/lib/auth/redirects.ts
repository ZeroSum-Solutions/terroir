import { safeNext } from "@/lib/api/safe-redirect";

const LOCAL_APP_ORIGIN = "http://localhost:3000";

export const AUTH_LINK_ERROR = "link";

export const AUTH_ERROR_MESSAGES = {
  invalid_email: "Enter a valid email address.",
  invalid_password: "Password must be at least 6 characters.",
  password_mismatch: "Passwords do not match.",
  invalid_credentials: "Email or password is incorrect.",
  rate_limited: "Too many attempts. Try again shortly.",
  unavailable: "Authentication is temporarily unavailable. Try again shortly.",
  [AUTH_LINK_ERROR]:
    "This sign-in link is invalid or has expired. Request a new link.",
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES;

export type LoginUrlOptions = {
  error?: AuthErrorCode;
  forgot?: boolean;
  magic?: boolean;
  password?: boolean;
  signup?: boolean;
  magicSent?: boolean;
  signupSent?: boolean;
  reset?: boolean;
  resetDone?: boolean;
  next?: string | null;
};

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

export function getAppOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (!configured) {
    if (process.env.NODE_ENV !== "production") return LOCAL_APP_ORIGIN;
    throw new Error("NEXT_PUBLIC_APP_URL must be set in production.");
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("NEXT_PUBLIC_APP_URL must be an absolute URL.");
  }

  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL must be an origin without a path or credentials.",
    );
  }

  const isLoopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("NEXT_PUBLIC_APP_URL must use HTTPS outside localhost.");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_APP_URL must use HTTPS in production.");
  }

  return url.origin;
}

export function appUrl(pathname: string): URL {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new Error("Application paths must start with one slash.");
  }
  return new URL(pathname, getAppOrigin());
}

export function authCallbackUrl(next: string | null | undefined = "/"): string {
  const url = appUrl("/auth/callback");
  url.searchParams.set("next", safeNext(next, "/"));
  return url.toString();
}

export function loginUrl(options: LoginUrlOptions = {}): string {
  const url = appUrl("/login");
  if (options.error) url.searchParams.set("error", options.error);
  if (options.forgot) url.searchParams.set("forgot", "1");
  if (options.magic) url.searchParams.set("mode", "magic");
  if (options.password) url.searchParams.set("mode", "password");
  if (options.signup) url.searchParams.set("mode", "signup");
  if (options.magicSent) url.searchParams.set("sent", "1");
  if (options.signupSent) url.searchParams.set("signup", "1");
  if (options.reset) url.searchParams.set("reset", "1");
  if (options.resetDone) url.searchParams.set("reset_done", "1");
  if (options.next) url.searchParams.set("next", safeNext(options.next, "/"));
  return url.toString();
}

export function authErrorMessage(code: string | undefined): string | undefined {
  return code && code in AUTH_ERROR_MESSAGES
    ? AUTH_ERROR_MESSAGES[code as AuthErrorCode]
    : undefined;
}
