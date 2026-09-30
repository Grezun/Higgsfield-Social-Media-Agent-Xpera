import { PlanJobPayloadSchema } from "@reel/db";
import type { Planner } from "@reel/engine";
import type { JobHandler } from "../loop";
import type { ReelDb } from "../reel-db";

export type PlanHandlerDeps = {
  planner: Planner;
  db: ReelDb;
  voices: { he?: string; en?: string };
  voiceModelId: string;
  /** Fake mode: always use this voice id so fake audio never shares a cache key with a real voice. */
  forceVoiceId?: string;
};

export function createPlanHandler(deps: PlanHandlerDeps): JobHandler {
  return async (job) => {
    try {
      const form = PlanJobPayloadSchema.parse(job.payload);
      const voiceId = deps.forceVoiceId ?? form.voiceId ?? deps.voices[form.language];
      if (!voiceId) {
        throw new Error(`No voice for ${form.language}: set ELEVENLABS_VOICE_${form.language.toUpperCase()} in the worker's .env.local or enter a voice id`);
      }
      const planned = await deps.planner.plan({
        brief: form.brief,
        language: form.language,
        targetDurationSec: form.targetDurationSec,
        pacing: form.pacing,
        captionPreset: form.captionPreset,
        palette: form.palette,
        voice: { voiceId, modelId: deps.voiceModelId },
      });
      const version = await deps.db.nextStoryboardVersion(job.project_id);
      const storyboard = { ...planned, version };
      await deps.db.insertStoryboard({ projectId: job.project_id, version, json: storyboard, createdBy: "agent" });
      await deps.db.setProjectStatus(job.project_id, "draft", storyboard.title);
      return { status: "done" };
    } catch (err) {
      await deps.db.setProjectStatus(job.project_id, "failed").catch(() => {});
      throw err;
    }
  };
}
