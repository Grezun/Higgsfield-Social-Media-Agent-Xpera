import type { PlanForm } from "@reel/core";

export interface CreateReelDeps {
  insertProject(input: { title: string; language: "he" | "en" }): Promise<{ id: string } | { error: string }>;
  insertPlanJob(projectId: string, payload: PlanForm): Promise<{ ok: true } | { error: string; code?: string }>;
  markProjectFailed(projectId: string): Promise<void>;
}

export async function createReelFromForm(
  deps: CreateReelDeps,
  form: PlanForm,
): Promise<{ ok: true; projectId: string } | { ok: false; errors: string[] }> {
  const title = Array.from(form.brief).slice(0, 80).join("");
  const project = await deps.insertProject({ title, language: form.language });
  if ("error" in project) return { ok: false, errors: [`Couldn't create the reel: ${project.error}`] };

  const job = await deps.insertPlanJob(project.id, form);
  if ("error" in job) {
    try {
      await deps.markProjectFailed(project.id);
    } catch {
      // best effort
    }
    if (job.code === "23505") return { ok: false, errors: ["A job for this reel is already queued or running."] };
    return { ok: false, errors: [`Couldn't start planning: ${job.error}`] };
  }
  return { ok: true, projectId: project.id };
}
