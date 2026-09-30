import { assertWithinCap, assetSrc, estimateCost, parseStoryboard, SceneFailuresError, type PipelineEvent } from "@reel/core";
import { applyPipelineEvent, BUCKETS, emptyProgress, GenerateJobPayloadSchema, renderPaths } from "@reel/db";
import { buildTimeline, generateAssets, renderAndExport, type AssetStore, type GeneratedAssets, type Providers } from "@reel/engine";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobHandler } from "../loop";
import type { ReelDb } from "../reel-db";
import type { BlobStore } from "../storage";

export type GenerateHandlerDeps = {
  providers: Providers;
  store: AssetStore;
  blobs: BlobStore;
  db: ReelDb;
  spendCapUsd: number;
  costModels: { image: string; video: string; voice: string };
  /** Fake mode: only accept storyboards using this voice id (see PlanHandlerDeps.forceVoiceId). */
  requireVoiceId?: string;
};

export function createGenerateHandler(deps: GenerateHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const { storyboardId } = GenerateJobPayloadSchema.parse(job.payload);
    const record = await deps.db.getStoryboard(storyboardId);
    if (!record || record.projectId !== job.project_id) throw new Error(`storyboard ${storyboardId} not found for this project`);
    if (record.status !== "approved") throw new Error("storyboard is not approved; approve it before generating");

    let progress = emptyProgress();
    const tmpDir = await mkdtemp(join(tmpdir(), "reel-job-"));
    try {
      const sb = parseStoryboard(record.json);
      if (deps.requireVoiceId && sb.voice?.voiceId !== deps.requireVoiceId) {
        throw new Error("this worker runs fake providers; the storyboard uses a real voice. Run the real worker, or plan a new reel with the fake worker");
      }
      assertWithinCap(estimateCost(sb, deps.costModels), deps.spendCapUsd);
      await deps.db.setProjectStatus(job.project_id, "generating");

      const onEvent = (e: PipelineEvent) => {
        progress = applyPipelineEvent(progress, e);
        ctx.report(progress);
      };
      const pipelineDeps = { providers: deps.providers, store: deps.store, tmpDir, log: ctx.log, onEvent };

      let gen: GeneratedAssets;
      try {
        gen = await generateAssets(sb, pipelineDeps);
      } catch (err) {
        if (!(err instanceof SceneFailuresError)) throw err;
        await deps.db.setProjectStatus(job.project_id, "needs_attention");
        return { status: "needs_attention", error: err.message, progress };
      }

      const out = await renderAndExport(sb, gen, pipelineDeps, join(tmpDir, "out"));
      const paths = renderPaths(job.project_id, sb.version);
      await deps.blobs.upload(BUCKETS.renders, paths.reel, out.reel, "video/mp4");
      await deps.blobs.upload(BUCKETS.renders, paths.preview, out.preview, "video/mp4");
      await deps.blobs.upload(BUCKETS.renders, paths.thumbnail, out.thumbnail, "image/jpeg");
      await deps.db.insertRender({
        projectId: job.project_id,
        storyboardId,
        storyboardVersion: sb.version,
        paths,
        timeline: buildTimeline(sb, gen, assetSrc),
      });
      await deps.db.setProjectStatus(job.project_id, "rendered");
      return { status: "done", progress };
    } catch (err) {
      await deps.db.setProjectStatus(job.project_id, "failed").catch(() => {});
      throw err;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  };
}
