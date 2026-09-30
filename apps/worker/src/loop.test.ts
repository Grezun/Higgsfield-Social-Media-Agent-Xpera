import { describe, expect, it } from "vitest";
import type { Handlers } from "./loop";
import { createThrottledReporter, processNextJob, runWorker } from "./loop";
import { FakeJobQueue, makeJob } from "./testing/fakes";

const noop = async () => ({ status: "done" as const });
const handlers = (over: Partial<Handlers> = {}): Handlers => ({ plan: noop, generate: noop, ...over });
const opts = { workerId: "w1", heartbeatMs: 5, progressThrottleMs: 5 };

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
});
