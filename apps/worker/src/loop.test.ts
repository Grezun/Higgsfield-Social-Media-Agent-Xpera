import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import type { Handlers } from "./loop";
import { createThrottledReporter, processNextJob, runWorker } from "./loop";
import { FakeJobQueue, makeJob } from "./testing/fakes";

const noop = async () => ({ status: "done" as const });
const handlers = (over: Partial<Handlers> = {}): Handlers => ({ plan: noop, generate: noop, ...over });
const opts = { workerId: "w1", heartbeatMs: 5, progressThrottleMs: 5, finishRetryDelaysMs: [0, 0] };

describe("processNextJob", () => {
  it("returns false when nothing is queued", async () => {
    expect(await processNextJob(new FakeJobQueue(), handlers(), opts)).toBe(false);
  });

  it("runs the handler for the job type and records the outcome with the final progress flushed", async () => {
    const q = new FakeJobQueue([makeJob({ id: "j1", type: "generate" })]);
    const ran = await processNextJob(q, handlers({
      generate: async (_job, ctx) => {
        ctx.report({ steps: { voice: "running" }, scenes: {} });
        ctx.report({ steps: { voice: "done" }, scenes: {} });
        return { status: "done" };
      },
    }), opts);
    expect(ran).toBe(true);
    expect(q.finished).toEqual([{ jobId: "j1", outcome: { status: "done" } }]);
    expect(q.progressWrites.at(-1)?.progress).toEqual({ steps: { voice: "done" }, scenes: {} });
  });

  it("marks the job failed with the error message when the handler throws", async () => {
    const q = new FakeJobQueue([makeJob({ id: "j2" })]);
    await processNextJob(q, handlers({ plan: async () => { throw new Error("boom"); } }), opts);
    expect(q.finished[0].outcome).toEqual({ status: "failed", error: "boom" });
  });

  it("passes a needs_attention outcome through", async () => {
    const q = new FakeJobQueue([makeJob({ id: "j3", type: "generate" })]);
    await processNextJob(q, handlers({ generate: async () => ({ status: "needs_attention", error: "1 scene(s) failed" }) }), opts);
    expect(q.finished[0].outcome.status).toBe("needs_attention");
  });

  it("fails unknown job types", async () => {
    const q = new FakeJobQueue([makeJob({ id: "j4", type: "revise" })]);
    await processNextJob(q, handlers(), opts);
    expect(q.finished[0].outcome).toEqual({ status: "failed", error: 'unknown job type "revise"' });
  });

  it("heartbeats while the handler runs and stops afterwards", async () => {
    const q = new FakeJobQueue([makeJob({ id: "j5" })]);
    await processNextJob(q, handlers({ plan: async () => { await new Promise((r) => setTimeout(r, 40)); return { status: "done" }; } }), opts);
    const beats = q.heartbeats.length;
    expect(beats).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(q.heartbeats.length).toBe(beats);
  });
});

describe("createThrottledReporter", () => {
  it("coalesces rapid reports into the latest value", async () => {
    const sent: unknown[] = [];
    const r = createThrottledReporter(async (p) => void sent.push(p), 50);
    r.report({ steps: {}, scenes: { a: { status: "running" } } });
    r.report({ steps: {}, scenes: { a: { status: "done" } } });
    await r.flush();
    expect(sent).toEqual([{ steps: {}, scenes: { a: { status: "done" } } }]);
  });
});

describe("runWorker", () => {
  it("requeues stale jobs on start, processes queued jobs, and stops when aborted", async () => {
    const q = new FakeJobQueue([makeJob({ id: "a" }), makeJob({ id: "b" })]);
    const controller = new AbortController();
    let count = 0;
    await runWorker(q, handlers({
      plan: async () => {
        if (++count === 2) controller.abort();
        return { status: "done" };
      },
    }), { ...opts, pollMs: 10, signal: controller.signal });
    expect(q.requeueCalls).toEqual([120]);
    expect(q.finished.map((f) => f.jobId)).toEqual(["a", "b"]);
  });

  it("leaves no abort listeners behind after idle polls", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    await runWorker(new FakeJobQueue(), handlers(), { ...opts, pollMs: 1, signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("requeues stale jobs periodically", async () => {
    const q = new FakeJobQueue();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    await runWorker(q, handlers(), { ...opts, pollMs: 10, requeueEveryMs: 5, signal: controller.signal });
    expect(q.requeueCalls.length).toBeGreaterThan(1);
  });
});

describe("ownership and finish resilience", () => {
  it("logs once and stops heartbeating when ownership is lost", async () => {
    const q = new FakeJobQueue([makeJob({ id: "l1" })]);
    q.lostJobs.add("l1");
    const logs: string[] = [];
    await processNextJob(q, handlers({ plan: async () => { await new Promise((r) => setTimeout(r, 40)); return { status: "done" }; } }), { ...opts, log: (m) => logs.push(m) });
    expect(logs.filter((m) => m.includes("lost ownership of job l1 (requeued elsewhere); its result will be discarded"))).toHaveLength(1);
    expect(q.heartbeats.length).toBe(1);
  });

  it("logs a discarded result when finish reports lost ownership", async () => {
    const q = new FakeJobQueue([makeJob({ id: "l2" })]);
    q.lostJobs.add("l2");
    const logs: string[] = [];
    await processNextJob(q, handlers(), { ...opts, heartbeatMs: 10_000, log: (m) => logs.push(m) });
    expect(logs).toContain("job l2 result discarded: this worker no longer owns it");
    expect(logs.some((m) => m.startsWith("job l2 done"))).toBe(false);
  });

  it("retries finish after transient failures", async () => {
    const q = new FakeJobQueue([makeJob({ id: "r1" })]);
    q.finishFailures = 2;
    await processNextJob(q, handlers(), opts);
    expect(q.finishAttempts).toBe(3);
    expect(q.finished).toEqual([{ jobId: "r1", outcome: { status: "done" } }]);
  });

  it("gives up after exhausting finish retries and continues", async () => {
    const q = new FakeJobQueue([makeJob({ id: "r2" })]);
    q.finishFailures = 5;
    expect(await processNextJob(q, handlers(), opts)).toBe(true);
    expect(q.finishAttempts).toBe(3);
  });

  it("treats Object.prototype names as unknown job types", async () => {
    const q = new FakeJobQueue([makeJob({ id: "c1", type: "constructor" })]);
    await processNextJob(q, handlers(), opts);
    expect(q.finished[0].outcome).toEqual({ status: "failed", error: 'unknown job type "constructor"' });
  });
});
