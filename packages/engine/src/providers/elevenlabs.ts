import { ElevenLabsClient, ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import { alignmentToWords, PermanentProviderError, type CharacterAlignment, type Word } from "@reel/core";
import { withRetry } from "../retry";
import type { VoiceGen, VoiceRequest, VoiceResult } from "./types";

export type TtsBody = {
  text: string;
  modelId: string;
  languageCode: string;
  outputFormat: "mp3_44100_128";
  voiceSettings?: { stability?: number; style?: number };
};

export type ElevenLabsApi = {
  tts(voiceId: string, body: TtsBody): Promise<{ audioBase64: string; alignment?: CharacterAlignment | null }>;
  stt(audio: Buffer, languageCode: string): Promise<Word[]>;
};

export function sdkElevenLabs(apiKey: string): ElevenLabsApi {
  const client = new ElevenLabsClient({ apiKey });
  return {
    tts: async (voiceId, body) => await client.textToSpeech.convertWithTimestamps(voiceId, body),
    stt: async (audio, languageCode) => {
      const res = await client.speechToText.convert({
        modelId: "scribe_v2",
        file: new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }),
        languageCode,
        timestampsGranularity: "word",
      });
      if (!("words" in res)) throw new Error("Unexpected speech-to-text response (no words)");
      return res.words
        .filter((w) => w.type === "word" && w.start !== undefined && w.end !== undefined)
        .map((w) => ({ text: w.text.trim(), startMs: Math.round(w.start! * 1000), endMs: Math.round(w.end! * 1000) }))
        .filter((w) => w.text.length > 0);
    },
  };
}

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"]);

export function isTransientElevenLabsError(err: unknown): boolean {
  if (err instanceof ElevenLabsError) {
    const status = err.statusCode ?? 0;
    return status === 429 || status >= 500;
  }
  return NETWORK_CODES.has((err as { code?: string } | null)?.code ?? "");
}

export class ElevenLabsVoice implements VoiceGen {
  constructor(private readonly api: ElevenLabsApi, private readonly opts: { sleep?: (ms: number) => Promise<void> } = {}) {}

  async synthesize(req: VoiceRequest): Promise<VoiceResult> {
    const retry = { attempts: 3, baseDelayMs: 2000, isTransient: isTransientElevenLabsError, sleep: this.opts.sleep };
    const body: TtsBody = {
      text: req.text,
      modelId: req.modelId, // always explicit: the API default model has no Hebrew
      languageCode: req.language,
      outputFormat: "mp3_44100_128",
    };
    if (req.stability !== undefined || req.style !== undefined) body.voiceSettings = { stability: req.stability, style: req.style };

    const res = await withRetry(() => this.api.tts(req.voiceId, body), retry);
    const audio = Buffer.from(res.audioBase64, "base64");
    if (audio.length === 0) throw new PermanentProviderError("ElevenLabs returned empty audio", "elevenlabs");

    if (res.alignment && res.alignment.characters.length > 0) {
      return { audio, ext: "mp3", words: alignmentToWords(res.alignment), timingSource: "alignment" };
    }
    const words = await withRetry(() => this.api.stt(audio, req.language), retry);
    return { audio, ext: "mp3", words, timingSource: "transcription" };
  }
}
