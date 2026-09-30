"use server";
import { redirect } from "next/navigation";
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
  const { data: project, error } = await supabase
    .from("projects")
    .insert({ title: form.brief.slice(0, 80), language: form.language, format: "faceless", status: "planning" })
    .select("id")
    .single();
  if (error || !project) return { errors: [`Couldn't create the reel: ${error?.message ?? "unknown error"}`] };

  const { error: jobError } = await supabase.from("jobs").insert({ project_id: project.id, type: "plan", payload: form });
  if (jobError) {
    if (jobError.code === "23505") return { errors: ["A job for this reel is already queued or running."] };
    return { errors: [`Couldn't start planning: ${jobError.message}`] };
  }
  redirect(`/projects/${project.id}`);
}
