"use server";
import type { Json } from "@reel/db";
import { revalidatePath } from "next/cache";
import { approveStoryboard, newDraftFrom, retryGenerate, saveDraft, type Result, type StoryboardWriteDeps } from "@/lib/approve";
import { createClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createClient>>;

function depsFor(sb: Client): StoryboardWriteDeps {
  const must = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  return {
    async updateDraft(id, json, status) {
      const { data, error } = await sb.from("storyboards").update({ json: json as unknown as Json, status }).eq("id", id).eq("status", "draft").select("id");
      must("storyboard update", error);
      return data?.length ?? 0;
    },
    async queueGenerate(projectId, storyboardId) {
      const { error } = await sb.from("jobs").insert({ project_id: projectId, type: "generate", payload: { storyboardId } });
      if (error?.code === "23505") throw new Error("A job for this reel is already queued or running.");
      must("queue generate", error);
    },
    async setProjectStatus(projectId, status) {
      const { error } = await sb.from("projects").update({ status }).eq("id", projectId);
      must("project status", error);
    },
    async activeJobCount(projectId) {
      const { count, error } = await sb.from("jobs").select("id", { count: "exact", head: true }).eq("project_id", projectId).in("status", ["queued", "running"]);
      must("job lookup", error);
      return count ?? 0;
    },
    async insertDraft(projectId, version, json) {
      const { error } = await sb.from("storyboards").insert({ project_id: projectId, version, json: json as unknown as Json, status: "draft", created_by: "user" });
      must("new draft", error);
    },
    async maxVersion(projectId) {
      const { data, error } = await sb.from("storyboards").select("version").eq("project_id", projectId).order("version", { ascending: false }).limit(1).maybeSingle();
      must("version lookup", error);
      return data?.version ?? 0;
    },
  };
}

async function run(projectId: string, fn: (deps: StoryboardWriteDeps) => Promise<Result>): Promise<Result> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return { ok: false, errors: ["Your session expired. Sign in again."] };
  try {
    return await fn(depsFor(supabase));
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  } finally {
    revalidatePath(`/projects/${projectId}`);
  }
}

export async function saveStoryboardAction(projectId: string, storyboardId: string, json: unknown) {
  return run(projectId, (deps) => saveDraft(deps, { storyboardId, json }));
}
export async function approveStoryboardAction(projectId: string, storyboardId: string, json: unknown) {
  return run(projectId, (deps) => approveStoryboard(deps, { projectId, storyboardId, json }));
}
export async function retryGenerateAction(projectId: string, storyboardId: string) {
  return run(projectId, (deps) => retryGenerate(deps, { projectId, storyboardId }));
}
export async function editAsNewVersionAction(projectId: string, json: unknown) {
  return run(projectId, (deps) => newDraftFrom(deps, { projectId, json }));
}
