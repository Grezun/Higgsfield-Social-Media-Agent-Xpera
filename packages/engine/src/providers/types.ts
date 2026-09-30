import type { Language, Storyboard, Word } from "@reel/core";

export type GenResult = { url: string; requestId: string };

export interface ImageGen {
  readonly model: string;
  generate(req: { prompt: string }): Promise<GenResult>;
}

export interface VideoGen {
  readonly model: string;
  imageToVideo(req: { imageUrl: string; prompt: string; durationSec: number }): Promise<GenResult>;
}

export interface MediaUploader {
  /** Uploads bytes and returns a public HTTPS URL a provider can read. */
  upload(data: Buffer, contentType: string): Promise<string>;
}

export type VoiceRequest = { text: string; voiceId: string; modelId: string; language: Language; stability?: number; style?: number };
export type VoiceResult = { audio: Buffer; ext: "mp3" | "wav"; words: Word[]; requestId?: string; timingSource: "alignment" | "transcription" };

export interface VoiceGen {
  synthesize(req: VoiceRequest): Promise<VoiceResult>;
}

export type PlanRequest = {
  brief: string;
  language: Language;
  targetDurationSec: 15 | 30 | 45 | 60;
  pacing: "calm" | "punchy";
  captionPreset: "bold_pop" | "clean";
  palette: string[];
  voice: { voiceId: string; modelId: string };
};

export interface Planner {
  plan(req: PlanRequest): Promise<Storyboard>;
}

export type Providers = { image: ImageGen; video: VideoGen; uploader: MediaUploader; voice: VoiceGen };
