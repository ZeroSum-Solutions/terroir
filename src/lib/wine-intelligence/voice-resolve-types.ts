import type { ResolveOutcome } from "./name-resolver";

export type VoiceWineItem = {
  itemId: string;
  name: string;
  producer: string;
  locations: string[];
};

type AbstainReason = Extract<ResolveOutcome, { kind: "abstain" }>["reason"];

export type VoiceResolveResponse =
  | { kind: "resolved"; transcript: string; item: VoiceWineItem }
  | { kind: "ambiguous"; transcript: string; candidates: VoiceWineItem[] }
  | {
      kind: "abstain";
      transcript: string;
      reason: AbstainReason;
      message: "Couldn't find that cellar wine.";
    }
  | { kind: "gated"; reason: "empty_cellar" | "placements_unavailable" }
  | { kind: "unavailable"; reason: "voice_unavailable" }
  | {
      kind: "stt_failed";
      reason: "timeout" | "upstream_error";
      transcript?: string;
    };

export type VoiceAvailabilityResponse = { available: boolean };
