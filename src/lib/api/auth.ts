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

export type AuthResult = {
  supabase: SupabaseClient<Database>;
  user: { id: string; email?: string };
};

export type MembershipResult = AuthResult & {
  restaurantId: string;
  role: MembershipRole;
};

/** Returns authenticated user + supabase client, or a 401 response. */
export async function requireAuth(): Promise<AuthResult | NextResponse> {
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
export async function requireMembership(): Promise<
  MembershipResult | NextResponse
> {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

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

/** Returns membership with owner role, or 401/403 response. */
export async function requireOwner(): Promise<MembershipResult | NextResponse> {
  const result = await requireMembership();
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
): Promise<MembershipResult | NextResponse> {
  const result = await requireMembership();
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
): Promise<MembershipResult | NextResponse> {
  const result = await requireMembership();
  if (result instanceof NextResponse) return result;

  if (!hasCapability(result.role, capability)) {
    return Errors.forbidden(`Capability ${capability} required.`);
  }

  return result;
}
