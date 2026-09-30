# Reel Length and Higgsfield Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two fixes found by the first real reel:
1. Planned reels respect their target length. A 15 s brief produced 32 s of voiceover.
2. Slow or flaky Higgsfield generations never cost twice. A clip abandoned after 15 minutes is picked up again by its request ID, and a submit that fails with a 5xx error is retried.

**Architecture:**
- **Length:** a pure length estimate in `@reel/core` is used in three places:
  - the Claude planner, which gets one repair round when the script is too long or has too many scenes
  - the planner prompt, which states hard limits
  - the storyboard editor, which shows the estimated length and a warning
- **Higgsfield:** the gateway stops using the SDK's all-in-one `subscribe()` and splits the work in two:
  - **submit**, which is safe to retry because nothing exists yet
  - **wait**, which polls with generous limits and tolerates errors
  
  Each request ID is recorded in a local "pending" store, keyed by the pipeline's content hash. A later run with the same key resumes waiting on it instead of submitting again.

**Tech Stack:** existing monorepo (TypeScript 7, Vitest 5, zod 4). Higgsfield HTTP API `POST {base}/{model}` and `GET {base}/requests/{id}/status`, with header `Authorization: Key <id:secret>` (the same endpoints and auth the SDK uses).

**Spec:** `docs/superpowers/specs/2026-09-30-social-reel-agent-design.md` (§4.1 visuals, §6 error handling, §7 cost control). These are bounded follow-ups to Phases 1a and 1b, approved in chat on 2026-10-01.

## Global Constraints

- **Speaking rates:** Hebrew 2.3 words/s, English 2.6 words/s (the existing `WORDS_PER_SECOND`). Each scene counts for at least 2 s (the existing `estimateSceneSeconds`).
- **Too long:** a storyboard is too long when its estimated speech exceeds `target × 1.25`, or when it has more than `ceil(target / 2.5)` scenes.
- **Planner repair:**
  - At most one extra Claude call for length.
  - If the second answer is still too long, the planner **returns it anyway**. The editor shows the warning, so there is no hard failure.
  - Invalid schema output keeps its existing behaviour: one repair, then an error.
- **Submit retries:** Higgsfield submit is retried (up to 4 attempts, exponential backoff from 5 s) on HTTP 429, any 5xx, network errors, and HTTP 400 whose body mentions "concurrent". Any other 4xx is permanent.
- **Waiting:**
  - Poll every 5 s (injectable).
  - Status-call errors (5xx, network, timeout) never fail the wait.
  - Max wait: video `HF_MAX_WAIT_MINUTES` (default 40), images 10 minutes.
- **Timeout:** when the wait times out, the pending record is **kept**, and the error says the request is still processing and gives the request ID. A retry resumes it.
- **Finished requests:** on a terminal status (completed, failed, nsfw, canceled) the pending record is **deleted**. "Failed" then resubmits on a retry.
- **Unknown request ID:** a status call returning 404 (the provider no longer knows the ID) deletes the pending record and submits fresh.
- **Pending store location:** local JSON files under `<cacheDir>/pending/` (fake mode: `<cacheDir>/fake/pending/`). This covers a single worker machine. Mirroring to Supabase is a Phase 5 item.
- **Secrets:** the Higgsfield credentials are never logged.

## Review Focus

1. **A clip that finishes after the worker gave up.** Retry must fetch it (the same request ID) without submitting again or paying twice. Pinned in Task 3.
2. **A 502 on submit.** It must be retried and the scene must still succeed. Pinned in Task 3.
3. **A 502 while polling.** It is ignored and the wait continues. Pinned in Task 3.
4. **Claude returns 10 scenes for a 15 s reel.** One repair round runs. If the answer is still long, the storyboard is still returned, so the user isn't blocked. Pinned in Task 1.
5. **A Hebrew storyboard edited to be too long in the editor.** A visible length warning appears before approval. Pinned in Task 2 (the pure function).

---

### Task 1: Length estimate in core and planner enforcement

**Files:**
- Create: `packages/core/src/length.ts`
- Modify: `packages/core/src/index.ts`, `packages/engine/src/planner.ts`
- Test: `packages/core/src/length.test.ts`, `packages/engine/src/planner.test.ts` (extend)

**Interfaces:**
- Produces (from `@reel/core`):
  - `LENGTH_TOLERANCE = 1.25`
  - `maxScenesFor(targetSec: number): number`
  - `targetWordsFor(targetSec: number, language: Language): number`
  - `estimateStoryboardSeconds(sb: Pick<Storyboard, "language" | "scenes">): number`
  - `lengthIssues(sb: Pick<Storyboard, "language" | "scenes" | "targetDurationSec">): string[]` (empty when OK)
- `userPrompt` states the hard limits; `createPlanner` runs one length repair.

- [ ] **Step 1: Write the failing core test**

`packages/core/src/length.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { estimateStoryboardSeconds, lengthIssues, maxScenesFor, targetWordsFor } from "./length";

const scene = (script: string) => ({ id: "s", script, visual: { kind: "graphic" as const, motion: "none" as const }, overlays: [], transitionOut: "cut" as const });
const words = (n: number) => Array.from({ length: n }, () => "מילה").join(" ");

describe("length", () => {
  it("derives limits from the target", () => {
    expect(maxScenesFor(15)).toBe(6);
    expect(maxScenesFor(30)).toBe(12);
    expect(targetWordsFor(15, "he")).toBe(35);
    expect(targetWordsFor(30, "en")).toBe(78);
  });

  it("estimates seconds per scene with a 2 s floor", () => {
    expect(estimateStoryboardSeconds({ language: "he", scenes: [scene(words(23)), scene("היי")] })).toBeCloseTo(12, 5);
  });

  it("flags too much speech and too many scenes, with actionable numbers", () => {
    const long = { language: "he" as const, targetDurationSec: 15 as const, scenes: Array.from({ length: 10 }, () => scene(words(8))) };
    const issues = lengthIssues(long);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/about 3\d s of speech.*target is 15 s.*about 35 words/);
    expect(issues[1]).toMatch(/at most 6 scenes \(you wrote 10\)/);
  });

  it("accepts a storyboard within 25% of the target", () => {
    expect(lengthIssues({ language: "en", targetDurationSec: 15, scenes: [scene(words(20)), scene(words(20))] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run packages/core/src/length.test.ts`. Expected: FAIL (import not resolved).

- [ ] **Step 3: Implement `packages/core/src/length.ts`**

```ts
import { estimateSceneSeconds } from "./cost";
import type { Language, Storyboard } from "./schema/storyboard";

/** How far over the target a storyboard may run before the planner repairs it or the editor warns. */
export const LENGTH_TOLERANCE = 1.25;
const WORDS_PER_SECOND: Record<Language, number> = { he: 2.3, en: 2.6 };
const SECONDS_PER_SCENE_MIN = 2.5;

export const maxScenesFor = (targetSec: number) => Math.ceil(targetSec / SECONDS_PER_SCENE_MIN);
export const targetWordsFor = (targetSec: number, language: Language) => Math.round(targetSec * WORDS_PER_SECOND[language]);

export function estimateStoryboardSeconds(sb: Pick<Storyboard, "language" | "scenes">): number {
  return sb.scenes.reduce((sum, s) => sum + estimateSceneSeconds(s.script, sb.language), 0);
}

export function lengthIssues(sb: Pick<Storyboard, "language" | "scenes" | "targetDurationSec">): string[] {
  const issues: string[] = [];
  const seconds = estimateStoryboardSeconds(sb);
  if (seconds > sb.targetDurationSec * LENGTH_TOLERANCE) {
    issues.push(
      `The voiceover is about ${Math.round(seconds)} s of speech but the target is ${sb.targetDurationSec} s: cut it to about ${targetWordsFor(sb.targetDurationSec, sb.language)} words in total.`,
    );
  }
  const maxScenes = maxScenesFor(sb.targetDurationSec);
  if (sb.scenes.length > maxScenes) issues.push(`Use at most ${maxScenes} scenes (you wrote ${sb.scenes.length}).`);
  return issues;
}
```
Append `export * from "./length";` to `packages/core/src/index.ts`. The new module imports nothing from `node:`, so the browser-safe guard test keeps passing.

- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run packages/core`. Expected: PASS.

- [ ] **Step 5: Planner tests (failing first)**

Add to `packages/engine/src/planner.test.ts`, reusing its `REQ` (Hebrew, 30 s) and `reply()` helpers. Build long drafts with 20 scenes of 12 words each:
```ts
const longDraft = (): StoryboardDraft => ({
  title: "ארוך",
  scenes: Array.from({ length: 20 }, () => ({
    script: Array.from({ length: 12 }, () => "מילה").join(" "),
    visual: { kind: "graphic", prompt: "", motion: "none" },
    overlays: [],
    transitionOut: "cut",
  })),
});

describe("length enforcement", () => {
  it("asks Claude once to shorten an over-long storyboard and returns the fixed one", async () => {
    const model = vi.fn<DraftModel>().mockResolvedValueOnce(reply(longDraft())).mockResolvedValueOnce(reply(draft()));
    const sb = await createPlanner(model).plan(REQ);
    expect(model).toHaveBeenCalledTimes(2);
    expect(model.mock.calls[1][0].user).toMatch(/at most 12 scenes \(you wrote 20\)/);
    expect(sb.scenes).toHaveLength(2);
  });

  it("returns a still-long second answer instead of failing", async () => {
    const model = vi.fn<DraftModel>(async () => reply(longDraft()));
    const sb = await createPlanner(model).plan(REQ);
    expect(model).toHaveBeenCalledTimes(2);
    expect(sb.scenes).toHaveLength(20);
  });

  it("states hard limits in the prompt", () => {
    expect(userPrompt(REQ)).toMatch(/Hard limits: at most 12 scenes and about 69 spoken words/);
  });
});
```
Run `npx vitest run packages/engine/src/planner.test.ts`. Expected: the three new tests FAIL.

- [ ] **Step 6: Implement it in `packages/engine/src/planner.ts`**

1. Import `lengthIssues`, `maxScenesFor` and `targetWordsFor` from `@reel/core`.
2. In `userPrompt`, replace the `Target length:` line with:
```ts
    `Target length: ${req.targetDurationSec} seconds, about ${words} spoken words in total, about ${scenes} scenes.`,
    `Hard limits: at most ${maxScenesFor(req.targetDurationSec)} scenes and about ${targetWordsFor(req.targetDurationSec, req.language)} spoken words. Longer reels are rejected.`,
```
3. Change `Attempt` and `attempt()` so that a successfully built storyboard with length issues is reported separately:
```ts
type Attempt =
  | { ok: true; storyboard: Storyboard }
  | { ok: false; error: string; storyboard?: Storyboard };

function attempt(result: Awaited<ReturnType<DraftModel>>, req: PlanRequest): Attempt {
  if (result.stopReason === "refusal") throw new PlannerRefusedError();
  if (!result.draft) return { ok: false, error: "The output did not match the storyboard schema." };
  let storyboard: Storyboard;
  try {
    storyboard = buildStoryboard(result.draft, req);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const issues = lengthIssues(storyboard);
  return issues.length ? { ok: false, error: issues.join("\n"), storyboard } : { ok: true, storyboard };
}
```
4. In `createPlanner`, after the second attempt:
```ts
      const second = attempt(await model({ system, user: repairUser }), req);
      if (second.ok) return second.storyboard;
      // Valid but still over length: return it — the editor shows the length warning.
      if (second.storyboard) return second.storyboard;
      throw new Error(`Claude returned an invalid storyboard twice:\n${second.error}`);
```
The repair message template (`Your previous storyboard was rejected: … Previous output: …`) stays as it is. The length issues are its `error` text.

- [ ] **Step 7: Run everything.** Run `npx vitest run packages && npx tsc -p tsconfig.json`. Expected: all pass. The existing planner tests stay green because their fixtures are short.

- [ ] **Step 8: Commit** with message `feat: planned reels respect their target length (estimate, prompt limits, one repair round)`.

---

### Task 2: Show the estimated length in the storyboard editor

**Files:**
- Create: `apps/web/lib/length-view.ts`
- Modify: `apps/web/components/StoryboardEditor.tsx`
- Test: `apps/web/lib/length-view.test.ts`

**Interfaces:**
- Consumes: `estimateStoryboardSeconds` and `LENGTH_TOLERANCE` (Task 1)
- Produces: `describeLength(sb): { text: string; tooLong: boolean }`

- [ ] **Step 1: Write the failing test**

`apps/web/lib/length-view.test.ts`:
```ts
import { parseStoryboard } from "@reel/core";
import { describe, expect, it } from "vitest";
import { describeLength } from "./length-view";

const sb = (scripts: string[], target: 15 | 30 = 15) =>
  parseStoryboard({
    version: 1, title: "t", language: "he", format: "faceless", aspect: "9:16", targetDurationSec: target,
    voice: { voiceId: "v", modelId: "eleven_v4" },
    style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D"], pacing: "punchy" },
    scenes: scripts.map((script, i) => ({ id: `s${i + 1}`, script, visual: { kind: "graphic" }, overlays: [], transitionOut: "cut" })),
  });
const words = (n: number) => Array.from({ length: n }, () => "מילה").join(" ");

describe("describeLength", () => {
  it("shows the estimate against the target", () => {
    expect(describeLength(sb([words(23), words(11)]))).toEqual({ text: "Estimated length ≈ 15 s (target 15 s)", tooLong: false });
  });
  it("warns when more than 25% over", () => {
    const view = describeLength(sb(Array.from({ length: 6 }, () => words(10))));
    expect(view.tooLong).toBe(true);
    expect(view.text).toBe("Estimated length ≈ 26 s (target 15 s): too long; trim the voiceover or remove scenes.");
  });
});
```
Run `npx vitest run apps/web/lib/length-view.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement `apps/web/lib/length-view.ts`**

```ts
import { estimateStoryboardSeconds, LENGTH_TOLERANCE, type Storyboard } from "@reel/core";

export function describeLength(sb: Pick<Storyboard, "language" | "scenes" | "targetDurationSec">): { text: string; tooLong: boolean } {
  const seconds = Math.round(estimateStoryboardSeconds(sb));
  const tooLong = seconds > sb.targetDurationSec * LENGTH_TOLERANCE;
  const base = `Estimated length ≈ ${seconds} s (target ${sb.targetDurationSec} s)`;
  return { text: tooLong ? `${base}: too long; trim the voiceover or remove scenes.` : base, tooLong };
}
```

- [ ] **Step 3: Show it in the editor.** In `StoryboardEditor.tsx`:
- Import `describeLength` from `@/lib/length-view`.
- Compute `const length = useMemo(() => describeLength(sb), [sb]);`.
- In the header row, directly below the cost estimate `<span>`, add `<span className={length.tooLong ? "warn" : "muted"}>{length.text}</span>`.
- Keep the header row's layout (`className="row"`).

- [ ] **Step 4: Verify.** Run `npx vitest run apps/web && npm run typecheck && npm run build -w @reel/web`. Expected: all pass.

- [ ] **Step 5: Commit** with message `feat(web): show estimated reel length and warn when over target`.

---

### Task 3: Higgsfield submit/wait split with resume by request ID

**Files:**
- Create: `packages/engine/src/providers/higgsfield-api.ts`, `packages/engine/src/pending-store.ts`
- Modify:
  - `packages/engine/src/providers/higgsfield.ts`
  - `packages/engine/src/providers/types.ts`
  - `packages/engine/src/providers/fake.ts` (it must accept the new optional parameter)
  - `packages/engine/src/providers/index.ts`
  - `packages/engine/src/pipeline.ts`
  - `packages/engine/src/config.ts`
  - `packages/engine/src/index.ts`
  - `.env.example`
  - `docs/RUNNING.md`
- Test: `packages/engine/src/providers/higgsfield.test.ts` (rewrite the gateway tests), `packages/engine/src/pending-store.test.ts`
- Remove: `sdkSubscribe` and `isTransientHiggsfieldError` (superseded)

**Interfaces:**
- `higgsfield-api.ts`:
  - `type HfStatus = { status: string; request_id: string; images?: { url: string }[]; video?: { url: string } }`
  - `class HfHttpError extends Error { status: number }`
  - `interface HiggsfieldApi { submit(model: string, input: Record<string, unknown>): Promise<string /* request id */>; status(requestId: string): Promise<HfStatus> }`
  - `httpHiggsfieldApi(credentials, baseUrl, fetchImpl?): HiggsfieldApi`
  - `isRetryableSubmitError(err): boolean`
- `pending-store.ts`:
  - `type PendingRecord = { requestId: string; model: string; submittedAt: string }`
  - `interface PendingStore { get(key); set(key, rec); delete(key) }`
  - `class FilePendingStore(dir)`, `class MemoryPendingStore`
- `HiggsfieldGateway(api, pending, concurrency, opts?: { pollMs?, submitBaseDelayMs?, sleep?, now?, log? })`
  - `run(model, input, pick, { resumeKey?, maxWaitMs })`
- `ImageGen.generate(req: { prompt: string; resumeKey?: string })` and `VideoGen.imageToVideo(req: { imageUrl; prompt; durationSec; resumeKey?: string })`. Both are optional and the fake providers ignore them.
- `EngineConfig.higgsfield.maxWaitMinutes: number`, from `HF_MAX_WAIT_MINUTES` (default 40; must be an integer ≥ 1)

- [ ] **Step 1: Write the failing tests**

`packages/engine/src/pending-store.test.ts` should cover, for both implementations: `set` then `get` round-trips; `delete` removes the record; an unknown key gives `null`. For `FilePendingStore`: a key containing `/` or `..` is rejected with a thrown `Error`, because keys are 64-hex content hashes. A corrupt JSON file is treated as `null` and removed.

`packages/engine/src/providers/higgsfield.test.ts` replaces the old gateway tests. Keep the uploader tests and the image/video parameter tests, adapted to the new constructor. It uses a fake `HiggsfieldApi`, `MemoryPendingStore`, and injected `sleep: async () => {}` plus a controllable `now`:
```ts
function fakeApi(script: { submit?: (() => Promise<string>)[]; statuses?: Record<string, (() => Promise<HfStatus>)[]> }) {
  const calls = { submit: 0, status: 0 };
  const api: HiggsfieldApi = {
    async submit() { calls.submit++; const next = script.submit?.shift(); return next ? next() : "req-1"; },
    async status(id) { calls.status++; const q = script.statuses?.[id]; const next = q?.shift(); if (!next) throw new Error(`no scripted status for ${id}`); return next(); },
  };
  return { api, calls };
}
```
Required tests. The expected request IDs and messages are exact.
1. **Image happy path:** submit returns `req-1`, then status in_progress, then completed with `images: [{url}]`. The result is `{ url, requestId: "req-1" }`. The submitted input is `{ prompt, aspect_ratio: "9:16", resolution: "1080p", batch_size: 1 }` for model `higgsfield-ai/soul/v2/standard`. The pending store is empty afterwards.
2. **Submit retried on 502:** submit throws `new HfHttpError(502, …)` twice, then returns `req-2`. The job completes, `calls.submit` is 3, and the result's requestId is `req-2`.
3. **Submit not retried on 422:** it throws immediately (`HfHttpError` 422), with 1 submit call.
4. **Submit retried on the concurrency 400:** the body text contains "Maximum number of concurrent requests".
5. **Polling tolerates errors:** status throws `HfHttpError(502)`, then a network error (`Object.assign(new Error("reset"), { code: "ECONNRESET" })`), then returns completed. It succeeds with 1 submit.
6. **Timeout keeps pending:**
   - `now` advances past `maxWaitMs` while the status stays in_progress.
   - It rejects with `PermanentProviderError` matching `/still processing after \d+ min.*retry to pick it up/` with `requestId: "req-1"`.
   - `pending.get(resumeKey)` is still `{ requestId: "req-1", … }`.
7. **Resume reuses the request ID:**
   - With `pending.set(key, { requestId: "req-9", model, submittedAt })` already stored, `run(…, { resumeKey: key })` makes **0 submit calls**, polls `req-9` to completed, and clears the pending record.
   - This test pins Review Focus 1.
8. **Resume of an unknown ID:** status for `req-9` throws `HfHttpError(404)`. The pending record is deleted, a fresh submit happens (`req-1`), and it completes.
9. **Terminal failure clears pending:**
   - Status is `failed`, so it rejects with `PermanentProviderError` `/ended with status "failed"/` and the request ID.
   - Pending is cleared, so a second run submits fresh.
   - `nsfw` gives `/content moderation/`.
10. **Concurrency:** at most `concurrency` runs are in flight (the existing peak test, adapted).
11. **Video parameters:** `imageToVideo` sends `{ image_url, prompt, duration, resolution, generate_audio: false }`. It still rejects durations outside the 4–30 integer range before any API call.

- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run packages/engine/src/pending-store.test.ts packages/engine/src/providers/higgsfield.test.ts`.

- [ ] **Step 3: Implement `pending-store.ts`**

```ts
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type PendingRecord = { requestId: string; model: string; submittedAt: string };

/** Remembers provider request ids that were submitted but not yet collected, so a retry can resume instead of paying again. */
export interface PendingStore {
  get(key: string): Promise<PendingRecord | null>;
  set(key: string, record: PendingRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

const assertKey = (key: string) => {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`invalid pending key "${key}"`);
};

export class FilePendingStore implements PendingStore {
  constructor(private readonly dir: string) {}
  private file(key: string) {
    assertKey(key);
    return path.join(this.dir, `${key}.json`);
  }
  async get(key: string) {
    const file = this.file(key);
    try {
      const rec = JSON.parse(await readFile(file, "utf8")) as Partial<PendingRecord>;
      if (typeof rec.requestId === "string" && typeof rec.model === "string" && typeof rec.submittedAt === "string") return rec as PendingRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      if (!(err instanceof SyntaxError)) throw err;
    }
    await rm(file, { force: true });
    return null;
  }
  async set(key: string, record: PendingRecord) {
    const file = this.file(key);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, file);
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

export class MemoryPendingStore implements PendingStore {
  readonly records = new Map<string, PendingRecord>();
  async get(key: string) { return this.records.get(key) ?? null; }
  async set(key: string, record: PendingRecord) { this.records.set(key, record); }
  async delete(key: string) { this.records.delete(key); }
}
```
`MemoryPendingStore` is used by tests. Its keys aren't validated, so tests may use readable keys.

- [ ] **Step 4: Implement `providers/higgsfield-api.ts`**

```ts
import { FETCH_TIMEOUT_MS } from "../download";

export type HfStatus = { status: string; request_id: string; images?: { url: string }[]; video?: { url: string } };

export class HfHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HfHttpError";
  }
}

export interface HiggsfieldApi {
  /** Starts a generation; resolves to its request id. */
  submit(model: string, input: Record<string, unknown>): Promise<string>;
  status(requestId: string): Promise<HfStatus>;
}

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"]);
export const isNetworkError = (err: unknown) =>
  NETWORK_CODES.has((err as { code?: string; cause?: { code?: string } } | null)?.code ?? (err as { cause?: { code?: string } } | null)?.cause?.code ?? "") ||
  (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));

/** A submit that failed before a job existed is safe to retry. */
export function isRetryableSubmitError(err: unknown): boolean {
  if (err instanceof HfHttpError) return err.status === 429 || err.status >= 500 || (err.status === 400 && /concurrent/i.test(err.message));
  return isNetworkError(err);
}

export function httpHiggsfieldApi(credentials: string, baseUrl = "https://api.higgsfield.ai", fetchImpl: typeof fetch = fetch): HiggsfieldApi {
  const headers = { Authorization: `Key ${credentials}`, "Content-Type": "application/json", Accept: "application/json" };
  const call = async (url: string, init: RequestInit) => {
    const res = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new HfHttpError(res.status, `Higgsfield HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as HfStatus;
  };
  return {
    async submit(model, input) {
      const body = await call(`${baseUrl}/${model}`, { method: "POST", body: JSON.stringify(input) });
      if (!body.request_id) throw new HfHttpError(502, "Higgsfield submit returned no request_id");
      return body.request_id;
    },
    status: (requestId) => call(`${baseUrl}/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" }),
  };
}
```
Add tests in `higgsfield.test.ts` for `httpHiggsfieldApi`, using a fake `fetch`:
- The submit URL is `https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard` with method POST, the `Authorization: Key id:secret` header, and a JSON body. It returns `request_id`.
- The status URL is `https://api.higgsfield.ai/requests/req-1/status`.
- A non-OK response throws `HfHttpError` with `.status`.
- `isRetryableSubmitError` returns true for 502, 429, the concurrency 400 and ECONNRESET, and false for 422 and a plain 400.

- [ ] **Step 5: Rewrite the gateway in `providers/higgsfield.ts`**

Remove `sdkSubscribe`, `isTransientHiggsfieldError`, the `SubscribeFn` type and the `@higgsfield/client/v2` imports. Keep `HiggsfieldUploader` unchanged. New gateway:
```ts
import { PermanentProviderError } from "@reel/core";
import type { PendingStore } from "../pending-store";
import { Semaphore, withRetry } from "../retry";
import { HfHttpError, isRetryableSubmitError, type HfStatus, type HiggsfieldApi } from "./higgsfield-api";
import type { GenResult, ImageGen, MediaUploader, VideoGen } from "./types";

const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled", "cancelled"]);
export const IMAGE_MAX_WAIT_MS = 10 * 60 * 1000;

type GatewayOpts = { pollMs?: number; submitBaseDelayMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; log?: (m: string) => void };

export class HiggsfieldGateway {
  private readonly semaphore: Semaphore;
  constructor(private readonly api: HiggsfieldApi, private readonly pending: PendingStore, concurrency: number, private readonly opts: GatewayOpts = {}) {
    this.semaphore = new Semaphore(concurrency);
  }

  async run(model: string, input: Record<string, unknown>, pick: (r: HfStatus) => string | undefined, run: { resumeKey?: string; maxWaitMs: number }): Promise<GenResult> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? Date.now;
    const log = this.opts.log ?? (() => {});
    return this.semaphore.run(async () => {
      let requestId: string | null = null;
      const resumed = run.resumeKey ? await this.pending.get(run.resumeKey) : null;
      if (resumed) {
        requestId = resumed.requestId;
        log(`resuming Higgsfield request ${requestId} instead of submitting again`);
      }
      for (;;) {
        if (!requestId) {
          requestId = await withRetry(() => this.api.submit(model, input), {
            attempts: 4,
            baseDelayMs: this.opts.submitBaseDelayMs ?? 5000,
            isTransient: isRetryableSubmitError,
            sleep,
          });
          if (run.resumeKey) await this.pending.set(run.resumeKey, { requestId, model, submittedAt: new Date(now()).toISOString() });
        }
        const result = await this.waitFor(requestId, run.maxWaitMs, sleep, now);
        if (result === "unknown") {
          // The provider no longer knows this id: forget it and submit fresh.
          if (run.resumeKey) await this.pending.delete(run.resumeKey);
          requestId = null;
          continue;
        }
        if (run.resumeKey) await this.pending.delete(run.resumeKey);
        const status: string = result.status;
        const url = pick(result);
        if (status === "completed" && url) return { url, requestId };
        const reason =
          status === "nsfw" ? "was blocked by content moderation"
          : status === "completed" ? "completed without an output URL"
          : `ended with status "${status}"`;
        throw new PermanentProviderError(`Higgsfield ${model} ${reason} (request ${requestId})`, "higgsfield", requestId);
      }
    });
  }

  private async waitFor(requestId: string, maxWaitMs: number, sleep: (ms: number) => Promise<void>, now: () => number): Promise<HfStatus | "unknown"> {
    const deadline = now() + maxWaitMs;
    for (;;) {
      try {
        const s = await this.api.status(requestId);
        if (TERMINAL.has(s.status)) return s;
      } catch (err) {
        if (err instanceof HfHttpError && err.status === 404) return "unknown";
        // Status polling is read-only: tolerate 5xx, timeouts and network errors.
        const tolerable = (err instanceof HfHttpError && (err.status >= 500 || err.status === 429)) || !(err instanceof HfHttpError);
        if (!tolerable) throw err;
      }
      if (now() >= deadline) {
        throw new PermanentProviderError(
          `Higgsfield request ${requestId} still processing after ${Math.round(maxWaitMs / 60000)} min; retry to pick it up without paying again`,
          "higgsfield",
          requestId,
        );
      }
      await sleep(this.opts.pollMs ?? 5000);
    }
  }
}
```
Image and video generators:
```ts
export class HiggsfieldImageGen implements ImageGen {
  constructor(private readonly gateway: HiggsfieldGateway, readonly model = "higgsfield-ai/soul/v2/standard") {}
  generate({ prompt, resumeKey }: { prompt: string; resumeKey?: string }): Promise<GenResult> {
    return this.gateway.run(this.model, { prompt, aspect_ratio: "9:16", resolution: "1080p", batch_size: 1 }, (r) => r.images?.[0]?.url, { resumeKey, maxWaitMs: IMAGE_MAX_WAIT_MS });
  }
}

export class HiggsfieldVideoGen implements VideoGen {
  constructor(
    private readonly gateway: HiggsfieldGateway,
    readonly model = "bytedance/seedance-2.5/image-to-video",
    readonly resolution: "480p" | "720p" | "1080p" = "720p",
    private readonly maxWaitMs = 40 * 60 * 1000,
  ) {}
  async imageToVideo({ imageUrl, prompt, durationSec, resumeKey }: { imageUrl: string; prompt: string; durationSec: number; resumeKey?: string }): Promise<GenResult> {
    if (!Number.isInteger(durationSec) || durationSec < 4 || durationSec > 30) {
      throw new RangeError(`durationSec must be an integer from 4 to 30, got ${durationSec}`);
    }
    return this.gateway.run(
      this.model,
      { image_url: imageUrl, prompt, duration: durationSec, resolution: this.resolution, generate_audio: false },
      (r) => r.video?.url,
      { resumeKey, maxWaitMs: this.maxWaitMs },
    );
  }
}
```

- [ ] **Step 6: Wire it in**
- `providers/types.ts`: add `resumeKey?: string` to both request parameter types (see Interfaces).
- `providers/fake.ts`: the fake image and video generators accept `resumeKey` and ignore it (type-only change).
- `config.ts`:
  - Add `maxWaitMinutes: number` to `higgsfield`.
  - Parse `HF_MAX_WAIT_MINUTES` (default "40"). An integer ≥ 1 is required, otherwise throw `HF_MAX_WAIT_MINUTES must be an integer ≥ 1 (got "…")`.
  - Extend `config.test.ts`: the default is 40, and "0" throws.
- `providers/index.ts` (`createProviders`, real mode):
```ts
  const api = httpHiggsfieldApi(credentials, config.higgsfield.baseUrl);
  const pending = new FilePendingStore(path.join(config.cacheDir, "pending"));
  const gateway = new HiggsfieldGateway(api, pending, config.higgsfield.concurrency, { log: (m) => console.log(m) });
  // …
  video: new HiggsfieldVideoGen(gateway, config.higgsfield.videoModel, config.higgsfield.videoResolution, config.higgsfield.maxWaitMinutes * 60_000),
```
  (Import `path` from `node:path`. The worker's fake mode uses fake providers, so it never touches the pending store.)
- `pipeline.ts`:
  - Pass the cache key as `resumeKey`: `p.image.generate({ prompt, resumeKey: imageHash })`, where `imageHash` is `hashes.image(p.image.model, prompt)`. Compute it once, before `cached(...)`, and reuse it.
  - Pass `p.video.imageToVideo({ imageUrl, prompt, durationSec: billSec, resumeKey: rawHash })`.
- `index.ts` (engine): add `export * from "./pending-store";` and `export * from "./providers/higgsfield-api";`.
- `.env.example`: add `HF_MAX_WAIT_MINUTES=40` under the Higgsfield lines.
- `docs/RUNNING.md`:
  - Mention `HF_MAX_WAIT_MINUTES` in the optional settings.
  - Add a one-line note: "A scene that times out on Higgsfield is not lost — Retry picks up the same request instead of paying again."
- `packages/engine/scripts/smoke-higgsfield.ts`: update it to construct `new HiggsfieldGateway(httpHiggsfieldApi(credentials, config.higgsfield.baseUrl), new MemoryPendingStore(), 1)`. It keeps the same checks. Don't run it; it spends credits.

- [ ] **Step 7: Verify everything.** Run `npm test && npm run typecheck && npm run build -w @reel/web`. Expected: all pass. Nothing may import `@higgsfield/client/v2` any more. Confirm with `grep -rn "@higgsfield/client" packages apps --include=*.ts | grep -v node_modules`, which should find no files. Keep the package dependency; removing it is out of scope.

- [ ] **Step 8: Commit** with message `feat(engine): Higgsfield submit/wait split with retryable submit, tolerant polling, and resume by request id`.
