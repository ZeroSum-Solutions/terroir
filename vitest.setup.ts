// BND-003: getSecret() in src/lib/api/active-restaurant.ts now throws
// unconditionally when ACTIVE_RESTAURANT_COOKIE_SECRET is missing or under
// 16 chars. Tests that exercise the cookie path need a deterministic value.
process.env.ACTIVE_RESTAURANT_COOKIE_SECRET =
  process.env.ACTIVE_RESTAURANT_COOKIE_SECRET ?? "x".repeat(32);
