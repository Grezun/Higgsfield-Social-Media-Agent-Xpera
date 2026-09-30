import { describe, expect, it } from "vitest";
import { applyPipelineEvent, emptyProgress, GenerateJobPayloadSchema, JobProgressSchema, renderPaths } from "./index";

describe("@reel/db", () => {
  it("folds pipeline events into job progress", () => {
    let p = emptyProgress();
    p = applyPipelineEvent(p, { type: "step", step: "voice", status: "running" });
    p = applyPipelineEvent(p, { type: "step", step: "voice", status: "done" });
    p = applyPipelineEvent(p, { type: "scene", sceneId: "s2", status: "failed", reason: "blocked" });
    p = applyPipelineEvent(p, { type: "render-progress", progress: 0.42 });
    expect(p).toEqual({
      steps: { voice: "done" },
      scenes: { s2: { status: "failed", reason: "blocked" } },
      renderProgress: 0.42,
    });
    expect(JobProgressSchema.parse(p)).toEqual(p);
  });

  it("does not mutate the input progress", () => {
    const p = emptyProgress();
    applyPipelineEvent(p, { type: "step", step: "voice", status: "running" });
    expect(p).toEqual(emptyProgress());
  });

  it("parses stored progress with defaults for missing keys", () => {
    expect(JobProgressSchema.parse({})).toEqual({ steps: {}, scenes: {} });
  });

  it("builds render storage paths per project version", () => {
    expect(renderPaths("p1", 3)).toEqual({ reel: "p1/v3/reel.mp4", preview: "p1/v3/preview.mp4", thumbnail: "p1/v3/thumbnail.jpg" });
  });

  it("validates generate payloads", () => {
    expect(GenerateJobPayloadSchema.safeParse({ storyboardId: "not-a-uuid" }).success).toBe(false);
    expect(GenerateJobPayloadSchema.parse({ storyboardId: "0b5f7a2e-8c2d-4b8a-9f3e-2a1c5d6e7f80" }).storyboardId).toBeTruthy();
  });
});
