import { createHash } from "node:crypto";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BrowserContext } from "@playwright/test";
import type { Database } from "../../src/types/database";
import type {
  FixtureIdentity,
  IsolatedE2eConfig,
} from "./config";
import { assertIsolatedE2eConfig } from "./config";

const STORAGE_BUCKET = "wine-images";
const WEBP_PIXEL = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==",
  "base64",
);

type AdminClient = SupabaseClient<Database>;

export type IsolatedFixture = FixtureIdentity & {
  password: string;
  userId: string;
};

/**
 * Test-only staging fixture manager. This module lives outside src/, has no
 * HTTP entrypoint, and is guarded by config.ts before a privileged client is
 * constructed. Real authentication tests must never import this module.
 */
export async function provisionIsolatedFixture(
  config: IsolatedE2eConfig,
  identity: FixtureIdentity,
): Promise<IsolatedFixture> {
  assertIsolatedE2eConfig(config);
  const admin = adminClient(config);
  await cleanupIsolatedFixture(config, identity, admin);

  const password = fixturePassword(config, identity);
  const { data, error } = await admin.auth.admin.createUser({
    email: identity.email,
    email_confirm: true,
    password,
    user_metadata: {
      restaurant_name: `E2E bootstrap ${identity.namespace}`,
    },
  });
  if (error || !data.user) {
    throw new Error(`Unable to create isolated E2E user: ${error?.message ?? "no user returned"}`);
  }

  try {
    await replaceBootstrapRestaurant(admin, data.user.id, identity);
    await seedRestaurantData(admin, identity);
    const { error: storageError } = await admin.storage
      .from(STORAGE_BUCKET)
      .upload(identity.storagePath, WEBP_PIXEL, {
        contentType: "image/webp",
        upsert: false,
      });
    if (storageError) throw storageError;

    return { ...identity, password, userId: data.user.id };
  } catch (error) {
    try {
      await cleanupIsolatedFixture(config, identity, admin);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Fixture provisioning and rollback both failed.",
      );
    }
    throw error;
  }
}

export async function cleanupIsolatedFixture(
  config: IsolatedE2eConfig,
  identity: FixtureIdentity,
  existingAdmin?: AdminClient,
): Promise<void> {
  assertIsolatedE2eConfig(config);
  const admin = existingAdmin ?? adminClient(config);
  const cleanupErrors: Error[] = [];

  // Pour history has a restrictive tenant FK to wines. Delete fixture ledger
  // rows first so the restaurant cascade cannot race that restriction. The
  // delete trigger also gets a live open-bottle row to reverse before the rest
  // of the fixture graph is removed.
  for (const restaurantId of [
    identity.restaurantId,
    identity.secondRestaurantId,
  ]) {
    const { error } = await admin
      .from("pour_events")
      .delete()
      .eq("restaurant_id", restaurantId);
    if (error) cleanupErrors.push(error);
  }

  const { error: storageError } = await admin.storage
    .from(STORAGE_BUCKET)
    .remove([identity.storagePath]);
  if (storageError) cleanupErrors.push(storageError);

  const user = await findUserByEmail(admin, identity.email);
  if (user) {
    let canDeleteUser = true;
    const { data: memberships, error: membershipError } = await admin
      .from("memberships")
      .select("restaurant_id, restaurants(name)")
      .eq("user_id", user.id);
    if (membershipError) {
      cleanupErrors.push(membershipError);
      canDeleteUser = false;
    } else {
      const fixtureRestaurantIds = new Set([
        identity.restaurantId,
        identity.secondRestaurantId,
      ]);
      const expectedBootstrapName = `E2E bootstrap ${identity.namespace}`;
      for (const restaurantId of new Set(
        (memberships ?? []).map((row) => row.restaurant_id),
      )) {
        const membership = (memberships ?? []).find(
          (row) => row.restaurant_id === restaurantId,
        );
        const restaurantName = (
          membership?.restaurants as { name: string } | null
        )?.name;
        if (
          !fixtureRestaurantIds.has(restaurantId)
          && restaurantName !== expectedBootstrapName
        ) {
          cleanupErrors.push(
            new Error(
              "Refusing to delete a restaurant without fixture provenance.",
            ),
          );
          canDeleteUser = false;
          continue;
        }
        const { error } = await admin
          .from("restaurants")
          .delete()
          .eq("id", restaurantId);
        if (error) {
          cleanupErrors.push(error);
          canDeleteUser = false;
        }
      }
    }

    if (canDeleteUser) {
      const { error: userError } = await admin.auth.admin.deleteUser(user.id);
      if (userError) cleanupErrors.push(userError);
    }
  }

  const { error: restaurantError } = await admin
    .from("restaurants")
    .delete()
    .eq("id", identity.restaurantId);
  if (restaurantError) cleanupErrors.push(restaurantError);

  const { error: secondRestaurantError } = await admin
    .from("restaurants")
    .delete()
    .eq("id", identity.secondRestaurantId);
  if (secondRestaurantError) cleanupErrors.push(secondRestaurantError);

  const { error: foreignRestaurantError } = await admin
    .from("restaurants")
    .delete()
    .eq("id", identity.foreignRestaurantId);
  if (foreignRestaurantError) cleanupErrors.push(foreignRestaurantError);

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Unable to clean isolated E2E fixture.");
  }
}

/** Injects a provider-issued password session into a non-auth workflow. */
export async function injectFixtureSession(
  context: BrowserContext,
  config: IsolatedE2eConfig,
  fixture: IsolatedFixture,
): Promise<void> {
  assertIsolatedE2eConfig(config);
  let cookiesToSet: Array<{
    name: string;
    options: CookieOptions;
    value: string;
  }> = [];
  const client = createServerClient<Database>(
    config.supabaseUrl,
    config.publishableKey,
    {
      auth: { autoRefreshToken: false, persistSession: true },
      cookies: {
        getAll: () => [],
        setAll: (cookies) => {
          cookiesToSet = cookies;
        },
      },
    },
  );
  const { data, error } = await client.auth.signInWithPassword({
    email: fixture.email,
    password: fixture.password,
  });
  if (error || !data.session || cookiesToSet.length === 0) {
    throw new Error(
      `Unable to create a valid isolated E2E session: ${error?.message ?? "no session cookies returned"}`,
    );
  }

  await context.addCookies(
    cookiesToSet
      .filter((cookie) => cookie.value.length > 0)
      .map((cookie) => {
        const sameSite = playwrightSameSite(cookie.options.sameSite);
        const expires = cookieExpiry(cookie.options);
        return {
          name: cookie.name,
          value: cookie.value,
          url: config.baseUrl,
          secure: true,
          ...(typeof cookie.options.httpOnly === "boolean"
            ? { httpOnly: cookie.options.httpOnly }
            : {}),
          ...(sameSite ? { sameSite } : {}),
          ...(expires ? { expires } : {}),
        };
      }),
  );
}

function adminClient(config: IsolatedE2eConfig): AdminClient {
  assertIsolatedE2eConfig(config);
  return createClient<Database>(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function fixturePassword(
  config: IsolatedE2eConfig,
  identity: FixtureIdentity,
): string {
  const digest = createHash("sha256")
    .update(config.serviceRoleKey)
    .update(":")
    .update(identity.namespace)
    .digest("base64url")
    .slice(0, 28);
  return `T3rroir-${digest}!`;
}

async function findUserByEmail(admin: AdminClient, email: string) {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email === email);
    if (user) return user;
    if (data.users.length < 1000) return null;
  }
  throw new Error("Unable to exhaustively search staging E2E users.");
}

async function replaceBootstrapRestaurant(
  admin: AdminClient,
  userId: string,
  identity: FixtureIdentity,
): Promise<void> {
  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select("restaurant_id")
    .eq("user_id", userId);
  if (membershipError) throw membershipError;

  for (const membership of memberships ?? []) {
    const { error } = await admin
      .from("restaurants")
      .delete()
      .eq("id", membership.restaurant_id);
    if (error) throw error;
  }

  const { error: restaurantError } = await admin.from("restaurants").insert({
    id: identity.restaurantId,
    name: `Primary E2E ${identity.namespace}`,
  });
  if (restaurantError) throw restaurantError;

  const { error: secondRestaurantError } = await admin.from("restaurants").insert({
    id: identity.secondRestaurantId,
    name: `Second E2E ${identity.namespace}`,
  });
  if (secondRestaurantError) throw secondRestaurantError;

  const { error: foreignRestaurantError } = await admin.from("restaurants").insert({
    id: identity.foreignRestaurantId,
    name: `Foreign E2E ${identity.namespace}`,
  });
  if (foreignRestaurantError) throw foreignRestaurantError;

  const { error: newMembershipError } = await admin.from("memberships").insert({
    restaurant_id: identity.restaurantId,
    role: "owner",
    user_id: userId,
  });
  if (newMembershipError) throw newMembershipError;

  const { error: secondMembershipError } = await admin.from("memberships").insert({
    restaurant_id: identity.secondRestaurantId,
    role: "manager",
    user_id: userId,
  });
  if (secondMembershipError) throw secondMembershipError;
}

async function seedRestaurantData(
  admin: AdminClient,
  identity: FixtureIdentity,
): Promise<void> {
  await seedOneRestaurant(admin, {
    inventoryId: identity.inventoryId,
    listId: identity.listId,
    listLabel: `Primary List ${identity.namespace}`,
    quantity: 3,
    restaurantId: identity.restaurantId,
    sectionId: identity.sectionId,
    slug: `e2e-primary-${identity.namespace}`,
    unitCost: 20,
    wineId: identity.wineId,
    wineLabel: `Primary Cuvee ${identity.namespace}`,
    wineListItemId: identity.wineListItemId,
  });
  await seedOneRestaurant(admin, {
    inventoryId: identity.secondInventoryId,
    listId: identity.secondListId,
    listLabel: `Second List ${identity.namespace}`,
    quantity: 7,
    restaurantId: identity.secondRestaurantId,
    sectionId: identity.secondSectionId,
    slug: `e2e-second-${identity.namespace}`,
    unitCost: 30,
    wineId: identity.secondWineId,
    wineLabel: `Second Cuvee ${identity.namespace}`,
    wineListItemId: identity.secondWineListItemId,
  });
}

async function seedOneRestaurant(
  admin: AdminClient,
  fixture: {
    inventoryId: string;
    listId: string;
    listLabel: string;
    quantity: number;
    restaurantId: string;
    sectionId: string;
    slug: string;
    unitCost: number;
    wineId: string;
    wineLabel: string;
    wineListItemId: string;
  },
): Promise<void> {
  const { error: wineError } = await admin.from("wines").insert({
    id: fixture.wineId,
    country: "France",
    name: fixture.wineLabel,
    producer: "Terroir E2E",
    region: "Champagne",
    restaurant_id: fixture.restaurantId,
    size_ml: 750,
    vintage: 2020,
  });
  if (wineError) throw wineError;

  const { error: inventoryError } = await admin.from("inventory_items").insert({
    id: fixture.inventoryId,
    added_via: "manual",
    quantity: fixture.quantity,
    restaurant_id: fixture.restaurantId,
    unit_cost: fixture.unitCost,
    wine_id: fixture.wineId,
  });
  if (inventoryError) throw inventoryError;

  const { error: listError } = await admin.from("wine_lists").insert({
    id: fixture.listId,
    is_published: true,
    name: fixture.listLabel,
    restaurant_id: fixture.restaurantId,
    slug: fixture.slug,
  });
  if (listError) throw listError;

  const { error: sectionError } = await admin.from("wine_list_sections").insert({
    id: fixture.sectionId,
    name: "By the Glass",
    position: 0,
    wine_list_id: fixture.listId,
  });
  if (sectionError) throw sectionError;

  const { error: itemError } = await admin.from("wine_list_items").insert({
    bottle_price: 80,
    glass_pour_ml: 150,
    glass_price: 18,
    id: fixture.wineListItemId,
    position: 0,
    pour_size_mode: "fixed",
    section_id: fixture.sectionId,
    wine_id: fixture.wineId,
  });
  if (itemError) throw itemError;
}

function playwrightSameSite(
  value: CookieOptions["sameSite"],
): "Lax" | "None" | "Strict" | undefined {
  if (value === true || value === "strict") return "Strict";
  if (value === "none") return "None";
  if (value === "lax") return "Lax";
  return undefined;
}

function cookieExpiry(options: CookieOptions): number | undefined {
  if (options.expires instanceof Date) return options.expires.getTime() / 1000;
  if (typeof options.maxAge === "number") {
    return Math.floor(Date.now() / 1000) + options.maxAge;
  }
  return undefined;
}
