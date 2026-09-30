import { parseStoryboard, type Storyboard } from "@reel/core";
import { describe, expect, it } from "vitest";
import { approveStoryboard, newDraftFrom, retryGenerate, saveDraft, type StoryboardRow, type StoryboardWriteDeps } from "./approve";

const valid = () =>
  parseStoryboard({
    version: 2, title: "t", language: "en", format: "faceless", aspect: "9:16", targetDurationSec: 15,
    voice: { voiceId: "v", modelId: "eleven_v4" },
    style: { captionPreset: "clean", font: "Heebo", palette: ["#FFE14D"], pacing: "calm" },
    scenes: [{ id: "s1", script: "Hook", visual: { kind: "graphic" }, overlays: [], transitionOut: "cut" }],
  });

type Over = Partial<{
  updated: number; active: number; max: number; row: StoryboardRow | null; done: boolean; queueThrows: boolean; insertError: string;
}>;

function fakeDeps(over: Over = {}) {
  const calls: string[] = [];
  const updates: Storyboard[] = [];
  const inserts: Storyboard[] = [];
  const row: StoryboardRow | null = "row" in over ? (over.row ?? null) : { projectId: "p", version: 2, status: "draft", json: valid() };
  const deps: StoryboardWriteDeps = {
    async getStoryboard() { return row; },
    async updateDraft(projectId, id, json, status) { calls.push(`update:${id}:${status}`); updates.push(json); return over.updated ?? 1; },
    async queueGenerate(projectId, storyboardId) {
      if (over.queueThrows) throw new Error("boom");
      calls.push(`queue:${projectId}:${storyboardId}`);
    },
    async setProjectStatus(projectId, status) { calls.push(`status:${projectId}:${status}`); },
    async activeJobCount() { return over.active ?? 0; },
    async hasDoneGenerate() { return over.done ?? false; },
    async insertDraft(projectId, version, json) {
      if (over.insertError) throw new Error(over.insertError);
      calls.push(`insert:${projectId}:${version}:${json.version}`);
      inserts.push(json);
    },
    async maxVersion() { return over.max ?? 2; },
  };
  return { deps, calls, updates, inserts };
}

const approved = (version = 2): StoryboardRow => ({ projectId: "p", version, status: "approved", json: valid() });
const WRONG = { ok: false, errors: ["This storyboard doesn't belong to this reel. Refresh the page."] };

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
  it("refuses before writing anything when a job is already queued or running", async () => {
    const { deps, calls } = fakeDeps({ active: 1 });
    const r = await approveStoryboard(deps, { projectId: "p", storyboardId: "sb", json: valid() });
    expect(r).toEqual({ ok: false, errors: ["A job for this reel is already queued or running."] });
    expect(calls).toEqual([]);
  });
  it("refuses a storyboard from another project or a missing one, writing nothing", async () => {
    const other = fakeDeps({ row: { projectId: "q", version: 2, status: "draft", json: valid() } });
    expect(await approveStoryboard(other.deps, { projectId: "p", storyboardId: "sb", json: valid() })).toEqual(WRONG);
    expect(other.calls).toEqual([]);
    const missing = fakeDeps({ row: null });
    expect(await approveStoryboard(missing.deps, { projectId: "p", storyboardId: "sb", json: valid() })).toEqual(WRONG);
    expect(missing.calls).toEqual([]);
  });
  it("stamps version, voice, format and aspect from the stored row, not the client", async () => {
    const { deps, updates } = fakeDeps();
    const tampered = { ...valid(), version: 99, format: "avatar", voice: { voiceId: "evil", modelId: "eleven_v4" } };
    expect(await approveStoryboard(deps, { projectId: "p", storyboardId: "sb", json: tampered })).toEqual({ ok: true });
    expect(updates[0]).toMatchObject({ version: 2, format: "faceless", aspect: "9:16", voice: { voiceId: "v" } });
  });
  it("reports a queuing failure after approval without reverting", async () => {
    const { deps, calls } = fakeDeps({ queueThrows: true });
    const r = await approveStoryboard(deps, { projectId: "p", storyboardId: "sb", json: valid() });
    expect(r).toEqual({ ok: false, errors: ["Approved, but queuing failed — use “Retry generation”."] });
    expect(calls).toEqual(["update:sb:approved"]);
  });
});

describe("saveDraft", () => {
  it("saves a valid draft and reports when it is no longer editable", async () => {
    expect(await saveDraft(fakeDeps().deps, { projectId: "p", storyboardId: "sb", json: valid() })).toEqual({ ok: true });
    expect(await saveDraft(fakeDeps({ updated: 0 }).deps, { projectId: "p", storyboardId: "sb", json: valid() })).toEqual({
      ok: false, errors: ["Only draft storyboards can be edited. Use “Edit as new version”."],
    });
  });
  it("refuses a project mismatch with no writes and stamps identity fields from the stored row", async () => {
    const other = fakeDeps({ row: { projectId: "q", version: 2, status: "draft", json: valid() } });
    expect(await saveDraft(other.deps, { projectId: "p", storyboardId: "sb", json: valid() })).toEqual(WRONG);
    expect(other.calls).toEqual([]);
    const { deps, updates } = fakeDeps();
    await saveDraft(deps, { projectId: "p", storyboardId: "sb", json: { ...valid(), version: 7, format: "avatar", voice: { voiceId: "x", modelId: "eleven_v4" } } });
    expect(updates[0]).toMatchObject({ version: 2, format: "faceless", aspect: "9:16", voice: { voiceId: "v" } });
  });
});

describe("retryGenerate", () => {
  const input = { projectId: "p", storyboardId: "sb" };
  it("queues for an approved, latest, never-generated storyboard", async () => {
    const ok = fakeDeps({ row: approved() });
    expect(await retryGenerate(ok.deps, input)).toEqual({ ok: true });
    expect(ok.calls).toEqual(["queue:p:sb", "status:p:generating"]);
  });
  it("refuses while a job is active", async () => {
    const busy = fakeDeps({ row: approved(), active: 1 });
    expect(await retryGenerate(busy.deps, input)).toEqual({ ok: false, errors: ["A job for this reel is already queued or running."] });
    expect(busy.calls).toEqual([]);
  });
  it("refuses when not approved, wrong project, not the latest version, or already generated", async () => {
    const draft = fakeDeps({ row: { ...approved(), status: "draft" } });
    expect(await retryGenerate(draft.deps, input)).toEqual({ ok: false, errors: ["Only an approved storyboard can be generated."] });
    const wrong = fakeDeps({ row: { ...approved(), projectId: "q" } });
    expect(await retryGenerate(wrong.deps, input)).toEqual({ ok: false, errors: ["Only an approved storyboard can be generated."] });
    const old = fakeDeps({ row: approved(2), max: 3 });
    expect(await retryGenerate(old.deps, input)).toEqual({ ok: false, errors: ["A newer version exists — approve that one instead."] });
    const done = fakeDeps({ row: approved(), done: true });
    expect(await retryGenerate(done.deps, input)).toEqual({ ok: false, errors: ["This version was already generated. Use “Edit as new version” to make changes."] });
    for (const f of [draft, wrong, old, done]) expect(f.calls).toEqual([]);
  });
});

describe("newDraftFrom", () => {
  const input = { projectId: "p", sourceStoryboardId: "sb" };
  it("inserts the next version copied from the stored json", async () => {
    const { deps, calls, inserts } = fakeDeps({ max: 2, row: approved() });
    expect(await newDraftFrom(deps, input)).toEqual({ ok: true });
    expect(calls).toEqual(["insert:p:3:3", "status:p:draft"]);
    expect(inserts[0].scenes).toEqual(valid().scenes);
  });
  it("refuses while a job is active or for a foreign storyboard", async () => {
    const busy = fakeDeps({ active: 1, row: approved() });
    expect(await newDraftFrom(busy.deps, input)).toEqual({ ok: false, errors: ["Wait for the current job to finish before editing."] });
    expect(busy.calls).toEqual([]);
    const foreign = fakeDeps({ row: { ...approved(), projectId: "q" } });
    expect(await newDraftFrom(foreign.deps, input)).toEqual(WRONG);
  });
  it("maps a duplicate-version insert to a refresh message", async () => {
    const { deps, calls } = fakeDeps({ row: approved(), insertError: '23505: duplicate key value violates unique constraint' });
    expect(await newDraftFrom(deps, input)).toEqual({ ok: false, errors: ["A newer version already exists. Refresh the page."] });
    expect(calls).toEqual([]);
  });
});
