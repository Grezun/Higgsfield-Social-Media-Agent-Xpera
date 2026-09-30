import { emptyProgress, JobProgressSchema } from "@reel/db";

export type StepView = { key: "voice" | "visuals" | "render" | "export"; label: string; state: "pending" | "running" | "done" };
export type SceneView = { id: string; state: "pending" | "running" | "done" | "failed"; reason?: string };
export type ProgressView = {
  headline: string;
  tone: "info" | "success" | "warning" | "error";
  steps: StepView[];
  scenes: SceneView[];
  renderPercent?: number;
  error?: string;
};

type JobLike = { type: string; status: string; progress: unknown; error: string | null };

const STEPS: [StepView["key"], string][] = [["voice", "Voice"], ["visuals", "Visuals"], ["render", "Render"], ["export", "Export"]];

const PLAN_HEADLINES: Record<string, [string, ProgressView["tone"]]> = {
  queued: ["Waiting for a worker…", "info"],
  running: ["Claude is writing the storyboard…", "info"],
  done: ["Storyboard ready: review and approve it below.", "success"],
  failed: ["Planning failed.", "error"],
};
const GENERATE_HEADLINES: Record<string, [string, ProgressView["tone"]]> = {
  queued: ["Queued: waiting for a worker…", "info"],
  running: ["Generating your reel…", "info"],
  done: ["Your reel is ready.", "success"],
  needs_attention: ["Some scenes failed: fix their prompts, then retry. Finished scenes won't be charged again.", "warning"],
  failed: ["Generation failed.", "error"],
};

export function describeJob(job: JobLike | null, sceneIds: string[]): ProgressView | null {
  if (!job) return null;
  const progress = JobProgressSchema.catch(emptyProgress()).parse(job.progress);
  const [headline, tone] = (job.type === "plan" ? PLAN_HEADLINES : GENERATE_HEADLINES)[job.status] ?? [job.status, "info"];
  const view: ProgressView = { headline, tone, steps: [], scenes: [], ...(job.error ? { error: job.error } : {}) };
  if (job.type !== "generate") return view;
  view.steps = STEPS.map(([key, label]) => ({ key, label, state: progress.steps[key] ?? "pending" }));
  view.scenes = sceneIds.map((id) => {
    const s = progress.scenes[id];
    if (!s) return { id, state: "pending" as const };
    return s.reason ? { id, state: s.status, reason: s.reason } : { id, state: s.status };
  });
  if (progress.steps.render === "running" && progress.renderProgress !== undefined) view.renderPercent = Math.round(progress.renderProgress * 100);
  return view;
}
