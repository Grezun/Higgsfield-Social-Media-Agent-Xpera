export type PipelineStep = "voice" | "visuals" | "render" | "export";

/** Progress events emitted by the engine pipeline; the worker folds them into the job's progress JSON. */
export type PipelineEvent =
  | { type: "step"; step: PipelineStep; status: "running" | "done" }
  | { type: "scene"; sceneId: string; status: "running" | "done" | "failed"; reason?: string }
  | { type: "render-progress"; progress: number };
