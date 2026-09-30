import type { JobProgress, JobRow } from "@reel/db";
import type { JobOutcome, JobQueue } from "../queue";

export function makeJob(partial: Partial<JobRow> = {}): JobRow {
  return {
    id: partial.id ?? crypto.randomUUID(),
    project_id: "p1",
    type: "plan",
    status: "queued",
    payload: {},
    progress: {},
    error: null,
    attempts: 0,
    locked_by: null,
    heartbeat_at: null,
    created_by: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    ...partial,
  };
}

/** In-memory JobQueue with the same claim/finish semantics as the SQL functions. */
export class FakeJobQueue implements JobQueue {
  readonly heartbeats: string[] = [];
  readonly progressWrites: { jobId: string; progress: JobProgress }[] = [];
  readonly finished: { jobId: string; outcome: JobOutcome }[] = [];
  requeueCalls: number[] = [];
  /** Jobs whose ownership was lost: heartbeat/finish return false. */
  readonly lostJobs = new Set<string>();
  /** Number of upcoming finish() calls that throw. */
  finishFailures = 0;
  finishAttempts = 0;
  constructor(public jobs: JobRow[] = []) {}

  async requeueStale(staleSeconds: number) {
    this.requeueCalls.push(staleSeconds);
    return 0;
  }
  async claim(workerId: string) {
    const job = this.jobs.find((j) => j.status === "queued");
    if (!job) return null;
    Object.assign(job, { status: "running", locked_by: workerId, attempts: job.attempts + 1 });
    return { ...job };
  }
  async heartbeat(jobId: string) {
    this.heartbeats.push(jobId);
    return !this.lostJobs.has(jobId);
  }
  async setProgress(jobId: string, progress: JobProgress) {
    this.progressWrites.push({ jobId, progress });
  }
  async finish(jobId: string, outcome: JobOutcome) {
    this.finishAttempts++;
    if (this.finishFailures > 0) {
      this.finishFailures--;
      throw new Error("finish failed");
    }
    if (this.lostJobs.has(jobId)) return false;
    this.finished.push({ jobId, outcome });
    const job = this.jobs.find((j) => j.id === jobId);
    if (job) Object.assign(job, { status: outcome.status, locked_by: null });
    return true;
  }
}
