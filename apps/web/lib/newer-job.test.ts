import { describe, expect, it } from "vitest";
import { newerJob } from "./newer-job";

const j = (created_at: string, id = "x") => ({ id, created_at });
describe("newerJob", () => {
  it("returns next when there is no previous", () => {
    const n = j("2026-10-01T10:00:00+00:00");
    expect(newerJob(null, n)).toBe(n);
  });
  it("keeps prev when next is older", () => {
    const p = j("2026-10-01T10:00:05+00:00", "p");
    expect(newerJob(p, j("2026-10-01T10:00:00+00:00", "n"))).toBe(p);
  });
  it("takes next when equal", () => {
    const n = j("2026-10-01T10:00:00+00:00", "n");
    expect(newerJob(j("2026-10-01T10:00:00+00:00", "p"), n)).toBe(n);
  });
  it("compares by time, not string, across fractional precisions", () => {
    const p = j("2026-10-01T10:00:00.5+00:00", "p");
    const n = j("2026-10-01T10:00:00.123456+00:00", "n");
    expect(newerJob(p, n)).toBe(p);
    expect(newerJob(n, p)).toBe(p);
  });
});
