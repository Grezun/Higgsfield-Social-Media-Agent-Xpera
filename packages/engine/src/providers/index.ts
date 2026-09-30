import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { requireRealCredentials, type EngineConfig } from "../config";
import { claudeDraftModel, createPlanner } from "../planner";
import { ElevenLabsVoice, sdkElevenLabs } from "./elevenlabs";
import { FilePendingStore } from "../pending-store";
import { createFakeProviders } from "./fake";
import { httpHiggsfieldApi } from "./higgsfield-api";
import { HiggsfieldGateway, HiggsfieldImageGen, HiggsfieldUploader, HiggsfieldVideoGen } from "./higgsfield";
import type { Planner, Providers } from "./types";

export function createProviders(config: EngineConfig, workDir: string, opts?: { log?: (m: string) => void }): Providers {
  if (config.providers === "fake") return createFakeProviders({ workDir });
  requireRealCredentials(config);
  const credentials = config.higgsfield.credentials!;
  const api = httpHiggsfieldApi(credentials, config.higgsfield.baseUrl);
  const pending = new FilePendingStore(path.join(config.cacheDir, "pending"));
  const gateway = new HiggsfieldGateway(api, pending, config.higgsfield.concurrency, { log: opts?.log ?? ((m) => console.log(m)) });
  return {
    image: new HiggsfieldImageGen(gateway, config.higgsfield.imageModel),
    video: new HiggsfieldVideoGen(gateway, config.higgsfield.videoModel, config.higgsfield.videoResolution, config.higgsfield.maxWaitMinutes * 60_000),
    uploader: new HiggsfieldUploader(credentials, config.higgsfield.baseUrl),
    voice: new ElevenLabsVoice(sdkElevenLabs(config.elevenlabs.apiKey!)),
  };
}

/** Planning needs only Claude, so it doesn't require Higgsfield/ElevenLabs keys. */
export function createPlannerFor(config: EngineConfig, workDir: string): Planner {
  if (config.providers === "fake") return createFakeProviders({ workDir }).planner;
  return createPlanner(claudeDraftModel(new Anthropic(), config.claudeModel));
}
