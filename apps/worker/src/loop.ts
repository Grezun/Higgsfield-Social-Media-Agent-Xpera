import type { JobProgress, JobRow, JobType } from "@reel/db";
import type { JobOutcome, JobQueue } from "./queue";

export type JobContext = { report(progress: JobProgress): void; log(msg: string): void };
export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<JobOutcome>;
export type Handlers = Record<JobType, JobHandler>;
export type LoopOptions = { workerId: string; heartbeatMs?: number; progressThrottleMs?: number; log?: (msg: string) => void };

/** Sends at most one progress write per interval, always the latest value; flush() sends any pending value. */
export function createThrottledReporter(send: (p: JobProgress) => Promise<void>, intervalMs: number, log: (m: string) => void = () => {}) {
  let pending: JobProgress | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const sendPending = () => {
    timer = null;
    if (!pending) return;
    const value = pending;
    pending = null;
    chain = chain.then(() => send(value)).catch((err) => log(`progress write failed: ${err instanceof Error ? err.message : err}`));
  };
  return {
    report(progress: JobProgress) {
      pending = progress;
      timer ??= setTimeout(sendPending, intervalMs);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      sendPending();
      await chain;
    },
  };
}

export async function processNextJob(queue: JobQueue, handlers: Handlers, opts: LoopOptions): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const job = await queue.claim(opts.workerId);
  if (!job) return false;
  log(`job ${job.id} (${job.type}) started, attempt ${job.attempts}`);
  const reporter = createThrottledReporter((p) => queue.setProgress(job.id, p), opts.progressThrottleMs ?? 1000, log);
  const beat = setInterval(() => {
    queue.heartbeat(job.id).catch((err) => log(`heartbeat failed: ${err instanceof Error ? err.message : err}`));
  }, opts.heartbeatMs ?? 15_000);
  let outcome: JobOutcome;
  try {
    const handler = (handlers as Record<string, JobHandler | undefined>)[job.type];
    if (!handler) throw new Error(`unknown job type "${job.type}"`);
    outcome = await handler(job, { report: (p) => reporter.report(p), log });
  } catch (err) {
    outcome = { status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(beat);
    await reporter.flush();
  }
  await queue.finish(job.id, outcome);
  log(`job ${job.id} ${outcome.status}${outcome.status === "done" ? "" : `: ${outcome.error}`}`);
  return true;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

export async function runWorker(
  queue: JobQueue,
  handlers: Handlers,
  opts: LoopOptions & { pollMs: number; signal: AbortSignal; staleSeconds?: number },
): Promise<void> {
  const log = opts.log ?? (() => {});
  const requeued = await queue.requeueStale(opts.staleSeconds ?? 120);
  if (requeued) log(`requeued ${requeued} stale job(s) from a stopped worker`);
  while (!opts.signal.aborted) {
    let worked = false;
    try {
      worked = await processNextJob(queue, handlers, opts);
    } catch (err) {
      log(`queue error: ${err instanceof Error ? err.message : err}`);
    }
    if (!worked && !opts.signal.aborted) await sleep(opts.pollMs, opts.signal);
  }
}
