import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const auth = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  requireRole: vi.fn(),
}));
const images = vi.hoisted(() => ({
  deleteWineHeroImage: vi.fn(),
  uploadWineHeroImage: vi.fn(),
}));
const providers = vi.hoisted(() => ({
  enrichRestaurantBatch: vi.fn(),
  enrichWine: vi.fn(),
  enrichWineWithClaude: vi.fn(),
  fetchRetailPrices: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) => auth.requireRole(...args),
  requireMembership: (...args: unknown[]) =>
    auth.requireMembership(...args),
  requireRole: (...args: unknown[]) => auth.requireRole(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/domains/cellar/wine-image-service", () => {
  class WineImageNotFoundError extends Error {}
  class WineImageUnsupportedTypeError extends Error {}
  class WineImageTooLargeError extends Error {}
  class WineImageStorageError extends Error {}
  class WineImagePersistenceError extends Error {}
  return {
    ...images,
    WineImageNotFoundError,
    WineImageUnsupportedTypeError,
    WineImageTooLargeError,
    WineImageStorageError,
    WineImagePersistenceError,
  };
});
vi.mock("@/lib/wine-intelligence/batch", () => ({
  enrichRestaurantBatch: (...args: unknown[]) =>
    providers.enrichRestaurantBatch(...args),
}));
vi.mock("@/lib/wine-intelligence/enrich", () => ({
  enrichWine: (...args: unknown[]) => providers.enrichWine(...args),
}));
vi.mock("@/lib/wine-intelligence/enrich-claude", () => ({
  enrichWineWithClaude: (...args: unknown[]) =>
    providers.enrichWineWithClaude(...args),
}));
vi.mock("@/lib/wine-intelligence/wine-searcher", () => ({
  fetchRetailPrices: (...args: unknown[]) =>
    providers.fetchRetailPrices(...args),
}));

const { POST: ENRICH_ONE } = await import("./[id]/enrich/route");
const { POST: UPLOAD_IMAGE, DELETE: DELETE_IMAGE } = await import(
  "./[id]/image/route"
);
const { POST: REFRESH_ONE } = await import("./[id]/refresh-retail/route");
const { POST: CREATE_LWIN } = await import("./create-from-lwin/route");
const { POST: ENRICH_BATCH } = await import("./enrich/route");
const { POST: REFRESH_BATCH } = await import("./refresh-retail-batch/route");

const VALID_ID = "11111111-1111-4111-8111-111111111111";

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}

function imageRequest() {
  const formData = new FormData();
  formData.set("file", new File(["image"], "hero.png", { type: "image/png" }));
  return { formData: async () => formData } as NextRequest;
}

function watchedParams(id = VALID_ID) {
  let touches = 0;
  const params = {
    then(resolve: (value: { id: string }) => void) {
      touches += 1;
      resolve({ id });
    },
  } as unknown as Promise<{ id: string }>;
  return { params, touches: () => touches };
}

const dynamicOperations = [
  {
    name: "POST single enrichment",
    auth: "role",
    call: (params: Promise<{ id: string }>) =>
      ENRICH_ONE({} as Request, { params }),
  },
  {
    name: "POST image",
    auth: "role",
    call: (params: Promise<{ id: string }>) =>
      UPLOAD_IMAGE(imageRequest(), { params }),
  },
  {
    name: "DELETE image",
    auth: "role",
    call: (params: Promise<{ id: string }>) =>
      DELETE_IMAGE({} as NextRequest, { params }),
  },
  {
    name: "POST single retail refresh",
    auth: "role",
    call: (params: Promise<{ id: string }>) =>
      REFRESH_ONE({} as Request, { params }),
  },
] as const;

describe("wine provider mutation request boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    images.uploadWineHeroImage.mockResolvedValue("https://cdn.example/hero.png");
    images.deleteWineHeroImage.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const operation of dynamicOperations) {
    it(`${operation.name} returns auth denial before resolving params`, async () => {
      const denial = NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      );
      if (operation.auth === "role") {
        auth.requireRole.mockResolvedValue(denial);
      } else {
        auth.requireMembership.mockResolvedValue(denial);
      }
      const watched = watchedParams();

      const response = await operation.call(watched.params);

      expect(response).toBe(denial);
      expect(watched.touches()).toBe(0);
    });

    it(`${operation.name} rejects invalid UUID before dependencies`, async () => {
      const from = vi.fn(() => {
        throw new Error("database must not run");
      });
      const allowed = {
        supabase: { from, rpc: vi.fn() },
        restaurantId: "22222222-2222-4222-8222-222222222222",
        role: "owner",
      };
      if (operation.auth === "role") {
        auth.requireRole.mockResolvedValue(allowed);
      } else {
        auth.requireMembership.mockResolvedValue(allowed);
      }

      const response = await operation.call(
        Promise.resolve({ id: "not-a-uuid" }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_error" },
      });
      expect(from).not.toHaveBeenCalled();
      expect(images.uploadWineHeroImage).not.toHaveBeenCalled();
      expect(images.deleteWineHeroImage).not.toHaveBeenCalled();
      expect(providers.fetchRetailPrices).not.toHaveBeenCalled();
    });
  }

  it("POST create from LWIN rejects unknown fields before database work", async () => {
    const rpc = vi.fn(() => {
      throw new Error("database must not run");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from: vi.fn(), rpc },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await CREATE_LWIN(
      request("/api/wines/create-from-lwin", "POST", {
        lwin_id: "1000001",
        display_name: "Domaine Example",
        restaurant_id: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("POST batch enrichment returns a nested role denial", async () => {
    auth.requireRole.mockResolvedValue(
      NextResponse.json(
        { error: { code: "forbidden", message: "Forbidden" } },
        { status: 403 },
      ),
    );

    const response = await ENRICH_BATCH();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "forbidden" },
    });
  });

  it("POST batch enrichment redacts an unexpected dependency throw", async () => {
    auth.requireRole.mockResolvedValue({
      supabase: {},
      restaurantId: "22222222-2222-4222-8222-222222222222",
      role: "owner",
    });
    providers.enrichRestaurantBatch.mockRejectedValue(
      new Error("provider secret"),
    );

    const response = await ENRICH_BATCH();

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });

  it("POST batch retail refresh redacts an unexpected database throw", async () => {
    const from = vi.fn(() => {
      throw new Error("provider secret");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from },
      restaurantId: "22222222-2222-4222-8222-222222222222",
      role: "owner",
    });
    vi.stubEnv("WINE_SEARCHER_API_KEY", "configured-for-test");

    const response = await REFRESH_BATCH();

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });
});
