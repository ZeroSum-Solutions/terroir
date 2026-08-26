import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";
import { fileField, parseMultipart } from "@/lib/api/validation";
import {
  resolveWineName,
  type WineCandidate,
} from "@/lib/wine-intelligence/name-resolver";
import type {
  SpeechTranscriber,
  SttResult,
} from "@/lib/wine-intelligence/stt-assemblyai";
import type {
  VoiceAvailabilityResponse,
  VoiceResolveResponse,
  VoiceWineItem,
} from "@/lib/wine-intelligence/voice-resolve-types";

const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_MULTIPART_BYTES = 3 * 1024 * 1024;
const MAX_INVENTORY_ROWS = 5_000;
const ALLOWED_AUDIO_TYPES = new Set(["audio/webm", "audio/mp4"]);
const AudioSchema = z.strictObject({ file: fileField });

type Membership = { supabase: unknown; restaurantId: string };
type RequireMembership = () => Promise<Membership | NextResponse>;

type Dependencies = {
  requireMembership: RequireMembership;
  getApiKey: () => string | undefined;
  createTranscriber: (apiKey: string) => SpeechTranscriber;
};

type QueryResult = { data: unknown; error: unknown };
type VoiceQuery = {
  select(columns: string): VoiceQuery;
  eq(column: string, value: unknown): VoiceQuery;
  is(column: string, value: unknown): VoiceQuery;
  gt(column: string, value: unknown): VoiceQuery;
  not(column: string, operator: string, value: unknown): VoiceQuery;
  limit(count: number): Promise<QueryResult>;
};
type VoiceDb = { from(table: string): VoiceQuery };

type InventoryRow = {
  id?: unknown;
  name?: unknown;
  producer?: unknown;
  vintage?: unknown;
};

export function createVoiceResolveHandlers(dependencies: Dependencies) {
  return {
    GET: () => getAvailability(dependencies),
    POST: (request: NextRequest) => postVoiceResolve(request, dependencies),
  };
}

async function getAvailability({ requireMembership, getApiKey }: Dependencies) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  if (!getApiKey()?.trim()) {
    return NextResponse.json<VoiceAvailabilityResponse>({ available: false });
  }

  const placementState = await readPlacementState(asVoiceDb(auth.supabase), auth.restaurantId);
  return NextResponse.json<VoiceAvailabilityResponse>({
    available: placementState === "populated",
  });
}

async function postVoiceResolve(request: NextRequest, dependencies: Dependencies) {
  const auth = await dependencies.requireMembership();
  if (auth instanceof NextResponse) return auth;
  const db = asVoiceDb(auth.supabase);

  const placementState = await readPlacementState(db, auth.restaurantId);
  if (placementState === "unavailable") {
    return voiceJson(
      { kind: "gated", reason: "placements_unavailable" },
      503,
    );
  }
  if (placementState === "empty") {
    return voiceJson({ kind: "gated", reason: "empty_cellar" }, 409);
  }

  const apiKey = dependencies.getApiKey()?.trim();
  if (!apiKey) {
    return voiceJson(
      { kind: "unavailable", reason: "voice_unavailable" },
      503,
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_MULTIPART_BYTES) {
    return Errors.tooLarge("Voice recording must be under 2 MB.");
  }

  const parsed = await parseMultipart(request, AudioSchema, {
    message: "Expected a voice recording.",
  });
  if (!parsed.ok) return parsed.response;
  const file = parsed.data.file;
  if (file.size === 0) return Errors.badRequest("Voice recording is empty.");
  if (file.size > MAX_AUDIO_BYTES) {
    return Errors.tooLarge("Voice recording must be under 2 MB.");
  }
  const mediaType = file.type.split(";", 1)[0].toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.has(mediaType)) {
    return Errors.unsupportedMediaType("Use WebM/Opus or MP4/AAC audio.");
  }

  const inventory = await loadInventory(db, auth.restaurantId);
  if (!inventory.ok) throw inventory.error;
  if (inventory.candidates.length === 0) {
    return voiceJson({ kind: "gated", reason: "empty_cellar" }, 409);
  }

  const stt = await dependencies.createTranscriber(apiKey).transcribe({
    audio: new Uint8Array(await file.arrayBuffer()),
    contentType: file.type,
    keyterms: inventory.candidates.map(
      (candidate) => `${candidate.producer} ${candidate.displayName}`,
    ),
  });
  if (!stt.ok) return sttFailure(stt);

  const outcome = resolveWineName(stt.transcript, inventory.candidates);
  if (outcome.kind === "resolved") {
    return voiceJson({
      kind: "resolved",
      transcript: stt.transcript,
      item: inventory.items.get(outcome.match.candidate.itemId)!,
    });
  }
  if (outcome.kind === "ambiguous") {
    return voiceJson({
      kind: "ambiguous",
      transcript: stt.transcript,
      candidates: outcome.candidates.map(
        ({ candidate }) => inventory.items.get(candidate.itemId)!,
      ),
    });
  }
  return voiceJson({
    kind: "abstain",
    transcript: stt.transcript,
    reason: outcome.reason,
    message: "Couldn't find that cellar wine.",
  });
}

async function readPlacementState(
  db: VoiceDb,
  restaurantId: string,
): Promise<"populated" | "empty" | "unavailable"> {
  // SPEC-20's placements gate switches to bottle_placements when SPEC-09/10
  // land (spec-list §1, migrations 0117+).
  const { data, error } = await db
    .from("inventory_items")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .gt("quantity", 0)
    .limit(1);
  if (error) return "unavailable";
  return Array.isArray(data) && data.length > 0 ? "populated" : "empty";
}

async function loadInventory(db: VoiceDb, restaurantId: string) {
  const { data, error } = await db
    .from("wines")
    .select("id, name, producer, vintage, inventory_items!inner(restaurant_id, quantity)")
    .eq("restaurant_id", restaurantId)
    .eq("inventory_items.restaurant_id", restaurantId)
    .gt("inventory_items.quantity", 0)
    .limit(MAX_INVENTORY_ROWS);
  if (error) return { ok: false as const, error };

  const items = new Map<string, VoiceWineItem>();
  for (const raw of Array.isArray(data) ? data : []) {
    const row = raw as InventoryRow;
    if (
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.producer !== "string"
    ) {
      continue;
    }
    items.set(row.id, {
      itemId: row.id,
      name: [typeof row.vintage === "number" ? row.vintage : null, row.name]
        .filter((value) => value != null)
        .join(" "),
      producer: row.producer,
      // SPEC-09/10 have not landed in this branch. Do not present the
      // read-legacy inventory_items.bin_location as placement truth.
      locations: [],
    });
  }

  const candidates: WineCandidate[] = [...items.values()].map((item) => ({
    itemId: item.itemId,
    displayName: item.name,
    producer: item.producer,
  }));
  return { ok: true as const, items, candidates };
}

function sttFailure(result: Exclude<SttResult, { ok: true }>) {
  return voiceJson(
    {
      kind: "stt_failed",
      reason: result.reason,
      ...(result.transcript !== undefined ? { transcript: result.transcript } : {}),
    },
    result.reason === "timeout" ? 504 : 502,
  );
}

function voiceJson(body: VoiceResolveResponse, status = 200) {
  return NextResponse.json<VoiceResolveResponse>(body, { status });
}

function asVoiceDb(value: unknown): VoiceDb {
  return value as VoiceDb;
}
