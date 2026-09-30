import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS } from "@reel/core";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type EngineConfig = {
  providers: "real" | "fake";
  cacheDir: string;
  spendCapUsd: number;
  claudeModel: string;
  higgsfield: {
    credentials?: string;
    concurrency: number;
    imageModel: string;
    videoModel: string;
    videoResolution: "480p" | "720p" | "1080p";
    baseUrl: string;
  };
  elevenlabs: { apiKey?: string; modelId: string; voices: { he?: string; en?: string } };
};

export function loadEnvFile(): void {
  loadDotenv({ path: path.join(REPO_ROOT, ".env.local"), quiet: true });
}

const RESOLUTIONS = ["480p", "720p", "1080p"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: { providers?: "real" | "fake" } = {}): EngineConfig {
  const resolution = env.HF_VIDEO_RESOLUTION ?? "720p";
  if (!(RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new Error(`HF_VIDEO_RESOLUTION must be one of ${RESOLUTIONS.join(", ")} (got "${resolution}")`);
  }
  const cap = Number(env.REEL_SPEND_CAP_USD ?? "10");
  if (!Number.isFinite(cap) || cap <= 0) throw new Error(`REEL_SPEND_CAP_USD must be a positive number (got "${env.REEL_SPEND_CAP_USD}")`);
  const concurrency = Number(env.HF_CONCURRENCY ?? "4");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`HF_CONCURRENCY must be an integer ≥ 1 (got "${env.HF_CONCURRENCY}")`);
  return {
    providers: overrides.providers ?? "real",
    cacheDir: path.resolve(REPO_ROOT, env.REEL_CACHE_DIR ?? ".reel-cache"),
    spendCapUsd: cap,
    claudeModel: env.CLAUDE_MODEL ?? "claude-opus-5-5",
    higgsfield: {
      credentials: env.HF_CREDENTIALS || undefined,
      concurrency,
      imageModel: DEFAULT_MODELS.image,
      videoModel: DEFAULT_MODELS.video,
      videoResolution: resolution as EngineConfig["higgsfield"]["videoResolution"],
      baseUrl: env.HF_BASE_URL ?? "https://api.higgsfield.ai",
    },
    elevenlabs: {
      apiKey: env.ELEVENLABS_API_KEY || undefined,
      modelId: env.ELEVENLABS_MODEL_ID ?? DEFAULT_MODELS.voiceModelId,
      voices: { he: env.ELEVENLABS_VOICE_HE || undefined, en: env.ELEVENLABS_VOICE_EN || undefined },
    },
  };
}

export function requireRealCredentials(config: EngineConfig): void {
  const missing = [
    !config.higgsfield.credentials && "HF_CREDENTIALS",
    !config.elevenlabs.apiKey && "ELEVENLABS_API_KEY",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing in .env.local: ${missing.join(", ")} (or run with --fake)`);
}

export function costModels(config: EngineConfig) {
  return {
    image: config.higgsfield.imageModel,
    video: config.higgsfield.videoModel,
    voice: `elevenlabs/${config.elevenlabs.modelId}`,
  };
}
