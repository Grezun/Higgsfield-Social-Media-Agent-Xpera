import type { JobProgress, JobRow, JobType } from "@reel/db";
import type { JobOutcome, JobQueue } from "./queue";

export type JobContext = { report(progress: JobProgress): void; log(msg: string): void };
export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<JobOutcome>;
export type Handlers = Record<JobType, JobHandler>;
export type LoopOptions = { workerId: string; heartbeatMs?: number; progressThrottleMs?: number; finishRetryDelaysMs?: number[]; requeueEveryMs?: number; log?: (msg: string) => void };

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
  let lost = false;
  const beat = setInterval(() => {
    queue.heartbeat(job.id).then(
      (owned) => {
        if (owned || lost) return;
        lost = true;
        clearInterval(beat);
        log(`lost ownership of job ${job.id} (requeued elsewhere); its result will be discarded`);
      },
      (err) => log(`heartbeat failed: ${err instanceof Error ? err.message : err}`),
    );
  }, opts.heartbeatMs ?? 15_000);
  let outcome: JobOutcome;
  try {
    const handler = Object.hasOwn(handlers, job.type) ? (handlers as Record<string, JobHandler>)[job.type] : undefined;
    if (!handler) throw new Error(`unknown job type "${job.type}"`);
    outcome = await handler(job, { report: (p) => reporter.report(p), log });
  } catch (err) {
    outcome = { status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(beat);
    await reporter.flush();
  }
  const delays = opts.finishRetryDelaysMs ?? [500, 1000];
  let owned: boolean | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      owned = await queue.finish(job.id, outcome);
      break;
    } catch (err) {
      log(`finish failed (attempt ${attempt + 1}): ${err instanceof Error ? err.message : err}`);
      if (attempt >= delays.length) break;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  if (owned === undefined) log(`job ${job.id} could not be finished; it stays running until requeued as stale`);
  else if (!owned) log(`job ${job.id} result discarded: this worker no longer owns it`);
  else log(`job ${job.id} ${outcome.status}${outcome.status === "done" ? "" : `: ${outcome.error}`}`);
  return true;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export async function runWorker(
  queue: JobQueue,
  handlers: Handlers,
  opts: LoopOptions & { pollMs: number; signal: AbortSignal; staleSeconds?: number },
): Promise<void> {
  const log = opts.log ?? (() => {});
  const staleSeconds = opts.staleSeconds ?? 120;
  const requeueStale = async () => {
    const requeued = await queue.requeueStale(staleSeconds);
    if (requeued) log(`requeued ${requeued} stale job(s) from a stopped worker`);
  };
  await requeueStale();
  let lastRequeue = Date.now();
  while (!opts.signal.aborted) {
    if (Date.now() - lastRequeue >= (opts.requeueEveryMs ?? 60_000)) {
      lastRequeue = Date.now();
      try {
        await requeueStale();
      } catch (err) {
        log(`requeue error: ${err instanceof Error ? err.message : err}`);
      }
    }
    let worked = false;
    try {
      worked = await processNextJob(queue, handlers, opts);
    } catch (err) {
      log(`queue error: ${err instanceof Error ? err.message : err}`);
    }
    if (!worked && !opts.signal.aborted) await sleep(opts.pollMs, opts.signal);
  }
}
