import type { JobProgress, JobRow, ProjectStatus } from "@reel/db";
import { readFile, writeFile } from "node:fs/promises";
import type { JobOutcome, JobQueue } from "../queue";
import type { ReelDb, StoryboardRecord } from "../reel-db";
import type { AssetIndex, AssetRecord, BlobStore } from "../storage";

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

export class InMemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Buffer>();
  async upload(bucket: string, path: string, filePath: string) {
    this.objects.set(`${bucket}/${path}`, await readFile(filePath));
  }
  async download(bucket: string, path: string, destPath: string) {
    const data = this.objects.get(`${bucket}/${path}`);
    if (!data) throw new Error(`object not found: ${bucket}/${path}`);
    await writeFile(destPath, data);
  }
}

export class InMemoryAssetIndex implements AssetIndex {
  readonly records = new Map<string, AssetRecord>();
  finds = 0;
  async find(hash: string) {
    this.finds++;
    return this.records.get(hash) ?? null;
  }
  async insert(record: AssetRecord) {
    if (!this.records.has(record.inputHash)) this.records.set(record.inputHash, record);
  }
}

export class InMemoryReelDb implements ReelDb {
  readonly storyboards: StoryboardRecord[] = [];
  readonly renders: Parameters<ReelDb["insertRender"]>[0][] = [];
  readonly projectStatus = new Map<string, { status: ProjectStatus; title?: string }>();

  async nextStoryboardVersion(projectId: string) {
    return Math.max(0, ...this.storyboards.filter((s) => s.projectId === projectId).map((s) => s.version)) + 1;
  }
  async insertStoryboard(input: Parameters<ReelDb["insertStoryboard"]>[0]) {
    const id = crypto.randomUUID();
    this.storyboards.push({ id, projectId: input.projectId, version: input.version, json: input.json, status: "draft" });
    return id;
  }
  async getStoryboard(id: string) {
    return this.storyboards.find((s) => s.id === id) ?? null;
  }
  async setProjectStatus(projectId: string, status: ProjectStatus, title?: string) {
    this.projectStatus.set(projectId, { status, ...(title ? { title } : {}) });
  }
  async hasRender(storyboardId: string) {
    return this.renders.some((r) => r.storyboardId === storyboardId);
  }
  async insertRender(input: Parameters<ReelDb["insertRender"]>[0]) {
    this.renders.push(input);
  }
}
