import type { Database, JobProgress, JobRow, Json } from "@reel/db";
import type { SupabaseClient } from "@supabase/supabase-js";

export type JobOutcome =
  | { status: "done"; progress?: JobProgress }
  | { status: "needs_attention" | "failed"; error: string; progress?: JobProgress };

export interface JobQueue {
  requeueStale(staleSeconds: number): Promise<number>;
  claim(workerId: string): Promise<JobRow | null>;
  heartbeat(jobId: string): Promise<void>;
  setProgress(jobId: string, progress: JobProgress): Promise<void>;
  finish(jobId: string, outcome: JobOutcome): Promise<void>;
}

const fail = (what: string, message: string) => new Error(`${what} failed: ${message}`);

export class SupabaseJobQueue implements JobQueue {
  // Updates are scoped to locked_by = workerId so a worker whose job was requeued and re-claimed
  // by another worker cannot overwrite the new owner's row.
  constructor(private readonly sb: SupabaseClient<Database>, private readonly workerId: string) {}

  async requeueStale(staleSeconds: number): Promise<number> {
    const { data, error } = await this.sb.rpc("requeue_stale_jobs", { p_stale_seconds: staleSeconds });
    if (error) throw fail("requeue_stale_jobs", error.message);
    return data ?? 0;
  }

  async claim(workerId: string): Promise<JobRow | null> {
    const { data, error } = await this.sb.rpc("claim_job", { p_worker: workerId });
    if (error) throw fail("claim_job", error.message);
    return data?.[0] ?? null;
  }

  async heartbeat(jobId: string): Promise<void> {
    const { error } = await this.sb
      .from("jobs")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("locked_by", this.workerId);
    if (error) throw fail("heartbeat", error.message);
  }

  async setProgress(jobId: string, progress: JobProgress): Promise<void> {
    const { error } = await this.sb
      .from("jobs")
      .update({ progress: progress as Json })
      .eq("id", jobId)
      .eq("locked_by", this.workerId);
    if (error) throw fail("progress update", error.message);
  }

  async finish(jobId: string, outcome: JobOutcome): Promise<void> {
    const { error } = await this.sb
      .from("jobs")
      .update({
        status: outcome.status,
        error: outcome.status === "done" ? null : outcome.error,
        finished_at: new Date().toISOString(),
        locked_by: null,
        ...(outcome.progress ? { progress: outcome.progress as Json } : {}),
      })
      .eq("id", jobId)
      .eq("locked_by", this.workerId);
    if (error) throw fail("finish", error.message);
  }
}
