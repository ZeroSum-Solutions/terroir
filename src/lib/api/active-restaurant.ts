/**
 * Active-restaurant selection for users who belong to more than one restaurant.
 *
 * Storage: signed HttpOnly cookie (`active_restaurant_id`). No DB schema
 * change — the cookie is self-contained and the signature prevents tampering.
 * On read, we re-check that the user actually belongs to the restaurant named
 * in the cookie, so a user who has been removed from a restaurant cannot keep
 * operating as that restaurant even if the old cookie is still in their
 * browser.
 *
 * Background: resolves ARCH-003 / DEBT-009 / INT-009 — requireMembership
 * previously used `.limit(1).single()` with no ORDER BY, so multi-restaurant
 * users got a non-deterministic restaurant_id on every request.
 */

import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "@/types/database";
import type { SupabaseClient } from "@supabase/supabase-js";

const COOKIE_NAME = "active_restaurant_id";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

function getSecret(): string {
  const s = process.env.ACTIVE_RESTAURANT_COOKIE_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ACTIVE_RESTAURANT_COOKIE_SECRET must be set to a random ≥16-char string in production.",
    );
  }
  // Dev-only fallback — predictable, never used in prod.
  return "dev-insecure-active-restaurant-do-not-deploy";
}

function hmac(value: string): string {
  return createHmac("sha256", getSecret()).update(value).digest("base64url");
}

/** Build a `${restaurantId}.${signature}` cookie value. */
export function signActiveRestaurantCookie(restaurantId: string): string {
  return `${restaurantId}.${hmac(restaurantId)}`;
}

/** Return the restaurant_id if the signature matches, else null. Does not check membership. */
export function parseActiveRestaurantCookie(
  raw: string | undefined | null,
): string | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(".");
  if (idx === -1) return null;
  const id = raw.slice(0, idx);
  const mac = raw.slice(idx + 1);
  if (!id || !mac) return null;
  const expected = hmac(id);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  try {
    return timingSafeEqual(a, b) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Read the active restaurant_id from the request cookie and confirm the user
 * is still a member. Returns null if the cookie is missing, tampered, or
 * names a restaurant the user doesn't belong to.
 */
export async function readActiveRestaurantFromCookie(
  memberRestaurantIds: readonly string[],
): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE_NAME)?.value;
  const id = parseActiveRestaurantCookie(raw);
  if (!id) return null;
  return memberRestaurantIds.includes(id) ? id : null;
}

/**
 * Persist the user's active-restaurant choice. Verifies membership first so
 * a user can never pin a restaurant they don't belong to.
 */
export async function setActiveRestaurant(
  supabase: SupabaseClient<Database>,
  userId: string,
  restaurantId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("memberships")
    .select("restaurant_id")
    .eq("user_id", userId)
    .eq("restaurant_id", restaurantId)
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) {
    return { ok: false, error: "Not a member of this restaurant." };
  }

  const store = await cookies();
  store.set(COOKIE_NAME, signActiveRestaurantCookie(restaurantId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  });
  return { ok: true };
}

/** Clear the active restaurant cookie (used on sign-out). */
export async function clearActiveRestaurant(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export const __ACTIVE_RESTAURANT_COOKIE_NAME__ = COOKIE_NAME;
