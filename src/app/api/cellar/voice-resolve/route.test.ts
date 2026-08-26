import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { createVoiceResolveHandlers } from "./handler";

type InventoryRow = {
  id: string;
  restaurant_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  inventory_items: Array<{
    restaurant_id: string;
    quantity: number;
  }>;
};

const resolvedRows: InventoryRow[] = [
  {
    id: "wine-1",
    restaurant_id: "restaurant-1",
    name: "La Mouline",
    producer: "Guigal",
    vintage: null,
    inventory_items: [{ restaurant_id: "restaurant-1", quantity: 1 }],
  },
  {
    id: "wine-2",
    restaurant_id: "restaurant-1",
    name: "Grange",
    producer: "Penfolds",
    vintage: null,
    inventory_items: [{ restaurant_id: "restaurant-1", quantity: 1 }],
  },
];

function makeSupabase(options?: {
  cellar?: Array<{ id: string }>;
  cellarError?: unknown;
  inventory?: InventoryRow[];
}) {
  const cellar = options?.cellar ?? [{ id: "inventory-1" }];
  const inventory = options?.inventory ?? resolvedRows;

  const from = vi.fn((table: string) => {
    const equals = new Map<string, unknown>();
    const greaterThan = new Map<string, unknown>();
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn((column: string, value: unknown) => {
        equals.set(column, value);
        return chain;
      }),
      is: vi.fn(() => chain),
      gt: vi.fn((column: string, value: unknown) => {
        greaterThan.set(column, value);
        return chain;
      }),
      not: vi.fn(() => chain),
      limit: vi.fn(async () => {
        if (table === "inventory_items") {
          return { data: cellar, error: options?.cellarError ?? null };
        }
        const parentRestaurant = equals.get("restaurant_id");
        const joinedRestaurant = equals.get("inventory_items.restaurant_id");
        const minimumQuantity = greaterThan.get("inventory_items.quantity");
        return {
          data: inventory.filter((row) =>
            (parentRestaurant === undefined || row.restaurant_id === parentRestaurant) &&
            row.inventory_items.some((item) =>
              (joinedRestaurant === undefined || item.restaurant_id === joinedRestaurant) &&
              (typeof minimumQuantity !== "number" || item.quantity > minimumQuantity),
            ),
          ),
          error: null,
        };
      }),
    };
    return chain;
  });

  return { from };
}

function audioRequest(options?: { size?: number; type?: string }): NextRequest {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(options?.size ?? 32)], "cellar-voice.webm", {
      type: options?.type ?? "audio/webm;codecs=opus",
    }),
  );
  return new Request("http://localhost/api/cellar/voice-resolve", {
    method: "POST",
    body: form,
  }) as unknown as NextRequest;
}

function setup(options?: {
  supabase?: ReturnType<typeof makeSupabase>;
  apiKey?: string;
  sttResult?:
    | { ok: true; transcript: string }
    | { ok: false; reason: "timeout" | "upstream_error"; transcript?: string };
}) {
  const supabase = options?.supabase ?? makeSupabase();
  const transcribe = vi.fn(async () =>
    options?.sttResult ?? { ok: true as const, transcript: "find Guigal La Mouline" },
  );
  const createTranscriber = vi.fn(() => ({ transcribe }));
  const requireMembership = vi.fn(async () => ({
    supabase,
    restaurantId: "restaurant-1",
  }));
  const handlers = createVoiceResolveHandlers({
    requireMembership,
    getApiKey: () => options?.apiKey ?? "assembly-key",
    createTranscriber,
  });

  return { handlers, supabase, transcribe, createTranscriber, requireMembership };
}

describe("/api/cellar/voice-resolve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the sibling auth response without querying the cellar", async () => {
    const supabase = makeSupabase();
    const handlers = createVoiceResolveHandlers({
      requireMembership: vi.fn(async () => NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      )),
      getApiKey: () => "assembly-key",
      createTranscriber: vi.fn(),
    });

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(401);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("EV-VWP-20.5: gates an empty current-schema cellar before STT is invoked", async () => {
    const supabase = makeSupabase({ cellar: [] });
    const { handlers, transcribe, createTranscriber } = setup({ supabase });

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ kind: "gated", reason: "empty_cellar" });
    expect(createTranscriber).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("gates on positive inventory for the member restaurant", async () => {
    const supabase = makeSupabase();
    const { handlers } = setup({ supabase });

    await handlers.POST(audioRequest());

    expect(supabase.from).toHaveBeenNthCalledWith(1, "inventory_items");
    const query = supabase.from.mock.results[0]?.value;
    expect(query.select).toHaveBeenCalledWith("id");
    expect(query.eq).toHaveBeenCalledWith("restaurant_id", "restaurant-1");
    expect(query.gt).toHaveBeenCalledWith("quantity", 0);
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it("fails closed when the current-schema cellar gate query errors", async () => {
    const supabase = makeSupabase({ cellarError: new Error("query failed") });
    const { handlers, createTranscriber } = setup({ supabase });

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      kind: "gated",
      reason: "placements_unavailable",
    });
    expect(createTranscriber).not.toHaveBeenCalled();
  });

  it("returns a typed unavailable outcome when the AssemblyAI key is absent", async () => {
    const { handlers, createTranscriber } = setup({ apiKey: "" });

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      kind: "unavailable",
      reason: "voice_unavailable",
    });
    expect(createTranscriber).not.toHaveBeenCalled();
  });

  it("resolves a transcript to a server-grounded wine id", async () => {
    const { handlers, transcribe } = setup();

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "resolved",
      transcript: "find Guigal La Mouline",
      item: {
        itemId: "wine-1",
        name: "La Mouline",
        producer: "Guigal",
        locations: [],
      },
    });
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      contentType: "audio/webm;codecs=opus",
      keyterms: ["Guigal La Mouline", "Penfolds Grange"],
    }));
  });

  it("returns the resolver's disambiguation list without guessing", async () => {
    const supabase = makeSupabase({
      inventory: [
        {
          id: "wine-musigny",
          restaurant_id: "restaurant-1",
          name: "Musigny",
          producer: "Roumier",
          vintage: null,
          inventory_items: [{ restaurant_id: "restaurant-1", quantity: 1 }],
        },
        {
          id: "wine-vv",
          restaurant_id: "restaurant-1",
          name: "Musigny Vieilles Vignes",
          producer: "Roumier",
          vintage: null,
          inventory_items: [{ restaurant_id: "restaurant-1", quantity: 1 }],
        },
      ],
    });
    const { handlers } = setup({
      supabase,
      sttResult: { ok: true, transcript: "find Roumier Musigny" },
    });

    const response = await handlers.POST(audioRequest({ type: "audio/mp4" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      kind: "ambiguous",
      transcript: "find Roumier Musigny",
    });
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates.map((candidate: { itemId: string }) => candidate.itemId)).toEqual([
      "wine-musigny",
      "wine-vv",
    ]);
  });

  it("EV-VWP-20.4: returns an explicit couldn't-find response for abstention", async () => {
    const { handlers } = setup({
      sttResult: { ok: true, transcript: "what is the weather tomorrow" },
    });

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "abstain",
      reason: "below_threshold",
      message: "Couldn't find that cellar wine.",
      transcript: "what is the weather tomorrow",
    });
  });

  it("rejects audio larger than 2 MB without invoking STT", async () => {
    const { handlers, transcribe } = setup();

    const response = await handlers.POST(audioRequest({ size: 2 * 1024 * 1024 + 1 }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "too_large" } });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("rejects an oversized multipart request before consuming formData", async () => {
    const { handlers } = setup();
    const formData = vi.fn(() => {
      throw new Error("formData must not be consumed");
    });
    const request = {
      headers: new Headers({ "content-length": String(3 * 1024 * 1024 + 1) }),
      formData,
    } as unknown as NextRequest;

    const response = await handlers.POST(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "too_large" } });
    expect(formData).not.toHaveBeenCalled();
  });

  it("resolves another wine when one wine has 5000 stocked lots", async () => {
    const supabase = makeSupabase({
      inventory: [
        {
          id: "wine-many-lots",
          restaurant_id: "restaurant-1",
          name: "Lot Heavy",
          producer: "Producer A",
          vintage: null,
          inventory_items: Array.from({ length: 5_000 }, () => ({
            restaurant_id: "restaurant-1",
            quantity: 1,
          })),
        },
        {
          id: "wine-other",
          restaurant_id: "restaurant-1",
          name: "Other Wine",
          producer: "Producer B",
          vintage: null,
          inventory_items: [{ restaurant_id: "restaurant-1", quantity: 1 }],
        },
      ],
    });
    const { handlers } = setup({
      supabase,
      sttResult: { ok: true, transcript: "find Producer B Other Wine" },
    });

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "resolved",
      item: { itemId: "wine-other" },
    });
    expect(supabase.from).toHaveBeenNthCalledWith(2, "wines");
    const query = supabase.from.mock.results[1]?.value;
    expect(query.select).toHaveBeenCalledWith(
      "id, name, producer, vintage, inventory_items!inner(restaurant_id, quantity)",
    );
    expect(query.eq).toHaveBeenCalledWith("restaurant_id", "restaurant-1");
    expect(query.eq).toHaveBeenCalledWith(
      "inventory_items.restaurant_id",
      "restaurant-1",
    );
    expect(query.gt).toHaveBeenCalledWith("inventory_items.quantity", 0);
    expect(query.limit).toHaveBeenCalledWith(5_000);
  });

  it("excludes wines outside either parent or joined restaurant scope", async () => {
    const supabase = makeSupabase({
      inventory: [
        {
          id: "foreign-parent",
          restaurant_id: "restaurant-2",
          name: "Foreign Parent",
          producer: "Leak One",
          vintage: null,
          inventory_items: [{ restaurant_id: "restaurant-1", quantity: 1 }],
        },
        {
          id: "foreign-inventory",
          restaurant_id: "restaurant-1",
          name: "Foreign Inventory",
          producer: "Leak Two",
          vintage: null,
          inventory_items: [{ restaurant_id: "restaurant-2", quantity: 1 }],
        },
        {
          id: "safe-wine",
          restaurant_id: "restaurant-1",
          name: "Safe Wine",
          producer: "Safe Producer",
          vintage: null,
          inventory_items: [{ restaurant_id: "restaurant-1", quantity: 1 }],
        },
      ],
    });
    const { handlers, transcribe } = setup({ supabase });

    await handlers.POST(audioRequest());

    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      keyterms: ["Safe Producer Safe Wine"],
    }));
  });

  it("maps an STT timeout to the typed stt_failed outcome", async () => {
    const { handlers } = setup({
      sttResult: { ok: false, reason: "timeout" },
    });

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ kind: "stt_failed", reason: "timeout" });
  });

  it("reports unavailable from GET when the key is absent without probing the cellar", async () => {
    const supabase = makeSupabase();
    const { handlers } = setup({ supabase, apiKey: "" });

    const response = await handlers.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("reports available from GET only when the current cellar is populated", async () => {
    const { handlers } = setup();

    const response = await handlers.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: true });
  });

  it("reports unavailable from GET when the keyed cellar is empty", async () => {
    const { handlers } = setup({ supabase: makeSupabase({ cellar: [] }) });

    const response = await handlers.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
  });
});
