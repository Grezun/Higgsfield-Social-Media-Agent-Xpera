"use server";
import { redirect } from "next/navigation";
import { createReelFromForm } from "@/lib/create-reel";
import { parsePlanForm } from "@/lib/plan-form";
import { createClient } from "@/lib/supabase/server";

export type NewReelState = { errors?: string[] };

export async function createReel(_prev: NewReelState, formData: FormData): Promise<NewReelState> {
  const parsed = parsePlanForm(formData);
  if (!parsed.ok) return { errors: parsed.errors };
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return { errors: ["Your session expired. Sign in again."] };

  const { form } = parsed;
  const result = await createReelFromForm(
    {
      async insertProject(input) {
        const { data, error } = await supabase
          .from("projects")
          .insert({ title: input.title, language: input.language, format: "faceless", status: "planning" })
          .select("id")
          .single();
        if (error || !data) return { error: error?.message ?? "unknown error" };
        return { id: data.id };
      },
      async insertPlanJob(projectId, payload) {
        const { error } = await supabase.from("jobs").insert({ project_id: projectId, type: "plan", payload });
        return error ? { error: error.message, code: error.code } : { ok: true };
      },
      async markProjectFailed(projectId) {
        await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
      },
    },
    form,
  );
  if (!result.ok) return { errors: result.errors };
  redirect(`/projects/${result.projectId}`);
}
