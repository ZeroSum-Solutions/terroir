import type { NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { createAssemblyAiTranscriber } from "@/lib/wine-intelligence/stt-assemblyai";
import { createVoiceResolveHandlers } from "./handler";

export const runtime = "nodejs";
export const maxDuration = 30;

const handlers = createVoiceResolveHandlers({
  requireMembership,
  getApiKey: () => process.env.ASSEMBLYAI_API_KEY,
  createTranscriber: (apiKey) => createAssemblyAiTranscriber({ apiKey }),
});

export async function GET() {
  return withApiHandler(handlers.GET);
}

export async function POST(request: NextRequest) {
  return withApiHandler(() => handlers.POST(request));
}
