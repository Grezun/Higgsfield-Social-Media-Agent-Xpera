import { parseStoryboard, type Storyboard } from "@reel/core";
import { checkStoryboard } from "./storyboard-edit";

const ACTIVE_JOB_ERROR = "A job for this reel is already queued or running.";
const WRONG_PROJECT_ERROR = "This storyboard doesn't belong to this reel. Refresh the page.";

export type Result = { ok: true } | { ok: false; errors: string[] };

export interface StoryboardRow {
  projectId: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  json: unknown;
}

export interface StoryboardWriteDeps {
  getStoryboard(storyboardId: string): Promise<StoryboardRow | null>;
  /** Updates a storyboard only while it is a draft of this project; returns the number of rows changed (0 or 1). */
  updateDraft(projectId: string, storyboardId: string, json: Storyboard, status: "draft" | "approved"): Promise<number>;
  queueGenerate(projectId: string, storyboardId: string): Promise<void>;
  setProjectStatus(projectId: string, status: "draft" | "generating"): Promise<void>;
  activeJobCount(projectId: string): Promise<number>;
  hasDoneGenerate(storyboardId: string): Promise<boolean>;
  insertDraft(projectId: string, version: number, json: Storyboard): Promise<void>;
  maxVersion(projectId: string): Promise<number>;
}

const fail = (message: string): Result => ({ ok: false, errors: [message] });

type Prepared = { ok: true; row: StoryboardRow; json: Storyboard } | { ok: false; errors: string[] };

/** Loads the stored row and validates client JSON; identity fields always come from the server row. */
async function prepare(deps: StoryboardWriteDeps, projectId: string, storyboardId: string, clientJson: unknown): Promise<Prepared> {
  const row = await deps.getStoryboard(storyboardId);
  if (!row || row.projectId !== projectId) return fail(WRONG_PROJECT_ERROR) as Prepared;
  const checked = checkStoryboard(clientJson);
  if (!checked.ok) return checked;
  let stored: Storyboard;
  try {
    stored = parseStoryboard(row.json);
  } catch {
    return fail("The stored storyboard is invalid and can't be edited.") as Prepared;
  }
  const json: Storyboard = { ...checked.storyboard, version: row.version, voice: stored.voice, format: stored.format, aspect: stored.aspect };
  return { ok: true, row, json };
}

export async function saveDraft(deps: StoryboardWriteDeps, input: { projectId: string; storyboardId: string; json: unknown }): Promise<Result> {
  const p = await prepare(deps, input.projectId, input.storyboardId, input.json);
  if (!p.ok) return p;
  const updated = await deps.updateDraft(input.projectId, input.storyboardId, p.json, "draft");
  return updated ? { ok: true } : fail("Only draft storyboards can be edited. Use “Edit as new version”.");
}

export async function approveStoryboard(deps: StoryboardWriteDeps, input: { projectId: string; storyboardId: string; json: unknown }): Promise<Result> {
  const p = await prepare(deps, input.projectId, input.storyboardId, input.json);
  if (!p.ok) return p;
  // An approved row cannot be reverted by the web user (RLS), so refuse before writing if a job is already active.
  if ((await deps.activeJobCount(input.projectId)) > 0) return fail(ACTIVE_JOB_ERROR);
  // The draft→approved update is the lock: concurrent approvals serialize on the row and only one sees status='draft'.
  const updated = await deps.updateDraft(input.projectId, input.storyboardId, p.json, "approved");
  if (!updated) return fail("This storyboard was already approved. Refresh the page.");
  try {
    await deps.queueGenerate(input.projectId, input.storyboardId);
    await deps.setProjectStatus(input.projectId, "generating");
  } catch {
    return fail("Approved, but queuing failed — use “Retry generation”.");
  }
  return { ok: true };
}

export async function retryGenerate(deps: StoryboardWriteDeps, input: { projectId: string; storyboardId: string }): Promise<Result> {
  if ((await deps.activeJobCount(input.projectId)) > 0) return fail(ACTIVE_JOB_ERROR);
  const row = await deps.getStoryboard(input.storyboardId);
  if (!row || row.projectId !== input.projectId || row.status !== "approved") return fail("Only an approved storyboard can be generated.");
  if (row.version !== (await deps.maxVersion(input.projectId))) return fail("A newer version exists — approve that one instead.");
  if (await deps.hasDoneGenerate(input.storyboardId)) return fail("This version was already generated. Use “Edit as new version” to make changes.");
  await deps.queueGenerate(input.projectId, input.storyboardId);
  await deps.setProjectStatus(input.projectId, "generating");
  return { ok: true };
}

export async function newDraftFrom(deps: StoryboardWriteDeps, input: { projectId: string; sourceStoryboardId: string }): Promise<Result> {
  if ((await deps.activeJobCount(input.projectId)) > 0) return fail("Wait for the current job to finish before editing.");
  const row = await deps.getStoryboard(input.sourceStoryboardId);
  if (!row || row.projectId !== input.projectId) return fail(WRONG_PROJECT_ERROR);
  let stored: Storyboard;
  try {
    stored = parseStoryboard(row.json);
  } catch {
    return fail("The stored storyboard is invalid and can't be copied.");
  }
  const version = (await deps.maxVersion(input.projectId)) + 1;
  try {
    await deps.insertDraft(input.projectId, version, { ...stored, version });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("23505") || message.includes("duplicate key")) return fail("A newer version already exists. Refresh the page.");
    throw err;
  }
  await deps.setProjectStatus(input.projectId, "draft");
  return { ok: true };
}
