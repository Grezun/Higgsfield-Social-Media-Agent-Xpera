import { describe, expect, it } from "vitest";
import { Semaphore, withRetry } from "./retry";

const transient = new Error("transient");
const permanent = new Error("permanent");
const isTransient = (e: unknown) => e === transient;

describe("withRetry", () => {
  it("retries transient errors with exponential backoff, then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw transient;
        return "ok";
      },
      { isTransient, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
  });

  it("does not retry permanent errors", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw permanent; }, { isTransient, sleep: async () => {} })).rejects.toBe(permanent);
    expect(calls).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw transient; }, { isTransient, attempts: 3, sleep: async () => {} })).rejects.toBe(transient);
    expect(calls).toBe(3);
  });
});

describe("Semaphore", () => {
  it("never runs more than max tasks at once and runs them all", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return 1;
      });
    const results = await Promise.all(Array.from({ length: 7 }, task));
    expect(results).toHaveLength(7);
    expect(peak).toBe(2);
  });
});
