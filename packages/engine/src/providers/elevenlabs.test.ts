import { ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import { describe, expect, it, vi } from "vitest";
import { ElevenLabsVoice, type ElevenLabsApi } from "./elevenlabs";

const REQ = { text: "שלום עולם", voiceId: "v1", modelId: "eleven_v4", language: "he" as const };
const alignmentFor = (text: string) => {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * 0.1),
  };
};
const audioBase64 = Buffer.from("mp3-bytes").toString("base64");
const noSleep = { sleep: async () => {} };

describe("ElevenLabsVoice", () => {
  it("sends eleven_v4 with the language code and returns words from the alignment", async () => {
    const api: ElevenLabsApi = {
      tts: vi.fn(async () => ({ audioBase64, alignment: alignmentFor(REQ.text) })),
      stt: vi.fn(),
    };
    const result = await new ElevenLabsVoice(api, noSleep).synthesize(REQ);
    expect(api.tts).toHaveBeenCalledWith("v1", { text: REQ.text, modelId: "eleven_v4", languageCode: "he", outputFormat: "mp3_44100_128" });
    expect(result.timingSource).toBe("alignment");
    expect(result.words.map((w) => w.text)).toEqual(["שלום", "עולם"]);
    expect(result.audio.toString()).toBe("mp3-bytes");
    expect(api.stt).not.toHaveBeenCalled();
  });

  it("falls back to Scribe transcription when the model returns no alignment", async () => {
    const words = [{ text: "שלום", startMs: 0, endMs: 400 }, { text: "עולם", startMs: 450, endMs: 900 }];
    const api: ElevenLabsApi = { tts: async () => ({ audioBase64, alignment: null }), stt: vi.fn(async () => words) };
    const result = await new ElevenLabsVoice(api, noSleep).synthesize(REQ);
    expect(result.timingSource).toBe("transcription");
    expect(result.words).toEqual(words);
    expect(api.stt).toHaveBeenCalledWith(expect.any(Buffer), "he");
  });

  it("passes voice settings only when provided", async () => {
    const api: ElevenLabsApi = { tts: vi.fn(async () => ({ audioBase64, alignment: alignmentFor("a") })), stt: vi.fn() };
    await new ElevenLabsVoice(api, noSleep).synthesize({ ...REQ, text: "a", stability: 0.4 });
    expect(api.tts).toHaveBeenCalledWith("v1", expect.objectContaining({ voiceSettings: { stability: 0.4, style: undefined } }));
  });

  it("retries 429 and 5xx, not 4xx", async () => {
    let calls = 0;
    const flaky: ElevenLabsApi = {
      tts: async () => {
        calls++;
        if (calls === 1) throw new ElevenLabsError({ message: "rate limited", statusCode: 429 });
        return { audioBase64, alignment: alignmentFor("a") };
      },
      stt: vi.fn(),
    };
    await new ElevenLabsVoice(flaky, noSleep).synthesize({ ...REQ, text: "a" });
    expect(calls).toBe(2);

    let badCalls = 0;
    const bad: ElevenLabsApi = {
      tts: async () => {
        badCalls++;
        throw new ElevenLabsError({ message: "invalid voice", statusCode: 400 });
      },
      stt: vi.fn(),
    };
    await expect(new ElevenLabsVoice(bad, noSleep).synthesize(REQ)).rejects.toThrow(/invalid voice/);
    expect(badCalls).toBe(1);
  });

  it("rejects empty audio", async () => {
    const api: ElevenLabsApi = { tts: async () => ({ audioBase64: "", alignment: null }), stt: vi.fn() };
    await expect(new ElevenLabsVoice(api, noSleep).synthesize(REQ)).rejects.toThrow(/empty audio/);
  });
});
