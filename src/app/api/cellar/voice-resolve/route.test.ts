import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { createVoiceResolveHandlers } from "./handler";

type InventoryRow = {
  id: string;
  wine_id: string;
  bin_location: string | null;
  wines: {
    id: string;
    name: string;
    producer: string;
    vintage: number | null;
  };
};

const resolvedRows: InventoryRow[] = [
  {
    id: "lot-1",
    wine_id: "wine-1",
    bin_location: "A-12",
    wines: {
      id: "wine-1",
      name: "La Mouline",
      producer: "Guigal",
      vintage: null,
    },
  },
  {
    id: "lot-2",
    wine_id: "wine-2",
    bin_location: "B-04",
    wines: {
      id: "wine-2",
      name: "Grange",
      producer: "Penfolds",
      vintage: null,
    },
  },
];

function makeSupabase(options?: {
  placements?: Array<{ id: string }>;
  placementError?: unknown;
  inventory?: InventoryRow[];
}) {
  const placements = options?.placements ?? [{ id: "placement-1" }];
  const inventory = options?.inventory ?? resolvedRows;

  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      is: vi.fn(() => chain),
      gt: vi.fn(() => chain),
      not: vi.fn(() => chain),
      limit: vi.fn(async () =>
        table === "bottle_placements"
          ? { data: placements, error: options?.placementError ?? null }
          : { data: inventory, error: null },
      ),
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

  it("EV-VWP-20.5: gates an empty placement set before STT is invoked", async () => {
    const supabase = makeSupabase({ placements: [] });
    const { handlers, transcribe, createTranscriber } = setup({ supabase });

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ kind: "gated", reason: "empty_cellar" });
    expect(createTranscriber).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
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

  it("EV-VWP-20.3: returns the resolver's disambiguation list without guessing", async () => {
    const supabase = makeSupabase({
      inventory: [
        {
          id: "lot-1",
          wine_id: "wine-musigny",
          bin_location: "C-01",
          wines: {
            id: "wine-musigny",
            name: "Musigny",
            producer: "Roumier",
            vintage: null,
          },
        },
        {
          id: "lot-2",
          wine_id: "wine-vv",
          bin_location: "C-02",
          wines: {
            id: "wine-vv",
            name: "Musigny Vieilles Vignes",
            producer: "Roumier",
            vintage: null,
          },
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

  it("maps an STT timeout to the typed stt_failed outcome", async () => {
    const { handlers } = setup({
      sttResult: { ok: false, reason: "timeout" },
    });

    const response = await handlers.POST(audioRequest());

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ kind: "stt_failed", reason: "timeout" });
  });

  it("reports unavailable from GET when the key is absent without probing placements", async () => {
    const supabase = makeSupabase();
    const { handlers } = setup({ supabase, apiKey: "" });

    const response = await handlers.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("reports available from GET only when the placement dependency is reachable", async () => {
    const { handlers } = setup();

    const response = await handlers.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: true });
  });
});
