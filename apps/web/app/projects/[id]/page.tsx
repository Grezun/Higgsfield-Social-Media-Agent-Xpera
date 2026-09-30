import { notFound, redirect } from "next/navigation";
import { JobPanel } from "@/components/JobPanel";
import { ReelPreview } from "@/components/ReelPreview";
import { StoryboardEditor } from "@/components/StoryboardEditor";
import { getProjectView } from "@/lib/queries";
import { signRender, supabaseSigningClient } from "@/lib/render-urls";
import { checkStoryboard } from "@/lib/storyboard-edit";
import { createClient } from "@/lib/supabase/server";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) redirect("/login");
  const view = await getProjectView(supabase, id);
  if (!view) notFound();
  const { project, storyboard, job } = view;
  const parsed = storyboard ? checkStoryboard(storyboard.json) : null;
  const canRetry =
    storyboard?.status === "approved" &&
    !(job && (job.status === "queued" || job.status === "running")) &&
    !(job?.type === "generate" && job.status === "done");
  const sceneIds = parsed?.ok ? parsed.storyboard.scenes.filter((s) => s.visual.kind !== "graphic").map((s) => s.id) : [];
  const signed =
    view.render && project.status === "rendered"
      ? await signRender(supabaseSigningClient(supabase), view.render).catch((err: Error) => ({ error: err.message }))
      : null;

  return (
    <main className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 dir="auto" style={{ margin: 0 }}>{project.title}</h1>
        <span className="badge">{project.status}</span>
      </div>
      <JobPanel projectId={project.id} initialJob={job} sceneIds={sceneIds} />
      {signed && "error" in signed && <p className="error">{signed.error}</p>}
      {signed && !("error" in signed) && <ReelPreview timeline={signed.timeline} reelUrl={signed.reelUrl} />}
      {storyboard && parsed?.ok && (
        <StoryboardEditor
          key={`${storyboard.id}:${storyboard.updated_at}`}
          projectId={project.id}
          storyboardId={storyboard.id}
          initial={parsed.storyboard}
          editable={storyboard.status === "draft"}
          canRetry={canRetry}
        />
      )}
      {storyboard && parsed && !parsed.ok && <p className="error">This storyboard can't be displayed: {parsed.errors.join("; ")}</p>}
      {!storyboard && <p className="muted">Claude is writing the storyboard…</p>}
    </main>
  );
}
