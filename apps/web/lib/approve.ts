import type { Storyboard } from "@reel/core";
import { checkStoryboard } from "./storyboard-edit";

const ACTIVE_JOB_ERROR = "A job for this reel is already queued or running.";

export type Result = { ok: true } | { ok: false; errors: string[] };

export interface StoryboardWriteDeps {
  /** Updates a storyboard only while it is a draft; returns the number of rows changed (0 or 1). */
  updateDraft(storyboardId: string, json: Storyboard, status: "draft" | "approved"): Promise<number>;
  queueGenerate(projectId: string, storyboardId: string): Promise<void>;
  setProjectStatus(projectId: string, status: "draft" | "generating"): Promise<void>;
  activeJobCount(projectId: string): Promise<number>;
  insertDraft(projectId: string, version: number, json: Storyboard): Promise<void>;
  maxVersion(projectId: string): Promise<number>;
}

export async function saveDraft(deps: StoryboardWriteDeps, input: { storyboardId: string; json: unknown }): Promise<Result> {
  const check = checkStoryboard(input.json);
  if (!check.ok) return check;
  const updated = await deps.updateDraft(input.storyboardId, check.storyboard, "draft");
  return updated ? { ok: true } : { ok: false, errors: ["Only draft storyboards can be edited. Use “Edit as new version”."] };
}

export async function approveStoryboard(deps: StoryboardWriteDeps, input: { projectId: string; storyboardId: string; json: unknown }): Promise<Result> {
  const check = checkStoryboard(input.json);
  if (!check.ok) return check;
  // An approved row cannot be reverted by the web user (RLS), so refuse before writing if a job is already active.
  if ((await deps.activeJobCount(input.projectId)) > 0) return { ok: false, errors: [ACTIVE_JOB_ERROR] };
  // The draft→approved update is the lock: concurrent approvals serialize on the row and only one sees status='draft'.
  const updated = await deps.updateDraft(input.storyboardId, check.storyboard, "approved");
  if (!updated) return { ok: false, errors: ["This storyboard was already approved. Refresh the page."] };
  await deps.queueGenerate(input.projectId, input.storyboardId);
  await deps.setProjectStatus(input.projectId, "generating");
  return { ok: true };
}

export async function retryGenerate(deps: StoryboardWriteDeps, input: { projectId: string; storyboardId: string }): Promise<Result> {
  if ((await deps.activeJobCount(input.projectId)) > 0) return { ok: false, errors: [ACTIVE_JOB_ERROR] };
  await deps.queueGenerate(input.projectId, input.storyboardId);
  await deps.setProjectStatus(input.projectId, "generating");
  return { ok: true };
}

export async function newDraftFrom(deps: StoryboardWriteDeps, input: { projectId: string; json: unknown }): Promise<Result> {
  const check = checkStoryboard(input.json);
  if (!check.ok) return check;
  const version = (await deps.maxVersion(input.projectId)) + 1;
  await deps.insertDraft(input.projectId, version, { ...check.storyboard, version });
  await deps.setProjectStatus(input.projectId, "draft");
  return { ok: true };
}
