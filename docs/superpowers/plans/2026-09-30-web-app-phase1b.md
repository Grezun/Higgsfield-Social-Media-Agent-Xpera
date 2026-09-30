# Web App, Supabase and Worker (Phase 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the Phase 1a reel engine in the internal web app from the spec. The team:
- signs in with a magic link
- submits a brief
- edits and approves the Claude storyboard
- watches generation progress live
- previews the reel in a Remotion Player and downloads the MP4

A background worker does all the generation, backed by the hosted Supabase project `reel-agent`.

**Architecture:**
- **Web (`apps/web`, Next.js 16):** only reads and writes rows through the user's Supabase session, under row-level security. It never calls a provider.
- **Worker (`apps/worker`, Node):** claims jobs from a Postgres queue (`claim_job` with `FOR UPDATE SKIP LOCKED`) and runs the Phase 1a planner, pipeline and renderer. It mirrors every cached asset and final render into Supabase Storage and reports progress to the `jobs` row, which the web app streams over Supabase Realtime.
- **`@reel/db`:** a shared package holding the generated database types, bucket/job constants, job-payload and progress schemas, and the pure progress reducer.

**Tech Stack:**
- Next.js 16.3.8 (App Router, Turbopack, `proxy.ts`), React 19.3
- `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.2
- `@remotion/player` 4.0.531
- Supabase (Postgres 17, Auth, Storage, Realtime), project ref `aawjjdxneashqatwaxrt` (eu-central-1)
- Vitest 5, zod 4, and the Phase 1a packages (`@reel/core`, `@reel/media`, `@reel/video`, `@reel/engine`)

**Spec:** `docs/superpowers/specs/2026-09-30-social-reel-agent-design.md` (sections 2, 3.3, 5, 6 and 7). Phase 1a plan: `docs/superpowers/plans/2026-09-30-reel-engine-phase1a.md`.

## Global Constraints

- **Next.js 16:**
  - The session-refresh hook is `proxy.ts` (exporting `proxy`), not `middleware.ts`.
  - `cookies()`, `headers()`, page `params` and `searchParams` are async and must be awaited.
  - There is no `next lint`.
- **Supabase env names:**
  - Web: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (in `apps/web/.env.local`).
  - Worker: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (in the root `.env.local`).
- **Secrets:** the Supabase secret key, and every provider key (`HF_CREDENTIALS`, `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`), exist **only in the worker**. Nothing prefixed `NEXT_PUBLIC_` may hold a secret. The web app never imports `@reel/engine` or `@reel/media`.
- **Auth:** invite-only. `signInWithOtp` always passes `shouldCreateUser: false`, and "Allow new users to sign up" is off in the dashboard. Server code protects pages with `auth.getClaims()`, never `getSession()`.
- **Authorization:** RLS is on for every table. Any authenticated user can read all rows (one shared team workspace). Writes are limited to what the web app does. The worker uses the secret key and bypasses RLS.
- **Queue functions:** `SECURITY DEFINER` with `set search_path = ''`. EXECUTE is revoked from `public`, `anon` and `authenticated` and granted to `service_role` only.
- **Storage:** buckets `assets` and `renders`, both **private**. The web app serves media only through signed URLs.
- **Spend:**
  - Provider credits are spent only by a `generate` job.
  - A `generate` job is created only by the **Approve & generate** or **Retry** actions.
  - The worker re-checks the spend cap (`REEL_SPEND_CAP_USD`) before any provider call.
- **Worker liveness:** the worker heartbeats every 15 s. Jobs whose heartbeat is more than 120 s old are requeued when a worker starts.
- **Remotion:** every `remotion`/`@remotion/*` package, including `@remotion/player`, is pinned to exactly `4.0.531`.
- **RTL:** in Hebrew reels, script and overlay text fields render `dir="rtl"`. Visual prompts are always `dir="ltr"`, because they're written in English.

## Spec deviations (intentional, flagged for the reviewer)

1. **Job types are `plan` and `generate`.** A `generate` job runs voice → visuals → render → export in one job with per-step progress, so the spec's separate `render` job is folded in. `revise` (the "Ask Claude" box), the revision diff, version history, the settings page, the voice picker with preview, and the Characters library are **Phase 5 / Phase 3**, not this plan.
2. **The asset cache is a `MirroredAssetStore`.** The worker keeps its local disk cache, because Remotion and FFmpeg need local files. Every stored asset is also uploaded to the `assets` bucket and indexed in the `assets` table, so a new worker machine can restore it and the web app can sign URLs to it.
3. **Stored timelines reference assets as `asset:<fileName>`.** The web app resolves them to signed URLs for the Player. `@reel/core` gains `mapTimelineSources`.
4. **"Retry scene" reruns the whole `generate` job.** Every finished asset is cached, so only the failed scenes cost anything. Editing after approval creates a new draft storyboard version (`created_by: user`).
5. **The voice is chosen in `.env.local`.** It defaults to the worker's `ELEVENLABS_VOICE_HE/EN`. The form also takes an optional voice ID field; the picker with previews is Phase 5.

## Review Focus

1. **A double-click on "Approve & generate", or two open tabs.** Only one `generate` job may be created, and the second click gets "already approved". Pinned in Task 11 (`approveStoryboard` logic test).
2. **The worker process dies mid-job.** On the next start the stale job is requeued and reruns, and cached assets are not paid for again. Pinned in Task 5 (loop requeues stale on start) and Task 6 (the store restores assets from Storage).
3. **A crafted magic-link URL with `next=//evil.example`.** The redirect must stay on-site. Pinned in Task 9 (`safeNextPath`).
4. **An invalid storyboard edited in the UI and then approved** (empty script, image scene without a prompt). The server rejects it with readable messages, and no job is created. Pinned in Task 11.
5. **A generate job on a different worker machine from the one that made the assets.** Assets are restored from Storage instead of regenerated. Pinned in Task 6.

---

## File Structure

```
package.json                              + "apps/*" workspace, worker/web scripts
tsconfig.json                             + include apps/worker
vitest.config.ts                          + apps/**/*.test.ts
supabase/migrations/20260930200000_reel_schema.sql   tables, RLS, buckets, realtime, queue functions
packages/core/src/models.ts               DEFAULT_MODELS, costModelsFor
packages/core/src/plan-form.ts            PlanFormSchema (brief form = plan job payload)
packages/core/src/events.ts               PipelineEvent type
packages/core/src/timeline-sources.ts     ASSET_SRC_PREFIX, assetSrc, mapTimelineSources, timelineAssetFiles
packages/engine/src/index.ts              public engine API for the worker
packages/engine/src/asset-store.ts        + AssetStore interface
packages/engine/src/pipeline.ts           + onEvent, buildTimeline
packages/video/package.json               + "./reel" export for the Player
packages/db/                              @reel/db
  src/database.types.ts                   generated from the hosted project
  src/index.ts                            constants, row types, schemas, applyPipelineEvent, renderPaths
apps/worker/                              @reel/worker
  src/env.ts                              loadWorkerEnv
  src/queue.ts                            JobQueue, SupabaseJobQueue
  src/loop.ts                             processNextJob, runWorker, createThrottledReporter
  src/storage.ts                          BlobStore, AssetIndex, Supabase impls, MirroredAssetStore
  src/reel-db.ts                          ReelDb, SupabaseReelDb
  src/handlers/plan.ts                    createPlanHandler
  src/handlers/generate.ts                createGenerateHandler
  src/testing/fakes.ts                    in-memory JobQueue/BlobStore/AssetIndex/ReelDb
  src/main.ts                             entry point
  scripts/smoke-supabase.ts               live DB/queue/storage check (free)
apps/web/                                 @reel/web (Next.js 16)
  next.config.ts, tsconfig.json, proxy.ts, app/globals.css
  lib/supabase/{client,server,proxy}.ts
  lib/safe-next.ts, lib/plan-form.ts, lib/storyboard-edit.ts, lib/approve.ts,
  lib/progress-view.ts, lib/queries.ts, lib/render-urls.ts
  app/layout.tsx, app/page.tsx
  app/login/{page.tsx,login-form.tsx,actions.ts}, app/auth/confirm/route.ts, app/auth/error/page.tsx
  app/new/{page.tsx,new-reel-form.tsx,actions.ts}
  app/projects/[id]/{page.tsx,actions.ts}
  components/{StoryboardEditor,JobPanel,ReelPreview}.tsx
docs/RUNNING.md                           setup + run instructions
```

---

### Task 1: Core additions: shared models, plan form, pipeline events, timeline sources

**Files:**
- Create: `packages/core/src/models.ts`, `packages/core/src/plan-form.ts`, `packages/core/src/events.ts`, `packages/core/src/timeline-sources.ts`
- Modify: `packages/core/src/index.ts`, `packages/engine/src/config.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`
- Test: `packages/core/src/plan-form.test.ts`, `packages/core/src/timeline-sources.test.ts`

**Interfaces:**
- Consumes: `LanguageSchema`, `CaptionPresetSchema`, `PaletteColorSchema`, `Timeline` (existing in `@reel/core`)
- Produces (from `@reel/core`):
  - `DEFAULT_MODELS = { image: "higgsfield-ai/soul/v2/standard", video: "bytedance/seedance-2.5/image-to-video", voiceModelId: "eleven_v4" }`
  - `costModelsFor(voiceModelId: string): { image: string; video: string; voice: string }`
  - `PlanFormSchema`, `type PlanForm = { brief; language; targetDurationSec: 15|30|45|60; pacing; captionPreset; palette: string[]; voiceId?: string }`
  - `type PipelineEvent` (union below)
  - `ASSET_SRC_PREFIX = "asset:"`, `assetSrc(fileName)`, `mapTimelineSources(t, resolve)`, `timelineAssetFiles(t): string[]`

- [ ] **Step 1: Add the `apps/*` workspaces to tooling**

In root `package.json`, change `"workspaces": ["packages/*"]` to `"workspaces": ["packages/*", "apps/*"]`, and add these scripts next to the existing ones:
```json
"worker": "tsx apps/worker/src/main.ts",
"worker:fake": "tsx apps/worker/src/main.ts --fake",
"smoke:supabase": "tsx apps/worker/scripts/smoke-supabase.ts",
"web": "npm run dev -w @reel/web"
```
Change `"typecheck"` to:
```json
"typecheck": "tsc -p tsconfig.json && tsc -p apps/web/tsconfig.json"
```
Until Task 9 creates `apps/web/tsconfig.json`, run `npx tsc -p tsconfig.json` directly.

In `tsconfig.json`, change `"include"` to:
```json
"include": ["packages/*/src", "packages/*/scripts", "apps/worker/src", "apps/worker/scripts", "vitest.config.ts"]
```

In `vitest.config.ts`, change `include` to:
```ts
include: ["packages/*/src/**/*.test.{ts,tsx}", "apps/*/src/**/*.test.{ts,tsx}", "apps/web/lib/**/*.test.ts"],
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/plan-form.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { PlanFormSchema } from "./plan-form";

const valid = {
  brief: "3 טיפים לצמיחה בטיקטוק",
  language: "he",
  targetDurationSec: 30,
  pacing: "punchy",
  captionPreset: "bold_pop",
  palette: ["#FFE14D", "#111111"],
};

describe("PlanFormSchema", () => {
  it("accepts a valid form and leaves voiceId optional", () => {
    expect(PlanFormSchema.parse(valid)).toEqual(valid);
    expect(PlanFormSchema.parse({ ...valid, voiceId: " v1 " }).voiceId).toBe("v1");
  });
  it("rejects a too-short brief, bad length and bad colours", () => {
    expect(PlanFormSchema.safeParse({ ...valid, brief: "hi" }).success).toBe(false);
    expect(PlanFormSchema.safeParse({ ...valid, targetDurationSec: 20 }).success).toBe(false);
    expect(PlanFormSchema.safeParse({ ...valid, palette: ["yellow"] }).success).toBe(false);
  });
});
```

`packages/core/src/timeline-sources.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { assetSrc, mapTimelineSources, timelineAssetFiles } from "./timeline-sources";
import type { Timeline } from "./schema/timeline";

const timeline = (): Timeline => ({
  fps: 30, width: 1080, height: 1920, durationInFrames: 60, language: "he", direction: "rtl",
  style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D"] },
  audio: { voiceUrl: assetSrc("v.wav"), musicDuckingDb: -18 },
  clips: [
    { sceneId: "s1", kind: "image", src: assetSrc("a.png"), fromFrame: 0, durationInFrames: 30, motion: "none", transitionIn: "cut" },
    { sceneId: "s2", kind: "graphic", fromFrame: 30, durationInFrames: 30, motion: "none", transitionIn: "cut" },
    { sceneId: "s3", kind: "video", src: "https://already/abs.mp4", fromFrame: 30, durationInFrames: 30, motion: "none", transitionIn: "cut" },
  ],
  captions: { words: [] },
  overlays: [],
});

describe("timeline sources", () => {
  it("lists referenced asset files once each", () => {
    expect(timelineAssetFiles(timeline()).sort()).toEqual(["a.png", "v.wav"]);
  });
  it("resolves asset: refs and leaves other srcs alone", () => {
    const t = mapTimelineSources(timeline(), (f) => `https://signed/${f}`);
    expect(t.audio.voiceUrl).toBe("https://signed/v.wav");
    expect(t.clips.map((c) => c.src)).toEqual(["https://signed/a.png", undefined, "https://already/abs.mp4"]);
    expect(t.audio.musicUrl).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx vitest run packages/core/src/plan-form.test.ts packages/core/src/timeline-sources.test.ts`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 4: Implement the four core modules**

`packages/core/src/models.ts`:
```ts
/** Model ids used for generation and cost estimates; shared by the worker (engine config) and the web app (estimates). */
export const DEFAULT_MODELS = {
  image: "higgsfield-ai/soul/v2/standard",
  video: "bytedance/seedance-2.5/image-to-video",
  voiceModelId: "eleven_v4",
} as const;

export function costModelsFor(voiceModelId: string) {
  return { image: DEFAULT_MODELS.image, video: DEFAULT_MODELS.video, voice: `elevenlabs/${voiceModelId}` };
}
```

`packages/core/src/plan-form.ts`:
```ts
import * as z from "zod";
import { CaptionPresetSchema, LanguageSchema, PaletteColorSchema } from "./schema/storyboard";

/** The "new reel" form. It is also the payload of a `plan` job. */
export const PlanFormSchema = z.object({
  brief: z.string().trim().min(3, "brief must be at least 3 characters").max(2000),
  language: LanguageSchema,
  targetDurationSec: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
  pacing: z.enum(["calm", "punchy"]),
  captionPreset: CaptionPresetSchema,
  palette: z.array(PaletteColorSchema).min(1).max(5),
  voiceId: z.string().trim().min(1).optional(),
});
export type PlanForm = z.infer<typeof PlanFormSchema>;
```

`packages/core/src/events.ts`:
```ts
export type PipelineStep = "voice" | "visuals" | "render" | "export";

/** Progress events emitted by the engine pipeline; the worker folds them into the job's progress JSON. */
export type PipelineEvent =
  | { type: "step"; step: PipelineStep; status: "running" | "done" }
  | { type: "scene"; sceneId: string; status: "running" | "done" | "failed"; reason?: string }
  | { type: "render-progress"; progress: number };
```

`packages/core/src/timeline-sources.ts`:
```ts
import type { Timeline } from "./schema/timeline";

/** Stored timelines reference cached assets as `asset:<fileName>`; consumers resolve them to URLs they can load. */
export const ASSET_SRC_PREFIX = "asset:";
export const assetSrc = (fileName: string) => `${ASSET_SRC_PREFIX}${fileName}`;

const refOf = (src?: string) => (src?.startsWith(ASSET_SRC_PREFIX) ? src.slice(ASSET_SRC_PREFIX.length) : undefined);

export function timelineAssetFiles(t: Timeline): string[] {
  const refs = [t.audio.voiceUrl, t.audio.musicUrl, ...t.clips.map((c) => c.src)].map(refOf).filter((r): r is string => !!r);
  return [...new Set(refs)];
}

export function mapTimelineSources(t: Timeline, resolve: (fileName: string) => string): Timeline {
  const map = (src?: string) => {
    const ref = refOf(src);
    return ref ? resolve(ref) : src;
  };
  return {
    ...t,
    audio: { ...t.audio, voiceUrl: map(t.audio.voiceUrl), musicUrl: map(t.audio.musicUrl) },
    clips: t.clips.map((c) => ({ ...c, src: map(c.src) })),
  };
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from "./models";
export * from "./plan-form";
export * from "./events";
export * from "./timeline-sources";
```

In `packages/engine/src/config.ts`, import `DEFAULT_MODELS` from `@reel/core`. Replace these literals:
- `imageModel: "higgsfield-ai/soul/v2/standard"` becomes `imageModel: DEFAULT_MODELS.image`
- `videoModel: "bytedance/seedance-2.5/image-to-video"` becomes `videoModel: DEFAULT_MODELS.video`
- `modelId: env.ELEVENLABS_MODEL_ID ?? "eleven_v4"` becomes `modelId: env.ELEVENLABS_MODEL_ID ?? DEFAULT_MODELS.voiceModelId`

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run packages && npx tsc -p tsconfig.json`
Expected: every package test passes, including the 4 new tests and the existing `config.test.ts` defaults; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts packages/core packages/engine/src/config.ts
git commit -m "feat(core): shared model ids, plan form schema, pipeline events, timeline asset refs"
```

---

### Task 2: Engine: AssetStore interface, progress events, public API

**Files:**
- Modify: `packages/engine/src/asset-store.ts`, `packages/engine/src/pipeline.ts`, `packages/engine/package.json`, `packages/video/package.json`
- Create: `packages/engine/src/index.ts`
- Test: `packages/engine/src/pipeline.test.ts` (extend)

**Interfaces:**
- Consumes: `PipelineEvent`, `assetSrc` (Task 1)
- Produces:
  - `interface AssetStore { readonly root: string; get(hash: string): Promise<StoredAsset | null>; putFile(hash: string, sourcePath: string, ext: string, meta: Omit<AssetMeta, "createdAt">): Promise<StoredAsset> }`, implemented by `FileAssetStore`
  - `PipelineDeps = { providers; store: AssetStore; tmpDir; log; onEvent?: (e: PipelineEvent) => void }`
  - `buildTimeline(sb: Storyboard, gen: GeneratedAssets, urlFor: (fileName: string) => string): Timeline`
  - `@reel/engine` (`src/index.ts`) exports: config, asset-store, download, pipeline, planner, providers (index + types + fake), retry
  - `@reel/video/reel` exports `Reel` and `ReelProps`

- [ ] **Step 1: Write the failing tests**

Add to `packages/engine/src/pipeline.test.ts`:

At the top, add these imports:
```ts
import type { PipelineEvent } from "@reel/core";
import { buildTimeline } from "./pipeline";
```
Add this test inside the existing `describe`:
```ts
  it("emits step and scene events and builds asset-ref timelines", async () => {
    const { dir, providers, deps } = await setup();
    const events: PipelineEvent[] = [];
    const sb = await providers.planner.plan(REQ);
    const gen = await generateAssets(sb, { ...deps, onEvent: (e) => events.push(e) });
    const kinds = events.map((e) => (e.type === "step" ? `${e.step}:${e.status}` : e.type === "scene" ? `${e.sceneId}:${e.status}` : e.type));
    expect(kinds[0]).toBe("voice:running");
    expect(kinds).toContain("voice:done");
    expect(kinds).toContain("visuals:running");
    expect(kinds).toContain("s1:running");
    expect(kinds).toContain("s1:done");
    expect(kinds).toContain("s2:done");
    expect(kinds.at(-1)).toBe("visuals:done");
    expect(kinds.some((k) => k.startsWith("s3:"))).toBe(false); // graphic scene has no asset work

    const timeline = buildTimeline(sb, gen, (f) => `asset:${f}`);
    expect(timeline.audio.voiceUrl).toBe(`asset:${gen.voice.fileName}`);
    expect(timeline.clips.find((c) => c.sceneId === "s1")?.src).toBe(`asset:${gen.visuals.s1.asset.fileName}`);

    const renderEvents: PipelineEvent[] = [];
    await renderAndExport(sb, gen, { ...deps, onEvent: (e) => renderEvents.push(e) }, join(dir, "out-events"));
    const steps = renderEvents.filter((e) => e.type === "step").map((e) => `${(e as { step: string }).step}:${(e as { status: string }).status}`);
    expect(steps).toEqual(["render:running", "render:done", "export:running", "export:done"]);
    expect(renderEvents.some((e) => e.type === "render-progress")).toBe(true);
  }, 600_000);

  it("emits a failed scene event with the reason", async () => {
    const { providers, deps } = await setup("FAIL");
    const sb = await providers.planner.plan(REQ);
    sb.scenes[1].visual.prompt = "FAIL this prompt";
    const events: PipelineEvent[] = [];
    await generateAssets(sb, { ...deps, onEvent: (e) => events.push(e) }).catch(() => {});
    expect(events).toContainEqual({ type: "scene", sceneId: "s2", status: "failed", reason: expect.stringMatching(/content moderation/) });
    expect(events.some((e) => e.type === "step" && e.step === "visuals" && e.status === "done")).toBe(false);
  }, 300_000);
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/engine/src/pipeline.test.ts`
Expected: FAIL. `buildTimeline` is not exported, and no events are emitted.

- [ ] **Step 3: Implement**

In `packages/engine/src/asset-store.ts`, add this interface above the class, and change `export class FileAssetStore {` to `export class FileAssetStore implements AssetStore {`:
```ts
/** Where the pipeline caches provider outputs. `root` is a local directory holding every returned `path`. */
export interface AssetStore {
  readonly root: string;
  get(hash: string): Promise<StoredAsset | null>;
  putFile(hash: string, sourcePath: string, ext: string, meta: Omit<AssetMeta, "createdAt">): Promise<StoredAsset>;
}
```

In `packages/engine/src/pipeline.ts`:
1. Change the import `import type { AssetMeta, FileAssetStore, StoredAsset } from "./asset-store";` to `import type { AssetMeta, AssetStore, StoredAsset } from "./asset-store";`. Add `type PipelineEvent` to the `@reel/core` import list.
2. Replace the `PipelineDeps` type with:
```ts
export type PipelineDeps = {
  providers: Providers;
  store: AssetStore;
  tmpDir: string;
  log: (msg: string) => void;
  onEvent?: (event: PipelineEvent) => void;
};
```
3. In `cached(...)`, change the parameter type `store: FileAssetStore` to `store: AssetStore`.
4. In `generateAssets`:
   - After `const { providers: p, store, tmpDir, log } = deps;`, add `const emit = (e: PipelineEvent) => deps.onEvent?.(e);`.
   - Immediately before `const voice = await cached(`, add `emit({ type: "step", step: "voice", status: "running" });`.
   - Immediately after the `words`/`spans` lines (before the `// 2. Visuals` comment), add `emit({ type: "step", step: "voice", status: "done" });` then `emit({ type: "step", step: "visuals", status: "running" });`.
   - Inside the per-scene callback, right after `if (kind === "graphic") return;`, add `emit({ type: "scene", sceneId: scene.id, status: "running" });`.
   - Replace the two success points: before `return;` in the `kind === "image"` branch, and after `visuals[scene.id] = { kind: "video", asset: fitted };`. Each gets `emit({ type: "scene", sceneId: scene.id, status: "done" });`.
   - In the `catch`, compute `const reason = err instanceof Error ? err.message : String(err);`. Push `{ sceneId: scene.id, reason }` and `emit({ type: "scene", sceneId: scene.id, status: "failed", reason });`.
   - After the `if (failures.length) throw ...` line, add `emit({ type: "step", step: "visuals", status: "done" });`.
5. Add `buildTimeline` above `renderAndExport`, and use it inside `renderAndExport`:
```ts
/** The Timeline for this storyboard + generated assets, with each asset file mapped through `urlFor`. */
export function buildTimeline(sb: Storyboard, gen: GeneratedAssets, urlFor: (fileName: string) => string): Timeline {
  return assemble({
    storyboard: sb,
    spans: gen.spans,
    words: gen.words,
    visuals: Object.fromEntries(Object.entries(gen.visuals).map(([id, v]) => [id, { kind: v.kind, src: urlFor(v.asset.fileName) }])),
    voiceUrl: urlFor(gen.voice.fileName),
  });
}
```
Replace the body of `renderAndExport` from `const timeline = assemble({` down to `return { timeline, master, reel, preview, thumbnail: thumb };` with:
```ts
    const emit = (e: PipelineEvent) => deps.onEvent?.(e);
    const timeline = buildTimeline(sb, gen, server.urlFor);
    // Asset URLs in timeline.json point at the temporary local server and are only valid during this render.
    await writeFile(join(outDir, "timeline.json"), JSON.stringify(timeline, null, 2));
    const master = join(outDir, "master.mp4");
    deps.log("render: Remotion");
    emit({ type: "step", step: "render", status: "running" });
    await renderReel(timeline, master, (progress) => {
      onProgress?.(progress);
      emit({ type: "render-progress", progress });
    });
    emit({ type: "step", step: "render", status: "done" });
    emit({ type: "step", step: "export", status: "running" });
    const reel = join(outDir, "reel.mp4");
    deps.log("export: social_1080p");
    await exportDeliverable(master, reel, "social_1080p");
    const preview = join(outDir, "preview.mp4");
    await exportDeliverable(master, preview, "preview_540p");
    const thumb = join(outDir, "thumbnail.jpg");
    await thumbnail(master, thumb, Math.min(1, timeline.durationInFrames / 30 / 2));
    emit({ type: "step", step: "export", status: "done" });
    return { timeline, master, reel, preview, thumbnail: thumb };
```
6. Create `packages/engine/src/index.ts`:
```ts
export * from "./config";
export * from "./asset-store";
export * from "./download";
export * from "./pipeline";
export * from "./planner";
export * from "./providers";
export * from "./providers/types";
export { createFakeProviders } from "./providers/fake";
export { withRetry, Semaphore } from "./retry";
```
7. In `packages/engine/package.json`, change `"exports": { ".": "./src/pipeline.ts" }` to `"exports": { ".": "./src/index.ts" }`.
8. In `packages/video/package.json`, change `"exports"` to:
```json
"exports": { "./render": "./src/render.ts", "./sample": "./src/sample-timeline.ts", "./reel": "./src/Reel.tsx" }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run packages && npx tsc -p tsconfig.json`
Expected: all package tests pass, including the two new pipeline tests; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/engine packages/video/package.json
git commit -m "feat(engine): AssetStore interface, pipeline progress events, buildTimeline, public index"
```

---

### Task 3: Database schema on the hosted Supabase project

**Files:**
- Create: `supabase/migrations/20260930200000_reel_schema.sql`
- Create: `packages/db/package.json`, `packages/db/src/database.types.ts` (generated)

**Interfaces:**
- Consumes: the Supabase project `aawjjdxneashqatwaxrt` through the Supabase MCP tools (`apply_migration`, `list_tables`, `get_advisors`, `generate_typescript_types`, `execute_sql`)
- Produces:
  - tables `projects`, `storyboards`, `assets`, `jobs` and `renders` (columns below)
  - buckets `assets` and `renders`
  - functions `claim_job(p_worker text) → setof jobs` and `requeue_stale_jobs(p_stale_seconds int) → int`
  - Realtime on `jobs`, `storyboards` and `renders`
  - `packages/db/src/database.types.ts` exporting `Database` and `Json`

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260930200000_reel_schema.sql`:
```sql
-- Reel agent schema (Phase 1b). One shared team workspace: every signed-in user can read everything;
-- writes are limited to what the web app does. The worker uses the secret key (bypasses RLS).

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 120),
  language text not null check (language in ('he', 'en')),
  format text not null default 'faceless' check (format in ('faceless', 'avatar', 'character', 'footage')),
  status text not null default 'planning'
    check (status in ('planning', 'draft', 'generating', 'needs_attention', 'rendered', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_updated_idx on public.projects (updated_at desc);

create table public.storyboards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version int not null check (version > 0),
  json jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  created_by text not null check (created_by in ('user', 'agent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, version)
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  input_hash text not null unique check (input_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('image', 'video', 'audio')),
  file_name text not null,
  storage_path text not null,
  provider text not null,
  model text,
  provider_request_id text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  type text not null check (type in ('plan', 'generate')),
  status text not null default 'queued' check (status in ('queued', 'running', 'needs_attention', 'done', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  error text,
  attempts int not null default 0,
  locked_by text,
  heartbeat_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_queued_idx on public.jobs (created_at) where status = 'queued';
create index jobs_project_idx on public.jobs (project_id, created_at desc);

create table public.renders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  storyboard_id uuid not null references public.storyboards (id) on delete cascade,
  storyboard_version int not null,
  reel_path text not null,
  preview_path text not null,
  thumbnail_path text not null,
  timeline jsonb not null,
  created_at timestamptz not null default now()
);
create index renders_project_idx on public.renders (project_id, created_at desc);

-- updated_at maintenance
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();
create trigger storyboards_touch before update on public.storyboards for each row execute function public.touch_updated_at();

-- Row level security
alter table public.projects enable row level security;
alter table public.storyboards enable row level security;
alter table public.assets enable row level security;
alter table public.jobs enable row level security;
alter table public.renders enable row level security;

create policy "team reads projects" on public.projects for select to authenticated using (true);
create policy "members create projects" on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "team updates projects" on public.projects for update to authenticated using (true) with check (true);

create policy "team reads storyboards" on public.storyboards for select to authenticated using (true);
create policy "team adds user drafts" on public.storyboards for insert to authenticated
  with check (status = 'draft' and created_by = 'user');
create policy "team edits and approves drafts" on public.storyboards for update to authenticated
  using (status = 'draft') with check (status in ('draft', 'approved'));

create policy "team reads assets" on public.assets for select to authenticated using (true);

create policy "team reads jobs" on public.jobs for select to authenticated using (true);
create policy "team queues jobs" on public.jobs for insert to authenticated
  with check (status = 'queued' and attempts = 0 and locked_by is null and created_by = (select auth.uid()));

create policy "team reads renders" on public.renders for select to authenticated using (true);

-- Storage: private buckets; signed-in users may read (sign URLs), only the worker writes.
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false), ('renders', 'renders', false)
on conflict (id) do nothing;
create policy "team reads reel media" on storage.objects for select to authenticated
  using (bucket_id in ('assets', 'renders'));

-- Realtime (RLS still applies per subscriber)
alter publication supabase_realtime add table public.jobs, public.storyboards, public.renders;

-- Queue: claim the oldest queued job atomically; requeue jobs whose worker stopped heartbeating.
create function public.claim_job(p_worker text) returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.jobs j
     set status = 'running', locked_by = p_worker, started_at = now(), heartbeat_at = now(), attempts = j.attempts + 1
   where j.id = (
     select q.id from public.jobs q
      where q.status = 'queued'
      order by q.created_at
      for update skip locked
      limit 1)
  returning j.*;
end $$;

create function public.requeue_stale_jobs(p_stale_seconds int default 120) returns int
language sql security definer set search_path = '' as $$
  with stale as (
    update public.jobs
       set status = 'queued', locked_by = null
     where status = 'running' and heartbeat_at < now() - make_interval(secs => p_stale_seconds)
    returning 1)
  select count(*)::int from stale;
$$;

revoke execute on function public.claim_job(text) from public, anon, authenticated;
revoke execute on function public.requeue_stale_jobs(int) from public, anon, authenticated;
grant execute on function public.claim_job(text) to service_role;
grant execute on function public.requeue_stale_jobs(int) to service_role;
```

- [ ] **Step 2: Apply it to the hosted project**

Use the Supabase MCP tool `apply_migration` with `project_id: "aawjjdxneashqatwaxrt"`, `name: "reel_schema"` and `query` set to the full SQL file contents. (With the CLI instead: `supabase link --project-ref aawjjdxneashqatwaxrt && supabase db push`.)

Expected: success. If it fails, fix the SQL file, don't hand-edit the database, and re-apply.

- [ ] **Step 3: Verify the schema**

Use `list_tables` (`project_id`, `schemas: ["public"]`). Expected: `projects`, `storyboards`, `assets`, `jobs`, `renders`, each with RLS enabled.

Use `execute_sql` with:
```sql
select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as auth_can_exec,
       has_function_privilege('service_role', p.oid, 'execute') as service_can_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('claim_job', 'requeue_stale_jobs');
select id, public from storage.buckets where id in ('assets', 'renders');
select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
```
Expected:
- both functions have `auth_can_exec = false` and `service_can_exec = true`
- both buckets have `public = false`
- the publication lists `jobs`, `renders` and `storyboards`

Use `get_advisors` with `type: "security"`. Expected: no findings of level ERROR for these tables or functions. Record any WARN findings in the report.

- [ ] **Step 4: Generate the types into the new `@reel/db` package**

`packages/db/package.json`:
```json
{
  "name": "@reel/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@reel/core": "*",
    "@supabase/supabase-js": "2.117.2",
    "zod": "^4.6.5"
  }
}
```
Use the Supabase MCP tool `generate_typescript_types` (`project_id: "aawjjdxneashqatwaxrt"`) and save its output verbatim as `packages/db/src/database.types.ts`. With the CLI: `supabase gen types typescript --project-id aawjjdxneashqatwaxrt --schema public > packages/db/src/database.types.ts`. Confirm the file contains `export type Database` and `jobs:`. Then run `npm install`.

- [ ] **Step 5: Commit**

```bash
git add supabase packages/db package.json package-lock.json
git commit -m "feat(db): reel schema with RLS, private buckets, realtime and queue functions; generated types"
```

---

### Task 4: `@reel/db`: constants, row types, schemas, progress reducer

**Files:**
- Create: `packages/db/src/index.ts`
- Test: `packages/db/src/index.test.ts`

**Interfaces:**
- Consumes: `Database` (Task 3); `PlanFormSchema`, `PipelineEvent` (Task 1)
- Produces:
  - `BUCKETS = { assets: "assets", renders: "renders" }`
  - `type JobType = "plan" | "generate"`, `type JobStatus = "queued" | "running" | "needs_attention" | "done" | "failed"`
  - `type ProjectStatus = "planning" | "draft" | "generating" | "needs_attention" | "rendered" | "failed"`
  - `type Tables<T>` row helper, and `JobRow`, `ProjectRow`, `StoryboardRow`, `RenderRow`, `AssetRow`
  - `PlanJobPayloadSchema` (= `PlanFormSchema`), `GenerateJobPayloadSchema = { storyboardId: uuid }`
  - `JobProgressSchema`, `type JobProgress`, `emptyProgress()`, `applyPipelineEvent(progress, event): JobProgress`
  - `renderPaths(projectId: string, version: number): { reel; preview; thumbnail }`

- [ ] **Step 1: Write the failing test**

`packages/db/src/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { applyPipelineEvent, emptyProgress, GenerateJobPayloadSchema, JobProgressSchema, renderPaths } from "./index";

describe("@reel/db", () => {
  it("folds pipeline events into job progress", () => {
    let p = emptyProgress();
    p = applyPipelineEvent(p, { type: "step", step: "voice", status: "running" });
    p = applyPipelineEvent(p, { type: "step", step: "voice", status: "done" });
    p = applyPipelineEvent(p, { type: "scene", sceneId: "s2", status: "failed", reason: "blocked" });
    p = applyPipelineEvent(p, { type: "render-progress", progress: 0.42 });
    expect(p).toEqual({
      steps: { voice: "done" },
      scenes: { s2: { status: "failed", reason: "blocked" } },
      renderProgress: 0.42,
    });
    expect(JobProgressSchema.parse(p)).toEqual(p);
  });

  it("does not mutate the input progress", () => {
    const p = emptyProgress();
    applyPipelineEvent(p, { type: "step", step: "voice", status: "running" });
    expect(p).toEqual(emptyProgress());
  });

  it("parses stored progress with defaults for missing keys", () => {
    expect(JobProgressSchema.parse({})).toEqual({ steps: {}, scenes: {} });
  });

  it("builds render storage paths per project version", () => {
    expect(renderPaths("p1", 3)).toEqual({ reel: "p1/v3/reel.mp4", preview: "p1/v3/preview.mp4", thumbnail: "p1/v3/thumbnail.jpg" });
  });

  it("validates generate payloads", () => {
    expect(GenerateJobPayloadSchema.safeParse({ storyboardId: "not-a-uuid" }).success).toBe(false);
    expect(GenerateJobPayloadSchema.parse({ storyboardId: "0b5f7a2e-8c2d-4b8a-9f3e-2a1c5d6e7f80" }).storyboardId).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run packages/db`
Expected: FAIL with "Failed to resolve import "./index"".

- [ ] **Step 3: Implement `packages/db/src/index.ts`**

```ts
import { PlanFormSchema, type PipelineEvent } from "@reel/core";
import * as z from "zod";
import type { Database } from "./database.types";

export type { Database, Json } from "./database.types";

export const BUCKETS = { assets: "assets", renders: "renders" } as const;

export type JobType = "plan" | "generate";
export type JobStatus = "queued" | "running" | "needs_attention" | "done" | "failed";
export type ProjectStatus = "planning" | "draft" | "generating" | "needs_attention" | "rendered" | "failed";

export type Tables<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
export type JobRow = Tables<"jobs">;
export type ProjectRow = Tables<"projects">;
export type StoryboardRow = Tables<"storyboards">;
export type RenderRow = Tables<"renders">;
export type AssetRow = Tables<"assets">;

export const PlanJobPayloadSchema = PlanFormSchema;
export const GenerateJobPayloadSchema = z.object({ storyboardId: z.uuid() });

const StepStatusSchema = z.enum(["running", "done"]);
export const JobProgressSchema = z.object({
  steps: z.partialRecord(z.enum(["voice", "visuals", "render", "export"]), StepStatusSchema).default({}),
  scenes: z
    .record(z.string(), z.object({ status: z.enum(["running", "done", "failed"]), reason: z.string().optional() }))
    .default({}),
  renderProgress: z.number().min(0).max(1).optional(),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

export const emptyProgress = (): JobProgress => ({ steps: {}, scenes: {} });

export function applyPipelineEvent(progress: JobProgress, event: PipelineEvent): JobProgress {
  switch (event.type) {
    case "step":
      return { ...progress, steps: { ...progress.steps, [event.step]: event.status } };
    case "scene":
      return {
        ...progress,
        scenes: {
          ...progress.scenes,
          [event.sceneId]: event.reason === undefined ? { status: event.status } : { status: event.status, reason: event.reason },
        },
      };
    case "render-progress":
      return { ...progress, renderProgress: Math.min(1, Math.max(0, event.progress)) };
  }
}

export function renderPaths(projectId: string, version: number) {
  const base = `${projectId}/v${version}`;
  return { reel: `${base}/reel.mp4`, preview: `${base}/preview.mp4`, thumbnail: `${base}/thumbnail.jpg` };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run packages/db && npx tsc -p tsconfig.json`
Expected: PASS (5 tests); `tsc` exits 0. If `z.partialRecord` doesn't exist in the installed zod, use `z.object({ voice: StepStatusSchema.optional(), visuals: ..., render: ..., export: ... })`. Keep the same output shape and note the change in the report.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): shared constants, row types, job payload/progress schemas and reducer"
```

---

### Task 5: Worker: env, job queue and the processing loop

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/src/env.ts`, `apps/worker/src/queue.ts`, `apps/worker/src/loop.ts`, `apps/worker/src/testing/fakes.ts`
- Test: `apps/worker/src/env.test.ts`, `apps/worker/src/loop.test.ts`

**Interfaces:**
- Consumes: `Database`, `JobRow`, `JobProgress`, `JobType`, `Json` (`@reel/db`)
- Produces:
  - `type WorkerEnv = { supabaseUrl; supabaseSecretKey; workerId; pollMs; providers: "real" | "fake" }`, `loadWorkerEnv(env, argv): WorkerEnv`
  - `type JobOutcome = { status: "done"; progress?: JobProgress } | { status: "needs_attention" | "failed"; error: string; progress?: JobProgress }`
  - `interface JobQueue { requeueStale(staleSeconds): Promise<number>; claim(workerId): Promise<JobRow | null>; heartbeat(jobId): Promise<void>; setProgress(jobId, progress): Promise<void>; finish(jobId, outcome): Promise<void> }`, `class SupabaseJobQueue`
  - `type JobContext = { report(progress: JobProgress): void; log(msg: string): void }`, `type JobHandler = (job: JobRow, ctx: JobContext) => Promise<JobOutcome>`, `type Handlers = Record<JobType, JobHandler>`
  - `createThrottledReporter(send, intervalMs): { report(p): void; flush(): Promise<void> }`
  - `processNextJob(queue, handlers, opts): Promise<boolean>`
  - `runWorker(queue, handlers, opts & { pollMs; signal; staleSeconds? }): Promise<void>`
  - `testing/fakes.ts`: `makeJob(partial)`, `FakeJobQueue`

- [ ] **Step 1: Create the package manifest**

`apps/worker/package.json`:
```json
{
  "name": "@reel/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@reel/core": "*",
    "@reel/db": "*",
    "@reel/engine": "*",
    "@reel/media": "*",
    "@supabase/supabase-js": "2.117.2"
  }
}
```
Run `npm install`.

- [ ] **Step 2: Write the fakes and the failing tests**

`apps/worker/src/testing/fakes.ts`:
```ts
import type { JobProgress, JobRow } from "@reel/db";
import type { JobOutcome, JobQueue } from "../queue";

export function makeJob(partial: Partial<JobRow> = {}): JobRow {
  return {
    id: partial.id ?? crypto.randomUUID(),
    project_id: "p1",
    type: "plan",
    status: "queued",
    payload: {},
    progress: {},
    error: null,
    attempts: 0,
    locked_by: null,
    heartbeat_at: null,
    created_by: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    ...partial,
  };
}

/** In-memory JobQueue with the same claim/finish semantics as the SQL functions. */
export class FakeJobQueue implements JobQueue {
  readonly heartbeats: string[] = [];
  readonly progressWrites: { jobId: string; progress: JobProgress }[] = [];
  readonly finished: { jobId: string; outcome: JobOutcome }[] = [];
  requeueCalls: number[] = [];
  constructor(public jobs: JobRow[] = []) {}

  async requeueStale(staleSeconds: number) {
    this.requeueCalls.push(staleSeconds);
    return 0;
  }
  async claim(workerId: string) {
    const job = this.jobs.find((j) => j.status === "queued");
    if (!job) return null;
    Object.assign(job, { status: "running", locked_by: workerId, attempts: job.attempts + 1 });
    return { ...job };
  }
  async heartbeat(jobId: string) {
    this.heartbeats.push(jobId);
  }
  async setProgress(jobId: string, progress: JobProgress) {
    this.progressWrites.push({ jobId, progress });
  }
  async finish(jobId: string, outcome: JobOutcome) {
    this.finished.push({ jobId, outcome });
    const job = this.jobs.find((j) => j.id === jobId);
    if (job) Object.assign(job, { status: outcome.status, locked_by: null });
  }
}
```

`apps/worker/src/env.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadWorkerEnv } from "./env";

describe("loadWorkerEnv", () => {
  it("requires the Supabase URL and secret key", () => {
    expect(() => loadWorkerEnv({}, [])).toThrow(/SUPABASE_URL, SUPABASE_SECRET_KEY/);
  });
  it("applies defaults and reads --fake", () => {
    const env = loadWorkerEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" }, ["--fake"]);
    expect(env).toMatchObject({ supabaseUrl: "https://x.supabase.co", pollMs: 3000, providers: "fake" });
    expect(env.workerId).toMatch(/-\d+$/);
  });
  it("rejects a silly poll interval", () => {
    expect(() => loadWorkerEnv({ SUPABASE_URL: "u", SUPABASE_SECRET_KEY: "k", WORKER_POLL_MS: "10" }, [])).toThrow(/WORKER_POLL_MS/);
  });
});
```

`apps/worker/src/loop.test.ts`:
```ts
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
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx vitest run apps/worker`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 4: Implement `env.ts`, `queue.ts`, `loop.ts`**

`apps/worker/src/env.ts`:
```ts
import { hostname } from "node:os";

export type WorkerEnv = {
  supabaseUrl: string;
  supabaseSecretKey: string;
  workerId: string;
  pollMs: number;
  providers: "real" | "fake";
};

export function loadWorkerEnv(env: NodeJS.ProcessEnv, argv: string[]): WorkerEnv {
  const missing = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing in .env.local: ${missing.join(", ")}`);
  const pollMs = Number(env.WORKER_POLL_MS ?? "3000");
  if (!Number.isInteger(pollMs) || pollMs < 250) throw new Error(`WORKER_POLL_MS must be an integer ≥ 250 (got "${env.WORKER_POLL_MS}")`);
  return {
    supabaseUrl: env.SUPABASE_URL!,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY!,
    workerId: env.WORKER_ID || `${hostname()}-${process.pid}`,
    pollMs,
    providers: argv.includes("--fake") ? "fake" : "real",
  };
}
```

`apps/worker/src/queue.ts`:
```ts
import type { Database, JobProgress, JobRow, Json } from "@reel/db";
import type { SupabaseClient } from "@supabase/supabase-js";

export type JobOutcome =
  | { status: "done"; progress?: JobProgress }
  | { status: "needs_attention" | "failed"; error: string; progress?: JobProgress };

export interface JobQueue {
  requeueStale(staleSeconds: number): Promise<number>;
  claim(workerId: string): Promise<JobRow | null>;
  heartbeat(jobId: string): Promise<void>;
  setProgress(jobId: string, progress: JobProgress): Promise<void>;
  finish(jobId: string, outcome: JobOutcome): Promise<void>;
}

const fail = (what: string, message: string) => new Error(`${what} failed: ${message}`);

export class SupabaseJobQueue implements JobQueue {
  constructor(private readonly sb: SupabaseClient<Database>) {}

  async requeueStale(staleSeconds: number): Promise<number> {
    const { data, error } = await this.sb.rpc("requeue_stale_jobs", { p_stale_seconds: staleSeconds });
    if (error) throw fail("requeue_stale_jobs", error.message);
    return data ?? 0;
  }

  async claim(workerId: string): Promise<JobRow | null> {
    const { data, error } = await this.sb.rpc("claim_job", { p_worker: workerId });
    if (error) throw fail("claim_job", error.message);
    return data?.[0] ?? null;
  }

  async heartbeat(jobId: string): Promise<void> {
    const { error } = await this.sb.from("jobs").update({ heartbeat_at: new Date().toISOString() }).eq("id", jobId);
    if (error) throw fail("heartbeat", error.message);
  }

  async setProgress(jobId: string, progress: JobProgress): Promise<void> {
    const { error } = await this.sb.from("jobs").update({ progress: progress as Json }).eq("id", jobId);
    if (error) throw fail("progress update", error.message);
  }

  async finish(jobId: string, outcome: JobOutcome): Promise<void> {
    const { error } = await this.sb
      .from("jobs")
      .update({
        status: outcome.status,
        error: outcome.status === "done" ? null : outcome.error,
        finished_at: new Date().toISOString(),
        locked_by: null,
        ...(outcome.progress ? { progress: outcome.progress as Json } : {}),
      })
      .eq("id", jobId);
    if (error) throw fail("finish", error.message);
  }
}
```

`apps/worker/src/loop.ts`:
```ts
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
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run apps/worker && npx tsc -p tsconfig.json`
Expected: PASS (env 3, loop 8); `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/worker package-lock.json
git commit -m "feat(worker): env loading, Supabase job queue, processing loop with heartbeat and throttled progress"
```

---

### Task 6: Worker: Supabase-mirrored asset cache

**Files:**
- Create: `apps/worker/src/storage.ts`
- Modify: `apps/worker/src/testing/fakes.ts` (add in-memory blob store and asset index)
- Test: `apps/worker/src/storage.test.ts`

**Interfaces:**
- Consumes: `AssetStore`, `FileAssetStore`, `AssetMeta`, `StoredAsset`, `contentTypeFor`, `generateAssets`, `createFakeProviders` (`@reel/engine`); `BUCKETS`, `Database`, `Json` (`@reel/db`)
- Produces:
  - `interface BlobStore { upload(bucket, path, filePath, contentType): Promise<void>; download(bucket, path, destPath): Promise<void> }`, `class SupabaseBlobStore`
  - `type AssetRecord = { inputHash; kind: AssetKind; fileName; storagePath; provider; model?; requestId?; meta: { estUsd?; createdAt; extra? } }`
  - `interface AssetIndex { find(hash): Promise<AssetRecord | null>; insert(record): Promise<void> }`, `class SupabaseAssetIndex`
  - `class MirroredAssetStore implements AssetStore { constructor(local: FileAssetStore, blobs: BlobStore, index: AssetIndex, log?) }`
  - `fakes.ts`: `InMemoryBlobStore` (with `objects: Map<string, Buffer>` keyed by `"bucket/path"`), `InMemoryAssetIndex`

- [ ] **Step 1: Add the fakes**

Append to `apps/worker/src/testing/fakes.ts`:
```ts
import { readFile, writeFile } from "node:fs/promises";
import type { AssetIndex, AssetRecord, BlobStore } from "../storage";

export class InMemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Buffer>();
  async upload(bucket: string, path: string, filePath: string) {
    this.objects.set(`${bucket}/${path}`, await readFile(filePath));
  }
  async download(bucket: string, path: string, destPath: string) {
    const data = this.objects.get(`${bucket}/${path}`);
    if (!data) throw new Error(`object not found: ${bucket}/${path}`);
    await writeFile(destPath, data);
  }
}

export class InMemoryAssetIndex implements AssetIndex {
  readonly records = new Map<string, AssetRecord>();
  finds = 0;
  async find(hash: string) {
    this.finds++;
    return this.records.get(hash) ?? null;
  }
  async insert(record: AssetRecord) {
    if (!this.records.has(record.inputHash)) this.records.set(record.inputHash, record);
  }
}
```
(Move the new `import` lines to the top of the file with the existing imports.)

- [ ] **Step 2: Write the failing tests**

`apps/worker/src/storage.test.ts`:
```ts
import { createFakeProviders, FileAssetStore, generateAssets, type PlanRequest } from "@reel/engine";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MirroredAssetStore } from "./storage";
import { InMemoryAssetIndex, InMemoryBlobStore } from "./testing/fakes";

const HASH = "a".repeat(64);
const meta = { kind: "audio" as const, provider: "elevenlabs", model: "eleven_v4", requestId: "r1", estUsd: 0.01, extra: { words: [{ text: "hi", startMs: 0, endMs: 100 }] } };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mirror-"));
  const src = join(dir, "voice.wav");
  await writeFile(src, "wav-bytes");
  return { dir, src, blobs: new InMemoryBlobStore(), index: new InMemoryAssetIndex() };
}

describe("MirroredAssetStore", () => {
  it("putFile stores locally, uploads to the assets bucket, then indexes", async () => {
    const { dir, src, blobs, index } = await setup();
    const store = new MirroredAssetStore(new FileAssetStore(join(dir, "a")), blobs, index);
    const stored = await store.putFile(HASH, src, "wav", meta);
    expect(stored.fileName).toBe(`${HASH}.wav`);
    expect(blobs.objects.get(`assets/${HASH}.wav`)?.toString()).toBe("wav-bytes");
    expect(index.records.get(HASH)).toMatchObject({
      inputHash: HASH, kind: "audio", fileName: `${HASH}.wav`, storagePath: `${HASH}.wav`, provider: "elevenlabs", model: "eleven_v4", requestId: "r1",
      meta: { estUsd: 0.01, extra: meta.extra },
    });
  });

  it("a local hit never touches the index", async () => {
    const { dir, src, blobs, index } = await setup();
    const store = new MirroredAssetStore(new FileAssetStore(join(dir, "a")), blobs, index);
    await store.putFile(HASH, src, "wav", meta);
    index.finds = 0;
    expect(await store.get(HASH)).not.toBeNull();
    expect(index.finds).toBe(0);
  });

  it("restores an asset made on another machine from Storage, metadata included", async () => {
    const { dir, src, blobs, index } = await setup();
    await new MirroredAssetStore(new FileAssetStore(join(dir, "machineA")), blobs, index).putFile(HASH, src, "wav", meta);
    const b = new MirroredAssetStore(new FileAssetStore(join(dir, "machineB")), blobs, index);
    const restored = await b.get(HASH);
    expect(restored).toMatchObject({ hash: HASH, fileName: `${HASH}.wav`, meta: { kind: "audio", provider: "elevenlabs", extra: meta.extra } });
    expect((await readFile(restored!.path)).toString()).toBe("wav-bytes");
  });

  it("returns null when the index has no record", async () => {
    const { dir, blobs, index } = await setup();
    expect(await new MirroredAssetStore(new FileAssetStore(join(dir, "a")), blobs, index).get(HASH)).toBeNull();
  });

  it("returns null (and logs) when the indexed object is missing from Storage", async () => {
    const { dir, src, blobs, index } = await setup();
    await new MirroredAssetStore(new FileAssetStore(join(dir, "a")), blobs, index).putFile(HASH, src, "wav", meta);
    blobs.objects.clear();
    const logs: string[] = [];
    const b = new MirroredAssetStore(new FileAssetStore(join(dir, "b")), blobs, index, (m) => logs.push(m));
    expect(await b.get(HASH)).toBeNull();
    expect(logs.join("\n")).toMatch(/restore failed/);
  });

  it("a second machine regenerates nothing for the same storyboard", async () => {
    const { dir, blobs, index } = await setup();
    const providers = createFakeProviders({ workDir: dir });
    const req: PlanRequest = { brief: "3 tips", language: "he", targetDurationSec: 15, pacing: "punchy", captionPreset: "bold_pop", palette: ["#FFE14D", "#111111"], voice: { voiceId: "fake-voice", modelId: "eleven_v4" } };
    const sb = await providers.planner.plan(req);
    const log = () => {};
    await generateAssets(sb, { providers, store: new MirroredAssetStore(new FileAssetStore(join(dir, "A")), blobs, index), tmpDir: join(dir, "tA"), log });
    const before = { ...providers.calls };
    await generateAssets(sb, { providers, store: new MirroredAssetStore(new FileAssetStore(join(dir, "B")), blobs, index), tmpDir: join(dir, "tB"), log });
    expect(providers.calls).toEqual(before);
  }, 300_000);
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx vitest run apps/worker/src/storage.test.ts`
Expected: FAIL with "Failed to resolve import "./storage"".

- [ ] **Step 4: Implement `apps/worker/src/storage.ts`**

```ts
import { BUCKETS, type Database, type Json } from "@reel/db";
import { contentTypeFor, type AssetMeta, type AssetStore, type FileAssetStore, type StoredAsset } from "@reel/engine";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export interface BlobStore {
  upload(bucket: string, path: string, filePath: string, contentType: string): Promise<void>;
  download(bucket: string, path: string, destPath: string): Promise<void>;
}

export type AssetRecord = {
  inputHash: string;
  kind: AssetMeta["kind"];
  fileName: string;
  storagePath: string;
  provider: string;
  model?: string;
  requestId?: string;
  meta: { estUsd?: number; createdAt: string; extra?: Record<string, unknown> };
};

export interface AssetIndex {
  find(hash: string): Promise<AssetRecord | null>;
  insert(record: AssetRecord): Promise<void>;
}

export class SupabaseBlobStore implements BlobStore {
  constructor(private readonly sb: SupabaseClient<Database>) {}

  async upload(bucket: string, path: string, filePath: string, contentType: string): Promise<void> {
    const { error } = await this.sb.storage.from(bucket).upload(path, await readFile(filePath), { contentType, upsert: true });
    if (error) throw new Error(`upload ${bucket}/${path} failed: ${error.message}`);
  }

  async download(bucket: string, path: string, destPath: string): Promise<void> {
    const { data, error } = await this.sb.storage.from(bucket).download(path);
    if (error || !data) throw new Error(`download ${bucket}/${path} failed: ${error?.message ?? "no data"}`);
    await writeFile(destPath, Buffer.from(await data.arrayBuffer()));
  }
}

export class SupabaseAssetIndex implements AssetIndex {
  constructor(private readonly sb: SupabaseClient<Database>) {}

  async find(hash: string): Promise<AssetRecord | null> {
    const { data, error } = await this.sb.from("assets").select("*").eq("input_hash", hash).maybeSingle();
    if (error) throw new Error(`asset lookup failed: ${error.message}`);
    if (!data) return null;
    return {
      inputHash: data.input_hash,
      kind: data.kind as AssetRecord["kind"],
      fileName: data.file_name,
      storagePath: data.storage_path,
      provider: data.provider,
      model: data.model ?? undefined,
      requestId: data.provider_request_id ?? undefined,
      meta: (data.meta ?? {}) as AssetRecord["meta"],
    };
  }

  async insert(r: AssetRecord): Promise<void> {
    const { error } = await this.sb.from("assets").upsert(
      {
        input_hash: r.inputHash,
        kind: r.kind,
        file_name: r.fileName,
        storage_path: r.storagePath,
        provider: r.provider,
        model: r.model ?? null,
        provider_request_id: r.requestId ?? null,
        meta: r.meta as Json,
      },
      { onConflict: "input_hash", ignoreDuplicates: true },
    );
    if (error) throw new Error(`asset index insert failed: ${error.message}`);
  }
}

/**
 * Local disk cache (Remotion/FFmpeg need local files) mirrored to Supabase Storage + the `assets` table,
 * so any worker machine can restore an asset instead of paying for it again.
 */
export class MirroredAssetStore implements AssetStore {
  constructor(
    private readonly local: FileAssetStore,
    private readonly blobs: BlobStore,
    private readonly index: AssetIndex,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get root(): string {
    return this.local.root;
  }

  async get(hash: string): Promise<StoredAsset | null> {
    const hit = await this.local.get(hash);
    if (hit) return hit;
    const record = await this.index.find(hash);
    if (!record) return null;
    await mkdir(this.local.root, { recursive: true });
    const tmp = join(this.local.root, `${record.fileName}.download-${randomUUID()}`);
    try {
      await this.blobs.download(BUCKETS.assets, record.storagePath, tmp);
      return await this.local.putFile(hash, tmp, extname(record.fileName).slice(1), {
        kind: record.kind,
        provider: record.provider,
        model: record.model,
        requestId: record.requestId,
        estUsd: record.meta.estUsd,
        extra: record.meta.extra,
      });
    } catch (err) {
      this.log(`cache restore failed for ${hash}: ${err instanceof Error ? err.message : err}; it will be regenerated`);
      return null;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async putFile(hash: string, sourcePath: string, ext: string, meta: Omit<AssetMeta, "createdAt">): Promise<StoredAsset> {
    const stored = await this.local.putFile(hash, sourcePath, ext, meta);
    // Upload before indexing so the index never points at a missing object.
    await this.blobs.upload(BUCKETS.assets, stored.fileName, stored.path, contentTypeFor(stored.fileName));
    await this.index.insert({
      inputHash: hash,
      kind: meta.kind,
      fileName: stored.fileName,
      storagePath: stored.fileName,
      provider: meta.provider,
      model: meta.model,
      requestId: meta.requestId,
      meta: { estUsd: meta.estUsd, createdAt: stored.meta.createdAt, extra: meta.extra },
    });
    return stored;
  }
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run apps/worker && npx tsc -p tsconfig.json`
Expected: PASS (storage 6 plus the earlier worker tests); `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): asset cache mirrored to Supabase Storage and the assets table"
```

---

### Task 7: Worker: plan and generate job handlers

**Files:**
- Create: `apps/worker/src/reel-db.ts`, `apps/worker/src/handlers/plan.ts`, `apps/worker/src/handlers/generate.ts`
- Modify: `apps/worker/src/testing/fakes.ts` (add `InMemoryReelDb`)
- Test: `apps/worker/src/handlers/handlers.test.ts`

**Interfaces:**
- Consumes:
  - from `@reel/engine`: `Planner`, `Providers`, `AssetStore`, `generateAssets`, `renderAndExport`, `buildTimeline`, `createFakeProviders`, `FileAssetStore`
  - from `@reel/core`: `parseStoryboard`, `estimateCost`, `assertWithinCap`, `assetSrc`, `SceneFailuresError`, `SpendCapError`, `PipelineEvent`, `Storyboard`, `Timeline`
  - from `@reel/db`: `PlanJobPayloadSchema`, `GenerateJobPayloadSchema`, `emptyProgress`, `applyPipelineEvent`, `renderPaths`, `BUCKETS`, `ProjectStatus`
  - from Tasks 5–6: `JobHandler`, `BlobStore`
- Produces:
  - `type StoryboardRecord = { id; projectId; version; json: unknown; status: "draft" | "approved" | "superseded" }`
  - `interface ReelDb { nextStoryboardVersion(projectId): Promise<number>; insertStoryboard({ projectId, version, json, createdBy }): Promise<string>; getStoryboard(id): Promise<StoryboardRecord | null>; setProjectStatus(projectId, status, title?): Promise<void>; insertRender({ projectId, storyboardId, storyboardVersion, paths, timeline }): Promise<void> }`, `class SupabaseReelDb`
  - `createPlanHandler({ planner, db, voices, voiceModelId, forceVoiceId? }): JobHandler`
  - `createGenerateHandler({ providers, store, blobs, db, spendCapUsd, costModels, requireVoiceId? }): JobHandler`
  - `fakes.ts`: `InMemoryReelDb`

- [ ] **Step 1: Add `InMemoryReelDb` to the fakes**

Append to `apps/worker/src/testing/fakes.ts`, merging the imports into the top of the file:
```ts
import type { ProjectStatus } from "@reel/db";
import type { ReelDb, StoryboardRecord } from "../reel-db";

export class InMemoryReelDb implements ReelDb {
  readonly storyboards: StoryboardRecord[] = [];
  readonly renders: Parameters<ReelDb["insertRender"]>[0][] = [];
  readonly projectStatus = new Map<string, { status: ProjectStatus; title?: string }>();

  async nextStoryboardVersion(projectId: string) {
    return Math.max(0, ...this.storyboards.filter((s) => s.projectId === projectId).map((s) => s.version)) + 1;
  }
  async insertStoryboard(input: Parameters<ReelDb["insertStoryboard"]>[0]) {
    const id = crypto.randomUUID();
    this.storyboards.push({ id, projectId: input.projectId, version: input.version, json: input.json, status: "draft" });
    return id;
  }
  async getStoryboard(id: string) {
    return this.storyboards.find((s) => s.id === id) ?? null;
  }
  async setProjectStatus(projectId: string, status: ProjectStatus, title?: string) {
    this.projectStatus.set(projectId, { status, ...(title ? { title } : {}) });
  }
  async insertRender(input: Parameters<ReelDb["insertRender"]>[0]) {
    this.renders.push(input);
  }
}
```

- [ ] **Step 2: Write the failing tests**

`apps/worker/src/handlers/handlers.test.ts`:
```ts
import { SpendCapError } from "@reel/core";
import { costModels, createFakeProviders, FileAssetStore, loadConfig } from "@reel/engine";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryBlobStore, InMemoryReelDb, makeJob } from "../testing/fakes";
import { createGenerateHandler } from "./generate";
import { createPlanHandler } from "./plan";

const FORM = { brief: "3 טיפים לצמיחה בטיקטוק", language: "he", targetDurationSec: 15, pacing: "punchy", captionPreset: "bold_pop", palette: ["#FFE14D", "#111111"] };
const ctx = () => {
  const reports: unknown[] = [];
  return { reports, ctx: { report: (p: unknown) => void reports.push(p), log: () => {} } };
};

async function setup(failPromptsContaining?: string) {
  const dir = await mkdtemp(join(tmpdir(), "handlers-"));
  const providers = createFakeProviders({ workDir: dir, failPromptsContaining });
  const db = new InMemoryReelDb();
  const blobs = new InMemoryBlobStore();
  const config = loadConfig({ REEL_CACHE_DIR: join(dir, "cache") }, { providers: "fake" });
  const plan = createPlanHandler({ planner: providers.planner, db, voices: {}, voiceModelId: "eleven_v4", forceVoiceId: "fake-voice" });
  const generate = (over: Partial<Parameters<typeof createGenerateHandler>[0]> = {}) =>
    createGenerateHandler({ providers, store: new FileAssetStore(config.cacheDir), blobs, db, spendCapUsd: 10, costModels: costModels(config), requireVoiceId: "fake-voice", ...over });
  return { dir, providers, db, blobs, plan, generate };
}

async function planAndApprove(s: Awaited<ReturnType<typeof setup>>) {
  await s.plan(makeJob({ type: "plan", project_id: "p1", payload: FORM }), ctx().ctx);
  const record = s.db.storyboards[0];
  record.status = "approved";
  return record;
}

describe("plan handler", () => {
  it("writes storyboard v1 as an agent draft and moves the project to draft with the title", async () => {
    const s = await setup();
    const outcome = await s.plan(makeJob({ type: "plan", project_id: "p1", payload: FORM }), ctx().ctx);
    expect(outcome).toEqual({ status: "done" });
    expect(s.db.storyboards).toHaveLength(1);
    expect(s.db.storyboards[0]).toMatchObject({ projectId: "p1", version: 1, status: "draft" });
    expect((s.db.storyboards[0].json as { voice: { voiceId: string }; version: number }).voice.voiceId).toBe("fake-voice");
    expect(s.db.projectStatus.get("p1")?.status).toBe("draft");
  });

  it("uses the form's voice id, else the language default, and fails clearly without either", async () => {
    const s = await setup();
    const withDefaults = createPlanHandler({ planner: s.providers.planner, db: s.db, voices: { he: "voice-he" }, voiceModelId: "eleven_v4" });
    await withDefaults(makeJob({ type: "plan", project_id: "p2", payload: FORM }), ctx().ctx);
    expect((s.db.storyboards.at(-1)!.json as { voice: { voiceId: string } }).voice.voiceId).toBe("voice-he");
    await withDefaults(makeJob({ type: "plan", project_id: "p3", payload: { ...FORM, voiceId: "chosen" } }), ctx().ctx);
    expect((s.db.storyboards.at(-1)!.json as { voice: { voiceId: string } }).voice.voiceId).toBe("chosen");
    const noVoice = createPlanHandler({ planner: s.providers.planner, db: s.db, voices: {}, voiceModelId: "eleven_v4" });
    await expect(noVoice(makeJob({ type: "plan", project_id: "p4", payload: FORM }), ctx().ctx)).rejects.toThrow(/ELEVENLABS_VOICE_HE/);
    expect(s.db.projectStatus.get("p4")?.status).toBe("failed");
  });

  it("rejects an invalid payload and marks the project failed", async () => {
    const s = await setup();
    await expect(s.plan(makeJob({ type: "plan", project_id: "p5", payload: { brief: "x" } }), ctx().ctx)).rejects.toThrow();
    expect(s.db.projectStatus.get("p5")?.status).toBe("failed");
  });
});

describe("generate handler", () => {
  it("renders, uploads the three deliverables, stores an asset-ref timeline and marks the project rendered", async () => {
    const s = await setup();
    const record = await planAndApprove(s);
    const { reports, ctx: c } = ctx();
    const outcome = await s.generate()(makeJob({ type: "generate", project_id: "p1", payload: { storyboardId: record.id } }), c);
    expect(outcome.status).toBe("done");
    expect([...s.blobs.objects.keys()].sort()).toEqual(["renders/p1/v1/preview.mp4", "renders/p1/v1/reel.mp4", "renders/p1/v1/thumbnail.jpg"]);
    expect(s.db.renders).toHaveLength(1);
    const render = s.db.renders[0];
    expect(render).toMatchObject({ projectId: "p1", storyboardId: record.id, storyboardVersion: 1 });
    expect(render.timeline.audio.voiceUrl).toMatch(/^asset:/);
    expect(render.timeline.clips.filter((c) => c.kind !== "graphic").every((c) => c.src?.startsWith("asset:"))).toBe(true);
    expect(s.db.projectStatus.get("p1")?.status).toBe("rendered");
    expect(reports.length).toBeGreaterThan(0);
    expect(outcome.progress?.steps.export).toBe("done");
  }, 600_000);

  it("refuses a storyboard that isn't approved, before any spend", async () => {
    const s = await setup();
    await s.plan(makeJob({ type: "plan", project_id: "p1", payload: FORM }), ctx().ctx);
    const draft = s.db.storyboards[0];
    await expect(s.generate()(makeJob({ type: "generate", project_id: "p1", payload: { storyboardId: draft.id } }), ctx().ctx)).rejects.toThrow(/not approved/);
    expect(s.providers.calls.voice + s.providers.calls.image + s.providers.calls.video).toBe(0);
  });

  it("refuses a storyboard from another project", async () => {
    const s = await setup();
    const record = await planAndApprove(s);
    await expect(s.generate()(makeJob({ type: "generate", project_id: "other", payload: { storyboardId: record.id } }), ctx().ctx)).rejects.toThrow(/not found for this project/);
  });

  it("stops at the spend cap before any provider call and marks the project failed", async () => {
    const s = await setup();
    const record = await planAndApprove(s);
    await expect(s.generate({ spendCapUsd: 0.0001 })(makeJob({ type: "generate", project_id: "p1", payload: { storyboardId: record.id } }), ctx().ctx)).rejects.toBeInstanceOf(SpendCapError);
    expect(s.providers.calls.voice).toBe(0);
    expect(s.db.projectStatus.get("p1")?.status).toBe("failed");
  });

  it("returns needs_attention with the failed scene when a scene fails", async () => {
    const s = await setup("FAIL");
    await s.plan(makeJob({ type: "plan", project_id: "p1", payload: FORM }), ctx().ctx);
    const record = s.db.storyboards[0];
    (record.json as { scenes: { visual: { prompt?: string } }[] }).scenes[1].visual.prompt = "FAIL this prompt";
    record.status = "approved";
    const outcome = await s.generate()(makeJob({ type: "generate", project_id: "p1", payload: { storyboardId: record.id } }), ctx().ctx);
    expect(outcome.status).toBe("needs_attention");
    expect(outcome.status !== "done" && outcome.error).toMatch(/s2/);
    expect(outcome.progress?.scenes.s2?.status).toBe("failed");
    expect(s.db.projectStatus.get("p1")?.status).toBe("needs_attention");
  }, 300_000);

  it("in fake mode refuses storyboards that use a real voice (keeps fake audio out of the shared cache)", async () => {
    const s = await setup();
    const record = await planAndApprove(s);
    (record.json as { voice: { voiceId: string } }).voice.voiceId = "real-voice-id";
    await expect(s.generate()(makeJob({ type: "generate", project_id: "p1", payload: { storyboardId: record.id } }), ctx().ctx)).rejects.toThrow(/fake providers/);
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx vitest run apps/worker/src/handlers`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 4: Implement `reel-db.ts`**

```ts
import type { Storyboard, Timeline } from "@reel/core";
import type { Database, Json, ProjectStatus } from "@reel/db";
import type { SupabaseClient } from "@supabase/supabase-js";

export type StoryboardRecord = { id: string; projectId: string; version: number; json: unknown; status: "draft" | "approved" | "superseded" };

export interface ReelDb {
  nextStoryboardVersion(projectId: string): Promise<number>;
  insertStoryboard(input: { projectId: string; version: number; json: Storyboard; createdBy: "agent" | "user" }): Promise<string>;
  getStoryboard(id: string): Promise<StoryboardRecord | null>;
  setProjectStatus(projectId: string, status: ProjectStatus, title?: string): Promise<void>;
  insertRender(input: {
    projectId: string;
    storyboardId: string;
    storyboardVersion: number;
    paths: { reel: string; preview: string; thumbnail: string };
    timeline: Timeline;
  }): Promise<void>;
}

const check = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`${what} failed: ${error.message}`);
};

export class SupabaseReelDb implements ReelDb {
  constructor(private readonly sb: SupabaseClient<Database>) {}

  async nextStoryboardVersion(projectId: string) {
    const { data, error } = await this.sb.from("storyboards").select("version").eq("project_id", projectId)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    check("storyboard version lookup", error);
    return (data?.version ?? 0) + 1;
  }

  async insertStoryboard(input: Parameters<ReelDb["insertStoryboard"]>[0]) {
    const { data, error } = await this.sb.from("storyboards").insert({
      project_id: input.projectId, version: input.version, json: input.json as unknown as Json, status: "draft", created_by: input.createdBy,
    }).select("id").single();
    check("storyboard insert", error);
    return data!.id;
  }

  async getStoryboard(id: string) {
    const { data, error } = await this.sb.from("storyboards").select("id, project_id, version, json, status").eq("id", id).maybeSingle();
    check("storyboard lookup", error);
    return data ? { id: data.id, projectId: data.project_id, version: data.version, json: data.json, status: data.status as StoryboardRecord["status"] } : null;
  }

  async setProjectStatus(projectId: string, status: ProjectStatus, title?: string) {
    const { error } = await this.sb.from("projects").update({ status, ...(title ? { title: title.slice(0, 120) } : {}) }).eq("id", projectId);
    check("project status update", error);
  }

  async insertRender(input: Parameters<ReelDb["insertRender"]>[0]) {
    const { error } = await this.sb.from("renders").insert({
      project_id: input.projectId,
      storyboard_id: input.storyboardId,
      storyboard_version: input.storyboardVersion,
      reel_path: input.paths.reel,
      preview_path: input.paths.preview,
      thumbnail_path: input.paths.thumbnail,
      timeline: input.timeline as unknown as Json,
    });
    check("render insert", error);
  }
}
```

- [ ] **Step 5: Implement the handlers**

`apps/worker/src/handlers/plan.ts`:
```ts
import { PlanJobPayloadSchema } from "@reel/db";
import type { Planner } from "@reel/engine";
import type { JobHandler } from "../loop";
import type { ReelDb } from "../reel-db";

export type PlanHandlerDeps = {
  planner: Planner;
  db: ReelDb;
  voices: { he?: string; en?: string };
  voiceModelId: string;
  /** Fake mode: always use this voice id so fake audio never shares a cache key with a real voice. */
  forceVoiceId?: string;
};

export function createPlanHandler(deps: PlanHandlerDeps): JobHandler {
  return async (job) => {
    try {
      const form = PlanJobPayloadSchema.parse(job.payload);
      const voiceId = deps.forceVoiceId ?? form.voiceId ?? deps.voices[form.language];
      if (!voiceId) {
        throw new Error(`No voice for ${form.language}: set ELEVENLABS_VOICE_${form.language.toUpperCase()} in the worker's .env.local or enter a voice id`);
      }
      const planned = await deps.planner.plan({
        brief: form.brief,
        language: form.language,
        targetDurationSec: form.targetDurationSec,
        pacing: form.pacing,
        captionPreset: form.captionPreset,
        palette: form.palette,
        voice: { voiceId, modelId: deps.voiceModelId },
      });
      const version = await deps.db.nextStoryboardVersion(job.project_id);
      const storyboard = { ...planned, version };
      await deps.db.insertStoryboard({ projectId: job.project_id, version, json: storyboard, createdBy: "agent" });
      await deps.db.setProjectStatus(job.project_id, "draft", storyboard.title);
      return { status: "done" };
    } catch (err) {
      await deps.db.setProjectStatus(job.project_id, "failed").catch(() => {});
      throw err;
    }
  };
}
```

`apps/worker/src/handlers/generate.ts`:
```ts
import { assertWithinCap, assetSrc, estimateCost, parseStoryboard, SceneFailuresError, type PipelineEvent } from "@reel/core";
import { applyPipelineEvent, BUCKETS, emptyProgress, GenerateJobPayloadSchema, renderPaths } from "@reel/db";
import { buildTimeline, generateAssets, renderAndExport, type AssetStore, type GeneratedAssets, type Providers } from "@reel/engine";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobHandler } from "../loop";
import type { ReelDb } from "../reel-db";
import type { BlobStore } from "../storage";

export type GenerateHandlerDeps = {
  providers: Providers;
  store: AssetStore;
  blobs: BlobStore;
  db: ReelDb;
  spendCapUsd: number;
  costModels: { image: string; video: string; voice: string };
  /** Fake mode: only accept storyboards using this voice id (see PlanHandlerDeps.forceVoiceId). */
  requireVoiceId?: string;
};

export function createGenerateHandler(deps: GenerateHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const { storyboardId } = GenerateJobPayloadSchema.parse(job.payload);
    const record = await deps.db.getStoryboard(storyboardId);
    if (!record || record.projectId !== job.project_id) throw new Error(`storyboard ${storyboardId} not found for this project`);
    if (record.status !== "approved") throw new Error("storyboard is not approved; approve it before generating");

    let progress = emptyProgress();
    const tmpDir = await mkdtemp(join(tmpdir(), "reel-job-"));
    try {
      const sb = parseStoryboard(record.json);
      if (deps.requireVoiceId && sb.voice?.voiceId !== deps.requireVoiceId) {
        throw new Error("this worker runs fake providers; the storyboard uses a real voice. Run the real worker, or plan a new reel with the fake worker");
      }
      assertWithinCap(estimateCost(sb, deps.costModels), deps.spendCapUsd);
      await deps.db.setProjectStatus(job.project_id, "generating");

      const onEvent = (e: PipelineEvent) => {
        progress = applyPipelineEvent(progress, e);
        ctx.report(progress);
      };
      const pipelineDeps = { providers: deps.providers, store: deps.store, tmpDir, log: ctx.log, onEvent };

      let gen: GeneratedAssets;
      try {
        gen = await generateAssets(sb, pipelineDeps);
      } catch (err) {
        if (!(err instanceof SceneFailuresError)) throw err;
        await deps.db.setProjectStatus(job.project_id, "needs_attention");
        return { status: "needs_attention", error: err.message, progress };
      }

      const out = await renderAndExport(sb, gen, pipelineDeps, join(tmpDir, "out"));
      const paths = renderPaths(job.project_id, sb.version);
      await deps.blobs.upload(BUCKETS.renders, paths.reel, out.reel, "video/mp4");
      await deps.blobs.upload(BUCKETS.renders, paths.preview, out.preview, "video/mp4");
      await deps.blobs.upload(BUCKETS.renders, paths.thumbnail, out.thumbnail, "image/jpeg");
      await deps.db.insertRender({
        projectId: job.project_id,
        storyboardId,
        storyboardVersion: sb.version,
        paths,
        timeline: buildTimeline(sb, gen, assetSrc),
      });
      await deps.db.setProjectStatus(job.project_id, "rendered");
      return { status: "done", progress };
    } catch (err) {
      await deps.db.setProjectStatus(job.project_id, "failed").catch(() => {});
      throw err;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  };
}
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `npx vitest run apps/worker && npx tsc -p tsconfig.json`
Expected: PASS (handlers 9 plus the earlier worker tests; the render test takes about 20 s); `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): plan and generate job handlers with spend cap, scene failures and render upload"
```

---

### Task 8: Worker entry point and a live Supabase smoke check

**Files:**
- Create: `apps/worker/src/main.ts`, `apps/worker/scripts/smoke-supabase.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes:
  - from `@reel/engine`: `loadEnvFile`, `loadConfig`, `costModels`, `createProviders`, `createPlannerFor`, `FileAssetStore`
  - from `@reel/media`: `assertFfmpegAvailable`
  - everything from Tasks 5–7
- Produces:
  - `npm run worker` / `npm run worker:fake`, which poll the hosted queue
  - `npm run smoke:supabase`, which checks the queue functions, heartbeat requeue and storage round trip, and cleans up after itself (free: no provider calls)

- [ ] **Step 1: Implement `apps/worker/src/main.ts`**

```ts
import type { Database } from "@reel/db";
import { costModels, createPlannerFor, createProviders, FileAssetStore, loadConfig, loadEnvFile } from "@reel/engine";
import { assertFfmpegAvailable } from "@reel/media";
import { createClient } from "@supabase/supabase-js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkerEnv } from "./env";
import { createGenerateHandler } from "./handlers/generate";
import { createPlanHandler } from "./handlers/plan";
import { runWorker } from "./loop";
import { SupabaseJobQueue } from "./queue";
import { SupabaseReelDb } from "./reel-db";
import { MirroredAssetStore, SupabaseAssetIndex, SupabaseBlobStore } from "./storage";

const FAKE_VOICE_ID = "fake-voice";
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

loadEnvFile();
const env = loadWorkerEnv(process.env, process.argv.slice(2));
const config = loadConfig(process.env, { providers: env.providers });
log(await assertFfmpegAvailable());

const sb = createClient<Database>(env.supabaseUrl, env.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const workDir = await mkdtemp(join(tmpdir(), "reel-worker-"));
const fake = env.providers === "fake";
const providers = createProviders(config, workDir);
const planner = createPlannerFor(config, workDir);
const blobs = new SupabaseBlobStore(sb);
const store = new MirroredAssetStore(new FileAssetStore(fake ? join(config.cacheDir, "fake") : config.cacheDir), blobs, new SupabaseAssetIndex(sb), log);
const db = new SupabaseReelDb(sb);

const handlers = {
  plan: createPlanHandler({
    planner, db, voices: config.elevenlabs.voices, voiceModelId: config.elevenlabs.modelId,
    ...(fake ? { forceVoiceId: FAKE_VOICE_ID } : {}),
  }),
  generate: createGenerateHandler({
    providers, store, blobs, db, spendCapUsd: config.spendCapUsd, costModels: costModels(config),
    ...(fake ? { requireVoiceId: FAKE_VOICE_ID } : {}),
  }),
};

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log("stopping after the current job…");
    controller.abort();
  });
}

log(`worker ${env.workerId} polling every ${env.pollMs} ms (${env.providers} providers)`);
await runWorker(new SupabaseJobQueue(sb), handlers, { workerId: env.workerId, pollMs: env.pollMs, signal: controller.signal, log });
log("worker stopped");
```

- [ ] **Step 2: Implement `apps/worker/scripts/smoke-supabase.ts`**

```ts
import { BUCKETS, type Database } from "@reel/db";
import { loadEnvFile } from "@reel/engine";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkerEnv } from "../src/env";
import { SupabaseJobQueue } from "../src/queue";
import { SupabaseBlobStore } from "../src/storage";

// Free check of the hosted project: queue functions, stale requeue and storage round trip. Cleans up after itself.
loadEnvFile();
const env = loadWorkerEnv(process.env, []);
const sb = createClient<Database>(env.supabaseUrl, env.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const queue = new SupabaseJobQueue(sb);
const pass = (msg: string) => console.log(`PASS ${msg}`);
const fail = (msg: string): never => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};

const { count: queued } = await sb.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued");
if (queued) fail(`${queued} real job(s) are queued; stop and retry when the queue is empty so this check doesn't claim them`);

const { data: users, error: usersError } = await sb.auth.admin.listUsers({ perPage: 1 });
if (usersError) fail(`auth admin: ${usersError.message}`);
const owner = users!.users[0] ?? fail("no users yet: invite yourself first (Dashboard → Authentication → Users → Invite user)");

const { data: project, error: projectError } = await sb.from("projects").insert({ owner_id: owner.id, title: "smoke test", language: "en" }).select("id").single();
if (projectError || !project) fail(`insert project: ${projectError?.message}`);
pass("insert project");

try {
  const { data: job, error: jobError } = await sb.from("jobs").insert({ project_id: project!.id, type: "plan", payload: {}, created_by: owner.id }).select("id").single();
  if (jobError || !job) fail(`insert job: ${jobError?.message}`);

  const claimed = await queue.claim("smoke");
  if (claimed?.id !== job!.id || claimed.status !== "running" || claimed.attempts !== 1) fail(`claim_job returned ${JSON.stringify(claimed)}`);
  pass("claim_job claims the queued job");
  if (await queue.claim("smoke")) fail("claim_job returned a second job");
  pass("claim_job returns nothing when the queue is empty");

  await queue.heartbeat(job!.id);
  await sb.from("jobs").update({ heartbeat_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", job!.id);
  if ((await queue.requeueStale(120)) < 1) fail("requeue_stale_jobs did not requeue the stale job");
  const reclaimed = await queue.claim("smoke");
  if (reclaimed?.id !== job!.id || reclaimed.attempts !== 2) fail(`reclaim returned ${JSON.stringify(reclaimed)}`);
  pass("stale job requeued and reclaimed (attempt 2)");

  await queue.finish(job!.id, { status: "done", progress: { steps: { voice: "done" }, scenes: {} } });
  const { data: finished } = await sb.from("jobs").select("status, finished_at, progress").eq("id", job!.id).single();
  if (finished?.status !== "done" || !finished.finished_at) fail(`finish wrote ${JSON.stringify(finished)}`);
  pass("finish marks the job done");

  const dir = await mkdtemp(join(tmpdir(), "smoke-"));
  const name = `smoke-${randomUUID()}.txt`;
  await writeFile(join(dir, "up.txt"), "hello storage");
  const blobs = new SupabaseBlobStore(sb);
  await blobs.upload(BUCKETS.assets, name, join(dir, "up.txt"), "text/plain");
  await blobs.download(BUCKETS.assets, name, join(dir, "down.txt"));
  if ((await readFile(join(dir, "down.txt"), "utf8")) !== "hello storage") fail("storage round trip mismatch");
  await sb.storage.from(BUCKETS.assets).remove([name]);
  pass("storage upload/download round trip");
} finally {
  await sb.from("projects").delete().eq("id", project!.id);
}
console.log("All Supabase checks passed.");
```

- [ ] **Step 3: Document the new env vars**

Append to `.env.example`:
```
# Supabase (worker only; never expose the secret key to the browser)
SUPABASE_URL=
SUPABASE_SECRET_KEY=
WORKER_POLL_MS=3000
WORKER_ID=
```

- [ ] **Step 4: Typecheck and test**

Run: `npx tsc -p tsconfig.json && npx vitest run apps/worker`
Expected: `tsc` exits 0 and every worker test passes. Don't run the worker or the smoke script here: they need the hosted project's secret key, and Task 13 runs them.

- [ ] **Step 5: Commit**

```bash
git add apps/worker .env.example
git commit -m "feat(worker): entry point with graceful shutdown and a live Supabase smoke check"
```

---

### Task 9: Web app scaffold: Next.js 16, Supabase auth, magic-link login

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/proxy.ts`, `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, `apps/web/app/actions.ts`
- Create: `apps/web/lib/supabase/client.ts`, `apps/web/lib/supabase/server.ts`, `apps/web/lib/supabase/proxy.ts`, `apps/web/lib/safe-next.ts`
- Create: `apps/web/app/login/page.tsx`, `apps/web/app/login/login-form.tsx`, `apps/web/app/login/actions.ts`, `apps/web/app/auth/confirm/route.ts`, `apps/web/app/auth/error/page.tsx`, `apps/web/app/page.tsx` (placeholder, replaced in Task 10)
- Create: `apps/web/.env.example`
- Test: `apps/web/lib/safe-next.test.ts`

**Interfaces:**
- Consumes: `Database` (`@reel/db`)
- Produces:
  - `createClient()` in `@/lib/supabase/server`: an async, typed `SupabaseClient<Database>` for server components, actions and routes
  - `createClient()` in `@/lib/supabase/client`: the browser client
  - `updateSession(request)` in `@/lib/supabase/proxy`
  - `safeNextPath(raw: string | null | undefined): string`
  - `signOut()` server action
  - routes `/login`, `/auth/confirm`, `/auth/error`; every other route redirects to `/login` when signed out

- [ ] **Step 1: Create the package and config**

`apps/web/package.json`:
```json
{
  "name": "@reel/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "@reel/core": "*",
    "@reel/db": "*",
    "@reel/video": "*",
    "@remotion/player": "4.0.531",
    "@supabase/ssr": "0.12.7",
    "@supabase/supabase-js": "2.117.2",
    "next": "16.3.8",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "remotion": "4.0.531"
  }
}
```

`apps/web/next.config.ts`:
```ts
import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript source.
  transpilePackages: ["@reel/core", "@reel/db", "@reel/video"],
  turbopack: { root: path.resolve(process.cwd(), "../..") },
  // Type checking runs through the repo's `npm run typecheck` (TypeScript 7), not during `next build`.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "jsx": "preserve",
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```

`apps/web/.env.example`:
```
NEXT_PUBLIC_SUPABASE_URL=https://aawjjdxneashqatwaxrt.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
```
Add `apps/web/.next/` and `apps/web/next-env.d.ts` to the root `.gitignore`. Run `npm install`.

- [ ] **Step 2: Write the failing test**

`apps/web/lib/safe-next.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-next";

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/projects/abc?x=1")).toBe("/projects/abc?x=1");
  });
  it.each([null, undefined, "", "//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "projects"])(
    "falls back to / for %s",
    (raw) => {
      expect(safeNextPath(raw)).toBe("/");
    },
  );
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run apps/web/lib/safe-next.test.ts`
Expected: FAIL with "Failed to resolve import "./safe-next"".

- [ ] **Step 4: Implement the helpers and Supabase clients**

`apps/web/lib/safe-next.ts`:
```ts
/** Only same-site absolute paths; anything else (protocol-relative, backslash tricks, full URLs) becomes "/". */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
```

`apps/web/lib/supabase/server.ts`:
```ts
import type { Database } from "@reel/db";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only; proxy.ts refreshes the session instead.
        }
      },
    },
  });
}
```

`apps/web/lib/supabase/client.ts`:
```ts
import type { Database } from "@reel/db";
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
}
```

`apps/web/lib/supabase/proxy.ts`:
```ts
import type { Database } from "@reel/db";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PREFIXES = ["/login", "/auth"];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });
  // Do not run code between createServerClient and getClaims (session refresh depends on it).
  const { data } = await supabase.auth.getClaims();
  const isPublic = PUBLIC_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p));
  if (!data?.claims && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}
```

`apps/web/proxy.ts`:
```ts
import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run apps/web/lib/safe-next.test.ts`
Expected: PASS (9 cases).

- [ ] **Step 6: Implement the layout, login and auth routes**

`apps/web/app/globals.css`:
```css
:root {
  --bg: #f6f5f1;
  --surface: #ffffff;
  --text: #1c1b18;
  --muted: #6b6860;
  --line: #e2dfd6;
  --accent: #1f5f4a;
  --accent-text: #ffffff;
  --warn: #9a5b00;
  --error: #a3261c;
  --radius: 10px;
  font-family: system-ui, "Heebo", sans-serif;
  color: var(--text);
  background: var(--bg);
}
* { box-sizing: border-box; }
body { margin: 0; }
header.app { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--surface); }
header.app a { color: var(--text); font-weight: 700; text-decoration: none; }
main { max-width: 1040px; margin: 0 auto; padding: 24px 20px 64px; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--muted); }
input, select, textarea { font: inherit; color: var(--text); padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
textarea { min-height: 64px; resize: vertical; }
button, .button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; color: var(--text); text-decoration: none; display: inline-block; }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.error { color: var(--error); }
.warn { color: var(--warn); }
.muted { color: var(--muted); }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: start; padding: 10px 8px; border-bottom: 1px solid var(--line); }
@media (max-width: 640px) { main { padding: 16px; } }
```

`apps/web/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "./actions";
import { createClient } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = { title: "Reel Studio" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims?.email === "string" ? data.claims.email : null;
  return (
    <html lang="en">
      <body>
        <header className="app">
          <Link href="/">Reel Studio</Link>
          {email && (
            <form action={signOut} className="row">
              <span className="muted">{email}</span>
              <button type="submit">Sign out</button>
            </form>
          )}
        </header>
        {children}
      </body>
    </html>
  );
}
```

`apps/web/app/actions.ts`:
```ts
"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
```

`apps/web/app/login/actions.ts`:
```ts
"use server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: string; sent?: boolean };

export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return { error: "Enter a valid email address." };
  const origin = (await headers()).get("origin") ?? "http://localhost:3000";
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/confirm` },
  });
  if (error) return { error: "We couldn't send a sign-in link. This app is invite-only: ask an admin to invite your email." };
  return { sent: true };
}
```

`apps/web/app/login/login-form.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { sendMagicLink, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, {});
  if (state.sent) return <p role="status">Check your inbox for a sign-in link.</p>;
  return (
    <form action={action} className="stack">
      <label>
        Work email
        <input name="email" type="email" required autoComplete="email" />
      </label>
      {state.error && <p role="alert" className="error">{state.error}</p>}
      <button type="submit" className="primary" disabled={pending}>{pending ? "Sending…" : "Send sign-in link"}</button>
    </form>
  );
}
```

`apps/web/app/login/page.tsx`:
```tsx
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main style={{ maxWidth: 420 }}>
      <h1>Sign in</h1>
      <p className="muted">We'll email you a one-time sign-in link.</p>
      <div className="card"><LoginForm /></div>
    </main>
  );
}
```

`apps/web/app/auth/confirm/route.ts`:
```ts
import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { safeNextPath } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNextPath(searchParams.get("next"));
  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) redirect(next);
  }
  redirect("/auth/error");
}
```

`apps/web/app/auth/error/page.tsx`:
```tsx
import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <main style={{ maxWidth: 420 }}>
      <h1>That link didn't work</h1>
      <p className="muted">Sign-in links expire and can be used once. Request a new one.</p>
      <Link className="button primary" href="/login">Back to sign in</Link>
    </main>
  );
}
```

`apps/web/app/page.tsx` (a placeholder until Task 10):
```tsx
export default function Home() {
  return <main><h1>Reels</h1></main>;
}
```

- [ ] **Step 7: Verify that it type-checks and builds**

Create `apps/web/.env.local` with the two values from `.env.example`. The publishable key is fetched in Task 13; for now any non-empty placeholder lets the build run. Then run:
```bash
npx tsc -p apps/web/tsconfig.json
npm run build -w @reel/web
```
Expected: `tsc` exits 0, and `next build` completes and lists the routes `/`, `/login`, `/auth/confirm`, `/auth/error`, plus the proxy.

If `next build` fails because it can't load `typescript` (TypeScript 7 doesn't ship the JS compiler API), add `"typescript": "5.9.3"` to `apps/web/package.json` `devDependencies`. Run `npm install` and rebuild, and record this in the report. The root `tsc` still uses TypeScript 7.

- [ ] **Step 8: Commit**

```bash
git add apps/web .gitignore package-lock.json
git commit -m "feat(web): Next.js 16 app with Supabase SSR auth, invite-only magic-link login and proxy session refresh"
```

---

### Task 10: Projects list and the "new reel" form

**Files:**
- Create: `apps/web/lib/queries.ts`, `apps/web/lib/plan-form.ts`, `apps/web/app/new/page.tsx`, `apps/web/app/new/new-reel-form.tsx`, `apps/web/app/new/actions.ts`
- Modify: `apps/web/app/page.tsx`
- Test: `apps/web/lib/plan-form.test.ts`

**Interfaces:**
- Consumes: `PlanFormSchema`, `PlanForm` (`@reel/core`); `Database` (`@reel/db`); `createClient` (server, Task 9)
- Produces:
  - `parsePlanForm(fd: FormData): { ok: true; form: PlanForm } | { ok: false; errors: string[] }`
  - `listProjects(sb)`
  - `getProjectView(sb, id): Promise<{ project; storyboard; job; render } | null>` (the latest storyboard, job and render per project)
  - the `createReel` server action, which inserts the project and the `plan` job, then redirects to `/projects/<id>`

- [ ] **Step 1: Write the failing test**

`apps/web/lib/plan-form.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parsePlanForm } from "./plan-form";

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  Object.entries(entries).forEach(([k, v]) => f.set(k, v));
  return f;
};
const base = { brief: "3 טיפים לצמיחה בטיקטוק", language: "he", targetDurationSec: "30", pacing: "punchy", captionPreset: "bold_pop", color1: "#ffe14d", color2: "#111111" };

describe("parsePlanForm", () => {
  it("parses a valid form into a PlanForm", () => {
    expect(parsePlanForm(fd(base))).toEqual({
      ok: true,
      form: { brief: base.brief, language: "he", targetDurationSec: 30, pacing: "punchy", captionPreset: "bold_pop", palette: ["#ffe14d", "#111111"] },
    });
  });
  it("includes a voice id only when given", () => {
    const r = parsePlanForm(fd({ ...base, voiceId: "  v-123 " }));
    expect(r.ok && r.form.voiceId).toBe("v-123");
  });
  it("returns readable errors", () => {
    const r = parsePlanForm(fd({ ...base, brief: "x", targetDurationSec: "20" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join("\n")).toMatch(/brief/);
    expect(!r.ok && r.errors.join("\n")).toMatch(/targetDurationSec/);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run apps/web/lib/plan-form.test.ts`
Expected: FAIL with "Failed to resolve import "./plan-form"".

- [ ] **Step 3: Implement `lib/plan-form.ts` and `lib/queries.ts`**

`apps/web/lib/plan-form.ts`:
```ts
import { PlanFormSchema, type PlanForm } from "@reel/core";

export type ParsedPlanForm = { ok: true; form: PlanForm } | { ok: false; errors: string[] };

export function parsePlanForm(fd: FormData): ParsedPlanForm {
  const str = (key: string) => {
    const v = fd.get(key);
    return typeof v === "string" ? v : "";
  };
  const voiceId = str("voiceId").trim();
  const raw = {
    brief: str("brief"),
    language: str("language"),
    targetDurationSec: Number(str("targetDurationSec")),
    pacing: str("pacing"),
    captionPreset: str("captionPreset"),
    palette: [str("color1"), str("color2")].filter(Boolean),
    ...(voiceId ? { voiceId } : {}),
  };
  const result = PlanFormSchema.safeParse(raw);
  if (result.success) return { ok: true, form: result.data };
  return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`) };
}
```

`apps/web/lib/queries.ts`:
```ts
import type { Database } from "@reel/db";
import type { SupabaseClient } from "@supabase/supabase-js";

type Client = SupabaseClient<Database>;

export async function listProjects(sb: Client) {
  const { data, error } = await sb.from("projects").select("id, title, language, format, status, updated_at").order("updated_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return data;
}

export async function getProjectView(sb: Client, id: string) {
  const [project, storyboard, job, render] = await Promise.all([
    sb.from("projects").select("*").eq("id", id).maybeSingle(),
    sb.from("storyboards").select("*").eq("project_id", id).order("version", { ascending: false }).limit(1).maybeSingle(),
    sb.from("jobs").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("renders").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const r of [project, storyboard, job, render]) if (r.error) throw new Error(r.error.message);
  if (!project.data) return null;
  return { project: project.data, storyboard: storyboard.data, job: job.data, render: render.data };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run apps/web/lib/plan-form.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the pages and the action**

`apps/web/app/new/actions.ts`:
```ts
"use server";
import { redirect } from "next/navigation";
import { parsePlanForm } from "@/lib/plan-form";
import { createClient } from "@/lib/supabase/server";

export type NewReelState = { errors?: string[] };

export async function createReel(_prev: NewReelState, formData: FormData): Promise<NewReelState> {
  const parsed = parsePlanForm(formData);
  if (!parsed.ok) return { errors: parsed.errors };
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return { errors: ["Your session expired. Sign in again."] };

  const { form } = parsed;
  const { data: project, error } = await supabase
    .from("projects")
    .insert({ title: form.brief.slice(0, 80), language: form.language, format: "faceless", status: "planning" })
    .select("id")
    .single();
  if (error || !project) return { errors: [`Couldn't create the reel: ${error?.message ?? "unknown error"}`] };

  const { error: jobError } = await supabase.from("jobs").insert({ project_id: project.id, type: "plan", payload: form });
  if (jobError) return { errors: [`Couldn't start planning: ${jobError.message}`] };
  redirect(`/projects/${project.id}`);
}
```

`apps/web/app/new/new-reel-form.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { createReel, type NewReelState } from "./actions";

export function NewReelForm() {
  const [state, action, pending] = useActionState<NewReelState, FormData>(createReel, {});
  return (
    <form action={action} className="stack card">
      <label>
        Brief: what is this reel about, for whom, and what should viewers do?
        <textarea name="brief" dir="auto" required minLength={3} maxLength={2000} rows={5} />
      </label>
      <div className="row">
        <label>Language<select name="language" defaultValue="he"><option value="he">עברית</option><option value="en">English</option></select></label>
        <label>Length<select name="targetDurationSec" defaultValue="30">{[15, 30, 45, 60].map((s) => <option key={s} value={s}>{s}s</option>)}</select></label>
        <label>Pacing<select name="pacing" defaultValue="punchy"><option value="punchy">Punchy</option><option value="calm">Calm</option></select></label>
        <label>Captions<select name="captionPreset" defaultValue="bold_pop"><option value="bold_pop">Bold pop</option><option value="clean">Clean</option></select></label>
        <label>Accent<input name="color1" type="color" defaultValue="#ffe14d" /></label>
        <label>Background<input name="color2" type="color" defaultValue="#111111" /></label>
      </div>
      <label>
        ElevenLabs voice ID (optional; defaults to the team voice for the language)
        <input name="voiceId" dir="ltr" autoComplete="off" />
      </label>
      {state.errors && <ul role="alert" className="error">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="row">
        <button type="submit" className="primary" disabled={pending}>{pending ? "Creating…" : "Create storyboard"}</button>
        <span className="muted">Planning uses Claude only; nothing is generated until you approve.</span>
      </div>
    </form>
  );
}
```

`apps/web/app/new/page.tsx`:
```tsx
import { NewReelForm } from "./new-reel-form";

export default function NewReelPage() {
  return (
    <main className="stack">
      <h1>New reel</h1>
      <NewReelForm />
    </main>
  );
}
```

`apps/web/app/page.tsx` (replace the placeholder):
```tsx
import Link from "next/link";
import { listProjects } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

const STATUS_LABEL: Record<string, string> = {
  planning: "Planning", draft: "Awaiting approval", generating: "Generating", needs_attention: "Needs attention", rendered: "Rendered", failed: "Failed",
};

export default async function Home() {
  const supabase = await createClient();
  const projects = await listProjects(supabase);
  return (
    <main className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Reels</h1>
        <Link className="button primary" href="/new">New reel</Link>
      </div>
      {projects.length === 0 ? (
        <p className="muted">No reels yet. Start one from a short brief.</p>
      ) : (
        <table>
          <thead><tr><th>Title</th><th>Language</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td><Link href={`/projects/${p.id}`} dir="auto">{p.title}</Link></td>
                <td>{p.language === "he" ? "עברית" : "English"}</td>
                <td><span className="badge">{STATUS_LABEL[p.status] ?? p.status}</span></td>
                <td className="muted">{new Date(p.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Typecheck, test and build**

Run: `npx vitest run apps/web && npx tsc -p apps/web/tsconfig.json && npm run build -w @reel/web`
Expected: tests pass, `tsc` exits 0, and the build lists `/new`.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): projects list and new-reel form that queues a plan job"
```

---

### Task 11: Project page: storyboard editor, save, approve, retry

**Files:**
- Create: `apps/web/lib/storyboard-edit.ts`, `apps/web/lib/approve.ts`, `apps/web/app/projects/[id]/actions.ts`, `apps/web/app/projects/[id]/page.tsx`, `apps/web/components/StoryboardEditor.tsx`
- Test: `apps/web/lib/storyboard-edit.test.ts`, `apps/web/lib/approve.test.ts`

**Interfaces:**
- Consumes: `parseStoryboard`, `Storyboard`, `Scene`, `estimateCost`, `costModelsFor` (`@reel/core`); `getProjectView` (Task 10)
- Produces:
  - `type EditAction` (below), `editStoryboard(sb, action): Storyboard`, `newSceneId(existing): string`
  - `normalizeForSave(sb): Storyboard` (blank prompts become `undefined`), `checkStoryboard(input): { ok: true; storyboard } | { ok: false; errors: string[] }`
  - `interface StoryboardWriteDeps { updateDraft(storyboardId, json, status): Promise<number>; queueGenerate(projectId, storyboardId): Promise<void>; setProjectStatus(projectId, status): Promise<void>; activeJobCount(projectId): Promise<number>; insertDraft(projectId, version, json): Promise<void>; maxVersion(projectId): Promise<number> }`
  - `saveDraft`, `approveStoryboard`, `retryGenerate`, `newDraftFrom` (all returning `{ ok: true } | { ok: false; errors: string[] }`)
  - server actions `saveStoryboardAction`, `approveStoryboardAction`, `retryGenerateAction`, `editAsNewVersionAction`

- [ ] **Step 1: Write the failing tests**

`apps/web/lib/storyboard-edit.test.ts`:
```ts
import { parseStoryboard } from "@reel/core";
import { describe, expect, it } from "vitest";
import { checkStoryboard, editStoryboard, newSceneId, normalizeForSave } from "./storyboard-edit";

const sb = () =>
  parseStoryboard({
    version: 1, title: "t", language: "he", format: "faceless", aspect: "9:16", targetDurationSec: 30,
    voice: { voiceId: "v", modelId: "eleven_v4" },
    style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D"], pacing: "punchy" },
    scenes: [
      { id: "s1", script: "הוק", visual: { kind: "image", prompt: "phone", motion: "zoom_in" }, overlays: [], transitionOut: "cut" },
      { id: "s2", script: "טיפ", visual: { kind: "graphic" }, overlays: [], transitionOut: "cut" },
    ],
  });

describe("editStoryboard", () => {
  it("patches a scene's script and visual without touching other fields", () => {
    const next = editStoryboard(sb(), { type: "updateScene", index: 0, patch: { script: "חדש", visual: { prompt: "desk" } } });
    expect(next.scenes[0]).toMatchObject({ script: "חדש", visual: { kind: "image", prompt: "desk", motion: "zoom_in" } });
    expect(next.scenes[1]).toEqual(sb().scenes[1]);
  });
  it("adds a scene after an index with a fresh id and removes/moves scenes", () => {
    let s = editStoryboard(sb(), { type: "addScene", after: 0 });
    expect(s.scenes.map((x) => x.id)).toEqual(["s1", "s3", "s2"]);
    s = editStoryboard(s, { type: "moveScene", index: 2, direction: -1 });
    expect(s.scenes.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    s = editStoryboard(s, { type: "removeScene", index: 0 });
    expect(s.scenes.map((x) => x.id)).toEqual(["s2", "s3"]);
  });
  it("never removes the last scene or moves past the ends", () => {
    const one = editStoryboard(sb(), { type: "removeScene", index: 1 });
    expect(editStoryboard(one, { type: "removeScene", index: 0 }).scenes).toHaveLength(1);
    expect(editStoryboard(sb(), { type: "moveScene", index: 0, direction: -1 })).toEqual(sb());
  });
  it("adds (max 3), edits and removes overlays", () => {
    let s = sb();
    for (let i = 0; i < 4; i++) s = editStoryboard(s, { type: "addOverlay", sceneIndex: 0 });
    expect(s.scenes[0].overlays).toHaveLength(3);
    s = editStoryboard(s, { type: "updateOverlay", sceneIndex: 0, overlayIndex: 1, patch: { text: "טיפ 1" } });
    expect(s.scenes[0].overlays[1].text).toBe("טיפ 1");
    s = editStoryboard(s, { type: "removeOverlay", sceneIndex: 0, overlayIndex: 0 });
    expect(s.scenes[0].overlays).toHaveLength(2);
  });
  it("newSceneId skips ids in use", () => {
    expect(newSceneId(["s1", "s3"])).toBe("s4");
    expect(newSceneId([])).toBe("s1");
  });
});

describe("checkStoryboard", () => {
  it("drops blank prompts before validating (graphic scenes)", () => {
    const s = editStoryboard(sb(), { type: "updateScene", index: 1, patch: { visual: { prompt: "  " } } });
    expect(normalizeForSave(s).scenes[1].visual.prompt).toBeUndefined();
    expect(checkStoryboard(s).ok).toBe(true);
  });
  it("returns one readable line per problem", () => {
    let s = editStoryboard(sb(), { type: "updateScene", index: 0, patch: { script: "", visual: { prompt: "" } } });
    s = editStoryboard(s, { type: "addOverlay", sceneIndex: 1 });
    const r = checkStoryboard(s);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.length).toBeGreaterThanOrEqual(2);
    expect(!r.ok && r.errors.join("\n")).toMatch(/scenes\.0\.script/);
    expect(!r.ok && r.errors.every((e) => !e.startsWith("-"))).toBe(true);
  });
});
```

`apps/web/lib/approve.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run apps/web/lib/storyboard-edit.test.ts apps/web/lib/approve.test.ts`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement `lib/storyboard-edit.ts`**

```ts
import { parseStoryboard, type Scene, type Storyboard } from "@reel/core";

export const MAX_OVERLAYS = 3;

export type ScenePatch = Partial<Pick<Scene, "script" | "transitionOut">> & { visual?: Partial<Scene["visual"]> };
export type OverlayPatch = Partial<Scene["overlays"][number]>;

export type EditAction =
  | { type: "updateScene"; index: number; patch: ScenePatch }
  | { type: "addScene"; after: number }
  | { type: "removeScene"; index: number }
  | { type: "moveScene"; index: number; direction: -1 | 1 }
  | { type: "addOverlay"; sceneIndex: number }
  | { type: "updateOverlay"; sceneIndex: number; overlayIndex: number; patch: OverlayPatch }
  | { type: "removeOverlay"; sceneIndex: number; overlayIndex: number }
  | { type: "reset"; storyboard: Storyboard };

export function newSceneId(existing: string[]): string {
  for (let n = existing.length + 1; ; n++) {
    const id = `s${n}`;
    if (!existing.includes(id)) return id;
  }
}

const withScene = (sb: Storyboard, index: number, update: (s: Scene) => Scene): Storyboard => {
  const scene = sb.scenes[index];
  if (!scene) return sb;
  const scenes = [...sb.scenes];
  scenes[index] = update(scene);
  return { ...sb, scenes };
};

export function editStoryboard(sb: Storyboard, action: EditAction): Storyboard {
  switch (action.type) {
    case "updateScene":
      return withScene(sb, action.index, (s) => ({ ...s, ...action.patch, visual: { ...s.visual, ...action.patch.visual } }));
    case "addScene": {
      const scenes = [...sb.scenes];
      scenes.splice(action.after + 1, 0, {
        id: newSceneId(sb.scenes.map((s) => s.id)),
        script: "",
        visual: { kind: "image", prompt: "", motion: "zoom_in" },
        overlays: [],
        transitionOut: "cut",
      });
      return { ...sb, scenes };
    }
    case "removeScene": {
      if (sb.scenes.length <= 1 || !sb.scenes[action.index]) return sb;
      return { ...sb, scenes: sb.scenes.filter((_, i) => i !== action.index) };
    }
    case "moveScene": {
      const j = action.index + action.direction;
      if (j < 0 || j >= sb.scenes.length || !sb.scenes[action.index]) return sb;
      const scenes = [...sb.scenes];
      [scenes[action.index], scenes[j]] = [scenes[j], scenes[action.index]];
      return { ...sb, scenes };
    }
    case "addOverlay":
      return withScene(sb, action.sceneIndex, (s) =>
        s.overlays.length >= MAX_OVERLAYS ? s : { ...s, overlays: [...s.overlays, { text: "", position: "top", animation: "pop" }] });
    case "updateOverlay":
      return withScene(sb, action.sceneIndex, (s) => ({
        ...s,
        overlays: s.overlays.map((o, i) => (i === action.overlayIndex ? { ...o, ...action.patch } : o)),
      }));
    case "removeOverlay":
      return withScene(sb, action.sceneIndex, (s) => ({ ...s, overlays: s.overlays.filter((_, i) => i !== action.overlayIndex) }));
    case "reset":
      return action.storyboard;
  }
}

/** Blank prompts mean "no prompt" (graphic scenes); the schema requires a present prompt to be non-empty. */
export function normalizeForSave(sb: Storyboard): Storyboard {
  return {
    ...sb,
    scenes: sb.scenes.map((s) => {
      const prompt = s.visual.prompt?.trim();
      const { prompt: _drop, ...visual } = s.visual;
      return { ...s, visual: prompt ? { ...visual, prompt } : visual };
    }),
  };
}

export type StoryboardCheck = { ok: true; storyboard: Storyboard } | { ok: false; errors: string[] };

export function checkStoryboard(input: unknown): StoryboardCheck {
  try {
    const candidate = typeof input === "object" && input !== null && "scenes" in input ? normalizeForSave(input as Storyboard) : input;
    return { ok: true, storyboard: parseStoryboard(candidate) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lines = message.split("\n").slice(1).map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
    return { ok: false, errors: lines.length ? lines : [message] };
  }
}
```

- [ ] **Step 4: Implement `lib/approve.ts`**

```ts
import type { Storyboard } from "@reel/core";
import { checkStoryboard } from "./storyboard-edit";

export type Result = { ok: true } | { ok: false; errors: string[] };

export interface StoryboardWriteDeps {
  /** Updates a storyboard only while it is a draft; returns the number of rows changed (0 or 1). */
  updateDraft(storyboardId: string, json: Storyboard, status: "draft" | "approved"): Promise<number>;
  queueGenerate(projectId: string, storyboardId: string): Promise<void>;
  setProjectStatus(projectId: string, status: "draft" | "generating"): Promise<void>;
  activeJobCount(projectId: string): Promise<number>;
  insertDraft(projectId: string, version: number, json: Storyboard): Promise<void>;
  maxVersion(projectId: string): Promise<number>;
}

export async function saveDraft(deps: StoryboardWriteDeps, input: { storyboardId: string; json: unknown }): Promise<Result> {
  const check = checkStoryboard(input.json);
  if (!check.ok) return check;
  const updated = await deps.updateDraft(input.storyboardId, check.storyboard, "draft");
  return updated ? { ok: true } : { ok: false, errors: ["Only draft storyboards can be edited. Use “Edit as new version”."] };
}

export async function approveStoryboard(deps: StoryboardWriteDeps, input: { projectId: string; storyboardId: string; json: unknown }): Promise<Result> {
  const check = checkStoryboard(input.json);
  if (!check.ok) return check;
  // The draft→approved update is the lock: concurrent approvals serialize on the row and only one sees status='draft'.
  const updated = await deps.updateDraft(input.storyboardId, check.storyboard, "approved");
  if (!updated) return { ok: false, errors: ["This storyboard was already approved. Refresh the page."] };
  await deps.queueGenerate(input.projectId, input.storyboardId);
  await deps.setProjectStatus(input.projectId, "generating");
  return { ok: true };
}

export async function retryGenerate(deps: StoryboardWriteDeps, input: { projectId: string; storyboardId: string }): Promise<Result> {
  if ((await deps.activeJobCount(input.projectId)) > 0) return { ok: false, errors: ["A job for this reel is already queued or running."] };
  await deps.queueGenerate(input.projectId, input.storyboardId);
  await deps.setProjectStatus(input.projectId, "generating");
  return { ok: true };
}

export async function newDraftFrom(deps: StoryboardWriteDeps, input: { projectId: string; json: unknown }): Promise<Result> {
  const check = checkStoryboard(input.json);
  if (!check.ok) return check;
  const version = (await deps.maxVersion(input.projectId)) + 1;
  await deps.insertDraft(input.projectId, version, { ...check.storyboard, version });
  await deps.setProjectStatus(input.projectId, "draft");
  return { ok: true };
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run apps/web/lib`
Expected: PASS (storyboard-edit 7, approve 6, plus the earlier web tests).

- [ ] **Step 6: Implement the server actions**

`apps/web/app/projects/[id]/actions.ts`:
```ts
"use server";
import type { Json } from "@reel/db";
import { revalidatePath } from "next/cache";
import { approveStoryboard, newDraftFrom, retryGenerate, saveDraft, type Result, type StoryboardWriteDeps } from "@/lib/approve";
import { createClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createClient>>;

function depsFor(sb: Client): StoryboardWriteDeps {
  const must = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  return {
    async updateDraft(id, json, status) {
      const { data, error } = await sb.from("storyboards").update({ json: json as unknown as Json, status }).eq("id", id).eq("status", "draft").select("id");
      must("storyboard update", error);
      return data?.length ?? 0;
    },
    async queueGenerate(projectId, storyboardId) {
      const { error } = await sb.from("jobs").insert({ project_id: projectId, type: "generate", payload: { storyboardId } });
      must("queue generate", error);
    },
    async setProjectStatus(projectId, status) {
      const { error } = await sb.from("projects").update({ status }).eq("id", projectId);
      must("project status", error);
    },
    async activeJobCount(projectId) {
      const { count, error } = await sb.from("jobs").select("id", { count: "exact", head: true }).eq("project_id", projectId).in("status", ["queued", "running"]);
      must("job lookup", error);
      return count ?? 0;
    },
    async insertDraft(projectId, version, json) {
      const { error } = await sb.from("storyboards").insert({ project_id: projectId, version, json: json as unknown as Json, status: "draft", created_by: "user" });
      must("new draft", error);
    },
    async maxVersion(projectId) {
      const { data, error } = await sb.from("storyboards").select("version").eq("project_id", projectId).order("version", { ascending: false }).limit(1).maybeSingle();
      must("version lookup", error);
      return data?.version ?? 0;
    },
  };
}

async function run(projectId: string, fn: (deps: StoryboardWriteDeps) => Promise<Result>): Promise<Result> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return { ok: false, errors: ["Your session expired. Sign in again."] };
  try {
    return await fn(depsFor(supabase));
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  } finally {
    revalidatePath(`/projects/${projectId}`);
  }
}

export async function saveStoryboardAction(projectId: string, storyboardId: string, json: unknown) {
  return run(projectId, (deps) => saveDraft(deps, { storyboardId, json }));
}
export async function approveStoryboardAction(projectId: string, storyboardId: string, json: unknown) {
  return run(projectId, (deps) => approveStoryboard(deps, { projectId, storyboardId, json }));
}
export async function retryGenerateAction(projectId: string, storyboardId: string) {
  return run(projectId, (deps) => retryGenerate(deps, { projectId, storyboardId }));
}
export async function editAsNewVersionAction(projectId: string, json: unknown) {
  return run(projectId, (deps) => newDraftFrom(deps, { projectId, json }));
}
```

- [ ] **Step 7: Implement the editor component and the page**

`apps/web/components/StoryboardEditor.tsx`:
```tsx
"use client";
import { costModelsFor, estimateCost, type Storyboard } from "@reel/core";
import { useRouter } from "next/navigation";
import { useMemo, useReducer, useState, useTransition } from "react";
import { approveStoryboardAction, editAsNewVersionAction, retryGenerateAction, saveStoryboardAction } from "@/app/projects/[id]/actions";
import { checkStoryboard, editStoryboard, MAX_OVERLAYS, normalizeForSave } from "@/lib/storyboard-edit";

const MOTIONS = ["none", "zoom_in", "zoom_out", "pan_left", "pan_right"] as const;
const TRANSITIONS = ["cut", "fade", "whip", "zoom"] as const;
const KINDS = [["image", "Image"], ["broll_video", "B-roll video"], ["graphic", "Graphic"]] as const;

type Props = {
  projectId: string;
  storyboardId: string;
  initial: Storyboard;
  editable: boolean;
  canRetry: boolean;
};

export function StoryboardEditor({ projectId, storyboardId, initial, editable, canRetry }: Props) {
  const [sb, dispatch] = useReducer(editStoryboard, initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const textDir = sb.language === "he" ? "rtl" : "ltr";
  const check = useMemo(() => checkStoryboard(sb), [sb]);
  const estimate = useMemo(() => {
    try {
      return estimateCost(normalizeForSave(sb), costModelsFor(sb.voice?.modelId ?? "eleven_v4")).totalUsd;
    } catch {
      return null;
    }
  }, [sb]);

  const act = (fn: () => Promise<{ ok: true } | { ok: false; errors: string[] }>) =>
    startTransition(async () => {
      const result = await fn();
      setErrors(result.ok ? [] : result.errors);
      if (result.ok) router.refresh();
    });

  return (
    <section className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Storyboard v{sb.version}</h2>
        <span className="muted">{estimate === null ? "Estimate unavailable" : `Estimated generation cost: $${estimate.toFixed(2)}`}</span>
      </div>

      {sb.scenes.map((scene, i) => (
        <article key={scene.id} className="card stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Scene {i + 1} <span className="muted">· {scene.id}</span></strong>
            {editable && (
              <div className="row">
                <button type="button" onClick={() => dispatch({ type: "moveScene", index: i, direction: -1 })} disabled={i === 0} aria-label="Move up">↑</button>
                <button type="button" onClick={() => dispatch({ type: "moveScene", index: i, direction: 1 })} disabled={i === sb.scenes.length - 1} aria-label="Move down">↓</button>
                <button type="button" onClick={() => dispatch({ type: "removeScene", index: i })} disabled={sb.scenes.length === 1}>Delete</button>
              </div>
            )}
          </div>
          <label>
            Voiceover
            <textarea dir={textDir} value={scene.script} disabled={!editable} onChange={(e) => dispatch({ type: "updateScene", index: i, patch: { script: e.target.value } })} />
          </label>
          <div className="row">
            <label>Visual
              <select value={scene.visual.kind} disabled={!editable} onChange={(e) => dispatch({ type: "updateScene", index: i, patch: { visual: { kind: e.target.value as Storyboard["scenes"][number]["visual"]["kind"] } } })}>
                {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </label>
            <label>Camera
              <select value={scene.visual.motion} disabled={!editable} onChange={(e) => dispatch({ type: "updateScene", index: i, patch: { visual: { motion: e.target.value as (typeof MOTIONS)[number] } } })}>
                {MOTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label>Transition out
              <select value={scene.transitionOut} disabled={!editable} onChange={(e) => dispatch({ type: "updateScene", index: i, patch: { transitionOut: e.target.value as (typeof TRANSITIONS)[number] } })}>
                {TRANSITIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </div>
          {scene.visual.kind !== "graphic" && (
            <label>
              Visual prompt (English)
              <textarea dir="ltr" value={scene.visual.prompt ?? ""} disabled={!editable} onChange={(e) => dispatch({ type: "updateScene", index: i, patch: { visual: { prompt: e.target.value } } })} />
            </label>
          )}
          {scene.overlays.map((o, j) => (
            <div key={j} className="row">
              <input dir={textDir} value={o.text} placeholder="On-screen text" disabled={!editable} onChange={(e) => dispatch({ type: "updateOverlay", sceneIndex: i, overlayIndex: j, patch: { text: e.target.value } })} />
              <select value={o.position} disabled={!editable} onChange={(e) => dispatch({ type: "updateOverlay", sceneIndex: i, overlayIndex: j, patch: { position: e.target.value as typeof o.position } })}>
                {["top", "center", "bottom"].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select value={o.animation} disabled={!editable} onChange={(e) => dispatch({ type: "updateOverlay", sceneIndex: i, overlayIndex: j, patch: { animation: e.target.value as typeof o.animation } })}>
                {["pop", "fade", "type"].map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {editable && <button type="button" onClick={() => dispatch({ type: "removeOverlay", sceneIndex: i, overlayIndex: j })}>Remove</button>}
            </div>
          ))}
          {editable && (
            <div className="row">
              <button type="button" onClick={() => dispatch({ type: "addOverlay", sceneIndex: i })} disabled={scene.overlays.length >= MAX_OVERLAYS}>Add text overlay</button>
              <button type="button" onClick={() => dispatch({ type: "addScene", after: i })}>Add scene below</button>
            </div>
          )}
        </article>
      ))}

      {editable && !check.ok && (
        <ul className="warn">{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      {errors.length > 0 && <ul role="alert" className="error">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}

      <div className="row">
        {editable ? (
          <>
            <button type="button" disabled={pending} onClick={() => act(() => saveStoryboardAction(projectId, storyboardId, sb))}>Save draft</button>
            <button type="button" className="primary" disabled={pending || !check.ok} onClick={() => act(() => approveStoryboardAction(projectId, storyboardId, sb))}>
              Approve &amp; generate
            </button>
            <span className="muted">Approving spends Higgsfield and ElevenLabs credits.</span>
          </>
        ) : (
          <>
            <button type="button" disabled={pending} onClick={() => act(() => editAsNewVersionAction(projectId, sb))}>Edit as new version</button>
            {canRetry && (
              <button type="button" className="primary" disabled={pending} onClick={() => act(() => retryGenerateAction(projectId, storyboardId))}>
                Retry generation
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
```

`apps/web/app/projects/[id]/page.tsx` (Task 12 adds the progress panel and the preview):
```tsx
import { notFound } from "next/navigation";
import { StoryboardEditor } from "@/components/StoryboardEditor";
import { getProjectView } from "@/lib/queries";
import { checkStoryboard } from "@/lib/storyboard-edit";
import { createClient } from "@/lib/supabase/server";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const view = await getProjectView(supabase, id);
  if (!view) notFound();
  const { project, storyboard, job } = view;
  const parsed = storyboard ? checkStoryboard(storyboard.json) : null;
  const canRetry = job?.type === "generate" && (job.status === "needs_attention" || job.status === "failed");

  return (
    <main className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 dir="auto" style={{ margin: 0 }}>{project.title}</h1>
        <span className="badge">{project.status}</span>
      </div>
      {storyboard && parsed?.ok && (
        <StoryboardEditor
          key={`${storyboard.id}:${storyboard.updated_at}`}
          projectId={project.id}
          storyboardId={storyboard.id}
          initial={parsed.storyboard}
          editable={storyboard.status === "draft"}
          canRetry={canRetry}
        />
      )}
      {storyboard && parsed && !parsed.ok && <p className="error">This storyboard can't be displayed: {parsed.errors.join("; ")}</p>}
      {!storyboard && <p className="muted">Claude is writing the storyboard…</p>}
    </main>
  );
}
```

- [ ] **Step 8: Typecheck, test and build**

Run: `npx vitest run apps/web && npx tsc -p apps/web/tsconfig.json && npm run build -w @reel/web`
Expected: everything passes; the build lists `/projects/[id]`.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): storyboard editor with save, approve (single job), retry and edit-as-new-version"
```

---

### Task 12: Live job progress and the reel preview

**Files:**
- Create: `apps/web/lib/progress-view.ts`, `apps/web/lib/render-urls.ts`, `apps/web/components/JobPanel.tsx`, `apps/web/components/ReelPreview.tsx`
- Modify: `apps/web/app/projects/[id]/page.tsx`
- Test: `apps/web/lib/progress-view.test.ts`, `apps/web/lib/render-urls.test.ts`

**Interfaces:**
- Consumes:
  - from `@reel/db`: `JobProgressSchema`, `emptyProgress`, `BUCKETS`, `RenderRow`, `JobRow`
  - from `@reel/core`: `TimelineSchema`, `timelineAssetFiles`, `mapTimelineSources`, `Timeline`
  - from `@reel/video/reel`: `Reel`
  - the browser Supabase client
- Produces:
  - `describeJob(job, sceneIds): ProgressView | null`
  - `SIGNED_URL_TTL_SECONDS = 21600`, `interface SigningClient`, `signRender(client, render): Promise<SignedRender>`, `supabaseSigningClient(sb): SigningClient`
  - `<JobPanel projectId initialJob sceneIds />`, `<ReelPreview timeline reelUrl />`

- [ ] **Step 1: Write the failing tests**

`apps/web/lib/progress-view.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { describeJob } from "./progress-view";

const job = (over: Record<string, unknown>) => ({ type: "generate", status: "running", progress: {}, error: null, ...over });

describe("describeJob", () => {
  it("returns null without a job", () => {
    expect(describeJob(null, [])).toBeNull();
  });
  it("describes planning", () => {
    expect(describeJob(job({ type: "plan", status: "running" }), [])).toMatchObject({ headline: "Claude is writing the storyboard…", tone: "info", steps: [] });
    expect(describeJob(job({ type: "plan", status: "failed", error: "No voice for he" }), [])).toMatchObject({ tone: "error", error: "No voice for he" });
  });
  it("maps generate progress to steps, scene states and render percent", () => {
    const view = describeJob(
      job({ progress: { steps: { voice: "done", visuals: "done", render: "running" }, scenes: { s1: { status: "done" } }, renderProgress: 0.456 } }),
      ["s1", "s2"],
    )!;
    expect(view.steps.map((s) => `${s.key}:${s.state}`)).toEqual(["voice:done", "visuals:done", "render:running", "export:pending"]);
    expect(view.scenes).toEqual([{ id: "s1", state: "done" }, { id: "s2", state: "pending" }]);
    expect(view.renderPercent).toBe(46);
  });
  it("explains needs_attention with the failing scene reasons", () => {
    const view = describeJob(
      job({ status: "needs_attention", error: "1 scene(s) failed", progress: { scenes: { s2: { status: "failed", reason: "blocked by content moderation" } } } }),
      ["s2"],
    )!;
    expect(view.tone).toBe("warning");
    expect(view.headline).toMatch(/fix their prompts/);
    expect(view.scenes[0]).toEqual({ id: "s2", state: "failed", reason: "blocked by content moderation" });
  });
  it("tolerates malformed progress JSON", () => {
    expect(describeJob(job({ progress: { steps: "nope" } }), ["s1"])!.steps.every((s) => s.state === "pending")).toBe(true);
  });
});
```

`apps/web/lib/render-urls.test.ts`:
```ts
import { assetSrc, type Timeline } from "@reel/core";
import { describe, expect, it } from "vitest";
import { signRender, type SigningClient } from "./render-urls";

const timeline: Timeline = {
  fps: 30, width: 1080, height: 1920, durationInFrames: 60, language: "en", direction: "ltr",
  style: { captionPreset: "clean", font: "Heebo", palette: ["#FFE14D"] },
  audio: { voiceUrl: assetSrc("v.wav"), musicDuckingDb: -18 },
  clips: [{ sceneId: "s1", kind: "image", src: assetSrc("a.png"), fromFrame: 0, durationInFrames: 60, motion: "none", transitionIn: "cut" }],
  captions: { words: [] },
  overlays: [],
};
const render = { reel_path: "p/v1/reel.mp4", preview_path: "p/v1/preview.mp4", thumbnail_path: "p/v1/thumbnail.jpg", timeline };

function fakeClient(missing: string[] = []): SigningClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async createSignedUrls(bucket, paths) {
      calls.push(`many:${bucket}:${paths.sort().join(",")}`);
      return Object.fromEntries(paths.filter((p) => !missing.includes(p)).map((p) => [p, `https://signed/${bucket}/${p}`]));
    },
    async createSignedUrl(bucket, path, _ttl, download) {
      calls.push(`one:${bucket}:${path}:${download ?? ""}`);
      return `https://signed/${bucket}/${path}`;
    },
  };
}

describe("signRender", () => {
  it("signs every asset ref in one batch and the deliverables, with a download name for the reel", async () => {
    const client = fakeClient();
    const signed = await signRender(client, render);
    expect(signed.timeline.audio.voiceUrl).toBe("https://signed/assets/v.wav");
    expect(signed.timeline.clips[0].src).toBe("https://signed/assets/a.png");
    expect(signed.reelUrl).toBe("https://signed/renders/p/v1/reel.mp4");
    expect(client.calls).toContain("many:assets:a.png,v.wav");
    expect(client.calls).toContain("one:renders:p/v1/reel.mp4:reel.mp4");
  });
  it("fails clearly when an asset can't be signed", async () => {
    await expect(signRender(fakeClient(["a.png"]), render)).rejects.toThrow(/a\.png/);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run apps/web/lib/progress-view.test.ts apps/web/lib/render-urls.test.ts`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement `lib/progress-view.ts` and `lib/render-urls.ts`**

`apps/web/lib/progress-view.ts`:
```ts
import { emptyProgress, JobProgressSchema } from "@reel/db";

export type StepView = { key: "voice" | "visuals" | "render" | "export"; label: string; state: "pending" | "running" | "done" };
export type SceneView = { id: string; state: "pending" | "running" | "done" | "failed"; reason?: string };
export type ProgressView = {
  headline: string;
  tone: "info" | "success" | "warning" | "error";
  steps: StepView[];
  scenes: SceneView[];
  renderPercent?: number;
  error?: string;
};

type JobLike = { type: string; status: string; progress: unknown; error: string | null };

const STEPS: [StepView["key"], string][] = [["voice", "Voice"], ["visuals", "Visuals"], ["render", "Render"], ["export", "Export"]];

const PLAN_HEADLINES: Record<string, [string, ProgressView["tone"]]> = {
  queued: ["Waiting for a worker…", "info"],
  running: ["Claude is writing the storyboard…", "info"],
  done: ["Storyboard ready: review and approve it below.", "success"],
  failed: ["Planning failed.", "error"],
};
const GENERATE_HEADLINES: Record<string, [string, ProgressView["tone"]]> = {
  queued: ["Queued: waiting for a worker…", "info"],
  running: ["Generating your reel…", "info"],
  done: ["Your reel is ready.", "success"],
  needs_attention: ["Some scenes failed: fix their prompts, then retry. Finished scenes won't be charged again.", "warning"],
  failed: ["Generation failed.", "error"],
};

export function describeJob(job: JobLike | null, sceneIds: string[]): ProgressView | null {
  if (!job) return null;
  const progress = JobProgressSchema.catch(emptyProgress()).parse(job.progress);
  const [headline, tone] = (job.type === "plan" ? PLAN_HEADLINES : GENERATE_HEADLINES)[job.status] ?? [job.status, "info"];
  const view: ProgressView = { headline, tone, steps: [], scenes: [], ...(job.error ? { error: job.error } : {}) };
  if (job.type !== "generate") return view;
  view.steps = STEPS.map(([key, label]) => ({ key, label, state: progress.steps[key] ?? "pending" }));
  view.scenes = sceneIds.map((id) => {
    const s = progress.scenes[id];
    if (!s) return { id, state: "pending" as const };
    return s.reason ? { id, state: s.status, reason: s.reason } : { id, state: s.status };
  });
  if (progress.steps.render === "running" && progress.renderProgress !== undefined) view.renderPercent = Math.round(progress.renderProgress * 100);
  return view;
}
```

`apps/web/lib/render-urls.ts`:
```ts
import { mapTimelineSources, TimelineSchema, timelineAssetFiles, type Timeline } from "@reel/core";
import { BUCKETS, type Database } from "@reel/db";
import type { SupabaseClient } from "@supabase/supabase-js";

export const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

export interface SigningClient {
  createSignedUrls(bucket: string, paths: string[], expiresIn: number): Promise<Record<string, string>>;
  createSignedUrl(bucket: string, path: string, expiresIn: number, download?: string): Promise<string>;
}

export type SignedRender = { reelUrl: string; previewUrl: string; thumbnailUrl: string; timeline: Timeline };

export async function signRender(
  client: SigningClient,
  render: { reel_path: string; preview_path: string; thumbnail_path: string; timeline: unknown },
): Promise<SignedRender> {
  const timeline = TimelineSchema.parse(render.timeline);
  const files = timelineAssetFiles(timeline);
  const urls = files.length ? await client.createSignedUrls(BUCKETS.assets, files, SIGNED_URL_TTL_SECONDS) : {};
  const missing = files.filter((f) => !urls[f]);
  if (missing.length) throw new Error(`Preview media is missing from storage: ${missing.join(", ")}`);
  const [reelUrl, previewUrl, thumbnailUrl] = await Promise.all([
    client.createSignedUrl(BUCKETS.renders, render.reel_path, SIGNED_URL_TTL_SECONDS, "reel.mp4"),
    client.createSignedUrl(BUCKETS.renders, render.preview_path, SIGNED_URL_TTL_SECONDS),
    client.createSignedUrl(BUCKETS.renders, render.thumbnail_path, SIGNED_URL_TTL_SECONDS),
  ]);
  return { reelUrl, previewUrl, thumbnailUrl, timeline: mapTimelineSources(timeline, (f) => urls[f]) };
}

export function supabaseSigningClient(sb: SupabaseClient<Database>): SigningClient {
  return {
    async createSignedUrls(bucket, paths, expiresIn) {
      const { data, error } = await sb.storage.from(bucket).createSignedUrls(paths, expiresIn);
      if (error) throw new Error(`signing ${bucket} failed: ${error.message}`);
      return Object.fromEntries((data ?? []).filter((d) => d.signedUrl && !d.error && d.path).map((d) => [d.path as string, d.signedUrl]));
    },
    async createSignedUrl(bucket, path, expiresIn, download) {
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, expiresIn, download ? { download } : undefined);
      if (error || !data) throw new Error(`signing ${bucket}/${path} failed: ${error?.message ?? "no data"}`);
      return data.signedUrl;
    },
  };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run apps/web/lib`
Expected: PASS (progress-view 5, render-urls 2, plus the earlier web tests).

- [ ] **Step 5: Implement the components**

`apps/web/components/JobPanel.tsx`:
```tsx
"use client";
import type { JobRow } from "@reel/db";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { describeJob } from "@/lib/progress-view";
import { createClient } from "@/lib/supabase/client";

type JobLite = Pick<JobRow, "id" | "type" | "status" | "progress" | "error" | "created_at">;
const TERMINAL = new Set(["done", "needs_attention", "failed"]);
const ICON = { pending: "○", running: "◐", done: "●", failed: "✕" } as const;

export function JobPanel({ projectId, initialJob, sceneIds }: { projectId: string; initialJob: JobLite | null; sceneIds: string[] }) {
  const [job, setJob] = useState<JobLite | null>(initialJob);
  const router = useRouter();
  const lastStatus = useRef(initialJob?.status);

  useEffect(() => setJob(initialJob), [initialJob]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`jobs:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs", filter: `project_id=eq.${projectId}` }, (payload) => {
        const row = payload.new as Partial<JobLite>;
        if (!row?.id || !row.created_at) return;
        setJob((prev) => (!prev || row.created_at! >= prev.created_at ? (row as JobLite) : prev));
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  useEffect(() => {
    if (job && job.status !== lastStatus.current && TERMINAL.has(job.status)) router.refresh();
    lastStatus.current = job?.status;
  }, [job, router]);

  const view = describeJob(job, sceneIds);
  if (!view) return null;
  return (
    <section className="card stack" aria-live="polite">
      <strong className={view.tone === "error" ? "error" : view.tone === "warning" ? "warn" : undefined}>{view.headline}</strong>
      {view.steps.length > 0 && (
        <div className="row">
          {view.steps.map((s) => <span key={s.key} className="badge">{ICON[s.state]} {s.label}{s.key === "render" && view.renderPercent !== undefined ? ` ${view.renderPercent}%` : ""}</span>)}
        </div>
      )}
      {view.scenes.length > 0 && (
        <ul className="stack" style={{ margin: 0, paddingInlineStart: 18 }}>
          {view.scenes.map((s) => (
            <li key={s.id} className={s.state === "failed" ? "error" : undefined}>
              {ICON[s.state]} {s.id}{s.reason ? `: ${s.reason}` : ""}
            </li>
          ))}
        </ul>
      )}
      {view.error && view.tone === "error" && <p className="error" style={{ margin: 0 }}>{view.error}</p>}
    </section>
  );
}
```

`apps/web/components/ReelPreview.tsx`:
```tsx
"use client";
import type { Timeline } from "@reel/core";
import { Reel } from "@reel/video/reel";
import { Player } from "@remotion/player";
import { useMemo } from "react";

export function ReelPreview({ timeline, reelUrl }: { timeline: Timeline; reelUrl: string }) {
  const inputProps = useMemo(() => ({ timeline }), [timeline]);
  return (
    <section className="card stack" style={{ alignItems: "center" }}>
      <Player
        component={Reel}
        inputProps={inputProps}
        durationInFrames={timeline.durationInFrames}
        fps={timeline.fps}
        compositionWidth={timeline.width}
        compositionHeight={timeline.height}
        controls
        acknowledgeRemotionLicense
        style={{ width: "100%", maxWidth: 360, aspectRatio: "9 / 16", borderRadius: 8 }}
      />
      <a className="button primary" href={reelUrl}>Download MP4 (1080×1920)</a>
    </section>
  );
}
```

- [ ] **Step 6: Wire both into the project page**

In `apps/web/app/projects/[id]/page.tsx`:
1. Add imports:
```tsx
import { JobPanel } from "@/components/JobPanel";
import { ReelPreview } from "@/components/ReelPreview";
import { signRender, supabaseSigningClient } from "@/lib/render-urls";
```
2. After `const canRetry = ...`, add:
```tsx
  const sceneIds = parsed?.ok ? parsed.storyboard.scenes.filter((s) => s.visual.kind !== "graphic").map((s) => s.id) : [];
  const signed =
    view.render && project.status === "rendered"
      ? await signRender(supabaseSigningClient(supabase), view.render).catch((err: Error) => ({ error: err.message }))
      : null;
```
3. Directly after the title row `</div>`, insert:
```tsx
      <JobPanel projectId={project.id} initialJob={job} sceneIds={sceneIds} />
      {signed && "error" in signed && <p className="error">{signed.error}</p>}
      {signed && !("error" in signed) && <ReelPreview timeline={signed.timeline} reelUrl={signed.reelUrl} />}
```

- [ ] **Step 7: Typecheck, test and build**

Run: `npx vitest run apps/web && npx tsc -p apps/web/tsconfig.json && npm run build -w @reel/web`
Expected: everything passes. The build must bundle `@reel/video/reel` into the client without pulling in `@remotion/renderer` or `@remotion/bundler`; `Reel.tsx` doesn't import them. If the build reports a Node-only module in the client bundle, trace the import chain it prints and fix it at the source.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): realtime job progress and Remotion Player preview with signed media URLs"
```

---

### Task 13: Configure, run end to end, document

This task is mostly configuration and manual verification. It spends no provider credits until the final optional step.

**Files:**
- Create: `docs/RUNNING.md`
- Create (git-ignored): `apps/web/.env.local`, plus additions to the root `.env.local`

**Interfaces:**
- Consumes: everything above
- Produces: a working local setup (web on :3000 plus a worker) against the hosted project, and `docs/RUNNING.md`

- [ ] **Step 1: Fill in the web env (controller, with Supabase MCP)**

Use `get_project_url` and `get_publishable_keys` for project `aawjjdxneashqatwaxrt`. Pick a key whose `disabled` is not true, preferring the `sb_publishable_...` one. Write `apps/web/.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=<project url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
```

- [ ] **Step 2: Dashboard settings and the worker secret (the user does these; give them exact steps)**

In the Supabase dashboard for **reel-agent**:
1. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up". Keep Email enabled.
2. **Authentication → URL Configuration:** set the Site URL to `http://localhost:3000`, and add the redirect URL `http://localhost:3000/auth/confirm`.
3. **Authentication → Emails → Magic Link:** change the link in the template to
   `<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Sign in to Reel Studio</a>`
4. **Authentication → Users → Invite user:** invite each teammate's email.
5. **Project Settings → API Keys:** create or copy a **secret** key (`sb_secret_...`). Paste it into the root `.env.local` as `SUPABASE_SECRET_KEY=...`, together with `SUPABASE_URL=<project url>`. The controller appends the empty lines first, so the user only fills in the values.

- [ ] **Step 3: Live Supabase check (free)**

Run: `npm run smoke:supabase`
Expected: six `PASS` lines and "All Supabase checks passed."

- [ ] **Step 4: Run it end to end with fake providers (free)**

In two terminals run `npm run worker:fake` and `npm run web`. Then walk through this checklist (the user signs in, since magic links come by email):
1. `http://localhost:3000` redirects to `/login`. An uninvited email gets the invite-only message.
2. The invited email receives the link; clicking it lands on the Reels list.
3. **New reel** (Hebrew, 15 s) opens the project page. The panel shows "Waiting for a worker…", then "Claude is writing the storyboard…", then "Storyboard ready". This happens without a manual refresh, over Realtime. In fake mode the storyboard comes from the fake planner.
4. The Hebrew script and overlay fields type right to left, and prompts left to right. Blank one image prompt: a warning appears and **Approve & generate** is disabled. Fix it and **Save draft**.
5. **Approve & generate**. Step badges advance, scenes go ○ → ◐ → ●, and render shows a percentage.
6. When it's done, the Player preview plays with Hebrew captions, and **Download MP4** saves `reel.mp4`.
7. A double-click on Approve in a second tab shows "already approved", and only one generate job exists (check in the dashboard's `jobs` table).
8. Stop the worker (Ctrl-C) during a generate job, then restart it. It logs "requeued 1 stale job(s)" once the heartbeat is more than 120 s old, and the job completes.

- [ ] **Step 5: Write `docs/RUNNING.md`**

```markdown
# Running Reel Studio locally

## One-time setup
1. `npm install` (Node 25, ffmpeg ≥ 7 on PATH).
2. Root `.env.local` (worker only; never commit):
   - `HF_CREDENTIALS`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_HE`, `ELEVENLABS_VOICE_EN`, `ANTHROPIC_API_KEY` (workspace-scoped key)
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (Supabase → Project Settings → API Keys → secret key)
   - optional: `REEL_SPEND_CAP_USD` (default 10), `CLAUDE_MODEL`, `HF_VIDEO_RESOLUTION`, `WORKER_POLL_MS`
3. `apps/web/.env.local`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (publishable key only).
4. Supabase dashboard: public sign-ups off; Site URL and redirect `http://localhost:3000/auth/confirm`; the Magic Link template points to `/auth/confirm?token_hash={{ .TokenHash }}&type=email`; invite teammates.
5. Check: `npm run smoke:supabase`.

## Every day
- `npm run web`: the app on http://localhost:3000
- `npm run worker`: generates with real providers (spends credits on approved storyboards only)
- `npm run worker:fake`: free local stand-ins for trying the flow
- Database changes: add a file under `supabase/migrations/`, apply it, regenerate `packages/db/src/database.types.ts`.

## How it fits together
Browser → Next.js (reads/writes rows as the signed-in user, under RLS) → `jobs` table → worker (secret key) → Claude / Higgsfield / ElevenLabs → FFmpeg + Remotion → Supabase Storage → Realtime updates back to the browser.
```

- [ ] **Step 6: Commit**

```bash
git add docs/RUNNING.md
git commit -m "docs: how to configure and run the web app and worker"
```

- [ ] **Step 7 (optional, spends credits; only with the user's explicit go-ahead): one real reel**

After the Anthropic workspace key and a usable ElevenLabs voice are in `.env.local`, run `npm run worker` and create one 15 s Hebrew reel through the UI. Confirm that the MP4 downloads, plays, and has Hebrew captions in sync with the voice.
