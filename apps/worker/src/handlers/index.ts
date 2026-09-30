import type { Handlers } from "../loop";
import { FAKE_VOICE_ID } from "../fake-voice";
import { createGenerateHandler, type GenerateHandlerDeps } from "./generate";
import { createPlanHandler, type PlanHandlerDeps } from "./plan";

export type BuildHandlersDeps = {
  mode: "real" | "fake";
  planner: PlanHandlerDeps["planner"];
  providers: GenerateHandlerDeps["providers"];
  store: GenerateHandlerDeps["store"];
  blobs: GenerateHandlerDeps["blobs"];
  db: GenerateHandlerDeps["db"];
  voices: PlanHandlerDeps["voices"];
  voiceModelId: string;
  spendCapUsd: number;
  costModels: GenerateHandlerDeps["costModels"];
};

/** Fake workers only plan and generate with the fake voice; real workers refuse storyboards that use it. */
export function buildHandlers(deps: BuildHandlersDeps): Handlers {
  const fake = deps.mode === "fake";
  return {
    plan: createPlanHandler({
      planner: deps.planner, db: deps.db, voices: deps.voices, voiceModelId: deps.voiceModelId,
      ...(fake ? { forceVoiceId: FAKE_VOICE_ID } : {}),
    }),
    generate: createGenerateHandler({
      providers: deps.providers, store: deps.store, blobs: deps.blobs, db: deps.db,
      spendCapUsd: deps.spendCapUsd, costModels: deps.costModels,
      ...(fake ? { requireVoiceId: FAKE_VOICE_ID } : { forbidVoiceId: FAKE_VOICE_ID }),
    }),
  };
}
