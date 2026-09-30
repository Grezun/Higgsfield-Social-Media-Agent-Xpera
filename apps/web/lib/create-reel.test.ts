import { describe, expect, it, vi } from "vitest";
import type { PlanForm } from "@reel/core";
import { createReelFromForm, type CreateReelDeps } from "./create-reel";

const form: PlanForm = { brief: "a brief", language: "en", targetDurationSec: 30, pacing: "punchy", captionPreset: "bold_pop", palette: ["#ffe14d", "#111111"] };

const deps = (o: Partial<CreateReelDeps> = {}) => ({
  insertProject: vi.fn(async () => ({ id: "p1" })),
  insertPlanJob: vi.fn(async () => ({ ok: true as const })),
  markProjectFailed: vi.fn(async () => {}),
  ...o,
});

describe("createReelFromForm", () => {
  it("returns the project id on success", async () => {
    const d = deps();
    expect(await createReelFromForm(d, form)).toEqual({ ok: true, projectId: "p1" });
    expect(d.insertPlanJob).toHaveBeenCalledWith("p1", form);
    expect(d.markProjectFailed).not.toHaveBeenCalled();
  });
  it("stops when the project insert fails", async () => {
    const d = deps({ insertProject: vi.fn(async () => ({ error: "boom" })) });
    const r = await createReelFromForm(d, form);
    expect(r.ok).toBe(false);
    expect(d.insertPlanJob).not.toHaveBeenCalled();
    expect(d.markProjectFailed).not.toHaveBeenCalled();
  });
  it("marks the project failed when the job insert fails", async () => {
    const d = deps({ insertPlanJob: vi.fn(async () => ({ error: "nope" })) });
    const r = await createReelFromForm(d, form);
    expect(!r.ok && r.errors[0]).toMatch(/nope/);
    expect(d.markProjectFailed).toHaveBeenCalledTimes(1);
    expect(d.markProjectFailed).toHaveBeenCalledWith("p1");
  });
  it("maps 23505 to the ruled message and still marks failed", async () => {
    const d = deps({ insertPlanJob: vi.fn(async () => ({ error: "dup", code: "23505" })) });
    const r = await createReelFromForm(d, form);
    expect(r).toEqual({ ok: false, errors: ["A job for this reel is already queued or running."] });
    expect(d.markProjectFailed).toHaveBeenCalledTimes(1);
  });
  it("truncates the title by code points without splitting an emoji", async () => {
    const d = deps();
    await createReelFromForm(d, { ...form, brief: "a".repeat(79) + "😀" + "tail" });
    const title = (vi.mocked(d.insertProject).mock.calls[0] as unknown as [{ title: string }])[0].title;
    expect(title).toBe("a".repeat(79) + "😀");
    expect(Array.from(title)).toHaveLength(80);
  });
});
