import { NextResponse } from "next/server";
import { Errors } from "@/lib/api/errors";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveMembership } from "@/lib/api/resolve-active-membership";
import {
  hasCapability,
  type Capability,
  type MembershipRole,
} from "@/lib/auth/capabilities";
import type { Database } from "@/types/database";
import {
  isAuthSessionMissingError,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  enforceApiRateLimit,
  type ApiRateLimitClass,
} from "@/lib/api/rate-limit";

export type AuthResult = {
  supabase: SupabaseClient<Database>;
  user: { id: string; email?: string };
};

export type MembershipResult = AuthResult & {
  restaurantId: string;
  role: MembershipRole;
};

export type AuthGuardOptions = {
  rateLimit?: ApiRateLimitClass;
};

async function loadAuth(): Promise<AuthResult | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error && !isAuthSessionMissingError(error)) throw error;

  if (!user) {
    return Errors.unauthorized();
  }

  return { supabase, user };
}

async function applyRateLimit<T extends AuthResult>(
  result: T,
  options: AuthGuardOptions,
): Promise<T | NextResponse> {
  const limited = await enforceApiRateLimit({
    supabase: result.supabase,
    riskClass: options.rateLimit ?? "standard",
  });
  return limited ?? result;
}

async function loadRateLimitedAuth(
  options: AuthGuardOptions,
): Promise<AuthResult | NextResponse> {
  const auth = await loadAuth();
  if (auth instanceof NextResponse) return auth;
  return applyRateLimit(auth, options);
}

/** Returns authenticated user + supabase client, or a 401/429 response. */
export async function requireAuth(
  options: AuthGuardOptions = {},
): Promise<AuthResult | NextResponse> {
  return loadRateLimitedAuth(options);
}

async function loadMembership(
  auth: AuthResult,
): Promise<MembershipResult | NextResponse> {
  const { supabase, user } = auth;
  const membership = await resolveActiveMembership(supabase, user.id);

  if (!membership) {
    return Errors.forbidden("No restaurant membership found.");
  }

  return {
    supabase,
    user,
    restaurantId: membership.restaurantId,
    role: membership.role,
  };
}

/**
 * Returns auth + restaurant membership, or a 401/403 response.
 *
 * ARCH-013: delegates to resolveActiveMembership() — the SAME helper
 * getAuthContext() uses for the server-component path. Previously the
 * two helpers had independent resolution logic and could disagree on
 * which restaurant was active for a multi-membership user. They now
 * always pick the same one (cookie first, then created_at DESC /
 * id DESC fallback).
 */
export async function requireMembership(
  options: AuthGuardOptions = {},
): Promise<
  MembershipResult | NextResponse
> {
  const rateLimitedAuth = await loadRateLimitedAuth(options);
  if (rateLimitedAuth instanceof NextResponse) return rateLimitedAuth;
  return loadMembership(rateLimitedAuth);
}

/** Returns membership with owner role, or 401/403 response. */
export async function requireOwner(
  options: AuthGuardOptions = {},
): Promise<MembershipResult | NextResponse> {
  const rateLimitedAuth = await loadRateLimitedAuth({
    rateLimit: options.rateLimit ?? "mutation",
  });
  if (rateLimitedAuth instanceof NextResponse) return rateLimitedAuth;

  const result = await loadMembership(rateLimitedAuth);
  if (result instanceof NextResponse) return result;

  if (result.role !== "owner") {
    return Errors.forbidden("Owner access required.");
  }

  return result;
}

/**
 * Returns membership iff the caller's role is in the allowed list,
 * otherwise a 401/403 response. Shared helper for role-gated routes;
 * BND-037's availability toggle is the first consumer. Reusable by
 * any future endpoint that needs owner+manager or another subset.
 */
export async function requireRole(
  roles: MembershipRole[],
  options: AuthGuardOptions = {},
): Promise<MembershipResult | NextResponse> {
  const rateLimitedAuth = await loadRateLimitedAuth({
    rateLimit: options.rateLimit ?? "mutation",
  });
  if (rateLimitedAuth instanceof NextResponse) return rateLimitedAuth;

  const result = await loadMembership(rateLimitedAuth);
  if (result instanceof NextResponse) return result;

  if (!roles.includes(result.role)) {
    return Errors.forbidden(`Role ${roles.join(" or ")} required.`);
  }

  return result;
}

/**
 * Returns the active membership when its role owns the named product
 * capability. Prefer this over route-local role comparisons.
 */
export async function requireCapability(
  capability: Capability,
  options: AuthGuardOptions = {},
): Promise<MembershipResult | NextResponse> {
  const defaultRateLimit =
    capability.endsWith(":view") || capability === "export:read"
      ? "standard"
      : "mutation";
  const rateLimitedAuth = await loadRateLimitedAuth({
    rateLimit: options.rateLimit ?? defaultRateLimit,
  });
  if (rateLimitedAuth instanceof NextResponse) return rateLimitedAuth;

  const result = await loadMembership(rateLimitedAuth);
  if (result instanceof NextResponse) return result;

  if (!hasCapability(result.role, capability)) {
    return Errors.forbidden(`Capability ${capability} required.`);
  }

  return result;
}
