import type { Database } from "@reel/db";
import type { SupabaseClient } from "@supabase/supabase-js";

type Client = SupabaseClient<Database>;

export async function listProjects(sb: Client) {
  const { data, error } = await sb.from("projects").select("id, title, language, format, status, updated_at").order("updated_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return data;
}

export async function getProjectView(sb: Client, id: string) {
  const [project, storyboard, job, render] = await Promise.all([
    sb.from("projects").select("*").eq("id", id).maybeSingle(),
    sb.from("storyboards").select("*").eq("project_id", id).order("version", { ascending: false }).limit(1).maybeSingle(),
    sb.from("jobs").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("renders").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const r of [project, storyboard, job, render]) if (r.error) throw new Error(r.error.message);
  if (!project.data) return null;
  return { project: project.data, storyboard: storyboard.data, job: job.data, render: render.data };
}
