const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com/v2";
const DEFAULT_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 500;
const MAX_KEYTERM_WORDS = 1_000;
const MAX_WORDS_PER_PHRASE = 6;

export type SttResult =
  | { ok: true; transcript: string }
  | {
      ok: false;
      reason: "timeout" | "upstream_error";
      transcript?: string;
    };

export interface SttInput {
  audio: Uint8Array;
  contentType: string;
  keyterms: string[];
}

export interface SpeechTranscriber {
  transcribe(input: SttInput): Promise<SttResult>;
}

type AssemblyAiOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type AssemblyResponse = {
  upload_url?: string;
  id?: string;
  status?: string;
  text?: string | null;
};

export function buildAssemblyAiKeyterms(phrases: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let wordCount = 0;

  for (const phrase of phrases) {
    const words = phrase.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS_PER_PHRASE);
    if (words.length === 0 || wordCount + words.length > MAX_KEYTERM_WORDS) continue;
    const normalized = words.join(" ");
    const key = normalized.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    wordCount += words.length;
    if (wordCount === MAX_KEYTERM_WORDS) break;
  }

  return result;
}

export function createAssemblyAiTranscriber({
  apiKey,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: AssemblyAiOptions): SpeechTranscriber {
  return {
    async transcribe(input) {
      const deadline = now() + timeoutMs;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const headers = { authorization: apiKey };

      try {
        if (now() >= deadline) return { ok: false, reason: "timeout" };
        const upload = await fetchJson(
          fetchImpl,
          `${ASSEMBLYAI_BASE_URL}/upload`,
          {
            method: "POST",
            headers: { ...headers, "content-type": input.contentType },
            body: Buffer.from(input.audio),
            signal: controller.signal,
          },
        );
        if (!upload.ok || !upload.body.upload_url) {
          return { ok: false, reason: "upstream_error" };
        }

        if (now() >= deadline) return { ok: false, reason: "timeout" };
        const keyterms = buildAssemblyAiKeyterms(input.keyterms);
        const transcriptRequest = await fetchJson(
          fetchImpl,
          `${ASSEMBLYAI_BASE_URL}/transcript`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              audio_url: upload.body.upload_url,
              speech_models: ["universal-3-5-pro"],
              ...(keyterms.length > 0 ? { keyterms_prompt: keyterms } : {}),
            }),
            signal: controller.signal,
          },
        );
        if (!transcriptRequest.ok || !transcriptRequest.body.id) {
          return { ok: false, reason: "upstream_error" };
        }

        while (now() < deadline) {
          const poll = await fetchJson(
            fetchImpl,
            `${ASSEMBLYAI_BASE_URL}/transcript/${encodeURIComponent(transcriptRequest.body.id)}`,
            { headers, signal: controller.signal },
          );
          if (!poll.ok) return { ok: false, reason: "upstream_error" };
          if (poll.body.status === "completed") {
            return { ok: true, transcript: poll.body.text ?? "" };
          }
          if (poll.body.status === "error") {
            return {
              ok: false,
              reason: "upstream_error",
              ...(poll.body.text ? { transcript: poll.body.text } : {}),
            };
          }
          await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())));
        }

        return { ok: false, reason: "timeout" };
      } catch (error) {
        return {
          ok: false,
          reason:
            controller.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
              ? "timeout"
              : "upstream_error",
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; body: AssemblyResponse }> {
  const response = await fetchImpl(url, init);
  if (!response.ok) return { ok: false, body: {} };
  try {
    return { ok: true, body: (await response.json()) as AssemblyResponse };
  } catch {
    return { ok: false, body: {} };
  }
}
