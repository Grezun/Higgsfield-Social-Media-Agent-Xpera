import { describe, expect, it } from "vitest";
import { describeJob } from "./progress-view";

const job = (over: Record<string, unknown>) => ({ type: "generate", status: "running", progress: {}, error: null, ...over });

describe("describeJob", () => {
  it("returns null without a job", () => {
    expect(describeJob(null, [])).toBeNull();
  });
  it("describes planning", () => {
    expect(describeJob(job({ type: "plan", status: "running" }), [])).toMatchObject({ headline: "Claude is writing the storyboard…", tone: "info", steps: [] });
    expect(describeJob(job({ type: "plan", status: "failed", error: "No voice for he" }), [])).toMatchObject({ tone: "error", error: "No voice for he" });
  });
  it("maps generate progress to steps, scene states and render percent", () => {
    const view = describeJob(
      job({ progress: { steps: { voice: "done", visuals: "done", render: "running" }, scenes: { s1: { status: "done" } }, renderProgress: 0.456 } }),
      ["s1", "s2"],
    )!;
    expect(view.steps.map((s) => `${s.key}:${s.state}`)).toEqual(["voice:done", "visuals:done", "render:running", "export:pending"]);
    expect(view.scenes).toEqual([{ id: "s1", state: "done" }, { id: "s2", state: "pending" }]);
    expect(view.renderPercent).toBe(46);
  });
  it("explains needs_attention with the failing scene reasons", () => {
    const view = describeJob(
      job({ status: "needs_attention", error: "1 scene(s) failed", progress: { scenes: { s2: { status: "failed", reason: "blocked by content moderation" } } } }),
      ["s2"],
    )!;
    expect(view.tone).toBe("warning");
    expect(view.headline).toMatch(/fix their prompts/);
    expect(view.scenes[0]).toEqual({ id: "s2", state: "failed", reason: "blocked by content moderation" });
  });
  it("tolerates malformed progress JSON", () => {
    expect(describeJob(job({ progress: { steps: "nope" } }), ["s1"])!.steps.every((s) => s.state === "pending")).toBe(true);
  });
});
