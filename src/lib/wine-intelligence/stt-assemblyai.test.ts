import { describe, expect, it, vi } from "vitest";
import {
  buildAssemblyAiKeyterms,
  createAssemblyAiTranscriber,
} from "./stt-assemblyai";

describe("AssemblyAI STT client", () => {
  it("uploads audio, requests Universal-3.5 Pro with keyterms, and polls to completion", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ upload_url: "https://upload.test/audio" }))
      .mockResolvedValueOnce(Response.json({ id: "transcript-1", status: "queued" }))
      .mockResolvedValueOnce(Response.json({
        id: "transcript-1",
        status: "completed",
        text: "Guigal La Mouline",
      }));
    const transcriber = createAssemblyAiTranscriber({
      apiKey: "secret-key",
      fetchImpl,
      sleep: vi.fn(async () => undefined),
    });

    const result = await transcriber.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      contentType: "audio/webm",
      keyterms: ["Guigal La Mouline", "Penfolds Grange"],
    });

    expect(result).toEqual({ ok: true, transcript: "Guigal La Mouline" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.assemblyai.com/v2/upload");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "secret-key",
        "content-type": "audio/webm",
      },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      audio_url: "https://upload.test/audio",
      speech_models: ["universal-3-5-pro"],
      keyterms_prompt: ["Guigal La Mouline", "Penfolds Grange"],
    });
    expect(fetchImpl.mock.calls[2][0]).toBe(
      "https://api.assemblyai.com/v2/transcript/transcript-1",
    );
  });

  it("caps each phrase at six words and the complete prompt at 1000 words", () => {
    const phrases = [
      "one two three four five six seven eight",
      ...Array.from({ length: 1_000 }, (_, index) => `wine${index}`),
    ];

    const result = buildAssemblyAiKeyterms(phrases);

    expect(result[0]).toBe("one two three four five six");
    expect(result.flatMap((phrase) => phrase.split(/\s+/))).toHaveLength(1_000);
  });

  it("returns timeout when polling exceeds the overall budget", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ upload_url: "https://upload.test/audio" }))
      .mockResolvedValueOnce(Response.json({ id: "transcript-1", status: "queued" }))
      .mockResolvedValue(Response.json({ id: "transcript-1", status: "processing" }));
    let time = 0;
    const transcriber = createAssemblyAiTranscriber({
      apiKey: "secret-key",
      fetchImpl,
      timeoutMs: 25,
      now: () => (time += 10),
      sleep: vi.fn(async () => undefined),
    });

    const result = await transcriber.transcribe({
      audio: new Uint8Array([1]),
      contentType: "audio/mp4",
      keyterms: [],
    });

    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});
