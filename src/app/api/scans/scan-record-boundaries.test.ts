import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ requireMembership: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => auth.requireMembership(...args),
}));

const images = vi.hoisted(() => ({ getScanImageUrl: vi.fn() }));
vi.mock("@/domains/scanning/scan-image-service", () => ({
  getScanImageUrl: (...args: unknown[]) => images.getScanImageUrl(...args),
  ScanImageNotFoundError: class extends Error {},
  ScanImageStorageError: class extends Error {},
}));

const { PATCH } = await import("./[id]/route");
const { POST: COMMIT } = await import("./[id]/commit/route");
const { GET: IMAGE } = await import("./[id]/image/route");
const { POST: RE_EXTRACT } = await import("./[id]/re-extract/route");

const VALID_ID = "11111111-1111-4111-8111-111111111111";

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

function request(path: string, body?: string) {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "POST" : "PATCH",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body,
  }) as NextRequest;
}

describe("scan-record API boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  const operations = [
    {
      name: "PATCH /api/scans/[id]",
      call: (params: Promise<{ id: string }>) =>
        PATCH(request(`/api/scans/${VALID_ID}`, "{}"), { params }),
    },
    {
      name: "POST /api/scans/[id]/commit",
      call: (params: Promise<{ id: string }>) =>
        COMMIT(request(`/api/scans/${VALID_ID}/commit`), { params }),
    },
    {
      name: "GET /api/scans/[id]/image",
      call: (params: Promise<{ id: string }>) =>
        IMAGE({} as NextRequest, { params }),
    },
    {
      name: "POST /api/scans/[id]/re-extract",
      call: (params: Promise<{ id: string }>) =>
        RE_EXTRACT(request(`/api/scans/${VALID_ID}/re-extract`), { params }),
    },
  ];

  for (const operation of operations) {
    it(`${operation.name} returns the exact auth denial before resolving params`, async () => {
      const denial = NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      );
      auth.requireMembership.mockResolvedValue(denial);
      const watched = watchedParams();

      const response = await operation.call(watched.params);

      expect(response).toBe(denial);
      expect(watched.touches()).toBe(0);
    });

    it(`${operation.name} rejects an invalid scan UUID before dependencies`, async () => {
      const from = vi.fn(() => {
        throw new Error("database must not run");
      });
      auth.requireMembership.mockResolvedValue({
        supabase: { from, rpc: vi.fn() },
        restaurantId: "22222222-2222-4222-8222-222222222222",
        user: { id: "33333333-3333-4333-8333-333333333333" },
        role: "staff",
      });

      const response = await operation.call(Promise.resolve({ id: "not-a-uuid" }));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_error" },
      });
      expect(from).not.toHaveBeenCalled();
      expect(images.getScanImageUrl).not.toHaveBeenCalled();
    });
  }
});
