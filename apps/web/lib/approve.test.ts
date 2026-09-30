import { parseStoryboard } from "@reel/core";
import { describe, expect, it } from "vitest";
import { approveStoryboard, newDraftFrom, retryGenerate, saveDraft, type StoryboardWriteDeps } from "./approve";

const valid = () =>
  parseStoryboard({
    version: 2, title: "t", language: "en", format: "faceless", aspect: "9:16", targetDurationSec: 15,
    voice: { voiceId: "v", modelId: "eleven_v4" },
    style: { captionPreset: "clean", font: "Heebo", palette: ["#FFE14D"], pacing: "calm" },
    scenes: [{ id: "s1", script: "Hook", visual: { kind: "graphic" }, overlays: [], transitionOut: "cut" }],
  });

function fakeDeps(over: Partial<{ updated: number; active: number; max: number }> = {}) {
  const calls: string[] = [];
  const deps: StoryboardWriteDeps = {
    async updateDraft(id, _json, status) { calls.push(`update:${id}:${status}`); return over.updated ?? 1; },
    async queueGenerate(projectId, storyboardId) { calls.push(`queue:${projectId}:${storyboardId}`); },
    async setProjectStatus(projectId, status) { calls.push(`status:${projectId}:${status}`); },
    async activeJobCount() { return over.active ?? 0; },
    async insertDraft(projectId, version, json) { calls.push(`insert:${projectId}:${version}:${json.version}`); },
    async maxVersion() { return over.max ?? 2; },
  };
  return { deps, calls };
}

describe("approveStoryboard", () => {
  it("approves, then queues exactly one generate job and marks the project generating", async () => {
    const { deps, calls } = fakeDeps();
    expect(await approveStoryboard(deps, { projectId: "p", storyboardId: "sb", json: valid() })).toEqual({ ok: true });
    expect(calls).toEqual(["update:sb:approved", "queue:p:sb", "status:p:generating"]);
  });
  it("rejects an invalid storyboard with readable errors and writes nothing", async () => {
    const { deps, calls } = fakeDeps();
    const bad = { ...valid(), scenes: [{ ...valid().scenes[0], script: "" }] };
    const r = await approveStoryboard(deps, { projectId: "p", storyboardId: "sb", json: bad });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join()).toMatch(/scenes\.0\.script/);
    expect(calls).toEqual([]);
  });
  it("a second approval (double click, other tab) is refused and queues nothing", async () => {
    const { deps, calls } = fakeDeps({ updated: 0 });
    const r = await approveStoryboard(deps, { projectId: "p", storyboardId: "sb", json: valid() });
    expect(r).toEqual({ ok: false, errors: ["This storyboard was already approved. Refresh the page."] });
    expect(calls).toEqual(["update:sb:approved"]);
  });
});

describe("approveStoryboard with an active job", () => {
  it("refuses before writing anything when a job is already queued or running", async () => {
    const { deps, calls } = fakeDeps({ active: 1 });
    const r = await approveStoryboard(deps, { projectId: "p", storyboardId: "sb", json: valid() });
    expect(r).toEqual({ ok: false, errors: ["A job for this reel is already queued or running."] });
    expect(calls).toEqual([]);
  });
});

describe("saveDraft", () => {
  it("saves a valid draft and reports when it is no longer editable", async () => {
    expect(await saveDraft(fakeDeps().deps, { storyboardId: "sb", json: valid() })).toEqual({ ok: true });
    expect(await saveDraft(fakeDeps({ updated: 0 }).deps, { storyboardId: "sb", json: valid() })).toEqual({
      ok: false, errors: ["Only draft storyboards can be edited. Use “Edit as new version”."],
    });
  });
});

describe("retryGenerate", () => {
  it("queues a new generate job unless one is already queued or running", async () => {
    const ok = fakeDeps();
    expect(await retryGenerate(ok.deps, { projectId: "p", storyboardId: "sb" })).toEqual({ ok: true });
    expect(ok.calls).toEqual(["queue:p:sb", "status:p:generating"]);
    const busy = fakeDeps({ active: 1 });
    expect(await retryGenerate(busy.deps, { projectId: "p", storyboardId: "sb" })).toEqual({ ok: false, errors: ["A job for this reel is already queued or running."] });
    expect(busy.calls).toEqual([]);
  });
});

describe("newDraftFrom", () => {
  it("inserts the next version as a user draft with the version stamped into the JSON", async () => {
    const { deps, calls } = fakeDeps({ max: 2 });
    expect(await newDraftFrom(deps, { projectId: "p", json: valid() })).toEqual({ ok: true });
    expect(calls).toEqual(["insert:p:3:3", "status:p:draft"]);
  });
});
