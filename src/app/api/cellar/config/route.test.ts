import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireCapability = vi.fn();
const mockRequireMembership = vi.fn();
const mockCaptureException = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { GET, PATCH, POST } = await import("./route");

function makeSupabase(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn(async () => result);
  const limit = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ limit }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { from, select, eq, limit, maybeSingle };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("GET /api/cellar/config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it.each([401, 403])(
    "returns an auth denial before database access (%s)",
    async (status) => {
      const supabase = makeSupabase({ data: null, error: null });
      mockRequireMembership.mockResolvedValue(
        NextResponse.json({ error: "denied" }, { status }),
      );

      const response = await GET();

      expect(response.status).toBe(status);
      expect(supabase.from).not.toHaveBeenCalled();
    },
  );

  it("returns the current configuration", async () => {
    const config = { id: "config-a", rows: 10, columns: 12 };
    const supabase = makeSupabase({ data: config, error: null });
    allow(supabase);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(config);
    expect(supabase.from).toHaveBeenCalledWith("cellar_config");
  });

  it("preserves 200 null when no configuration exists", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("redacts and captures a real database failure", async () => {
    const error = { message: "password=super-secret", code: "XX000" };
    const supabase = makeSupabase({ data: null, error });
    allow(supabase);

    const response = await GET();
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to fetch cellar configuration.",
      },
    });
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("XX000");
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { surface: "cellar-config", phase: "fetch" },
      extra: { restaurantId: "restaurant-a" },
    });
  });
});

describe.each([
  {
    method: "POST",
    call: () =>
      POST(
        new NextRequest("http://localhost/api/cellar/config", {
          method: "POST",
          body: "{malformed",
        }),
      ),
  },
  {
    method: "PATCH",
    call: () =>
      PATCH(
        new NextRequest("http://localhost/api/cellar/config", {
          method: "PATCH",
          body: "{malformed",
        }),
      ),
  },
])("$method /api/cellar/config", ({ call }) => {
  beforeEach(() => vi.clearAllMocks());

  it.each([401, 403])(
    "returns capability denial before reading the body (%s)",
    async (status) => {
      const denial = NextResponse.json({ error: "denied" }, { status });
      mockRequireCapability.mockResolvedValue(denial);

      const response = await call();

      expect(response).toBe(denial);
      expect(mockRequireCapability).toHaveBeenCalledWith("cellar:manage");
    },
  );
});

type ClaimRow = {
  outcome:
    | "claimed"
    | "replay"
    | "in_progress"
    | "mismatch"
    | "expired"
    | "outcome_unknown";
  response_status: number | null;
  response_body: unknown;
  response_headers: Record<string, string> | null;
};

const KEY = "cellar-config-command-key-0001";
const RESTAURANT_ID = "restaurant-a";

function mutationRequest(
  method: "POST" | "PATCH",
  body: unknown,
  key?: string,
) {
  return new NextRequest("http://localhost/api/cellar/config", {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeMutationSupabase(options: {
  lookup?: {
    data: { id: string; labels: unknown } | null;
    error: { code?: string; message?: string } | null;
  };
  insert?: {
    data: Record<string, unknown> | null;
    error: { code?: string; message?: string } | null;
  };
  update?: {
    data: Record<string, unknown> | null;
    error: { code?: string; message?: string } | null;
  };
  claims?: ClaimRow[];
  complete?: { data: boolean | null; error: unknown };
} = {}) {
  const lookup = options.lookup ?? {
    data: { id: "config-a", labels: {} },
    error: null,
  };
  const insert = options.insert ?? {
    data: {
      id: "config-a",
      restaurant_id: RESTAURANT_ID,
      name: "Main Cellar",
      rows: 10,
      columns: 10,
      labels: {},
    },
    error: null,
  };
  const update = options.update ?? {
    data: {
      id: "config-a",
      restaurant_id: RESTAURANT_ID,
      labels: {},
    },
    error: null,
  };
  const claims = [...(options.claims ?? [{
    outcome: "claimed",
    response_status: null,
    response_body: null,
    response_headers: null,
  } satisfies ClaimRow])];
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const rpc = vi.fn(async (operation: string) => {
    if (operation === "claim_api_idempotency") {
      return {
        data: [claims.shift() ?? {
          outcome: "outcome_unknown",
          response_status: null,
          response_body: null,
          response_headers: null,
        }],
        error: null,
      };
    }
    if (operation === "complete_api_idempotency") {
      return options.complete ?? { data: true, error: null };
    }
    if (operation === "fail_api_idempotency") {
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${operation}`);
  });

  const from = vi.fn((table: string) => {
    if (table !== "cellar_config") {
      throw new Error(`Unexpected table ${table}`);
    }
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          limit: vi.fn(() => ({
            single: vi.fn(async () => lookup),
          })),
        })),
      })),
      insert: vi.fn((payload: Record<string, unknown>) => {
        inserts.push(payload);
        return {
          select: vi.fn(() => ({
            single: vi.fn(async () => insert),
          })),
        };
      }),
      update: vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return {
          eq: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => update),
            })),
          })),
        };
      }),
    };
  });

  return { from, rpc, inserts, updates };
}

function allowMutation(supabase: ReturnType<typeof makeMutationSupabase>) {
  mockRequireCapability.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: "user-a" },
    role: "manager",
  });
}

describe("POST /api/cellar/config idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("normalizes defaults and preserves the exact keyless success", async () => {
    const config = {
      id: "config-a",
      restaurant_id: RESTAURANT_ID,
      name: "Main Cellar",
      rows: 10,
      columns: 12,
    };
    const supabase = makeMutationSupabase({
      insert: { data: config, error: null },
    });
    allowMutation(supabase);

    const response = await POST(
      mutationRequest("POST", { columns: 12, name: "  Main Cellar  " }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await response.json()).toEqual(config);
    expect(supabase.inserts).toEqual([
      {
        restaurant_id: RESTAURANT_ID,
        name: "Main Cellar",
        rows: 10,
        columns: 12,
      },
    ]);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("claims and completes with the full normalized body hash", async () => {
    const config = {
      id: "config-a",
      restaurant_id: RESTAURANT_ID,
      name: "Reserve",
      rows: 8,
      columns: 20,
    };
    const supabase = makeMutationSupabase({
      insert: { data: config, error: null },
    });
    allowMutation(supabase);

    const response = await POST(
      mutationRequest(
        "POST",
        { columns: 20, rows: 8, name: " Reserve " },
        KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual(config);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "claim_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id: "api:POST:/api/cellar/config",
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({
          name: "Reserve",
          rows: 8,
          columns: 20,
        }),
      }),
    );
    expect(supabase.rpc).toHaveBeenCalledWith(
      "complete_api_idempotency",
      expect.objectContaining({
        p_response_status: 200,
        p_response_body: config,
      }),
    );
  });

  it("replays a completed response without inserting again", async () => {
    const replayed = {
      id: "config-a",
      name: "Main Cellar",
      rows: 10,
      columns: 10,
    };
    const supabase = makeMutationSupabase({
      claims: [{
        outcome: "replay",
        response_status: 200,
        response_body: replayed,
        response_headers: {},
      }],
    });
    allowMutation(supabase);

    const response = await POST(mutationRequest("POST", {}, KEY));

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(replayed);
    expect(supabase.inserts).toEqual([]);
  });

  it.each([
    ["unknown fields", { rows: 10, ignored: true }],
    ["invalid dimensions", { rows: 0 }],
  ])("rejects %s before a claim", async (_label, body) => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await POST(mutationRequest("POST", body, KEY));

    expect(response.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.inserts).toEqual([]);
  });

  it("returns the shared malformed-JSON envelope before a claim", async () => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await POST(
      mutationRequest("POST", "{malformed", KEY),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_json", message: "Invalid JSON." },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.inserts).toEqual([]);
  });

  it("returns Zod issue details for schema-invalid bodies before a claim", async () => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await POST(mutationRequest("POST", { rows: 0 }, KEY));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Invalid input.",
        details: [{ path: ["rows"] }],
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.inserts).toEqual([]);
  });

  it("rejects a malformed key before the insert", async () => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await POST(
      mutationRequest("POST", {}, "bad key!"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "Invalid Idempotency-Key.",
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.inserts).toEqual([]);
  });

  it("preserves the exact keyless provider envelope", async () => {
    const supabase = makeMutationSupabase({
      insert: {
        data: null,
        error: { code: "XX000", message: "provider detail" },
      },
    });
    allowMutation(supabase);

    const response = await POST(mutationRequest("POST", {}));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to create cellar configuration.",
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("preserves the provider envelope and fails a keyed claim closed", async () => {
    const error = { code: "XX000", message: "password=secret" };
    const supabase = makeMutationSupabase({
      insert: { data: null, error },
    });
    allowMutation(supabase);

    const response = await POST(mutationRequest("POST", {}, KEY));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to create cellar configuration.",
      },
    });
    expect(text).not.toContain("secret");
    expect(supabase.rpc).toHaveBeenCalledWith(
      "fail_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:POST:/api/cellar/config",
        p_idempotency_key: KEY,
      }),
    );
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: { surface: "cellar-config", phase: "insert" },
      }),
    );
  });

  it("does not repeat the insert after completion becomes ambiguous", async () => {
    const supabase = makeMutationSupabase({
      claims: [
        {
          outcome: "claimed",
          response_status: null,
          response_body: null,
          response_headers: null,
        },
        {
          outcome: "outcome_unknown",
          response_status: null,
          response_body: null,
          response_headers: null,
        },
      ],
      complete: {
        data: null,
        error: { message: "completion unavailable" },
      },
    });
    allowMutation(supabase);

    const first = await POST(mutationRequest("POST", {}, KEY));
    const second = await POST(mutationRequest("POST", {}, KEY));

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: {
        code: "idempotency_outcome_unknown",
        message:
          "The original request outcome is unknown and will not be retried.",
      },
    });
    expect(supabase.inserts).toHaveLength(1);
  });
});

describe("PATCH /api/cellar/config idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("truthfully rejects section_order without sections before a claim", async () => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await PATCH(
      mutationRequest("PATCH", { section_order: [" b ", "a"] }, KEY),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "bad_request",
        message: "Provide sections with section_order.",
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("rejects section_order beside pour_defaults when sections are absent", async () => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await PATCH(
      mutationRequest(
        "PATCH",
        {
          section_order: ["red"],
          pour_defaults: [
            { size_ml: 150, colour: "Red", default_oz: 5 },
          ],
        },
        KEY,
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "bad_request",
        message: "Provide sections with section_order.",
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("keeps the keyed missing-config insert inside the claimed boundary", async () => {
    const config = {
      id: "config-a",
      restaurant_id: RESTAURANT_ID,
      labels: {
        sections: [{ id: "a", name: "A" }],
        section_order: ["a"],
      },
    };
    const supabase = makeMutationSupabase({
      lookup: {
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      },
      insert: { data: config, error: null },
    });
    allowMutation(supabase);

    const response = await PATCH(
      mutationRequest(
        "PATCH",
        { sections: [{ id: "a", name: "A" }] },
        KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual(config);
    expect(supabase.inserts).toHaveLength(1);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "claim_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:PATCH:/api/cellar/config",
        p_idempotency_key: KEY,
      }),
    );
    expect(supabase.rpc).toHaveBeenCalledWith(
      "complete_api_idempotency",
      expect.objectContaining({ p_response_body: config }),
    );
  });

  it("normalizes the complete sections body before mutation", async () => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    await PATCH(
      mutationRequest(
        "PATCH",
        {
          sections: [{ id: " red ", name: " Reds " }],
          section_order: [" red "],
          pour_defaults: [
            { size_ml: 150, colour: " Red ", default_oz: 5 },
          ],
        },
        KEY,
      ),
    );

    expect(supabase.updates).toEqual([
      {
        labels: {
          sections: [{ id: "red", name: "Reds" }],
          section_order: ["red"],
          pour_defaults: [
            { size_ml: 150, colour: "Red", default_oz: 5 },
          ],
        },
      },
    ]);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "claim_api_idempotency",
      expect.objectContaining({
        p_request_hash: createIdempotencyRequestHash({
          sections: [{ id: "red", name: "Reds" }],
          section_order: ["red"],
          pour_defaults: [
            { size_ml: 150, colour: "Red", default_oz: 5 },
          ],
        }),
      }),
    );
  });

  it.each([
    ["empty body", {}],
    ["unknown fields", { ignored: true }],
    ["invalid nested fields", { sections: [{ id: "", name: "A" }] }],
  ])("rejects %s before a claim or lookup", async (_label, body) => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await PATCH(mutationRequest("PATCH", body, KEY));

    expect(response.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("returns the shared malformed-JSON envelope before a claim", async () => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await PATCH(
      mutationRequest("PATCH", "{malformed", KEY),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_json", message: "Invalid JSON." },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("returns Zod issue details for schema-invalid bodies before a claim", async () => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await PATCH(
      mutationRequest("PATCH", { sections: [{ id: "", name: "A" }] }, KEY),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Invalid sections.",
        details: [{ path: ["sections", 0, "id"] }],
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("rejects a malformed key before the lookup", async () => {
    const supabase = makeMutationSupabase();
    allowMutation(supabase);

    const response = await PATCH(
      mutationRequest(
        "PATCH",
        { sections: [{ id: "a", name: "A" }] },
        "bad key!",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "Invalid Idempotency-Key.",
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("preserves the exact keyless update provider envelope", async () => {
    const supabase = makeMutationSupabase({
      update: {
        data: null,
        error: { code: "XX000", message: "provider detail" },
      },
    });
    allowMutation(supabase);

    const response = await PATCH(
      mutationRequest("PATCH", {
        sections: [{ id: "a", name: "A" }],
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to update cellar configuration.",
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("preserves update provider errors and marks keyed work unknown", async () => {
    const error = { code: "XX000", message: "private database detail" };
    const supabase = makeMutationSupabase({
      update: { data: null, error },
    });
    allowMutation(supabase);

    const response = await PATCH(
      mutationRequest(
        "PATCH",
        { sections: [{ id: "a", name: "A" }] },
        KEY,
      ),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to update cellar configuration.",
      },
    });
    expect(supabase.rpc).toHaveBeenCalledWith(
      "fail_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:PATCH:/api/cellar/config",
        p_idempotency_key: KEY,
      }),
    );
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: {
          surface: "cellar-config",
          phase: "patch-update",
        },
      }),
    );
  });

  it("replays without repeating the lookup or update", async () => {
    const replayed = {
      id: "config-a",
      labels: {
        sections: [{ id: "a", name: "A" }],
        section_order: ["a"],
      },
    };
    const supabase = makeMutationSupabase({
      claims: [{
        outcome: "replay",
        response_status: 200,
        response_body: replayed,
        response_headers: {},
      }],
    });
    allowMutation(supabase);

    const response = await PATCH(
      mutationRequest(
        "PATCH",
        { sections: [{ id: "a", name: "A" }] },
        KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(replayed);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.updates).toEqual([]);
  });

  it("does not repeat the update after completion becomes ambiguous", async () => {
    const supabase = makeMutationSupabase({
      claims: [
        {
          outcome: "claimed",
          response_status: null,
          response_body: null,
          response_headers: null,
        },
        {
          outcome: "outcome_unknown",
          response_status: null,
          response_body: null,
          response_headers: null,
        },
      ],
      complete: {
        data: null,
        error: { message: "completion unavailable" },
      },
    });
    allowMutation(supabase);
    const body = { sections: [{ id: "a", name: "A" }] };

    const first = await PATCH(mutationRequest("PATCH", body, KEY));
    const second = await PATCH(mutationRequest("PATCH", body, KEY));

    expect(first.status).toBe(503);
    expect(second.status).toBe(409);
    expect(supabase.updates).toHaveLength(1);
  });
});
