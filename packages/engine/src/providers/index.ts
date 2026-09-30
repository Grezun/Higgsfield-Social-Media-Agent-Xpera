import Anthropic from "@anthropic-ai/sdk";
import { requireRealCredentials, type EngineConfig } from "../config";
import { claudeDraftModel, createPlanner } from "../planner";
import { ElevenLabsVoice, sdkElevenLabs } from "./elevenlabs";
import { createFakeProviders } from "./fake";
import { HiggsfieldGateway, HiggsfieldImageGen, HiggsfieldUploader, HiggsfieldVideoGen, sdkSubscribe } from "./higgsfield";
import type { Planner, Providers } from "./types";

export function createProviders(config: EngineConfig, workDir: string): Providers {
  if (config.providers === "fake") return createFakeProviders({ workDir });
  requireRealCredentials(config);
  const credentials = config.higgsfield.credentials!;
  const gateway = new HiggsfieldGateway(sdkSubscribe(credentials), config.higgsfield.concurrency);
  return {
    image: new HiggsfieldImageGen(gateway, config.higgsfield.imageModel),
    video: new HiggsfieldVideoGen(gateway, config.higgsfield.videoModel, config.higgsfield.videoResolution),
    uploader: new HiggsfieldUploader(credentials, config.higgsfield.baseUrl),
    voice: new ElevenLabsVoice(sdkElevenLabs(config.elevenlabs.apiKey!)),
  };
}

/** Planning needs only Claude, so it doesn't require Higgsfield/ElevenLabs keys. */
export function createPlannerFor(config: EngineConfig, workDir: string): Planner {
  if (config.providers === "fake") return createFakeProviders({ workDir }).planner;
  return createPlanner(claudeDraftModel(new Anthropic(), config.claudeModel));
}
