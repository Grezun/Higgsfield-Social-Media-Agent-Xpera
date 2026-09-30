"use client";
import type { JobRow } from "@reel/db";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { describeJob } from "@/lib/progress-view";
import { createClient } from "@/lib/supabase/client";

type JobLite = Pick<JobRow, "id" | "type" | "status" | "progress" | "error" | "created_at">;
const TERMINAL = new Set(["done", "needs_attention", "failed"]);
const ICON = { pending: "○", running: "◐", done: "●", failed: "✕" } as const;

export function JobPanel({ projectId, initialJob, sceneIds }: { projectId: string; initialJob: JobLite | null; sceneIds: string[] }) {
  const [job, setJob] = useState<JobLite | null>(initialJob);
  const router = useRouter();
  const lastStatus = useRef(initialJob?.status);

  useEffect(() => setJob(initialJob), [initialJob]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`jobs:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs", filter: `project_id=eq.${projectId}` }, (payload) => {
        const row = payload.new as Partial<JobLite>;
        if (!row?.id || !row.created_at) return;
        setJob((prev) => (!prev || row.created_at! >= prev.created_at ? (row as JobLite) : prev));
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  useEffect(() => {
    if (job && job.status !== lastStatus.current && TERMINAL.has(job.status)) router.refresh();
    lastStatus.current = job?.status;
  }, [job, router]);

  const view = describeJob(job, sceneIds);
  if (!view) return null;
  return (
    <section className="card stack" aria-live="polite">
      <strong className={view.tone === "error" ? "error" : view.tone === "warning" ? "warn" : undefined}>{view.headline}</strong>
      {view.steps.length > 0 && (
        <div className="row">
          {view.steps.map((s) => <span key={s.key} className="badge">{ICON[s.state]} {s.label}{s.key === "render" && view.renderPercent !== undefined ? ` ${view.renderPercent}%` : ""}</span>)}
        </div>
      )}
      {view.scenes.length > 0 && (
        <ul className="stack" style={{ margin: 0, paddingInlineStart: 18 }}>
          {view.scenes.map((s) => (
            <li key={s.id} className={s.state === "failed" ? "error" : undefined}>
              {ICON[s.state]} {s.id}{s.reason ? `: ${s.reason}` : ""}
            </li>
          ))}
        </ul>
      )}
      {view.error && view.tone === "error" && <p className="error" style={{ margin: 0 }}>{view.error}</p>}
    </section>
  );
}
