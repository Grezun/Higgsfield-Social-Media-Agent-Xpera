# Reel Engine (Phase 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless reel engine for the **faceless** format, plus a CLI with a plan → edit → approve → make checkpoint. The flow:
- brief → Claude storyboard (`storyboard.json`, editable)
- → ElevenLabs `eleven_v4` voice with word timestamps
- → Higgsfield 9:16 images and B-roll
- → FFmpeg normalization
- → Remotion composition (captions RTL/LTR, overlays, motion, transitions)
- → FFmpeg social export (MP4 + preview + thumbnail)

**Architecture:** An npm-workspaces monorepo with four packages:
- `@reel/core`: pure, fully unit-tested logic (schemas, word timing, scene spans, hashing, cost, assembly)
- `@reel/media`: an FFmpeg/ffprobe wrapper
- `@reel/video`: the Remotion project and renderer
- `@reel/engine`: IO (provider adapters, Claude planner, asset cache, pipeline, CLI)

The Storyboard is the contract Claude writes. The Timeline is derived by code and is the only input Remotion sees. Every provider output is cached under a content hash, so re-runs and edits only pay for what changed.

**Tech Stack:**
- Node 25, TypeScript 7, tsx, Vitest 5, zod 4
- `@anthropic-ai/sdk` 0.129 (`claude-opus-5-5`)
- `@elevenlabs/elevenlabs-js` 2.70
- `@higgsfield/client` 0.2.6 (v2 API)
- Remotion 4.0.531 (all `remotion`/`@remotion/*` packages pinned to exactly this version), React 19
- system `ffmpeg`/`ffprobe` ≥ 7

**Spec:** `docs/superpowers/specs/2026-09-30-social-reel-agent-design.md`. This plan covers Phase 1 **minus** Supabase, auth, the job queue, the worker and the web UI; those are Plan 1b, which wraps this engine.

## Global Constraints

- Output is always 9:16, 1080×1920, 30 fps. The Timeline schema enforces `fps: 30`, `width: 1080`, `height: 1920`.
- Languages: `he` | `en`, per reel. Hebrew reels render right to left (`direction: "rtl"`).
- Voice model: ElevenLabs `eleven_v4`, **always passed explicitly** as `modelId` (the API default doesn't support Hebrew). Configurable via the `ELEVENLABS_MODEL_ID` env var.
- Images: `higgsfield-ai/soul/v2/standard` with `aspect_ratio: "9:16"`, `resolution: "1080p"`, `batch_size: 1`.
- B-roll: `bytedance/seedance-2.5/image-to-video` from a 9:16 image. `generate_audio: false` always. `duration` is an integer between 4 and 30.
- Higgsfield inputs must be public HTTPS URLs (upload via `POST /files/generate-upload-url`). Outputs expire after about 7 days, so **download every output immediately**.
- Higgsfield has per-account concurrency (default 4). Enforce it with a semaphore; the concurrency-limit HTTP 400 is transient (retry with backoff).
- Claude: model `claude-opus-5-5` via `client.beta.messages.parse` with `betaZodOutputFormat`, `output_config.effort: "high"`, `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`. Check for `stop_reason === "refusal"`.
- FFmpeg: the system binary (`FFMPEG_PATH` / `FFPROBE_PATH` env, default `ffmpeg`/`ffprobe`). Run it with `spawn` and an argument array, never a shell. Every op has a timeout, and errors include the last 20 stderr lines.
- Social export: H.264 High, `yuv420p`, CRF 18, `-maxrate 12M -bufsize 24M`, AAC 48 kHz 192k, `loudnorm` −14 LUFS / −1 dBTP, `+faststart`.
- No provider credits are spent unless the user runs `make` with `--yes`. A per-reel spend cap (`REEL_SPEND_CAP_USD`, default 10) is checked before generation.
- Secrets live only in `.env.local` (git-ignored) and are never logged.

## Spec deviations (intentional, flagged for the reviewer)

1. The spec's `packages/core` is split into **`@reel/core`** (pure logic, no IO) and **`@reel/engine`** (adapters, planner, pipeline, CLI). This avoids a dependency cycle with `@reel/video`, which imports core's types.
2. Timeline clips carry **`transitionIn`** (the previous scene's `transitionOut`) instead of `transitionOut`, plus `kind: "graphic"` with no `src`. The Timeline also carries `style` (caption preset, font, palette). Clips are laid out exactly on their audio spans, and the incoming clip animates in over the outgoing one, so transitions never shift audio sync.
3. TTS audio gets **trailing** silence trimming only (`trimTrailingSilence`). Trimming leading silence would shift every word timestamp.
4. The asset cache in 1a is a local directory (`.reel-cache/`). Plan 1b swaps it for Supabase through the same `AssetStore` interface.

## Review Focus

1. **Hebrew caption with an embedded English word, a number and punctuation** (e.g. `3 טיפים ל-TikTok!`): words must keep their punctuation and render right to left, with the English token isolated so the "!" doesn't jump. Pinned in Task 3 (word grouping) and Task 9 (Hebrew still render includes mixed tokens).
2. **Word-count mismatch between scene scripts and timed words** (from text normalization or STT): scene spans must still be monotonic, cover the whole audio and never crash. Pinned in Task 3.
3. **A generated clip shorter or longer than its scene span** (4 s minimum clip for a 2 s scene; 4 s clip for a 9 s scene): the clip must end up exactly the scene length ±1 frame. Pinned in Task 7.
4. **Higgsfield's concurrency-limit 400 while scenes run in parallel**: it must be retried with backoff, not reported as a scene failure. Pinned in Task 11.
5. **A hand-edited `storyboard.json` with invalid content** (empty script, avatar scene in a faceless reel, duplicate ids): the user must get a readable validation error before anything is spent. Pinned in Task 2 and Task 15.

---

## File Structure

```
package.json                         root: workspaces, scripts, dev tooling
tsconfig.json                        one tsconfig for all packages (bundler resolution, react-jsx)
vitest.config.ts                     runs packages/*/src/**/*.test.{ts,tsx}
.env.example                         documents every env var
packages/core/
  package.json
  src/index.ts                       re-exports
  src/schema/storyboard.ts           StoryboardSchema, StoryboardDraftSchema, enums, formatValidationError
  src/schema/timeline.ts             TimelineSchema, WordSchema, types
  src/words.ts                       alignmentToWords (ElevenLabs char alignment → words)
  src/spans.ts                       sceneSpans (scene scripts + words → ms spans)
  src/hash.ts                        canonicalJson, inputHash
  src/cost.ts                        DEFAULT_COST_TABLE, estimateCost, assertWithinCap
  src/errors.ts                      PermanentProviderError, SpendCapError, SceneFailuresError, UnsupportedFormatError
  src/assemble.ts                    assemble (storyboard + spans + assets → Timeline)
packages/media/
  package.json
  src/index.ts
  src/run.ts                         runFfmpeg, runFfprobe, FfmpegError
  src/probe.ts                       probe
  src/ops.ts                         conformVideo, fitDuration, extractAudio, sliceAudio, trimTrailingSilence
  src/loudness.ts                    measureLoudness, normalizeLoudness, loudnormFilter
  src/export.ts                      EXPORT_PRESETS, exportDeliverable, thumbnail
  src/testing.ts                     makeTestVideo, makeTestTone, makeTestImage (lavfi fixtures)
packages/video/
  package.json
  src/index.ts                       registerRoot (Remotion entry)
  src/Root.tsx                       <Composition id="Reel">
  src/Reel.tsx                       top-level composition
  src/Clip.tsx                       one visual clip (motion + enter transition)
  src/Captions.tsx                   TikTok-style word captions, RTL-aware
  src/Overlays.tsx                   on-screen text overlays
  src/fonts.ts                       Heebo via @remotion/google-fonts
  src/motion.ts                      pure motion/transition math
  src/sample-timeline.ts             sampleTimeline(lang) for studio + tests
  src/render.ts                      renderReel, renderReelStill
packages/engine/
  package.json
  src/config.ts                      loadConfig (env → EngineConfig)
  src/retry.ts                       withRetry, Semaphore
  src/asset-store.ts                 FileAssetStore
  src/download.ts                    downloadTo
  src/serve.ts                       serveDir (local HTTP for Remotion)
  src/providers/types.ts             ImageGen, VideoGen, VoiceGen, Transcriber, MediaUploader, Planner, Providers
  src/providers/higgsfield.ts        HiggsfieldImageGen, HiggsfieldVideoGen, HiggsfieldUploader
  src/providers/elevenlabs.ts        ElevenLabsVoice
  src/providers/fake.ts              createFakeProviders
  src/planner.ts                     createPlanner, claudeDraftModel, buildStoryboard
  src/pipeline.ts                    generateAssets, renderAndExport
  src/cli.ts                         `reel plan` / `reel make`
  scripts/smoke-higgsfield.ts        live check (replaces root index.ts)
  scripts/smoke-elevenlabs.ts        live check: eleven_v4 alignment in he + en
```

---

### Task 1: Workspace scaffolding

**Files:**
- Modify: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `vitest.config.ts`, `.env.example`, `packages/{core,media,video,engine}/package.json`
- Move: `index.ts` → `packages/engine/scripts/smoke-higgsfield.ts`

**Interfaces:**
- Consumes: nothing
- Produces: workspace packages `@reel/core`, `@reel/media`, `@reel/video`, `@reel/engine`, each exporting TypeScript source directly (`"exports": {".": "./src/index.ts"}`); `npm test` and `npm run typecheck` at the root.

- [ ] **Step 1: Replace root `package.json`**

```json
{
  "name": "higgsfield-social-agent-xpera",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json",
    "reel": "tsx packages/engine/src/cli.ts",
    "studio": "npm run studio -w @reel/video",
    "smoke:higgsfield": "tsx packages/engine/scripts/smoke-higgsfield.ts",
    "smoke:elevenlabs": "tsx packages/engine/scripts/smoke-elevenlabs.ts"
  },
  "devDependencies": {
    "@types/node": "^26.6.3",
    "@types/react": "^19.0.0",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2",
    "vitest": "^5.0.3"
  }
}
```

- [ ] **Step 2: Replace `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["node"]
  },
  "include": ["packages/*/src", "packages/*/scripts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    testTimeout: 60_000,
    passWithNoTests: true,
  },
});
```

- [ ] **Step 4: Create the four package manifests**

`packages/core/package.json`:
```json
{
  "name": "@reel/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^4.6.5" }
}
```

`packages/media/package.json`:
```json
{
  "name": "@reel/media",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/video/package.json` (every Remotion package pinned to the **same exact** version, which Remotion requires):
```json
{
  "name": "@reel/video",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { "./render": "./src/render.ts", "./sample": "./src/sample-timeline.ts" },
  "scripts": { "studio": "remotion studio src/index.ts" },
  "dependencies": {
    "@reel/core": "*",
    "@remotion/bundler": "4.0.531",
    "@remotion/captions": "4.0.531",
    "@remotion/cli": "4.0.531",
    "@remotion/google-fonts": "4.0.531",
    "@remotion/renderer": "4.0.531",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "remotion": "4.0.531"
  }
}
```

`packages/engine/package.json`:
```json
{
  "name": "@reel/engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/pipeline.ts" },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.129.0",
    "@elevenlabs/elevenlabs-js": "^2.70.0",
    "@higgsfield/client": "^0.2.6",
    "@reel/core": "*",
    "@reel/media": "*",
    "@reel/video": "*",
    "dotenv": "^18.0.4",
    "zod": "^4.6.5"
  }
}
```

- [ ] **Step 5: Move the existing example script and update `.gitignore`**

```bash
mkdir -p packages/engine/scripts
git mv index.ts packages/engine/scripts/smoke-higgsfield.ts
```

Append to `.gitignore`:
```
.reel-cache/
work/
```

- [ ] **Step 6: Create `.env.example`**

```
# Higgsfield: "key-id:key-secret"
HF_CREDENTIALS=
HF_CONCURRENCY=4
HF_VIDEO_RESOLUTION=720p
# ElevenLabs
ELEVENLABS_API_KEY=
ELEVENLABS_MODEL_ID=eleven_v4
ELEVENLABS_VOICE_HE=
ELEVENLABS_VOICE_EN=
# Anthropic (optional if `ant auth login` profile is active)
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-opus-5-5
# Engine
REEL_SPEND_CAP_USD=10
REEL_CACHE_DIR=.reel-cache
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

- [ ] **Step 7: Install and verify tooling runs**

Run: `rm -rf node_modules package-lock.json && npm install && npm test && npm run typecheck`

Expected:
- `npm install` succeeds.
- `npm test` prints "No test files found, exiting with code 0".
- `typecheck` exits 0. The moved smoke script still typechecks, since it only imports `@higgsfield/client/v2` and `dotenv`, which are now engine dependencies hoisted to the root `node_modules`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: set up npm workspaces for reel engine packages"
```

---

### Task 2: Storyboard and Timeline schemas

**Files:**
- Create: `packages/core/src/schema/storyboard.ts`, `packages/core/src/schema/timeline.ts`, `packages/core/src/index.ts`, `packages/core/src/testing/fixtures.ts`
- Test: `packages/core/src/schema/storyboard.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (all exported from `@reel/core`):
  - `StoryboardSchema`, `type Storyboard`, `type Scene`
  - `StoryboardDraftSchema`, `type StoryboardDraft` (the LLM-facing subset)
  - `LanguageSchema`, `type Language = "he" | "en"`
  - `MotionSchema`, `TransitionSchema`, `CaptionPresetSchema`, `OverlayPositionSchema`, `OverlayAnimationSchema`, `VisualKindSchema`
  - `parseStoryboard(input: unknown): Storyboard` (throws `Error` with a readable, multi-line message)
  - `WordSchema`, `type Word = { text: string; startMs: number; endMs: number }`
  - `TimelineSchema`, `type Timeline`, `type TimelineClip`, `type TimelineOverlay`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/testing/fixtures.ts` (a shared fixture, kept out of `*.test.ts` files so importing it doesn't re-register tests):
```ts
export const validStoryboard = () => ({
  version: 1,
  title: "3 tips",
  language: "he",
  format: "faceless",
  aspect: "9:16",
  targetDurationSec: 30,
  voice: { voiceId: "voice-1", modelId: "eleven_v4" },
  style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D", "#111111"], pacing: "punchy" },
  scenes: [
    {
      id: "s1",
      script: "3 טיפים ל-TikTok!",
      visual: { kind: "image", prompt: "phone on a desk, soft light", motion: "zoom_in" },
      overlays: [{ text: "טיפ 1", position: "top", animation: "pop" }],
      transitionOut: "fade",
    },
    {
      id: "s2",
      script: "Second scene script",
      visual: { kind: "graphic" },
      overlays: [],
      transitionOut: "cut",
    },
  ],
});
```

`packages/core/src/schema/storyboard.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { validStoryboard } from "../testing/fixtures";
import { parseStoryboard } from "./storyboard";

describe("StoryboardSchema", () => {
  it("accepts a valid faceless storyboard and applies defaults", () => {
    const input = validStoryboard();
    delete (input.scenes[1] as { overlays?: unknown }).overlays;
    const sb = parseStoryboard(input);
    expect(sb.scenes[1].overlays).toEqual([]);
    expect(sb.scenes[1].visual.motion).toBe("none");
  });

  it("rejects an empty script with a readable message naming the path", () => {
    const input = validStoryboard();
    input.scenes[0].script = "   ";
    expect(() => parseStoryboard(input)).toThrow(/scenes\.0\.script/);
  });

  it("rejects avatar scenes in a faceless reel", () => {
    const input = validStoryboard();
    input.scenes[0].visual = { kind: "avatar", prompt: "x", motion: "none" } as never;
    expect(() => parseStoryboard(input)).toThrow(/not allowed in a faceless reel/);
  });

  it("rejects duplicate scene ids", () => {
    const input = validStoryboard();
    input.scenes[1].id = "s1";
    expect(() => parseStoryboard(input)).toThrow(/duplicate scene id "s1"/);
  });

  it("requires a prompt for image and broll_video scenes", () => {
    const input = validStoryboard();
    delete (input.scenes[0].visual as { prompt?: string }).prompt;
    expect(() => parseStoryboard(input)).toThrow(/needs a visual\.prompt/);
  });

  it("requires a voice unless the format is footage", () => {
    const input = { ...validStoryboard(), voice: null };
    expect(() => parseStoryboard(input)).toThrow(/voice is required/);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/core/src/schema/storyboard.test.ts`
Expected: FAIL with "Failed to resolve import "./storyboard"".

- [ ] **Step 3: Implement the storyboard schema**

`packages/core/src/schema/storyboard.ts`:
```ts
import * as z from "zod";

export const LanguageSchema = z.enum(["he", "en"]);
export type Language = z.infer<typeof LanguageSchema>;

export const MotionSchema = z.enum(["none", "zoom_in", "zoom_out", "pan_left", "pan_right"]);
export const TransitionSchema = z.enum(["cut", "fade", "whip", "zoom"]);
export const OverlayPositionSchema = z.enum(["top", "center", "bottom"]);
export const OverlayAnimationSchema = z.enum(["pop", "fade", "type"]);
export const VisualKindSchema = z.enum(["broll_video", "image", "avatar", "footage", "graphic"]);
export const CaptionPresetSchema = z.enum(["bold_pop", "clean"]);
export const FormatSchema = z.enum(["faceless", "avatar", "character", "footage"]);

const FACELESS_KINDS = new Set(["broll_video", "image", "graphic"]);
const PROMPTED_KINDS = new Set(["broll_video", "image"]);
// 20 scenes × 400 chars keeps one TTS request well under eleven_v4's 10k-character limit.

const OverlaySchema = z.object({
  text: z.string().trim().min(1).max(80),
  position: OverlayPositionSchema,
  animation: OverlayAnimationSchema,
});

export const SceneSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i, "scene id may only contain letters, digits, _ and -"),
  script: z.string().trim().min(1).max(400),
  footageSpan: z
    .object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() })
    .optional(),
  visual: z.object({
    kind: VisualKindSchema,
    prompt: z.string().trim().min(1).max(1500).optional(),
    model: z.string().min(1).optional(),
    motion: MotionSchema.default("none"),
  }),
  overlays: z.array(OverlaySchema).max(3).default([]),
  transitionOut: TransitionSchema.default("cut"),
});
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(120),
    language: LanguageSchema,
    format: FormatSchema,
    aspect: z.literal("9:16"),
    targetDurationSec: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
    voice: z
      .object({
        voiceId: z.string().min(1),
        modelId: z.string().min(1),
        stability: z.number().min(0).max(1).optional(),
        style: z.number().min(0).max(1).optional(),
      })
      .nullable(),
    character: z.object({ customReferenceId: z.string().min(1) }).optional(),
    sourceFootageAssetId: z.string().min(1).optional(),
    style: z.object({
      captionPreset: CaptionPresetSchema,
      font: z.string().min(1).default("Heebo"),
      palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i, "palette colors must be #RRGGBB")).min(1).max(5),
      musicAssetId: z.string().min(1).optional(),
      pacing: z.enum(["calm", "punchy"]),
    }),
    scenes: z.array(SceneSchema).min(1).max(20),
  })
  .superRefine((sb, ctx) => {
    const seen = new Set<string>();
    sb.scenes.forEach((scene, i) => {
      if (seen.has(scene.id)) {
        ctx.addIssue({ code: "custom", path: ["scenes", i, "id"], message: `duplicate scene id "${scene.id}"` });
      }
      seen.add(scene.id);
      if (sb.format === "faceless" && !FACELESS_KINDS.has(scene.visual.kind)) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", i, "visual", "kind"],
          message: `visual kind "${scene.visual.kind}" is not allowed in a faceless reel`,
        });
      }
      if (PROMPTED_KINDS.has(scene.visual.kind) && !scene.visual.prompt) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", i, "visual", "prompt"],
          message: `scene "${scene.id}" (${scene.visual.kind}) needs a visual.prompt`,
        });
      }
    });
    if (sb.format !== "footage" && sb.voice === null) {
      ctx.addIssue({ code: "custom", path: ["voice"], message: `voice is required for the ${sb.format} format` });
    }
  });
export type Storyboard = z.infer<typeof StoryboardSchema>;

/** Parses a storyboard, throwing an Error whose message lists every issue as "path: message". */
export function parseStoryboard(input: unknown): Storyboard {
  const result = StoryboardSchema.safeParse(input);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new Error(`Invalid storyboard:\n${lines.join("\n")}`);
}

/**
 * The subset Claude writes. Deliberately free of min/max constraints (structured outputs
 * do not enforce them); the full StoryboardSchema validates afterwards.
 */
export const StoryboardDraftSchema = z.object({
  title: z.string(),
  scenes: z.array(
    z.object({
      script: z.string(),
      visual: z.object({
        kind: z.enum(["broll_video", "image", "graphic"]),
        prompt: z.string(),
        motion: MotionSchema,
      }),
      overlays: z.array(
        z.object({ text: z.string(), position: OverlayPositionSchema, animation: OverlayAnimationSchema }),
      ),
      transitionOut: TransitionSchema,
    }),
  ),
});
export type StoryboardDraft = z.infer<typeof StoryboardDraftSchema>;
```

- [ ] **Step 4: Implement the timeline schema and the index**

`packages/core/src/schema/timeline.ts`:
```ts
import * as z from "zod";
import {
  CaptionPresetSchema,
  LanguageSchema,
  MotionSchema,
  OverlayAnimationSchema,
  OverlayPositionSchema,
  TransitionSchema,
} from "./storyboard";

export const WordSchema = z.object({
  text: z.string().min(1),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
});
export type Word = z.infer<typeof WordSchema>;

export const TimelineClipSchema = z.object({
  sceneId: z.string(),
  kind: z.enum(["video", "image", "graphic"]),
  src: z.string().optional(),
  fromFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  motion: MotionSchema,
  transitionIn: TransitionSchema,
});
export type TimelineClip = z.infer<typeof TimelineClipSchema>;

export const TimelineOverlaySchema = z.object({
  text: z.string().min(1),
  fromFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  position: OverlayPositionSchema,
  animation: OverlayAnimationSchema,
});
export type TimelineOverlay = z.infer<typeof TimelineOverlaySchema>;

export const TimelineSchema = z.object({
  fps: z.literal(30),
  width: z.literal(1080),
  height: z.literal(1920),
  durationInFrames: z.number().int().positive(),
  language: LanguageSchema,
  direction: z.enum(["rtl", "ltr"]),
  style: z.object({
    captionPreset: CaptionPresetSchema,
    font: z.string().min(1),
    palette: z.array(z.string()).min(1),
  }),
  audio: z.object({
    voiceUrl: z.string().optional(),
    musicUrl: z.string().optional(),
    musicDuckingDb: z.number(),
  }),
  clips: z.array(TimelineClipSchema),
  captions: z.object({ words: z.array(WordSchema) }),
  overlays: z.array(TimelineOverlaySchema),
});
export type Timeline = z.infer<typeof TimelineSchema>;
```

`packages/core/src/index.ts`:
```ts
export * from "./schema/storyboard";
export * from "./schema/timeline";
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run packages/core/src/schema/storyboard.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): storyboard and timeline schemas with readable validation"
```

---

### Task 3: Word timing and scene spans

**Files:**
- Create: `packages/core/src/words.ts`, `packages/core/src/spans.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/words.test.ts`, `packages/core/src/spans.test.ts`

**Interfaces:**
- Consumes: `type Word` from Task 2
- Produces:
  - `type CharacterAlignment = { characters: string[]; characterStartTimesSeconds: number[]; characterEndTimesSeconds: number[] }` (the same shape as ElevenLabs' `CharacterAlignmentResponseModel`)
  - `alignmentToWords(alignment: CharacterAlignment): Word[]`
  - `type SceneSpan = { sceneIndex: number; startMs: number; endMs: number }`
  - `sceneSpans(sceneScripts: string[], words: Word[], audioDurationMs: number): SceneSpan[]`
  - `MIN_SPAN_MS = 500`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/words.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { alignmentToWords } from "./words";

const align = (text: string, stepSec = 0.1) => {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * stepSec),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * stepSec),
  };
};

describe("alignmentToWords", () => {
  it("groups characters into words split on whitespace", () => {
    expect(alignmentToWords(align("Hi there"))).toEqual([
      { text: "Hi", startMs: 0, endMs: 200 },
      { text: "there", startMs: 300, endMs: 800 },
    ]);
  });

  it("keeps Hebrew punctuation, numbers and embedded English attached to their words", () => {
    const words = alignmentToWords(align("3 טיפים ל-TikTok!"));
    expect(words.map((w) => w.text)).toEqual(["3", "טיפים", "ל-TikTok!"]);
    expect(words[2].startMs).toBe(800);
    expect(words[2].endMs).toBe(1700);
  });

  it("ignores repeated whitespace and newlines", () => {
    expect(alignmentToWords(align("a  \n b")).map((w) => w.text)).toEqual(["a", "b"]);
  });

  it("returns [] for empty alignment", () => {
    expect(alignmentToWords({ characters: [], characterStartTimesSeconds: [], characterEndTimesSeconds: [] })).toEqual([]);
  });
});
```

`packages/core/src/spans.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MIN_SPAN_MS, sceneSpans } from "./spans";
import type { Word } from "./schema/timeline";

const words = (n: number, stepMs = 400): Word[] =>
  Array.from({ length: n }, (_, i) => ({ text: `w${i}`, startMs: i * stepMs, endMs: i * stepMs + stepMs - 50 }));

describe("sceneSpans", () => {
  it("maps each scene to the start of its first word when counts match", () => {
    const spans = sceneSpans(["a b", "c d e", "f"], words(6), 2600);
    expect(spans).toEqual([
      { sceneIndex: 0, startMs: 0, endMs: 800 },
      { sceneIndex: 1, startMs: 800, endMs: 2000 },
      { sceneIndex: 2, startMs: 2000, endMs: 2600 },
    ]);
  });

  it("scales boundaries proportionally when word counts do not match (e.g. '5' spoken as 'five hundred')", () => {
    const spans = sceneSpans(["a b", "c d"], words(8), 3400);
    expect(spans[0].startMs).toBe(0);
    expect(spans[1].startMs).toBe(1600); // boundary at word 4 of 8
    expect(spans[1].endMs).toBe(3400);
  });

  it("stays monotonic, covers the whole audio, and enforces MIN_SPAN_MS", () => {
    // 10 scripted words but only 2 timed words → rounding would collapse scenes
    const spans = sceneSpans(["a", "b", "c", "d e f g h i j"], words(2), 4000);
    for (let i = 0; i < spans.length; i++) {
      expect(spans[i].endMs - spans[i].startMs).toBeGreaterThanOrEqual(MIN_SPAN_MS);
      if (i > 0) expect(spans[i].startMs).toBe(spans[i - 1].endMs);
    }
    expect(spans[0].startMs).toBe(0);
    expect(spans.at(-1)!.endMs).toBe(4000);
  });

  it("splits duration by word count when there are no timed words", () => {
    const spans = sceneSpans(["a", "b c d"], [], 4000);
    expect(spans.map((s) => [s.startMs, s.endMs])).toEqual([[0, 1000], [1000, 4000]]);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/core/src/words.test.ts packages/core/src/spans.test.ts`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement `words.ts`**

```ts
import type { Word } from "./schema/timeline";

export type CharacterAlignment = {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
};

/** Groups ElevenLabs per-character timings into whitespace-delimited words (works for Hebrew and English). */
export function alignmentToWords(alignment: CharacterAlignment): Word[] {
  const words: Word[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (text) words.push({ text, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
    text = "";
  };
  alignment.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      flush();
      return;
    }
    if (!text) start = alignment.characterStartTimesSeconds[i];
    text += ch;
    end = alignment.characterEndTimesSeconds[i];
  });
  flush();
  return words;
}
```

- [ ] **Step 4: Implement `spans.ts`**

```ts
import type { Word } from "./schema/timeline";

export type SceneSpan = { sceneIndex: number; startMs: number; endMs: number };
export const MIN_SPAN_MS = 500;

const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Assigns each scene a [startMs, endMs) span of the voice track.
 * Exact when the timed word count matches the scripts; otherwise boundaries are scaled
 * proportionally. Spans are contiguous, start at 0, end at audioDurationMs, and are at
 * least MIN_SPAN_MS long whenever the audio is long enough to allow it.
 */
export function sceneSpans(sceneScripts: string[], words: Word[], audioDurationMs: number): SceneSpan[] {
  const counts = sceneScripts.map(countWords);
  const expected = counts.reduce((a, b) => a + b, 0) || 1;
  const cumulative: number[] = [];
  counts.reduce((acc, c) => {
    cumulative.push(acc);
    return acc + c;
  }, 0);

  const starts = cumulative.map((wordIndex, i) => {
    if (i === 0) return 0;
    if (words.length === 0) return Math.round((wordIndex / expected) * audioDurationMs);
    const idx = words.length === expected ? wordIndex : Math.round((wordIndex * words.length) / expected);
    return words[Math.min(idx, words.length - 1)].startMs;
  });

  const n = starts.length;
  const canEnforce = audioDurationMs >= n * MIN_SPAN_MS;
  if (canEnforce) {
    for (let i = 1; i < n; i++) starts[i] = Math.max(starts[i], starts[i - 1] + MIN_SPAN_MS);
    for (let i = n - 1; i >= 1; i--) {
      const latest = (i === n - 1 ? audioDurationMs : starts[i + 1]) - MIN_SPAN_MS;
      starts[i] = Math.min(starts[i], latest);
    }
  }

  return starts.map((startMs, i) => ({
    sceneIndex: i,
    startMs,
    endMs: i === n - 1 ? audioDurationMs : starts[i + 1],
  }));
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from "./words";
export * from "./spans";
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run packages/core/src/words.test.ts packages/core/src/spans.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): word grouping from TTS alignment and scene span mapping"
```

---

### Task 4: Hashing, cost estimate, errors

**Files:**
- Create: `packages/core/src/hash.ts`, `packages/core/src/cost.ts`, `packages/core/src/errors.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/hash.test.ts`, `packages/core/src/cost.test.ts`

**Interfaces:**
- Consumes: `type Storyboard` (Task 2)
- Produces:
  - `canonicalJson(value: unknown): string`, `inputHash(parts: Record<string, unknown>): string` (64-char hex sha256)
  - `type CostTable = Record<string, { perImage?: number; perSecond?: number; per1kChars?: number }>`
  - `DEFAULT_COST_TABLE`
  - `type CostEstimate = { totalUsd: number; lines: { item: string; model: string; quantity: number; unit: string; usd: number }[] }`
  - `estimateCost(sb: Storyboard, models: { image: string; video: string; voice: string }, table?: CostTable): CostEstimate`
  - `estimateSceneSeconds(script: string, language: "he" | "en"): number`
  - `videoBillSeconds(sceneSec: number): number` (the integer clip length requested from i2v, 4–30)
  - `assertWithinCap(estimate: CostEstimate, capUsd: number): void` (throws `SpendCapError`)
  - Errors: `PermanentProviderError(message, provider, requestId?)`, `SpendCapError(estimateUsd, capUsd)`, `SceneFailuresError(failures: { sceneId: string; reason: string }[])`, `UnsupportedFormatError(format)`, `UnknownCostModelError(model)`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/hash.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { canonicalJson, inputHash } from "./hash";

describe("inputHash", () => {
  it("is independent of key order and ignores undefined", () => {
    expect(inputHash({ a: 1, b: { c: 2, d: undefined } })).toBe(inputHash({ b: { c: 2 }, a: 1 }));
  });
  it("changes when any value changes", () => {
    expect(inputHash({ prompt: "cat" })).not.toBe(inputHash({ prompt: "cats" }));
  });
  it("produces 64 hex chars", () => {
    expect(inputHash({ x: [1, "a"] })).toMatch(/^[0-9a-f]{64}$/);
  });
  it("canonicalJson sorts nested keys and keeps array order", () => {
    expect(canonicalJson({ z: [3, 1], a: { y: 1, b: 2 } })).toBe('{"a":{"b":2,"y":1},"z":[3,1]}');
  });
});
```

`packages/core/src/cost.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { assertWithinCap, estimateCost, estimateSceneSeconds, videoBillSeconds } from "./cost";
import { SpendCapError, UnknownCostModelError } from "./errors";
import { parseStoryboard } from "./schema/storyboard";
import { validStoryboard } from "./testing/fixtures";

const MODELS = {
  image: "higgsfield-ai/soul/v2/standard",
  video: "bytedance/seedance-2.5/image-to-video",
  voice: "elevenlabs/eleven_v4",
};

describe("cost", () => {
  it("videoBillSeconds clamps to the 4–30 s integer range Seedance accepts", () => {
    expect(videoBillSeconds(1.2)).toBe(4);
    expect(videoBillSeconds(6.1)).toBe(7);
    expect(videoBillSeconds(45)).toBe(30);
  });

  it("estimateSceneSeconds is at least 2 s and grows with words", () => {
    expect(estimateSceneSeconds("hi", "en")).toBe(2);
    expect(estimateSceneSeconds(Array(26).fill("w").join(" "), "en")).toBeCloseTo(10, 0);
  });

  it("charges image scenes one image, broll one image plus video seconds, graphic nothing, voice per char", () => {
    const input = validStoryboard();
    input.scenes[1].visual = { kind: "broll_video", prompt: "city", motion: "none" } as never;
    const est = estimateCost(parseStoryboard(input), MODELS, {
      [MODELS.image]: { perImage: 0.1 },
      [MODELS.video]: { perSecond: 0.05 },
      [MODELS.voice]: { per1kChars: 1 },
    });
    const items = est.lines.map((l) => l.item);
    expect(items).toEqual(["image s1", "image s2", "video s2", "voice"]);
    expect(est.lines[2].quantity).toBe(4);
    expect(est.totalUsd).toBeCloseTo(0.1 + 0.1 + 0.2 + (est.lines[3].quantity / 1000) * 1, 5);
  });

  it("throws UnknownCostModelError when a model has no price", () => {
    expect(() => estimateCost(parseStoryboard(validStoryboard()), { ...MODELS, image: "nope" }, {})).toThrow(
      UnknownCostModelError,
    );
  });

  it("assertWithinCap throws SpendCapError over the cap", () => {
    expect(() => assertWithinCap({ totalUsd: 11, lines: [] }, 10)).toThrow(SpendCapError);
    expect(() => assertWithinCap({ totalUsd: 9, lines: [] }, 10)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/core/src/hash.test.ts packages/core/src/cost.test.ts`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement `errors.ts`**

```ts
export class PermanentProviderError extends Error {
  constructor(message: string, readonly provider: string, readonly requestId?: string) {
    super(message);
    this.name = "PermanentProviderError";
  }
}

export class SpendCapError extends Error {
  constructor(readonly estimateUsd: number, readonly capUsd: number) {
    super(`Estimated cost $${estimateUsd.toFixed(2)} exceeds the per-reel cap of $${capUsd.toFixed(2)}`);
    this.name = "SpendCapError";
  }
}

export class SceneFailuresError extends Error {
  constructor(readonly failures: { sceneId: string; reason: string }[]) {
    super(`${failures.length} scene(s) failed:\n${failures.map((f) => `  - ${f.sceneId}: ${f.reason}`).join("\n")}`);
    this.name = "SceneFailuresError";
  }
}

export class UnsupportedFormatError extends Error {
  constructor(readonly format: string) {
    super(`Format "${format}" is not supported yet (Phase 1 supports "faceless")`);
    this.name = "UnsupportedFormatError";
  }
}

export class UnknownCostModelError extends Error {
  constructor(readonly model: string) {
    super(`No cost entry for model "${model}". Add it to the cost table before generating.`);
    this.name = "UnknownCostModelError";
  }
}
```

- [ ] **Step 4: Implement `hash.ts`**

```ts
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function inputHash(parts: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}
```

- [ ] **Step 5: Implement `cost.ts`**

```ts
import { SpendCapError, UnknownCostModelError } from "./errors";
import type { Language, Storyboard } from "./schema/storyboard";

export type CostTable = Record<string, { perImage?: number; perSecond?: number; per1kChars?: number }>;

/**
 * Estimated USD prices. These are planning numbers, not invoices: check them against your
 * Higgsfield and ElevenLabs plans and edit here (Plan 1b moves this table into settings).
 */
export const DEFAULT_COST_TABLE: CostTable = {
  "higgsfield-ai/soul/v2/standard": { perImage: 0.04 },
  "bytedance/seedance-2.5/image-to-video": { perSecond: 0.08 },
  "elevenlabs/eleven_v4": { per1kChars: 0.3 },
};

const WORDS_PER_SECOND: Record<Language, number> = { he: 2.3, en: 2.6 };

export function estimateSceneSeconds(script: string, language: Language): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, words / WORDS_PER_SECOND[language]);
}

export function videoBillSeconds(sceneSec: number): number {
  return Math.min(30, Math.max(4, Math.ceil(sceneSec)));
}

export type CostLine = { item: string; model: string; quantity: number; unit: string; usd: number };
export type CostEstimate = { totalUsd: number; lines: CostLine[] };

function price(table: CostTable, model: string, key: "perImage" | "perSecond" | "per1kChars"): number {
  const value = table[model]?.[key];
  if (value === undefined) throw new UnknownCostModelError(model);
  return value;
}

export function estimateCost(
  sb: Storyboard,
  models: { image: string; video: string; voice: string },
  table: CostTable = DEFAULT_COST_TABLE,
): CostEstimate {
  const lines: CostLine[] = [];
  for (const scene of sb.scenes) {
    const kind = scene.visual.kind;
    if (kind === "image" || kind === "broll_video") {
      const model = scene.visual.model && kind === "image" ? scene.visual.model : models.image;
      lines.push({ item: `image ${scene.id}`, model, quantity: 1, unit: "image", usd: price(table, model, "perImage") });
    }
    if (kind === "broll_video") {
      const model = scene.visual.model ?? models.video;
      const seconds = videoBillSeconds(estimateSceneSeconds(scene.script, sb.language));
      lines.push({ item: `video ${scene.id}`, model, quantity: seconds, unit: "s", usd: seconds * price(table, model, "perSecond") });
    }
  }
  if (sb.voice) {
    const chars = sb.scenes.map((s) => s.script).join(" ").length;
    lines.push({ item: "voice", model: models.voice, quantity: chars, unit: "chars", usd: (chars / 1000) * price(table, models.voice, "per1kChars") });
  }
  return { totalUsd: lines.reduce((sum, l) => sum + l.usd, 0), lines };
}

export function assertWithinCap(estimate: CostEstimate, capUsd: number): void {
  if (estimate.totalUsd > capUsd) throw new SpendCapError(estimate.totalUsd, capUsd);
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from "./hash";
export * from "./cost";
export * from "./errors";
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `npx vitest run packages/core`
Expected: PASS (all core tests: 23).

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): content hashing, cost estimate with spend cap, error types"
```

---

### Task 5: Assemble the Timeline

**Files:**
- Create: `packages/core/src/assemble.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/assemble.test.ts`

**Interfaces:**
- Consumes: `Storyboard`, `SceneSpan`, `Word`, `TimelineSchema`
- Produces:
  - `type SceneVisual = { kind: "video" | "image"; src: string }`
  - `type AssembleInput = { storyboard: Storyboard; spans: SceneSpan[]; words: Word[]; visuals: Record<string, SceneVisual>; voiceUrl?: string; musicUrl?: string; tailMs?: number }`
  - `assemble(input: AssembleInput): Timeline` (validated with `TimelineSchema.parse`)
  - `FPS = 30`, `DEFAULT_TAIL_MS = 400`, `MUSIC_DUCKING_DB = -18`

- [ ] **Step 1: Write the failing test**

`packages/core/src/assemble.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { assemble } from "./assemble";
import { parseStoryboard } from "./schema/storyboard";
import { validStoryboard } from "./testing/fixtures";

const sb = () => {
  const input = validStoryboard();
  input.scenes.push({
    id: "s3",
    script: "Third",
    visual: { kind: "broll_video", prompt: "city", motion: "pan_left" },
    overlays: [
      { text: "A", position: "top", animation: "fade" },
      { text: "B", position: "bottom", animation: "type" },
    ],
    transitionOut: "cut",
  } as never);
  input.scenes[1].transitionOut = "whip";
  return parseStoryboard(input);
};

const spans = [
  { sceneIndex: 0, startMs: 0, endMs: 1000 },
  { sceneIndex: 1, startMs: 1000, endMs: 2500 },
  { sceneIndex: 2, startMs: 2500, endMs: 4000 },
];
const visuals = {
  s1: { kind: "image" as const, src: "http://x/s1.png" },
  s3: { kind: "video" as const, src: "http://x/s3.mp4" },
};

describe("assemble", () => {
  it("lays clips contiguously on audio spans and adds the tail to the last clip", () => {
    const t = assemble({ storyboard: sb(), spans, words: [], visuals, voiceUrl: "http://x/v.wav" });
    expect(t.durationInFrames).toBe(132); // (4000 + 400) ms × 30 fps
    expect(t.clips.map((c) => [c.fromFrame, c.durationInFrames])).toEqual([[0, 30], [30, 45], [75, 57]]);
    expect(t.clips.reduce((n, c) => n + c.durationInFrames, 0)).toBe(t.durationInFrames);
  });

  it("maps kinds, sources and carries the previous transitionOut as transitionIn", () => {
    const t = assemble({ storyboard: sb(), spans, words: [], visuals });
    expect(t.clips.map((c) => [c.kind, c.src, c.transitionIn])).toEqual([
      ["image", "http://x/s1.png", "cut"],
      ["graphic", undefined, "fade"],
      ["video", "http://x/s3.mp4", "whip"],
    ]);
  });

  it("sets rtl for Hebrew and copies style", () => {
    const t = assemble({ storyboard: sb(), spans, words: [], visuals });
    expect(t.direction).toBe("rtl");
    expect(t.style).toEqual({ captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D", "#111111"] });
  });

  it("splits a scene's overlays evenly across the scene", () => {
    const t = assemble({ storyboard: sb(), spans, words: [], visuals });
    const s3 = t.overlays.filter((o) => o.fromFrame >= 75);
    expect(s3.map((o) => [o.text, o.fromFrame, o.durationInFrames])).toEqual([["A", 75, 28], ["B", 103, 29]]);
  });

  it("throws when a non-graphic scene has no visual", () => {
    expect(() => assemble({ storyboard: sb(), spans, words: [], visuals: { s1: visuals.s1 } })).toThrow(
      /missing visual for scene "s3"/,
    );
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run packages/core/src/assemble.test.ts`
Expected: FAIL with "Failed to resolve import "./assemble"".

- [ ] **Step 3: Implement `assemble.ts`**

```ts
import type { Storyboard } from "./schema/storyboard";
import { TimelineSchema, type Timeline, type TimelineClip, type TimelineOverlay, type Word } from "./schema/timeline";
import type { SceneSpan } from "./spans";

export const FPS = 30;
export const DEFAULT_TAIL_MS = 400;
export const MUSIC_DUCKING_DB = -18;

export type SceneVisual = { kind: "video" | "image"; src: string };
export type AssembleInput = {
  storyboard: Storyboard;
  spans: SceneSpan[];
  words: Word[];
  visuals: Record<string, SceneVisual>;
  voiceUrl?: string;
  musicUrl?: string;
  tailMs?: number;
};

const msToFrame = (ms: number) => Math.round((ms * FPS) / 1000);

export function assemble(input: AssembleInput): Timeline {
  const { storyboard: sb, spans } = input;
  if (spans.length !== sb.scenes.length) {
    throw new Error(`expected ${sb.scenes.length} spans, got ${spans.length}`);
  }
  const totalMs = spans[spans.length - 1].endMs + (input.tailMs ?? DEFAULT_TAIL_MS);
  const durationInFrames = Math.ceil((totalMs * FPS) / 1000);
  const starts = spans.map((s, i) => (i === 0 ? 0 : msToFrame(s.startMs)));

  const clips: TimelineClip[] = [];
  const overlays: TimelineOverlay[] = [];
  sb.scenes.forEach((scene, i) => {
    const fromFrame = starts[i];
    const clipFrames = (i === sb.scenes.length - 1 ? durationInFrames : starts[i + 1]) - fromFrame;
    const transitionIn = i === 0 ? "cut" : sb.scenes[i - 1].transitionOut;
    if (scene.visual.kind === "graphic") {
      clips.push({ sceneId: scene.id, kind: "graphic", fromFrame, durationInFrames: clipFrames, motion: scene.visual.motion, transitionIn });
    } else {
      const visual = input.visuals[scene.id];
      if (!visual) throw new Error(`missing visual for scene "${scene.id}"`);
      clips.push({ sceneId: scene.id, kind: visual.kind, src: visual.src, fromFrame, durationInFrames: clipFrames, motion: scene.visual.motion, transitionIn });
    }
    const n = scene.overlays.length;
    scene.overlays.forEach((overlay, j) => {
      const oFrom = fromFrame + Math.floor((clipFrames * j) / n);
      const oEnd = fromFrame + Math.floor((clipFrames * (j + 1)) / n);
      overlays.push({ ...overlay, fromFrame: oFrom, durationInFrames: Math.max(1, oEnd - oFrom) });
    });
  });

  return TimelineSchema.parse({
    fps: FPS,
    width: 1080,
    height: 1920,
    durationInFrames,
    language: sb.language,
    direction: sb.language === "he" ? "rtl" : "ltr",
    style: { captionPreset: sb.style.captionPreset, font: sb.style.font, palette: sb.style.palette },
    audio: { voiceUrl: input.voiceUrl, musicUrl: input.musicUrl, musicDuckingDb: MUSIC_DUCKING_DB },
    clips,
    captions: { words: input.words },
    overlays,
  });
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from "./assemble";
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run packages/core && npm run typecheck`
Expected: PASS (28 core tests); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): assemble storyboard + audio spans + assets into a Timeline"
```

---

### Task 6: FFmpeg runner, probe and test fixtures

**Files:**
- Create: `packages/media/src/run.ts`, `packages/media/src/probe.ts`, `packages/media/src/testing.ts`, `packages/media/src/index.ts`
- Test: `packages/media/src/run.test.ts`, `packages/media/src/probe.test.ts`

**Interfaces:**
- Consumes: system `ffmpeg`/`ffprobe`
- Produces (from `@reel/media`):
  - `class FfmpegError extends Error { args: string[]; stderrTail: string }`
  - `runFfmpeg(args: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>` (prepends `-hide_banner -nostdin -y`)
  - `runFfprobe(args: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>`
  - `assertFfmpegAvailable(): Promise<string>` (returns the version line)
  - `type ProbeResult = { durationSec: number; video?: { width: number; height: number; fps: number; codec: string; pixFmt: string; sar: string }; audio?: { codec: string; sampleRate: number; channels: number } }`
  - `probe(file: string): Promise<ProbeResult>`
  - `makeTestVideo(out, { durationSec?, width?, height?, fps?, withAudio? })`, `makeTestTone(out, { durationSec?, volumeDb?, trailingSilenceSec? })`, `makeTestImage(out, { width?, height?, color? })`

- [ ] **Step 1: Write the failing tests**

`packages/media/src/run.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { assertFfmpegAvailable, FfmpegError, runFfmpeg } from "./run";

const originalPath = process.env.FFMPEG_PATH;
afterEach(() => {
  if (originalPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = originalPath;
});

describe("runFfmpeg", () => {
  it("reports ffmpeg version", async () => {
    expect(await assertFfmpegAvailable()).toMatch(/^ffmpeg version/);
  });

  it("throws FfmpegError with the stderr tail on failure", async () => {
    const err = await runFfmpeg(["-i", "/definitely/missing.mp4", "-f", "null", "-"]).catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect(err.message).toMatch(/No such file or directory/);
    expect(err.args).toContain("/definitely/missing.mp4");
  });

  it("kills the process on timeout", async () => {
    const err = await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=duration=120", "-f", "null", "-"], { timeoutMs: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect(err.message).toMatch(/timed out after 300 ms/);
  });

  it("reports a missing binary clearly", async () => {
    process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
    await expect(runFfmpeg(["-version"])).rejects.toThrow(/failed to start/);
  });
});
```

`packages/media/src/probe.test.ts`:
```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probe } from "./probe";
import { makeTestTone, makeTestVideo } from "./testing";

describe("probe", () => {
  it("reads video dimensions, fps, duration and absence of audio", async () => {
    const dir = await mkdtemp(join(tmpdir(), "media-"));
    const file = join(dir, "v.mp4");
    await makeTestVideo(file, { durationSec: 2, width: 640, height: 360, fps: 30 });
    const info = await probe(file);
    expect(info.video).toMatchObject({ width: 640, height: 360, codec: "h264", pixFmt: "yuv420p" });
    expect(info.video!.fps).toBeCloseTo(30, 3);
    expect(info.durationSec).toBeCloseTo(2, 1);
    expect(info.audio).toBeUndefined();
  });

  it("reads audio sample rate and channels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "media-"));
    const file = join(dir, "t.wav");
    await makeTestTone(file, { durationSec: 1 });
    const info = await probe(file);
    expect(info.audio).toEqual({ codec: "pcm_s16le", sampleRate: 48000, channels: 1 });
    expect(info.video).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/media`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement `run.ts`**

```ts
import { spawn } from "node:child_process";

export class FfmpegError extends Error {
  constructor(message: string, readonly args: string[], readonly stderrTail: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_CHARS = 64 * 1024;
const ffmpegBin = () => process.env.FFMPEG_PATH || "ffmpeg";
const ffprobeBin = () => process.env.FFPROBE_PATH || "ffprobe";

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`${bin} failed to start: ${err.message}`, args, ""));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = stderr.trimEnd().split("\n").slice(-20).join("\n");
      if (timedOut) reject(new FfmpegError(`${bin} timed out after ${timeoutMs} ms`, args, tail));
      else if (code !== 0) reject(new FfmpegError(`${bin} exited with code ${code}:\n${tail}`, args, tail));
      else resolve({ stdout, stderr });
    });
  });
}

export function runFfmpeg(args: string[], opts: { timeoutMs?: number } = {}) {
  return run(ffmpegBin(), ["-hide_banner", "-nostdin", "-y", ...args], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export function runFfprobe(args: string[], opts: { timeoutMs?: number } = {}) {
  return run(ffprobeBin(), ["-v", "error", ...args], opts.timeoutMs ?? 60_000);
}

export async function assertFfmpegAvailable(): Promise<string> {
  const { stdout } = await run(ffmpegBin(), ["-version"], 10_000);
  return stdout.split("\n")[0];
}
```

- [ ] **Step 4: Implement `probe.ts`**

```ts
import { runFfprobe } from "./run";

export type ProbeResult = {
  durationSec: number;
  video?: { width: number; height: number; fps: number; codec: string; pixFmt: string; sar: string };
  audio?: { codec: string; sampleRate: number; channels: number };
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  sample_rate?: string;
  channels?: number;
};

const parseRate = (rate = "0/1") => {
  const [num, den] = rate.split("/").map(Number);
  return den ? num / den : num;
};

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await runFfprobe(["-show_format", "-show_streams", "-of", "json", file]);
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: FfprobeStream[] };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  return {
    durationSec: Number(data.format?.duration ?? 0),
    video: v && {
      width: v.width ?? 0,
      height: v.height ?? 0,
      fps: parseRate(v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate),
      codec: v.codec_name ?? "",
      pixFmt: v.pix_fmt ?? "",
      sar: v.sample_aspect_ratio ?? "1:1",
    },
    audio: a && { codec: a.codec_name ?? "", sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0 },
  };
}
```

- [ ] **Step 5: Implement `testing.ts` and `index.ts`**

`packages/media/src/testing.ts`:
```ts
import { runFfmpeg } from "./run";

/** Synthetic fixtures generated with lavfi, so no binary media is committed. */
export async function makeTestVideo(
  out: string,
  { durationSec = 2, width = 1080, height = 1920, fps = 30, withAudio = false } = {},
): Promise<void> {
  await runFfmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=${fps}:duration=${durationSec}`,
    ...(withAudio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    ...(withAudio ? ["-c:a", "aac", "-shortest"] : []),
    out,
  ]);
}

export async function makeTestTone(
  out: string,
  { durationSec = 2, volumeDb = -20, trailingSilenceSec = 0 } = {},
): Promise<void> {
  await runFfmpeg([
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    "-af", `volume=${volumeDb}dB,apad=pad_dur=${trailingSilenceSec}`,
    "-c:a", "pcm_s16le", out,
  ]);
}

export async function makeTestImage(out: string, { width = 1080, height = 1920, color = "blue" } = {}): Promise<void> {
  await runFfmpeg(["-f", "lavfi", "-i", `color=c=${color}:size=${width}x${height}`, "-frames:v", "1", out]);
}
```

`packages/media/src/index.ts`:
```ts
export * from "./run";
export * from "./probe";
export * from "./testing";
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `npx vitest run packages/media`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/media
git commit -m "feat(media): ffmpeg runner with timeouts, ffprobe wrapper, lavfi fixtures"
```

---

### Task 7: Conform, fit duration, audio extract/slice/trim

**Files:**
- Create: `packages/media/src/ops.ts`
- Modify: `packages/media/src/index.ts`
- Test: `packages/media/src/ops.test.ts`

**Interfaces:**
- Consumes: `runFfmpeg`, `probe`, fixtures (Task 6)
- Produces:
  - `conformVideo(input: string, output: string, opts?: { keepAudio?: boolean }): Promise<void>`: 1080×1920 cover-crop, 30 fps CFR, SAR 1, yuv420p, H.264
  - `fitDuration(input: string, output: string, targetSec: number): Promise<void>`: cuts, or slows down by up to `MAX_SLOWDOWN` then freezes the last frame
  - `MAX_SLOWDOWN = 1.15`
  - `extractAudio(input, output)`: mono 16 kHz PCM WAV
  - `sliceAudio(input, output, startMs, endMs)`: PCM WAV
  - `trimTrailingSilence(input, output)`: PCM WAV; keeps 0.15 s of the trailing silence

- [ ] **Step 1: Write the failing tests**

`packages/media/src/ops.test.ts`:
```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { conformVideo, extractAudio, fitDuration, sliceAudio, trimTrailingSilence } from "./ops";
import { probe } from "./probe";
import { makeTestTone, makeTestVideo } from "./testing";

const FRAME = 1 / 30;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ops-"));
});

describe("conformVideo", () => {
  it("turns a 16:9 24 fps clip into 1080×1920 30 fps yuv420p with SAR 1:1", async () => {
    const src = join(dir, "wide.mp4");
    await makeTestVideo(src, { durationSec: 2, width: 1280, height: 720, fps: 24 });
    const out = join(dir, "conformed.mp4");
    await conformVideo(src, out);
    const info = await probe(out);
    expect(info.video).toMatchObject({ width: 1080, height: 1920, pixFmt: "yuv420p", codec: "h264", sar: "1:1" });
    expect(info.video!.fps).toBeCloseTo(30, 3);
    expect(info.durationSec).toBeCloseTo(2, 1);
    expect(info.audio).toBeUndefined();
  });
});

describe("fitDuration", () => {
  const make = async (name: string, sec: number) => {
    const file = join(dir, name);
    await makeTestVideo(file, { durationSec: sec, width: 540, height: 960 });
    return file;
  };

  it("cuts a longer clip to the target", async () => {
    const out = join(dir, "cut.mp4");
    await fitDuration(await make("five.mp4", 5), out, 3);
    expect(Math.abs((await probe(out)).durationSec - 3)).toBeLessThanOrEqual(FRAME + 0.005);
  });

  it("slows a slightly short clip to the target", async () => {
    const out = join(dir, "slow.mp4");
    await fitDuration(await make("two.mp4", 2), out, 2.2);
    expect(Math.abs((await probe(out)).durationSec - 2.2)).toBeLessThanOrEqual(FRAME + 0.005);
  });

  it("slows by at most 15% then freezes the last frame (4 s clip in a 9 s scene)", async () => {
    const out = join(dir, "pad.mp4");
    await fitDuration(await make("four.mp4", 4), out, 9);
    expect(Math.abs((await probe(out)).durationSec - 9)).toBeLessThanOrEqual(FRAME + 0.005);
  });

  it("cuts the 4 s minimum clip down to a 2 s scene", async () => {
    const out = join(dir, "short-scene.mp4");
    await fitDuration(await make("four-b.mp4", 4), out, 2);
    expect(Math.abs((await probe(out)).durationSec - 2)).toBeLessThanOrEqual(FRAME + 0.005);
  });
});

describe("audio ops", () => {
  it("extracts mono 16 kHz WAV from a video with audio", async () => {
    const src = join(dir, "av.mp4");
    await makeTestVideo(src, { durationSec: 2, width: 320, height: 240, withAudio: true });
    const out = join(dir, "extracted.wav");
    await extractAudio(src, out);
    const info = await probe(out);
    expect(info.audio).toEqual({ codec: "pcm_s16le", sampleRate: 16000, channels: 1 });
    expect(info.video).toBeUndefined();
  });

  it("slices an exact window", async () => {
    const src = join(dir, "tone3.wav");
    await makeTestTone(src, { durationSec: 3 });
    const out = join(dir, "slice.wav");
    await sliceAudio(src, out, 500, 1700);
    expect((await probe(out)).durationSec).toBeCloseTo(1.2, 2);
  });

  it("trims trailing silence but keeps leading timing", async () => {
    const src = join(dir, "tone-silence.wav");
    await makeTestTone(src, { durationSec: 2, trailingSilenceSec: 3 });
    const out = join(dir, "trimmed.wav");
    await trimTrailingSilence(src, out);
    const d = (await probe(out)).durationSec;
    expect(d).toBeGreaterThan(2.05);
    expect(d).toBeLessThan(2.3);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/media/src/ops.test.ts`
Expected: FAIL with "Failed to resolve import "./ops"".

- [ ] **Step 3: Implement `ops.ts`**

```ts
import { probe } from "./probe";
import { runFfmpeg } from "./run";

export const MAX_SLOWDOWN = 1.15;
const H264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p"];

export async function conformVideo(input: string, output: string, opts: { keepAudio?: boolean } = {}): Promise<void> {
  const vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,format=yuv420p";
  await runFfmpeg([
    "-i", input, "-vf", vf, ...H264,
    ...(opts.keepAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : ["-an"]),
    "-movflags", "+faststart", output,
  ]);
}

export async function fitDuration(input: string, output: string, targetSec: number): Promise<void> {
  if (!(targetSec > 0)) throw new RangeError(`targetSec must be > 0, got ${targetSec}`);
  const { durationSec } = await probe(input);
  const filters: string[] = [];
  if (durationSec < targetSec) {
    const factor = Math.min(MAX_SLOWDOWN, targetSec / durationSec);
    filters.push(`setpts=${factor.toFixed(4)}*PTS`);
    const slowed = durationSec * factor;
    if (slowed < targetSec) filters.push(`tpad=stop_mode=clone:stop_duration=${(targetSec - slowed + 0.2).toFixed(3)}`);
  }
  filters.push("fps=30", "format=yuv420p");
  await runFfmpeg(["-i", input, "-vf", filters.join(","), "-t", targetSec.toFixed(3), "-an", ...H264, "-movflags", "+faststart", output]);
}

export async function extractAudio(input: string, output: string): Promise<void> {
  await runFfmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output]);
}

export async function sliceAudio(input: string, output: string, startMs: number, endMs: number): Promise<void> {
  if (endMs <= startMs) throw new RangeError(`endMs (${endMs}) must be greater than startMs (${startMs})`);
  const af = `atrim=start=${(startMs / 1000).toFixed(3)}:end=${(endMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`;
  await runFfmpeg(["-i", input, "-vn", "-af", af, "-c:a", "pcm_s16le", output]);
}

/** Removes silence at the END only; leading audio is untouched so word timestamps stay valid. */
export async function trimTrailingSilence(input: string, output: string): Promise<void> {
  const af = "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.15,areverse";
  await runFfmpeg(["-i", input, "-vn", "-af", af, "-c:a", "pcm_s16le", output]);
}
```

Add to `packages/media/src/index.ts`:
```ts
export * from "./ops";
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run packages/media/src/ops.test.ts`
Expected: PASS (8 tests). If a `fitDuration` duration assertion misses by exactly one frame, check `ffprobe -show_format` on the output. The `-t` + `fps=30` pair must yield exactly `round(target × 30)` frames; do not loosen the tolerance.

- [ ] **Step 5: Commit**

```bash
git add packages/media
git commit -m "feat(media): conform to 1080x1920@30, fit clip duration, audio extract/slice/trim"
```

---

### Task 8: Loudness, social export, thumbnail

**Files:**
- Create: `packages/media/src/loudness.ts`, `packages/media/src/export.ts`
- Modify: `packages/media/src/index.ts`
- Test: `packages/media/src/loudness.test.ts`, `packages/media/src/export.test.ts`

**Interfaces:**
- Consumes: `runFfmpeg`, `probe`, fixtures
- Produces:
  - `type LoudnessTarget = { i: number; tp: number; lra: number }`, `SOCIAL_LOUDNESS` (−14/−1/11), `VOICE_LOUDNESS` (−16/−1.5/11)
  - `type LoudnessMeasurement = { inputI; inputTp; inputLra; inputThresh; targetOffset }` (numbers; `inputI` is `-Infinity` for silence)
  - `measureLoudness(input, target?)`, `isSilent(m)`, `loudnormFilter(m, target)`, `normalizeLoudness(input, output, target = VOICE_LOUDNESS)` (48 kHz PCM WAV out)
  - `EXPORT_PRESETS: { social_1080p; preview_540p }`, `type ExportPresetName`
  - `exportDeliverable(master, output, preset: ExportPresetName = "social_1080p")`
  - `thumbnail(master, output, atSec = 1)`

- [ ] **Step 1: Write the failing tests**

`packages/media/src/loudness.test.ts`:
```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSilent, measureLoudness, normalizeLoudness, VOICE_LOUDNESS } from "./loudness";
import { probe } from "./probe";
import { makeTestTone } from "./testing";

describe("loudness", () => {
  it("normalizes a quiet tone to the voice target within 1 LU", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loud-"));
    const src = join(dir, "quiet.wav");
    await makeTestTone(src, { durationSec: 5, volumeDb: -30 });
    const out = join(dir, "norm.wav");
    await normalizeLoudness(src, out, VOICE_LOUDNESS);
    const m = await measureLoudness(out, VOICE_LOUDNESS);
    expect(Math.abs(m.inputI - VOICE_LOUDNESS.i)).toBeLessThanOrEqual(1);
    expect((await probe(out)).audio).toMatchObject({ sampleRate: 48000, codec: "pcm_s16le" });
  });

  it("handles digital silence without producing NaN filters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loud-"));
    const src = join(dir, "silent.wav");
    await makeTestTone(src, { durationSec: 2, volumeDb: -200 });
    expect(isSilent(await measureLoudness(src))).toBe(true);
    await expect(normalizeLoudness(src, join(dir, "silent-out.wav"))).resolves.toBeUndefined();
  });
});
```

`packages/media/src/export.test.ts`:
```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { exportDeliverable, thumbnail } from "./export";
import { measureLoudness, SOCIAL_LOUDNESS } from "./loudness";
import { probe } from "./probe";
import { makeTestVideo } from "./testing";

let dir: string;
let master: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "export-"));
  master = join(dir, "master.mp4");
  await makeTestVideo(master, { durationSec: 4, withAudio: true });
});

describe("exportDeliverable", () => {
  it("social_1080p meets the delivery spec", async () => {
    const out = join(dir, "reel.mp4");
    await exportDeliverable(master, out, "social_1080p");
    const info = await probe(out);
    expect(info.video).toMatchObject({ width: 1080, height: 1920, codec: "h264", pixFmt: "yuv420p" });
    expect(info.video!.fps).toBeCloseTo(30, 3);
    expect(info.audio).toMatchObject({ codec: "aac", sampleRate: 48000 });
    const m = await measureLoudness(out, SOCIAL_LOUDNESS);
    expect(Math.abs(m.inputI - SOCIAL_LOUDNESS.i)).toBeLessThanOrEqual(1.5);
  });

  it("preview_540p is 540×960", async () => {
    const out = join(dir, "preview.mp4");
    await exportDeliverable(master, out, "preview_540p");
    expect((await probe(out)).video).toMatchObject({ width: 540, height: 960 });
  });

  it("exports a master without audio", async () => {
    const silentMaster = join(dir, "no-audio.mp4");
    await makeTestVideo(silentMaster, { durationSec: 1 });
    const out = join(dir, "no-audio-out.mp4");
    await exportDeliverable(silentMaster, out);
    expect((await probe(out)).audio).toBeUndefined();
  });
});

describe("thumbnail", () => {
  it("writes a 540-wide JPEG", async () => {
    const out = join(dir, "thumb.jpg");
    await thumbnail(master, out, 1);
    expect((await probe(out)).video).toMatchObject({ width: 540, height: 960 });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/media/src/loudness.test.ts packages/media/src/export.test.ts`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement `loudness.ts`**

```ts
import { runFfmpeg } from "./run";

export type LoudnessTarget = { i: number; tp: number; lra: number };
export const SOCIAL_LOUDNESS: LoudnessTarget = { i: -14, tp: -1, lra: 11 };
export const VOICE_LOUDNESS: LoudnessTarget = { i: -16, tp: -1.5, lra: 11 };

export type LoudnessMeasurement = {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
};

const num = (v: string | undefined) => (v === "-inf" ? -Infinity : v === "inf" ? Infinity : Number(v));

/** First pass of two-pass loudnorm: measures the input (printed as JSON on stderr). */
export async function measureLoudness(input: string, target: LoudnessTarget = SOCIAL_LOUDNESS): Promise<LoudnessMeasurement> {
  const { stderr } = await runFfmpeg([
    "-i", input, "-vn",
    "-af", `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}:print_format=json`,
    "-f", "null", "-",
  ]);
  const json = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
  const raw = JSON.parse(json) as Record<string, string>;
  return {
    inputI: num(raw.input_i),
    inputTp: num(raw.input_tp),
    inputLra: num(raw.input_lra),
    inputThresh: num(raw.input_thresh),
    targetOffset: num(raw.target_offset),
  };
}

export const isSilent = (m: LoudnessMeasurement) => !Number.isFinite(m.inputI) || !Number.isFinite(m.inputThresh);

/** Second pass: a linear loudnorm filter using the first-pass measurement. */
export function loudnormFilter(m: LoudnessMeasurement, target: LoudnessTarget): string {
  return (
    `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}` +
    `:measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}` +
    `:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true`
  );
}

export async function normalizeLoudness(input: string, output: string, target: LoudnessTarget = VOICE_LOUDNESS): Promise<void> {
  const m = await measureLoudness(input, target);
  const af = isSilent(m) ? "aresample=48000" : `${loudnormFilter(m, target)},aresample=48000`;
  await runFfmpeg(["-i", input, "-vn", "-af", af, "-ar", "48000", "-c:a", "pcm_s16le", output]);
}
```

- [ ] **Step 4: Implement `export.ts`**

```ts
import { isSilent, loudnormFilter, measureLoudness, SOCIAL_LOUDNESS } from "./loudness";
import { probe } from "./probe";
import { runFfmpeg } from "./run";

export type ExportPreset = {
  width: number;
  height: number;
  crf: number;
  preset: string;
  maxrate?: string;
  bufsize?: string;
  audioBitrate: string;
};

export const EXPORT_PRESETS = {
  /** One file that works for Instagram Reels, TikTok and YouTube Shorts. */
  social_1080p: { width: 1080, height: 1920, crf: 18, preset: "slow", maxrate: "12M", bufsize: "24M", audioBitrate: "192k" },
  preview_540p: { width: 540, height: 960, crf: 26, preset: "veryfast", audioBitrate: "96k" },
} satisfies Record<string, ExportPreset>;
export type ExportPresetName = keyof typeof EXPORT_PRESETS;

export async function exportDeliverable(master: string, output: string, presetName: ExportPresetName = "social_1080p"): Promise<void> {
  const p: ExportPreset = EXPORT_PRESETS[presetName];
  const info = await probe(master);
  const video = [
    "-vf", `scale=${p.width}:${p.height},fps=30,format=yuv420p`,
    "-c:v", "libx264", "-profile:v", "high", "-preset", p.preset, "-crf", String(p.crf),
    ...(p.maxrate && p.bufsize ? ["-maxrate", p.maxrate, "-bufsize", p.bufsize] : []),
  ];
  let audio = ["-an"];
  if (info.audio) {
    const m = await measureLoudness(master, SOCIAL_LOUDNESS);
    const af = isSilent(m) ? "aresample=48000" : `${loudnormFilter(m, SOCIAL_LOUDNESS)},aresample=48000`;
    audio = ["-af", af, "-c:a", "aac", "-b:a", p.audioBitrate, "-ar", "48000"];
  }
  await runFfmpeg(["-i", master, ...video, ...audio, "-movflags", "+faststart", output]);
}

export async function thumbnail(master: string, output: string, atSec = 1): Promise<void> {
  await runFfmpeg(["-ss", atSec.toFixed(3), "-i", master, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", output]);
}
```

Add to `packages/media/src/index.ts`:
```ts
export * from "./loudness";
export * from "./export";
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run packages/media && npm run typecheck`
Expected: PASS (all media tests); typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/media
git commit -m "feat(media): two-pass loudness normalization, social/preview export presets, thumbnails"
```

---

### Task 9: Remotion Reel composition and renderer

**Files:**
- Create: `packages/video/src/{index.ts,Root.tsx,Reel.tsx,Clip.tsx,Captions.tsx,Overlays.tsx,fonts.ts,motion.ts,sample-timeline.ts,render.ts}`
- Test: `packages/video/src/motion.test.ts`, `packages/video/src/render.test.ts`

**Interfaces:**
- Consumes: `import type { Timeline, TimelineClip, TimelineOverlay, Word } from "@reel/core"`. **Type-only imports**: nothing from `@reel/core` may be imported at runtime into the Remotion bundle.
- Produces:
  - `@reel/video/render`: `renderReel(timeline: Timeline, outputLocation: string, onProgress?: (p: number) => void): Promise<void>` (H.264 CRF 12 master with AAC), `renderReelStill(timeline: Timeline, output: string, frame: number): Promise<void>`
  - `@reel/video/sample`: `sampleTimeline(lang: "he" | "en"): Timeline`
  - The composition id `"Reel"`, props `{ timeline: Timeline }`

- [ ] **Step 1: Write the failing motion test**

`packages/video/src/motion.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { enterStyle, motionTransform, popScale, TRANSITION_FRAMES, typedLength } from "./motion";

describe("motionTransform", () => {
  it("zooms in from 1 to 1.15 across the clip", () => {
    expect(motionTransform("zoom_in", 0, 90)).toBe("scale(1.0000)");
    expect(motionTransform("zoom_in", 89, 90)).toBe("scale(1.1500)");
  });
  it("pans left from +4% to -4%", () => {
    expect(motionTransform("pan_left", 0, 60)).toBe("scale(1.12) translateX(4.000%)");
    expect(motionTransform("pan_left", 59, 60)).toBe("scale(1.12) translateX(-4.000%)");
  });
  it("returns none for no motion", () => {
    expect(motionTransform("none", 10, 60)).toBe("none");
  });
});

describe("enterStyle", () => {
  it("fades from 0 to 1 over TRANSITION_FRAMES", () => {
    expect(enterStyle("fade", 0)).toEqual({ opacity: 0 });
    expect(enterStyle("fade", TRANSITION_FRAMES)).toEqual({ opacity: 1 });
  });
  it("whips in from the right", () => {
    expect(enterStyle("whip", 0)).toEqual({ transform: "translateX(100.00%)" });
    expect(enterStyle("whip", TRANSITION_FRAMES)).toEqual({ transform: "translateX(0.00%)" });
  });
  it("does nothing on cut", () => {
    expect(enterStyle("cut", 0)).toEqual({});
  });
});

describe("overlay helpers", () => {
  it("popScale goes from 0.6 to 1", () => {
    expect(popScale(0)).toBeCloseTo(0.6);
    expect(popScale(8)).toBeCloseTo(1);
  });
  it("typedLength reveals by code point, including Hebrew", () => {
    expect(typedLength("שלום", 0)).toBe(1);
    expect(typedLength("שלום", 100)).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run packages/video/src/motion.test.ts`
Expected: FAIL with "Failed to resolve import "./motion"".

- [ ] **Step 3: Implement `motion.ts`**

```ts
import type { TimelineClip } from "@reel/core";

export type Motion = TimelineClip["motion"];
export type Transition = TimelineClip["transitionIn"];
export const TRANSITION_FRAMES = 8;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

/** Ken Burns-style camera move across the whole clip. */
export function motionTransform(motion: Motion, frame: number, durationInFrames: number): string {
  const p = clamp01(frame / Math.max(1, durationInFrames - 1));
  switch (motion) {
    case "zoom_in":
      return `scale(${(1 + 0.15 * p).toFixed(4)})`;
    case "zoom_out":
      return `scale(${(1.15 - 0.15 * p).toFixed(4)})`;
    case "pan_left":
      return `scale(1.12) translateX(${(4 - 8 * p).toFixed(3)}%)`;
    case "pan_right":
      return `scale(1.12) translateX(${(-4 + 8 * p).toFixed(3)}%)`;
    default:
      return "none";
  }
}

/** How a clip enters on top of the previous one during its first TRANSITION_FRAMES. */
export function enterStyle(transition: Transition, frame: number): { opacity?: number; transform?: string } {
  if (transition === "cut") return {};
  const e = easeOutCubic(clamp01(frame / TRANSITION_FRAMES));
  switch (transition) {
    case "fade":
      return { opacity: e };
    case "whip":
      return { transform: `translateX(${((1 - e) * 100).toFixed(2)}%)` };
    case "zoom":
      return { opacity: e, transform: `scale(${(1.3 - 0.3 * e).toFixed(4)})` };
  }
}

export function popScale(frame: number, frames = 8): number {
  return 0.6 + 0.4 * easeOutCubic(clamp01(frame / frames));
}

export function typedLength(text: string, frame: number, framesPerChar = 2): number {
  return Math.min([...text].length, Math.floor(frame / framesPerChar) + 1);
}
```

- [ ] **Step 4: Run the motion test to confirm it passes**

Run: `npx vitest run packages/video/src/motion.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Implement fonts, sample timeline and components**

`packages/video/src/fonts.ts`:
```ts
import { loadFont } from "@remotion/google-fonts/Heebo";

// Heebo covers Hebrew and Latin. Timeline.style.font is reserved for more fonts later; all text uses Heebo for now.
export const { fontFamily: HEEBO } = loadFont("normal", { weights: ["800"], subsets: ["hebrew", "latin"] });
```

`packages/video/src/sample-timeline.ts`:
```ts
import type { Timeline, Word } from "@reel/core";

const timedWords = (script: string, stepMs = 380): Word[] =>
  script.split(" ").map((text, i) => ({ text, startMs: i * stepMs, endMs: i * stepMs + stepMs - 40 }));

/** A media-free timeline (graphic clips only) for Remotion Studio and render tests. */
export function sampleTimeline(lang: "he" | "en"): Timeline {
  const script =
    lang === "he"
      ? "3 טיפים ל-TikTok! ככה תגדילו את החשיפה שלכם כבר השבוע"
      : "3 tips for TikTok! Here is how to grow your reach this week";
  const words = timedWords(script);
  const durationInFrames = Math.ceil(((words[words.length - 1].endMs + 400) * 30) / 1000);
  const half = Math.floor(durationInFrames / 2);
  return {
    fps: 30,
    width: 1080,
    height: 1920,
    durationInFrames,
    language: lang,
    direction: lang === "he" ? "rtl" : "ltr",
    style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D", "#1B1B3A"] },
    audio: { musicDuckingDb: -18 },
    clips: [
      { sceneId: "s1", kind: "graphic", fromFrame: 0, durationInFrames: half, motion: "zoom_in", transitionIn: "cut" },
      { sceneId: "s2", kind: "graphic", fromFrame: half, durationInFrames: durationInFrames - half, motion: "none", transitionIn: "whip" },
    ],
    captions: { words },
    overlays: [
      { text: lang === "he" ? "טיפ 1" : "Tip 1", fromFrame: 0, durationInFrames: half, position: "top", animation: "pop" },
    ],
  };
}
```

`packages/video/src/Clip.tsx`:
```tsx
import type { TimelineClip } from "@reel/core";
import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame } from "remotion";
import { enterStyle, motionTransform } from "./motion";

const FILL: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };

export const Clip: React.FC<{ clip: TimelineClip; palette: string[] }> = ({ clip, palette }) => {
  const frame = useCurrentFrame();
  let media: React.ReactNode;
  if (clip.kind === "video" && clip.src) {
    media = <OffthreadVideo src={clip.src} muted style={FILL} />;
  } else if (clip.kind === "image" && clip.src) {
    media = <Img src={clip.src} style={FILL} />;
  } else {
    media = <AbsoluteFill style={{ background: `linear-gradient(160deg, ${palette[0]} 0%, ${palette[1] ?? "#111111"} 100%)` }} />;
  }
  return (
    <AbsoluteFill style={enterStyle(clip.transitionIn, frame)}>
      <AbsoluteFill style={{ transform: motionTransform(clip.motion, frame, clip.durationInFrames) }}>{media}</AbsoluteFill>
    </AbsoluteFill>
  );
};
```

`packages/video/src/Captions.tsx`:
```tsx
import type { Timeline, Word } from "@reel/core";
import { createTikTokStyleCaptions, type Caption, type TikTokPage } from "@remotion/captions";
import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { HEEBO } from "./fonts";

export const COMBINE_MS = 900;

/** @remotion/captions uses the leading space as the word delimiter, so every token starts with one. */
export function wordsToCaptions(words: Word[]): Caption[] {
  return words.map((w) => ({ text: ` ${w.text}`, startMs: w.startMs, endMs: w.endMs, timestampMs: w.startMs, confidence: null }));
}

function tokenStyle(preset: Timeline["style"]["captionPreset"], active: boolean, accent: string): React.CSSProperties {
  if (preset === "clean") {
    return {
      color: "#FFFFFF",
      textShadow: "0 4px 18px rgba(0,0,0,0.6)",
      background: active ? "rgba(0,0,0,0.55)" : "transparent",
      borderRadius: 12,
      padding: "0 0.12em",
    };
  }
  return {
    color: active ? accent : "#FFFFFF",
    WebkitTextStroke: "12px #000000",
    paintOrder: "stroke fill",
    transform: active ? "scale(1.12)" : "none",
  };
}

const CaptionPage: React.FC<{ page: TikTokPage; timeline: Timeline }> = ({ page, timeline }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = page.startMs + (frame / fps) * 1000;
  return (
    <div
      dir={timeline.direction}
      style={{
        position: "absolute",
        top: "60%",
        left: 70,
        right: 70,
        textAlign: "center",
        direction: timeline.direction,
        fontFamily: HEEBO,
        fontWeight: 800,
        fontSize: 78,
        lineHeight: 1.2,
      }}
    >
      {page.tokens.map((token, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            unicodeBidi: "isolate",
            margin: "0 0.12em",
            ...tokenStyle(timeline.style.captionPreset, nowMs >= token.fromMs && nowMs < token.toMs, timeline.style.palette[0]),
          }}
        >
          {token.text.trim()}
        </span>
      ))}
    </div>
  );
};

export const Captions: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const { fps } = useVideoConfig();
  const pages = useMemo(
    () =>
      createTikTokStyleCaptions({
        captions: wordsToCaptions(timeline.captions.words),
        combineTokensWithinMilliseconds: COMBINE_MS,
      }).pages,
    [timeline.captions.words],
  );
  return (
    <AbsoluteFill>
      {pages.map((page, i) => {
        const from = Math.round((page.startMs / 1000) * fps);
        const endMs = pages[i + 1]?.startMs ?? page.startMs + page.durationMs;
        const durationInFrames = Math.max(1, Math.round((endMs / 1000) * fps) - from);
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames} layout="none">
            <CaptionPage page={page} timeline={timeline} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
```

`packages/video/src/Overlays.tsx`:
```tsx
import type { Timeline, TimelineOverlay } from "@reel/core";
import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { HEEBO } from "./fonts";
import { popScale, typedLength } from "./motion";

const TOP: Record<TimelineOverlay["position"], string> = { top: "9%", center: "40%", bottom: "80%" };

const OverlayText: React.FC<{ overlay: TimelineOverlay; timeline: Timeline }> = ({ overlay, timeline }) => {
  const frame = useCurrentFrame();
  const text = overlay.animation === "type" ? [...overlay.text].slice(0, typedLength(overlay.text, frame)).join("") : overlay.text;
  const opacity = overlay.animation === "fade" ? Math.min(1, frame / 8) : 1;
  const scale = overlay.animation === "pop" ? popScale(frame) : 1;
  return (
    <div dir={timeline.direction} style={{ position: "absolute", top: TOP[overlay.position], left: 0, right: 0, display: "flex", justifyContent: "center", opacity }}>
      <span
        style={{
          fontFamily: HEEBO,
          fontWeight: 800,
          fontSize: 64,
          color: "#FFFFFF",
          background: timeline.style.palette[1] ?? "#111111",
          padding: "12px 28px",
          borderRadius: 18,
          transform: `scale(${scale})`,
          direction: timeline.direction,
          unicodeBidi: "isolate",
        }}
      >
        {text}
      </span>
    </div>
  );
};

export const Overlays: React.FC<{ timeline: Timeline }> = ({ timeline }) => (
  <AbsoluteFill>
    {timeline.overlays.map((overlay, i) => (
      <Sequence key={i} from={overlay.fromFrame} durationInFrames={overlay.durationInFrames} layout="none">
        <OverlayText overlay={overlay} timeline={timeline} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
```

`packages/video/src/Reel.tsx`:
```tsx
import type { Timeline } from "@reel/core";
import React from "react";
import { AbsoluteFill, Audio, Sequence } from "remotion";
import { Captions } from "./Captions";
import { Clip } from "./Clip";
import { TRANSITION_FRAMES } from "./motion";
import { Overlays } from "./Overlays";

export type ReelProps = { timeline: Timeline };

export const Reel: React.FC<ReelProps> = ({ timeline }) => {
  const { clips, audio } = timeline;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {clips.map((clip, i) => {
        // Keep the outgoing clip visible while the next one animates in on top, so cuts stay on the audio beat.
        const next = clips[i + 1];
        const overlap = next && next.transitionIn !== "cut" ? TRANSITION_FRAMES : 0;
        return (
          <Sequence key={clip.sceneId} from={clip.fromFrame} durationInFrames={clip.durationInFrames + overlap}>
            <Clip clip={clip} palette={timeline.style.palette} />
          </Sequence>
        );
      })}
      <Overlays timeline={timeline} />
      <Captions timeline={timeline} />
      {audio.voiceUrl ? <Audio src={audio.voiceUrl} /> : null}
      {audio.musicUrl ? <Audio src={audio.musicUrl} loop volume={Math.pow(10, audio.musicDuckingDb / 20)} /> : null}
    </AbsoluteFill>
  );
};
```

`packages/video/src/Root.tsx`:
```tsx
import React from "react";
import { Composition } from "remotion";
import { Reel, type ReelProps } from "./Reel";
import { sampleTimeline } from "./sample-timeline";

const defaults: ReelProps = { timeline: sampleTimeline("he") };

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Reel"
    component={Reel}
    durationInFrames={defaults.timeline.durationInFrames}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={defaults}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.timeline.durationInFrames,
      fps: props.timeline.fps,
      width: props.timeline.width,
      height: props.timeline.height,
    })}
  />
);
```

`packages/video/src/index.ts`:
```ts
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
```

- [ ] **Step 6: Write the render test**

`packages/video/src/render.test.ts`:
```ts
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderReelStill } from "./render";
import { sampleTimeline } from "./sample-timeline";

// Written to work/stills so a human can open them (see Step 8).
const OUT = resolve("work/stills");

describe("renderReelStill", () => {
  it.each(["he", "en"] as const)("renders a %s frame with captions and an overlay", async (lang) => {
    await mkdir(OUT, { recursive: true });
    const file = join(OUT, `sample-${lang}.png`);
    await renderReelStill(sampleTimeline(lang), file, 20);
    expect((await stat(file)).size).toBeGreaterThan(20_000);
  }, 300_000);
});
```

- [ ] **Step 7: Implement `render.ts` and run the render test**

`packages/video/src/render.ts`:
```ts
import type { Timeline } from "@reel/core";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
let serveUrlPromise: Promise<string> | undefined;

/** Bundles the Remotion project once per process. */
export function getServeUrl(): Promise<string> {
  serveUrlPromise ??= bundle({ entryPoint: ENTRY });
  return serveUrlPromise;
}

async function prepare(timeline: Timeline) {
  const serveUrl = await getServeUrl();
  const inputProps = { timeline };
  const composition = await selectComposition({ serveUrl, id: "Reel", inputProps });
  return { serveUrl, inputProps, composition };
}

export async function renderReel(timeline: Timeline, outputLocation: string, onProgress?: (progress: number) => void): Promise<void> {
  const { serveUrl, inputProps, composition } = await prepare(timeline);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    crf: 12,
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    outputLocation,
    inputProps,
    onProgress: ({ progress }) => onProgress?.(progress),
  });
}

export async function renderReelStill(timeline: Timeline, output: string, frame: number): Promise<void> {
  const { serveUrl, inputProps, composition } = await prepare(timeline);
  await renderStill({ composition, serveUrl, output, frame, inputProps });
}
```

Run: `npx vitest run packages/video && npm run typecheck`
Expected: PASS (motion 8 + render 2). The first run downloads Chrome Headless Shell (Remotion does this automatically) and takes a few minutes.

- [ ] **Step 8: Visual check (manual, required)**

Open `work/stills/sample-he.png` and `work/stills/sample-en.png`. At frame 20 the first caption page is showing. Confirm:
- **Hebrew:**
  - the caption reads right to left: `3` is the **rightmost** token, then `טיפים`, then `ל-TikTok!` on the left
  - the `!` stays attached to `ל-TikTok!`
  - the active word is yellow with a black stroke
- **English:** the same page reads left to right.
- **Overlay:** "טיפ 1" / "Tip 1" appears near the top on a dark pill.

Then run `npm run studio` and scrub the Hebrew sample to confirm the whip transition at mid-point and the zoom on the first half. If the Hebrew order is wrong, fix `Captions.tsx` before continuing. Do not adjust the test.

- [ ] **Step 9: Commit**

```bash
git add packages/video
git commit -m "feat(video): Remotion Reel composition with RTL captions, overlays, motion and transitions"
```

---

### Task 10: Engine foundations: config, retry, asset store, download, local server

**Files:**
- Create: `packages/engine/src/config.ts`, `packages/engine/src/retry.ts`, `packages/engine/src/asset-store.ts`, `packages/engine/src/download.ts`, `packages/engine/src/serve.ts`
- Test: `packages/engine/src/config.test.ts`, `packages/engine/src/retry.test.ts`, `packages/engine/src/asset-store.test.ts`, `packages/engine/src/serve.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `REPO_ROOT: string`, `loadEnvFile(): void` (loads `<repo>/.env.local`)
  - `type EngineConfig` (shape below), `loadConfig(env?: NodeJS.ProcessEnv, overrides?: { providers?: "real" | "fake" }): EngineConfig`
  - `requireRealCredentials(config): void` (throws, listing every missing variable), `costModels(config): { image: string; video: string; voice: string }`
  - `withRetry<T>(fn, opts: RetryOptions): Promise<T>`, `class Semaphore { constructor(max: number); run<T>(fn: () => Promise<T>): Promise<T> }`
  - `type AssetMeta`, `type StoredAsset = { hash; fileName; path; meta }`, `class FileAssetStore { root; get(hash); putFile(hash, sourcePath, ext, meta) }`
  - `downloadTo(url: string, destPath: string, fetchImpl?: typeof fetch): Promise<void>`, `extFromUrl(url, fallback): string`, `contentTypeFor(fileName): string`
  - `serveDir(root): Promise<{ origin: string; urlFor(fileName: string): string; close(): Promise<void> }>`

`EngineConfig`:
```ts
{
  providers: "real" | "fake";
  cacheDir: string;              // absolute
  spendCapUsd: number;
  claudeModel: string;           // default "claude-opus-5-5"
  higgsfield: { credentials?: string; concurrency: number; imageModel: string; videoModel: string;
                videoResolution: "480p" | "720p" | "1080p"; baseUrl: string };
  elevenlabs: { apiKey?: string; modelId: string; voices: { he?: string; en?: string } };
}
```

- [ ] **Step 1: Write the failing tests**

`packages/engine/src/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { costModels, loadConfig, REPO_ROOT, requireRealCredentials } from "./config";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c.providers).toBe("real");
    expect(c.cacheDir).toBe(`${REPO_ROOT}/.reel-cache`);
    expect(c.spendCapUsd).toBe(10);
    expect(c.claudeModel).toBe("claude-opus-5-5");
    expect(c.elevenlabs.modelId).toBe("eleven_v4");
    expect(c.higgsfield).toMatchObject({ concurrency: 4, videoResolution: "720p", baseUrl: "https://api.higgsfield.ai" });
    expect(costModels(c)).toEqual({
      image: "higgsfield-ai/soul/v2/standard",
      video: "bytedance/seedance-2.5/image-to-video",
      voice: "elevenlabs/eleven_v4",
    });
  });

  it("rejects bad values with a clear message", () => {
    expect(() => loadConfig({ HF_VIDEO_RESOLUTION: "4k" })).toThrow(/HF_VIDEO_RESOLUTION/);
    expect(() => loadConfig({ REEL_SPEND_CAP_USD: "-1" })).toThrow(/REEL_SPEND_CAP_USD/);
    expect(() => loadConfig({ HF_CONCURRENCY: "0" })).toThrow(/HF_CONCURRENCY/);
  });

  it("lists every missing credential for real providers", () => {
    expect(() => requireRealCredentials(loadConfig({}))).toThrow(/HF_CREDENTIALS[\s\S]*ELEVENLABS_API_KEY/);
    expect(() => requireRealCredentials(loadConfig({ HF_CREDENTIALS: "a:b", ELEVENLABS_API_KEY: "k" }))).not.toThrow();
  });
});
```

`packages/engine/src/retry.test.ts`:
```ts
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
```

`packages/engine/src/asset-store.test.ts`:
```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { FileAssetStore } from "./asset-store";
import { contentTypeFor, downloadTo, extFromUrl } from "./download";

describe("FileAssetStore", () => {
  it("stores a file with metadata and reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "store-"));
    const src = join(dir, "src.png");
    await writeFile(src, "png-bytes");
    const store = new FileAssetStore(join(dir, "cache"));
    expect(await store.get("abc")).toBeNull();
    const put = await store.putFile("abc", src, "png", { kind: "image", provider: "higgsfield", model: "m", requestId: "r1" });
    expect(put.fileName).toBe("abc.png");
    const got = await store.get("abc");
    expect(got).toMatchObject({ hash: "abc", fileName: "abc.png", meta: { kind: "image", provider: "higgsfield", requestId: "r1" } });
    expect(got!.meta.createdAt).toMatch(/^\d{4}-/);
  });

  it("treats metadata without its file as a miss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "store-"));
    const src = join(dir, "a.wav");
    await writeFile(src, "x");
    const store = new FileAssetStore(join(dir, "cache"));
    await store.putFile("h", src, "wav", { kind: "audio", provider: "p" });
    await rm(join(dir, "cache", "h.wav"));
    expect(await store.get("h")).toBeNull();
  });
});

describe("download helpers", () => {
  it("copies file:// URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-"));
    const src = join(dir, "in.txt");
    await writeFile(src, "hello");
    const dest = join(dir, "out.txt");
    await downloadTo(pathToFileURL(src).href, dest);
    await expect(readFile(dest, "utf8")).resolves.toBe("hello");
  });

  it("throws on HTTP errors without leaking query strings", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    await expect(downloadTo("https://cdn.example/x.mp4?token=secret", "/tmp/never", fakeFetch)).rejects.toThrow(
      /HTTP 403 .*cdn\.example\/x\.mp4$/,
    );
  });

  it("derives extensions and content types", () => {
    expect(extFromUrl("https://cdn/x/image.WEBP?sig=1", "png")).toBe("webp");
    expect(extFromUrl("https://cdn/x/noext", "png")).toBe("png");
    expect(contentTypeFor("a.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("a.wav")).toBe("audio/wav");
  });
});
```

`packages/engine/src/serve.test.ts`:
```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveDir } from "./serve";

let server: Awaited<ReturnType<typeof serveDir>>;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "serve-"));
  await writeFile(join(dir, "clip.mp4"), "0123456789");
  server = await serveDir(dir);
});
afterAll(() => server.close());

describe("serveDir", () => {
  it("serves a file with its content type", async () => {
    const res = await fetch(server.urlFor("clip.mp4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("0123456789");
  });

  it("supports byte ranges", async () => {
    const res = await fetch(server.urlFor("clip.mp4"), { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("2345");
  });

  it("refuses path traversal and missing files", async () => {
    expect((await fetch(`${server.origin}/..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(server.urlFor("missing.mp4"))).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/engine`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement `config.ts`**

```ts
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type EngineConfig = {
  providers: "real" | "fake";
  cacheDir: string;
  spendCapUsd: number;
  claudeModel: string;
  higgsfield: {
    credentials?: string;
    concurrency: number;
    imageModel: string;
    videoModel: string;
    videoResolution: "480p" | "720p" | "1080p";
    baseUrl: string;
  };
  elevenlabs: { apiKey?: string; modelId: string; voices: { he?: string; en?: string } };
};

export function loadEnvFile(): void {
  loadDotenv({ path: path.join(REPO_ROOT, ".env.local"), quiet: true });
}

const RESOLUTIONS = ["480p", "720p", "1080p"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: { providers?: "real" | "fake" } = {}): EngineConfig {
  const resolution = env.HF_VIDEO_RESOLUTION ?? "720p";
  if (!(RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new Error(`HF_VIDEO_RESOLUTION must be one of ${RESOLUTIONS.join(", ")} (got "${resolution}")`);
  }
  const cap = Number(env.REEL_SPEND_CAP_USD ?? "10");
  if (!Number.isFinite(cap) || cap <= 0) throw new Error(`REEL_SPEND_CAP_USD must be a positive number (got "${env.REEL_SPEND_CAP_USD}")`);
  const concurrency = Number(env.HF_CONCURRENCY ?? "4");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`HF_CONCURRENCY must be an integer ≥ 1 (got "${env.HF_CONCURRENCY}")`);
  return {
    providers: overrides.providers ?? "real",
    cacheDir: path.resolve(REPO_ROOT, env.REEL_CACHE_DIR ?? ".reel-cache"),
    spendCapUsd: cap,
    claudeModel: env.CLAUDE_MODEL ?? "claude-opus-5-5",
    higgsfield: {
      credentials: env.HF_CREDENTIALS || undefined,
      concurrency,
      imageModel: "higgsfield-ai/soul/v2/standard",
      videoModel: "bytedance/seedance-2.5/image-to-video",
      videoResolution: resolution as EngineConfig["higgsfield"]["videoResolution"],
      baseUrl: env.HF_BASE_URL ?? "https://api.higgsfield.ai",
    },
    elevenlabs: {
      apiKey: env.ELEVENLABS_API_KEY || undefined,
      modelId: env.ELEVENLABS_MODEL_ID ?? "eleven_v4",
      voices: { he: env.ELEVENLABS_VOICE_HE || undefined, en: env.ELEVENLABS_VOICE_EN || undefined },
    },
  };
}

export function requireRealCredentials(config: EngineConfig): void {
  const missing = [
    !config.higgsfield.credentials && "HF_CREDENTIALS",
    !config.elevenlabs.apiKey && "ELEVENLABS_API_KEY",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing in .env.local: ${missing.join(", ")} (or run with --fake)`);
}

export function costModels(config: EngineConfig) {
  return {
    image: config.higgsfield.imageModel,
    video: config.higgsfield.videoModel,
    voice: `elevenlabs/${config.elevenlabs.modelId}`,
  };
}
```

- [ ] **Step 4: Implement `retry.ts`**

```ts
export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  isTransient: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, attempt: number) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 2000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !opts.isTransient(err)) throw err;
      opts.onRetry?.(err, attempt);
      await sleep(base * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }
}

/** Limits concurrent async work. A released slot is handed directly to the next waiter. */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error("Semaphore max must be ≥ 1");
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
```

- [ ] **Step 5: Implement `asset-store.ts`**

```ts
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AssetKind = "image" | "video" | "audio";
export type AssetMeta = {
  kind: AssetKind;
  provider: string;
  model?: string;
  requestId?: string;
  estUsd?: number;
  createdAt: string;
  extra?: Record<string, unknown>;
};
export type StoredAsset = { hash: string; fileName: string; path: string; meta: AssetMeta };

const isNotFound = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/** Content-addressed cache: <root>/<hash>.<ext> plus <root>/<hash>.json metadata. */
export class FileAssetStore {
  constructor(readonly root: string) {}

  async get(hash: string): Promise<StoredAsset | null> {
    try {
      const { fileName, ...meta } = JSON.parse(await readFile(path.join(this.root, `${hash}.json`), "utf8")) as AssetMeta & { fileName: string };
      const filePath = path.join(this.root, fileName);
      await access(filePath);
      return { hash, fileName, path: filePath, meta };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async putFile(hash: string, sourcePath: string, ext: string, meta: Omit<AssetMeta, "createdAt">): Promise<StoredAsset> {
    await mkdir(this.root, { recursive: true });
    const fileName = `${hash}.${ext}`;
    const filePath = path.join(this.root, fileName);
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await copyFile(sourcePath, tmp);
    await rename(tmp, filePath);
    const full: AssetMeta = { ...meta, createdAt: new Date().toISOString() };
    await writeFile(path.join(this.root, `${hash}.json`), JSON.stringify({ ...full, fileName }, null, 2));
    return { hash, fileName, path: filePath, meta: full };
  }
}
```

- [ ] **Step 6: Implement `download.ts`**

```ts
import { copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

export function contentTypeFor(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function extFromUrl(url: string, fallback: string): string {
  const match = new URL(url).pathname.match(/\.([a-z0-9]{2,4})$/i);
  return match ? match[1].toLowerCase() : fallback;
}

/** Downloads (or copies file://) to destPath. Error messages drop the query string, which may hold signed tokens. */
export async function downloadTo(url: string, destPath: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), destPath);
    return;
  }
  const res = await fetchImpl(url);
  if (!res.ok) {
    const { origin, pathname } = new URL(url);
    throw new Error(`Download failed with HTTP ${res.status} for ${origin}${pathname}`);
  }
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}
```

- [ ] **Step 7: Implement `serve.ts`**

```ts
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { contentTypeFor } from "./download";

/** Serves a flat directory over http://127.0.0.1 so Remotion's headless browser can load cached assets. */
export async function serveDir(root: string) {
  const server = http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname).replace(/^\/+/, "");
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
        res.writeHead(404).end();
        return;
      }
      const file = path.join(root, name);
      const { size } = await stat(file);
      const headers = { "Content-Type": contentTypeFor(name), "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...headers, "Content-Length": size });
        createReadStream(file).pipe(res);
      }
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    urlFor: (fileName: string) => `${origin}/${encodeURIComponent(fileName)}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
```

- [ ] **Step 8: Run the tests to confirm they pass**

Run: `npx vitest run packages/engine && npm run typecheck`
Expected: PASS (config 3, retry 4, asset-store 5, serve 3); typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): config, retry/semaphore, content-addressed asset store, downloads, local asset server"
```

---

### Task 11: Provider interfaces and the Higgsfield adapter

**Files:**
- Create: `packages/engine/src/providers/types.ts`, `packages/engine/src/providers/higgsfield.ts`
- Test: `packages/engine/src/providers/higgsfield.test.ts`

**Interfaces:**
- Consumes: `Semaphore`, `withRetry` (Task 10), `PermanentProviderError` (Task 4)
- Produces:
  - `providers/types.ts`:
    ```ts
    export type GenResult = { url: string; requestId: string };
    export interface ImageGen { readonly model: string; generate(req: { prompt: string }): Promise<GenResult> }
    export interface VideoGen { readonly model: string; imageToVideo(req: { imageUrl: string; prompt: string; durationSec: number }): Promise<GenResult> }
    export interface MediaUploader { upload(data: Buffer, contentType: string): Promise<string> }
    export type VoiceRequest = { text: string; voiceId: string; modelId: string; language: Language; stability?: number; style?: number };
    export type VoiceResult = { audio: Buffer; ext: "mp3" | "wav"; words: Word[]; requestId?: string; timingSource: "alignment" | "transcription" };
    export interface VoiceGen { synthesize(req: VoiceRequest): Promise<VoiceResult> }
    export type PlanRequest = { brief: string; language: Language; targetDurationSec: 15 | 30 | 45 | 60; pacing: "calm" | "punchy";
      captionPreset: "bold_pop" | "clean"; palette: string[]; voice: { voiceId: string; modelId: string } };
    export interface Planner { plan(req: PlanRequest): Promise<Storyboard> }
    export type Providers = { image: ImageGen; video: VideoGen; uploader: MediaUploader; voice: VoiceGen };
    ```
  - `higgsfield.ts`:
    - `type SubscribeFn = (endpoint: string, input: Record<string, unknown>) => Promise<V2Response>`
    - `sdkSubscribe(credentials: string): SubscribeFn`
    - `isTransientHiggsfieldError(err): boolean`
    - `class HiggsfieldGateway(subscribe, concurrency, opts?: { baseDelayMs?; sleep? })` with `run(endpoint, input, pick)`
    - `class HiggsfieldImageGen(gateway, model?)`, `class HiggsfieldVideoGen(gateway, model?, resolution?)`, `class HiggsfieldUploader(credentials, baseUrl?, fetchImpl?)`

- [ ] **Step 1: Write the provider types**

`packages/engine/src/providers/types.ts`:
```ts
import type { Language, Storyboard, Word } from "@reel/core";

export type GenResult = { url: string; requestId: string };

export interface ImageGen {
  readonly model: string;
  generate(req: { prompt: string }): Promise<GenResult>;
}

export interface VideoGen {
  readonly model: string;
  imageToVideo(req: { imageUrl: string; prompt: string; durationSec: number }): Promise<GenResult>;
}

export interface MediaUploader {
  /** Uploads bytes and returns a public HTTPS URL a provider can read. */
  upload(data: Buffer, contentType: string): Promise<string>;
}

export type VoiceRequest = { text: string; voiceId: string; modelId: string; language: Language; stability?: number; style?: number };
export type VoiceResult = { audio: Buffer; ext: "mp3" | "wav"; words: Word[]; requestId?: string; timingSource: "alignment" | "transcription" };

export interface VoiceGen {
  synthesize(req: VoiceRequest): Promise<VoiceResult>;
}

export type PlanRequest = {
  brief: string;
  language: Language;
  targetDurationSec: 15 | 30 | 45 | 60;
  pacing: "calm" | "punchy";
  captionPreset: "bold_pop" | "clean";
  palette: string[];
  voice: { voiceId: string; modelId: string };
};

export interface Planner {
  plan(req: PlanRequest): Promise<Storyboard>;
}

export type Providers = { image: ImageGen; video: VideoGen; uploader: MediaUploader; voice: VoiceGen };
```

- [ ] **Step 2: Write the failing Higgsfield tests**

`packages/engine/src/providers/higgsfield.test.ts`:
```ts
import { BadInputError, NotEnoughCreditsError, type V2Response } from "@higgsfield/client/v2";
import { PermanentProviderError } from "@reel/core";
import { describe, expect, it, vi } from "vitest";
import { HiggsfieldGateway, HiggsfieldImageGen, HiggsfieldUploader, HiggsfieldVideoGen, isTransientHiggsfieldError } from "./higgsfield";

const done = (extra: Partial<V2Response>): V2Response => ({
  status: "completed", request_id: "req-1", status_url: "", cancel_url: "", ...extra,
});
const noSleep = async () => {};

describe("HiggsfieldImageGen", () => {
  it("requests a single 9:16 1080p image and returns its URL", async () => {
    const subscribe = vi.fn(async () => done({ images: [{ url: "https://cdn/img.png" }] }));
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(subscribe, 4, { sleep: noSleep }));
    expect(await gen.generate({ prompt: "a cat" })).toEqual({ url: "https://cdn/img.png", requestId: "req-1" });
    expect(subscribe).toHaveBeenCalledWith("higgsfield-ai/soul/v2/standard", {
      prompt: "a cat", aspect_ratio: "9:16", resolution: "1080p", batch_size: 1,
    });
  });

  it("turns nsfw into a PermanentProviderError carrying the request id", async () => {
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(async () => done({ status: "nsfw" }), 1, { sleep: noSleep }));
    const err = await gen.generate({ prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentProviderError);
    expect(err.message).toMatch(/content moderation/);
    expect(err.requestId).toBe("req-1");
  });
});

describe("HiggsfieldVideoGen", () => {
  it("sends image-to-video with audio disabled", async () => {
    const subscribe = vi.fn(async () => done({ video: { url: "https://cdn/v.mp4" } }));
    const gen = new HiggsfieldVideoGen(new HiggsfieldGateway(subscribe, 1, { sleep: noSleep }), undefined, "720p");
    await gen.imageToVideo({ imageUrl: "https://cdn/i.png", prompt: "push in", durationSec: 5 });
    expect(subscribe).toHaveBeenCalledWith("bytedance/seedance-2.5/image-to-video", {
      image_url: "https://cdn/i.png", prompt: "push in", duration: 5, resolution: "720p", generate_audio: false,
    });
  });

  it("rejects durations outside 4–30 integer seconds before calling the API", async () => {
    const subscribe = vi.fn();
    const gen = new HiggsfieldVideoGen(new HiggsfieldGateway(subscribe, 1));
    await expect(gen.imageToVideo({ imageUrl: "u", prompt: "p", durationSec: 3 })).rejects.toThrow(RangeError);
    await expect(gen.imageToVideo({ imageUrl: "u", prompt: "p", durationSec: 5.5 })).rejects.toThrow(RangeError);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("HiggsfieldGateway retries", () => {
  it("retries the concurrency-limit 400 instead of failing the scene", async () => {
    let calls = 0;
    const subscribe = async () => {
      calls++;
      if (calls < 3) throw new BadInputError("Maximum number of concurrent requests reached");
      return done({ images: [{ url: "https://cdn/ok.png" }] });
    };
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(subscribe, 1, { sleep: noSleep }));
    expect((await gen.generate({ prompt: "x" })).url).toBe("https://cdn/ok.png");
    expect(calls).toBe(3);
  });

  it("does not retry when credits run out", async () => {
    let calls = 0;
    const subscribe = async () => {
      calls++;
      throw new NotEnoughCreditsError();
    };
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(subscribe, 1, { sleep: noSleep }));
    await expect(gen.generate({ prompt: "x" })).rejects.toBeInstanceOf(NotEnoughCreditsError);
    expect(calls).toBe(1);
  });

  it("classifies errors", () => {
    expect(isTransientHiggsfieldError(new BadInputError("Maximum number of concurrent requests"))).toBe(true);
    expect(isTransientHiggsfieldError(new BadInputError("prompt: field required"))).toBe(false);
    expect(isTransientHiggsfieldError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
  });

  it("limits concurrent requests to the account limit", async () => {
    let active = 0;
    let peak = 0;
    const subscribe = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return done({ images: [{ url: "https://cdn/x.png" }] });
    };
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(subscribe, 2, { sleep: noSleep }));
    await Promise.all(Array.from({ length: 6 }, () => gen.generate({ prompt: "p" })));
    expect(peak).toBe(2);
  });
});

describe("HiggsfieldUploader", () => {
  it("gets an upload URL, PUTs the bytes and returns the public URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/files/generate-upload-url")) {
        return Response.json({ upload_url: "https://upload/put", public_url: "https://cdn/public.png" });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const uploader = new HiggsfieldUploader("id:secret", "https://api.higgsfield.ai", fakeFetch);
    expect(await uploader.upload(Buffer.from("png"), "image/png")).toBe("https://cdn/public.png");
    expect(calls[0].url).toBe("https://api.higgsfield.ai/files/generate-upload-url");
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe("Key id:secret");
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ content_type: "image/png" });
    expect(calls[1]).toMatchObject({ url: "https://upload/put", init: { method: "PUT" } });
  });

  it("fails loudly when the PUT fails", async () => {
    const fakeFetch = (async (url: string) =>
      url.endsWith("generate-upload-url")
        ? Response.json({ upload_url: "https://upload/put", public_url: "https://cdn/p.png" })
        : new Response(null, { status: 500 })) as typeof fetch;
    await expect(new HiggsfieldUploader("a:b", undefined, fakeFetch).upload(Buffer.from("x"), "image/png")).rejects.toThrow(
      /upload PUT failed: HTTP 500/,
    );
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx vitest run packages/engine/src/providers/higgsfield.test.ts`
Expected: FAIL with "Failed to resolve import "./higgsfield"".

- [ ] **Step 4: Implement `higgsfield.ts`**

```ts
import {
  APIError,
  BadInputError,
  createHiggsfieldClient,
  NotEnoughCreditsError,
  type V2Response,
} from "@higgsfield/client/v2";
import { PermanentProviderError } from "@reel/core";
import { Semaphore, withRetry } from "../retry";
import type { GenResult, ImageGen, MediaUploader, VideoGen } from "./types";

export type SubscribeFn = (endpoint: string, input: Record<string, unknown>) => Promise<V2Response>;

export function sdkSubscribe(credentials: string): SubscribeFn {
  // Video generation can take several minutes; the SDK default poll limit is 5.
  const client = createHiggsfieldClient({ credentials, maxPollTime: 15 * 60 * 1000 });
  return (endpoint, input) => client.subscribe(endpoint, { input, withPolling: true });
}

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"]);

export function isTransientHiggsfieldError(err: unknown): boolean {
  if (err instanceof NotEnoughCreditsError) return false;
  // The per-account concurrency limit surfaces as HTTP 400 "Maximum number of concurrent requests…".
  if (err instanceof BadInputError) return /concurrent/i.test(`${err.message} ${JSON.stringify(err.responseData ?? "")}`);
  if (err instanceof APIError) return err.statusCode === 429 || (err.statusCode ?? 0) >= 500;
  return NETWORK_CODES.has((err as { code?: string } | null)?.code ?? "");
}

export class HiggsfieldGateway {
  private readonly semaphore: Semaphore;

  constructor(
    private readonly subscribe: SubscribeFn,
    concurrency: number,
    private readonly opts: { baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.semaphore = new Semaphore(concurrency);
  }

  async run(endpoint: string, input: Record<string, unknown>, pick: (r: V2Response) => string | undefined): Promise<GenResult> {
    const result = await this.semaphore.run(() =>
      withRetry(() => this.subscribe(endpoint, input), {
        attempts: 4,
        baseDelayMs: this.opts.baseDelayMs ?? 5000,
        isTransient: isTransientHiggsfieldError,
        sleep: this.opts.sleep,
      }),
    );
    // The SDK types omit "canceled", which the API can also return; compare as a plain string.
    const status: string = result.status;
    const url = pick(result);
    if (status === "completed" && url) return { url, requestId: result.request_id };
    const reason =
      status === "nsfw" ? "was blocked by content moderation"
      : status === "completed" ? "completed without an output URL"
      : `ended with status "${status}"`;
    throw new PermanentProviderError(`Higgsfield ${endpoint} ${reason}`, "higgsfield", result.request_id);
  }
}

export class HiggsfieldImageGen implements ImageGen {
  constructor(private readonly gateway: HiggsfieldGateway, readonly model = "higgsfield-ai/soul/v2/standard") {}

  generate({ prompt }: { prompt: string }): Promise<GenResult> {
    return this.gateway.run(this.model, { prompt, aspect_ratio: "9:16", resolution: "1080p", batch_size: 1 }, (r) => r.images?.[0]?.url);
  }
}

export class HiggsfieldVideoGen implements VideoGen {
  constructor(
    private readonly gateway: HiggsfieldGateway,
    readonly model = "bytedance/seedance-2.5/image-to-video",
    private readonly resolution: "480p" | "720p" | "1080p" = "720p",
  ) {}

  async imageToVideo({ imageUrl, prompt, durationSec }: { imageUrl: string; prompt: string; durationSec: number }): Promise<GenResult> {
    if (!Number.isInteger(durationSec) || durationSec < 4 || durationSec > 30) {
      throw new RangeError(`durationSec must be an integer from 4 to 30, got ${durationSec}`);
    }
    return this.gateway.run(
      this.model,
      { image_url: imageUrl, prompt, duration: durationSec, resolution: this.resolution, generate_audio: false },
      (r) => r.video?.url,
    );
  }
}

/** The v2 SDK has no upload helper; this implements the documented two-step upload. */
export class HiggsfieldUploader implements MediaUploader {
  constructor(
    private readonly credentials: string,
    private readonly baseUrl = "https://api.higgsfield.ai",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async upload(data: Buffer, contentType: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/files/generate-upload-url`, {
      method: "POST",
      headers: { Authorization: `Key ${this.credentials}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: contentType }),
    });
    if (!res.ok) throw new Error(`Higgsfield upload URL request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { upload_url: string; public_url: string; upload_headers?: Record<string, string> };
    const put = await this.fetchImpl(body.upload_url, {
      method: "PUT",
      headers: body.upload_headers ?? { "Content-Type": contentType },
      body: new Uint8Array(data),
    });
    if (!put.ok) throw new Error(`Higgsfield upload PUT failed: HTTP ${put.status}`);
    return body.public_url;
  }
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run packages/engine/src/providers/higgsfield.test.ts && npm run typecheck`
Expected: PASS (10 tests); typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/providers
git commit -m "feat(engine): provider interfaces and Higgsfield image/video/upload adapter with retries and concurrency limit"
```

---

### Task 12: ElevenLabs voice adapter

**Files:**
- Create: `packages/engine/src/providers/elevenlabs.ts`
- Test: `packages/engine/src/providers/elevenlabs.test.ts`

**Interfaces:**
- Consumes: `alignmentToWords`, `CharacterAlignment`, `Word`, `PermanentProviderError` (core); `withRetry` (Task 10); `VoiceGen`, `VoiceRequest`, `VoiceResult` (Task 11)
- Produces:
  - `type TtsBody = { text: string; modelId: string; languageCode: string; outputFormat: "mp3_44100_128"; voiceSettings?: { stability?: number; style?: number } }`
  - `type ElevenLabsApi = { tts(voiceId: string, body: TtsBody): Promise<{ audioBase64: string; alignment?: CharacterAlignment | null }>; stt(audio: Buffer, languageCode: string): Promise<Word[]> }`
  - `sdkElevenLabs(apiKey: string): ElevenLabsApi`
  - `isTransientElevenLabsError(err): boolean`
  - `class ElevenLabsVoice implements VoiceGen { constructor(api: ElevenLabsApi, opts?: { sleep? }) }`

- [ ] **Step 1: Write the failing tests**

`packages/engine/src/providers/elevenlabs.test.ts`:
```ts
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import { describe, expect, it, vi } from "vitest";
import { ElevenLabsVoice, type ElevenLabsApi } from "./elevenlabs";

const REQ = { text: "שלום עולם", voiceId: "v1", modelId: "eleven_v4", language: "he" as const };
const alignmentFor = (text: string) => {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * 0.1),
  };
};
const audioBase64 = Buffer.from("mp3-bytes").toString("base64");
const noSleep = { sleep: async () => {} };

describe("ElevenLabsVoice", () => {
  it("sends eleven_v4 with the language code and returns words from the alignment", async () => {
    const api: ElevenLabsApi = {
      tts: vi.fn(async () => ({ audioBase64, alignment: alignmentFor(REQ.text) })),
      stt: vi.fn(),
    };
    const result = await new ElevenLabsVoice(api, noSleep).synthesize(REQ);
    expect(api.tts).toHaveBeenCalledWith("v1", { text: REQ.text, modelId: "eleven_v4", languageCode: "he", outputFormat: "mp3_44100_128" });
    expect(result.timingSource).toBe("alignment");
    expect(result.words.map((w) => w.text)).toEqual(["שלום", "עולם"]);
    expect(result.audio.toString()).toBe("mp3-bytes");
    expect(api.stt).not.toHaveBeenCalled();
  });

  it("falls back to Scribe transcription when the model returns no alignment", async () => {
    const words = [{ text: "שלום", startMs: 0, endMs: 400 }, { text: "עולם", startMs: 450, endMs: 900 }];
    const api: ElevenLabsApi = { tts: async () => ({ audioBase64, alignment: null }), stt: vi.fn(async () => words) };
    const result = await new ElevenLabsVoice(api, noSleep).synthesize(REQ);
    expect(result.timingSource).toBe("transcription");
    expect(result.words).toEqual(words);
    expect(api.stt).toHaveBeenCalledWith(expect.any(Buffer), "he");
  });

  it("passes voice settings only when provided", async () => {
    const api: ElevenLabsApi = { tts: vi.fn(async () => ({ audioBase64, alignment: alignmentFor("a") })), stt: vi.fn() };
    await new ElevenLabsVoice(api, noSleep).synthesize({ ...REQ, text: "a", stability: 0.4 });
    expect(api.tts).toHaveBeenCalledWith("v1", expect.objectContaining({ voiceSettings: { stability: 0.4, style: undefined } }));
  });

  it("retries 429 and 5xx, not 4xx", async () => {
    let calls = 0;
    const flaky: ElevenLabsApi = {
      tts: async () => {
        calls++;
        if (calls === 1) throw new ElevenLabsError({ message: "rate limited", statusCode: 429 });
        return { audioBase64, alignment: alignmentFor("a") };
      },
      stt: vi.fn(),
    };
    await new ElevenLabsVoice(flaky, noSleep).synthesize({ ...REQ, text: "a" });
    expect(calls).toBe(2);

    let badCalls = 0;
    const bad: ElevenLabsApi = {
      tts: async () => {
        badCalls++;
        throw new ElevenLabsError({ message: "invalid voice", statusCode: 400 });
      },
      stt: vi.fn(),
    };
    await expect(new ElevenLabsVoice(bad, noSleep).synthesize(REQ)).rejects.toThrow(/invalid voice/);
    expect(badCalls).toBe(1);
  });

  it("rejects empty audio", async () => {
    const api: ElevenLabsApi = { tts: async () => ({ audioBase64: "", alignment: null }), stt: vi.fn() };
    await expect(new ElevenLabsVoice(api, noSleep).synthesize(REQ)).rejects.toThrow(/empty audio/);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/engine/src/providers/elevenlabs.test.ts`
Expected: FAIL with "Failed to resolve import "./elevenlabs"".

- [ ] **Step 3: Implement `elevenlabs.ts`**

```ts
import { ElevenLabsClient, ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import { alignmentToWords, PermanentProviderError, type CharacterAlignment, type Word } from "@reel/core";
import { withRetry } from "../retry";
import type { VoiceGen, VoiceRequest, VoiceResult } from "./types";

export type TtsBody = {
  text: string;
  modelId: string;
  languageCode: string;
  outputFormat: "mp3_44100_128";
  voiceSettings?: { stability?: number; style?: number };
};

export type ElevenLabsApi = {
  tts(voiceId: string, body: TtsBody): Promise<{ audioBase64: string; alignment?: CharacterAlignment | null }>;
  stt(audio: Buffer, languageCode: string): Promise<Word[]>;
};

export function sdkElevenLabs(apiKey: string): ElevenLabsApi {
  const client = new ElevenLabsClient({ apiKey });
  return {
    tts: async (voiceId, body) => await client.textToSpeech.convertWithTimestamps(voiceId, body),
    stt: async (audio, languageCode) => {
      const res = await client.speechToText.convert({
        modelId: "scribe_v2",
        file: new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }),
        languageCode,
        timestampsGranularity: "word",
      });
      if (!("words" in res)) throw new Error("Unexpected speech-to-text response (no words)");
      return res.words
        .filter((w) => w.type === "word" && w.start !== undefined && w.end !== undefined)
        .map((w) => ({ text: w.text.trim(), startMs: Math.round(w.start! * 1000), endMs: Math.round(w.end! * 1000) }))
        .filter((w) => w.text.length > 0);
    },
  };
}

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"]);

export function isTransientElevenLabsError(err: unknown): boolean {
  if (err instanceof ElevenLabsError) {
    const status = err.statusCode ?? 0;
    return status === 429 || status >= 500;
  }
  return NETWORK_CODES.has((err as { code?: string } | null)?.code ?? "");
}

export class ElevenLabsVoice implements VoiceGen {
  constructor(private readonly api: ElevenLabsApi, private readonly opts: { sleep?: (ms: number) => Promise<void> } = {}) {}

  async synthesize(req: VoiceRequest): Promise<VoiceResult> {
    const retry = { attempts: 3, baseDelayMs: 2000, isTransient: isTransientElevenLabsError, sleep: this.opts.sleep };
    const body: TtsBody = {
      text: req.text,
      modelId: req.modelId, // always explicit: the API default model has no Hebrew
      languageCode: req.language,
      outputFormat: "mp3_44100_128",
    };
    if (req.stability !== undefined || req.style !== undefined) body.voiceSettings = { stability: req.stability, style: req.style };

    const res = await withRetry(() => this.api.tts(req.voiceId, body), retry);
    const audio = Buffer.from(res.audioBase64, "base64");
    if (audio.length === 0) throw new PermanentProviderError("ElevenLabs returned empty audio", "elevenlabs");

    if (res.alignment && res.alignment.characters.length > 0) {
      return { audio, ext: "mp3", words: alignmentToWords(res.alignment), timingSource: "alignment" };
    }
    const words = await withRetry(() => this.api.stt(audio, req.language), retry);
    return { audio, ext: "mp3", words, timingSource: "transcription" };
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run packages/engine/src/providers/elevenlabs.test.ts && npm run typecheck`
Expected: PASS (5 tests). Typecheck exits 0, which confirms `TtsBody` is assignable to the SDK's `BodyTextToSpeechFullWithTimestamps` inside `sdkElevenLabs`.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/providers
git commit -m "feat(engine): ElevenLabs eleven_v4 voice with word timestamps and Scribe fallback"
```

---

### Task 13: Claude storyboard planner

**Files:**
- Create: `packages/engine/src/planner.ts`
- Test: `packages/engine/src/planner.test.ts`

**Interfaces:**
- Consumes: `StoryboardDraftSchema`, `StoryboardDraft`, `parseStoryboard`, `Storyboard` (core); `Planner`, `PlanRequest` (Task 11)
- Produces:
  - `type DraftModel = (req: { system: string; user: string }) => Promise<{ stopReason: string | null; draft: StoryboardDraft | null; raw: string }>`
  - `claudeDraftModel(client: Anthropic, model: string): DraftModel`
  - `systemPrompt(): string`, `userPrompt(req: PlanRequest): string`
  - `buildStoryboard(draft: StoryboardDraft, req: PlanRequest): Storyboard`
  - `createPlanner(model: DraftModel): Planner`
  - `class PlannerRefusedError extends Error`

- [ ] **Step 1: Write the failing tests**

`packages/engine/src/planner.test.ts`:
```ts
import type { StoryboardDraft } from "@reel/core";
import { describe, expect, it, vi } from "vitest";
import { buildStoryboard, createPlanner, PlannerRefusedError, userPrompt, type DraftModel } from "./planner";
import type { PlanRequest } from "./providers/types";

const REQ: PlanRequest = {
  brief: "3 טיפים לצמיחה בטיקטוק",
  language: "he",
  targetDurationSec: 30,
  pacing: "punchy",
  captionPreset: "bold_pop",
  palette: ["#FFE14D", "#111111"],
  voice: { voiceId: "v1", modelId: "eleven_v4" },
};

const draft = (script = "הוק חזק"): StoryboardDraft => ({
  title: "טיפים",
  scenes: [
    { script, visual: { kind: "image", prompt: "phone on desk, soft light", motion: "zoom_in" }, overlays: [], transitionOut: "whip" },
    { script: "טיפ ראשון", visual: { kind: "graphic", prompt: "  ", motion: "none" }, overlays: [{ text: "טיפ 1", position: "top", animation: "pop" }], transitionOut: "cut" },
  ],
});

const reply = (d: StoryboardDraft | null, stopReason: string = "end_turn") => ({ stopReason, draft: d, raw: JSON.stringify(d) });

describe("buildStoryboard", () => {
  it("fills ids, request settings and drops blank graphic prompts", () => {
    const sb = buildStoryboard(draft(), REQ);
    expect(sb).toMatchObject({ version: 1, language: "he", format: "faceless", aspect: "9:16", targetDurationSec: 30, voice: REQ.voice });
    expect(sb.style).toEqual({ captionPreset: "bold_pop", font: "Heebo", palette: REQ.palette, pacing: "punchy" });
    expect(sb.scenes.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(sb.scenes[1].visual.prompt).toBeUndefined();
  });
});

describe("createPlanner", () => {
  it("returns the storyboard from a valid first answer", async () => {
    const model: DraftModel = vi.fn(async () => reply(draft()));
    const sb = await createPlanner(model).plan(REQ);
    expect(sb.scenes).toHaveLength(2);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("repairs once, sending the validation errors back", async () => {
    const model = vi.fn<DraftModel>().mockResolvedValueOnce(reply(draft("   "))).mockResolvedValueOnce(reply(draft()));
    const sb = await createPlanner(model).plan(REQ);
    expect(sb.scenes[0].script).toBe("הוק חזק");
    expect(model.mock.calls[1][0].user).toMatch(/scenes\.0\.script/);
  });

  it("repairs when the output did not parse at all", async () => {
    const model = vi.fn<DraftModel>().mockResolvedValueOnce(reply(null)).mockResolvedValueOnce(reply(draft()));
    await createPlanner(model).plan(REQ);
    expect(model.mock.calls[1][0].user).toMatch(/did not match the storyboard schema/);
  });

  it("throws after two invalid answers", async () => {
    const model: DraftModel = async () => reply(draft("   "));
    await expect(createPlanner(model).plan(REQ)).rejects.toThrow(/invalid storyboard twice/);
  });

  it("throws PlannerRefusedError on refusal without retrying", async () => {
    const model = vi.fn<DraftModel>(async () => reply(null, "refusal"));
    await expect(createPlanner(model).plan(REQ)).rejects.toBeInstanceOf(PlannerRefusedError);
    expect(model).toHaveBeenCalledTimes(1);
  });
});

describe("userPrompt", () => {
  it("states language, length and a word budget", () => {
    const p = userPrompt(REQ);
    expect(p).toMatch(/Hebrew/);
    expect(p).toMatch(/30 seconds, about 69 spoken words/);
    expect(p).toMatch(/about 10 scenes/);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/engine/src/planner.test.ts`
Expected: FAIL with "Failed to resolve import "./planner"".

- [ ] **Step 3: Implement `planner.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { parseStoryboard, StoryboardDraftSchema, type Storyboard, type StoryboardDraft } from "@reel/core";
import type { PlanRequest, Planner } from "./providers/types";

export type DraftModel = (req: { system: string; user: string }) => Promise<{
  stopReason: string | null;
  draft: StoryboardDraft | null;
  raw: string;
}>;

export class PlannerRefusedError extends Error {
  constructor() {
    super("Claude declined to write this storyboard. Rephrase the brief and try again.");
    this.name = "PlannerRefusedError";
  }
}

export function claudeDraftModel(client: Anthropic, model: string): DraftModel {
  return async ({ system, user }) => {
    const res = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      // On a safety decline, the API re-runs the request on a fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: betaZodOutputFormat(StoryboardDraftSchema) },
      system,
      messages: [{ role: "user", content: user }],
    });
    const raw = res.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return { stopReason: res.stop_reason, draft: res.parsed_output ?? null, raw };
  };
}

export function systemPrompt(): string {
  return [
    "You write storyboards for short vertical social videos (Instagram Reels, TikTok, YouTube Shorts).",
    "A storyboard is a list of scenes. Each scene has the voiceover line spoken during it, one visual, optional on-screen text overlays, and the transition into the next scene.",
    "",
    "What makes a strong reel:",
    "- Scene 1 is the hook: a bold claim, question, or surprising number within the first 2 seconds. No greetings or channel intros.",
    "- One idea per scene. Voiceover lines are short, spoken, conversational sentences, not written prose.",
    "- End with a clear payoff or call to action.",
    "",
    "Visuals:",
    '- kind "image": a still the editor animates with a slow camera move; set motion to zoom_in, zoom_out, pan_left or pan_right.',
    '- kind "broll_video": a moving shot for action and atmosphere. It costs more, so use it for at most half of the scenes.',
    '- kind "graphic": a plain branded background for text-heavy moments (lists, numbers); put the key text in an overlay and leave prompt empty.',
    "- Write every visual prompt in English, even for Hebrew reels, as a concrete photographic description: subject, setting, lighting, camera angle, vertical 9:16 framing. Never ask for text, captions, logos or watermarks inside the image.",
    "",
    "Overlays: at most 2 per scene, each under 6 words, in the reel's language. Voiceover captions are added automatically, so overlays must not repeat the voiceover.",
    'Transitions: mostly "cut"; use "whip" or "zoom" for energy and "fade" for calm moments.',
  ].join("\n");
}

export function userPrompt(req: PlanRequest): string {
  const wordsPerSecond = req.language === "he" ? 2.3 : 2.6;
  const words = Math.round(req.targetDurationSec * wordsPerSecond);
  const scenes = Math.max(3, Math.round(req.targetDurationSec / (req.pacing === "punchy" ? 3 : 5)));
  return [
    `Brief: ${req.brief}`,
    `Language of the voiceover and overlays: ${req.language === "he" ? "Hebrew" : "English"}.`,
    `Target length: ${req.targetDurationSec} seconds, about ${words} spoken words in total, about ${scenes} scenes.`,
    `Pacing: ${req.pacing}.`,
    "Keep each scene's voiceover under 400 characters.",
  ].join("\n");
}

export function buildStoryboard(draft: StoryboardDraft, req: PlanRequest): Storyboard {
  return parseStoryboard({
    version: 1,
    title: draft.title,
    language: req.language,
    format: "faceless",
    aspect: "9:16",
    targetDurationSec: req.targetDurationSec,
    voice: req.voice,
    style: { captionPreset: req.captionPreset, font: "Heebo", palette: req.palette, pacing: req.pacing },
    scenes: draft.scenes.map((scene, i) => ({
      id: `s${i + 1}`,
      script: scene.script,
      visual: { kind: scene.visual.kind, prompt: scene.visual.prompt.trim() || undefined, motion: scene.visual.motion },
      overlays: scene.overlays.slice(0, 3),
      transitionOut: scene.transitionOut,
    })),
  });
}

type Attempt = { ok: true; storyboard: Storyboard } | { ok: false; error: string };

function attempt(result: Awaited<ReturnType<DraftModel>>, req: PlanRequest): Attempt {
  if (result.stopReason === "refusal") throw new PlannerRefusedError();
  if (!result.draft) return { ok: false, error: "The output did not match the storyboard schema." };
  try {
    return { ok: true, storyboard: buildStoryboard(result.draft, req) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createPlanner(model: DraftModel): Planner {
  return {
    async plan(req) {
      const system = systemPrompt();
      const user = userPrompt(req);
      const first = await model({ system, user });
      const firstAttempt = attempt(first, req);
      if (firstAttempt.ok) return firstAttempt.storyboard;

      const repairUser = [
        user,
        "",
        "Your previous storyboard was rejected:",
        firstAttempt.error,
        "",
        "Previous output:",
        first.raw,
        "",
        "Return a corrected storyboard.",
      ].join("\n");
      const second = attempt(await model({ system, user: repairUser }), req);
      if (second.ok) return second.storyboard;
      throw new Error(`Claude returned an invalid storyboard twice:\n${second.error}`);
    },
  };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run packages/engine/src/planner.test.ts && npm run typecheck`
Expected: PASS (7 tests); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/planner.ts packages/engine/src/planner.test.ts
git commit -m "feat(engine): Claude storyboard planner with structured output and one repair round"
```

---

### Task 14: Fake providers and the generate → render → export pipeline

**Files:**
- Create: `packages/engine/src/providers/fake.ts`, `packages/engine/src/pipeline.ts`
- Test: `packages/engine/src/pipeline.test.ts`

**Interfaces:**
- Consumes:
  - Everything above
  - `@reel/media`: `probe`, `trimTrailingSilence`, `normalizeLoudness`, `conformVideo`, `fitDuration`, `exportDeliverable`, `thumbnail`, fixtures
  - `@reel/video/render`: `renderReel`
- Produces:
  - `createFakeProviders(opts: { workDir: string; failPromptsContaining?: string }): Providers & { planner: Planner; calls: { image: number; video: number; upload: number; voice: number; plan: number } }`
  - `hashes`: `{ voice(req: VoiceRequest): string; image(model: string, prompt: string): string; video(model, prompt, imageHash, durationSec): string; fit(sourceHash, targetMs): string }`
  - `type PipelineDeps = { providers: Providers; store: FileAssetStore; tmpDir: string; log: (msg: string) => void }`
  - `type GeneratedAssets = { voice: StoredAsset; words: Word[]; spans: SceneSpan[]; visuals: Record<string, { kind: "video" | "image"; asset: StoredAsset }> }`
  - `generateAssets(sb: Storyboard, deps: PipelineDeps): Promise<GeneratedAssets>` (throws `UnsupportedFormatError`, or `SceneFailuresError` after caching every scene that succeeded)
  - `type RenderOutputs = { timeline: Timeline; master: string; reel: string; preview: string; thumbnail: string }`
  - `renderAndExport(sb, gen, deps, outDir, onProgress?): Promise<RenderOutputs>`

- [ ] **Step 1: Implement the fake providers**

`packages/engine/src/providers/fake.ts`:
```ts
import { PermanentProviderError } from "@reel/core";
import { makeTestImage, makeTestTone, makeTestVideo } from "@reel/media";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildStoryboard } from "../planner";
import type { Planner, PlanRequest, Providers } from "./types";

const COLORS = ["0x2E86AB", "0xE4572E", "0x76B041", "0xFFC914", "0x7D5BA6"];
const WORD_MS = 350;

const FAKE_SCRIPTS = {
  he: ["3 טיפים ל-TikTok שכדאי להכיר", "טיפ ראשון: תפתחו עם הוק חזק", "שמרו ועקבו לעוד טיפים"],
  en: ["3 TikTok tips you should know", "Tip one: open with a strong hook", "Save this and follow for more"],
};

/** Deterministic, free providers backed by lavfi fixtures, for tests and `--fake` runs. */
export function createFakeProviders(opts: { workDir: string; failPromptsContaining?: string }) {
  const calls = { image: 0, video: 0, upload: 0, voice: 0, plan: 0 };
  let n = 0;
  const nextFile = (ext: string) => join(opts.workDir, `fake-${++n}.${ext}`);

  const providers: Providers & { planner: Planner; calls: typeof calls } = {
    calls,
    image: {
      model: "higgsfield-ai/soul/v2/standard",
      async generate({ prompt }) {
        calls.image++;
        if (opts.failPromptsContaining && prompt.includes(opts.failPromptsContaining)) {
          throw new PermanentProviderError("Higgsfield (fake) was blocked by content moderation", "fake", "fake-req");
        }
        const out = nextFile("png");
        await makeTestImage(out, { color: COLORS[n % COLORS.length] });
        return { url: pathToFileURL(out).href, requestId: `fake-image-${n}` };
      },
    },
    video: {
      model: "bytedance/seedance-2.5/image-to-video",
      async imageToVideo({ durationSec }) {
        calls.video++;
        const out = nextFile("mp4");
        await makeTestVideo(out, { durationSec, width: 720, height: 1280, fps: 24 });
        return { url: pathToFileURL(out).href, requestId: `fake-video-${n}` };
      },
    },
    uploader: {
      async upload() {
        calls.upload++;
        return `https://fake.local/upload-${calls.upload}`;
      },
    },
    voice: {
      async synthesize({ text }) {
        calls.voice++;
        const tokens = text.trim().split(/\s+/);
        const words = tokens.map((t, i) => ({ text: t, startMs: i * WORD_MS, endMs: i * WORD_MS + WORD_MS - 50 }));
        const out = nextFile("wav");
        await makeTestTone(out, { durationSec: (tokens.length * WORD_MS) / 1000, volumeDb: -20 });
        return { audio: await readFile(out), ext: "wav", words, timingSource: "alignment" };
      },
    },
    planner: {
      async plan(req: PlanRequest) {
        calls.plan++;
        const [hook, tip, cta] = FAKE_SCRIPTS[req.language];
        return buildStoryboard(
          {
            title: req.brief.slice(0, 120),
            scenes: [
              { script: hook, visual: { kind: "image", prompt: "smartphone on a desk, soft morning light", motion: "zoom_in" }, overlays: [], transitionOut: "whip" },
              { script: tip, visual: { kind: "broll_video", prompt: "hands scrolling a phone, close-up", motion: "none" }, overlays: [], transitionOut: "fade" },
              { script: cta, visual: { kind: "graphic", prompt: "", motion: "none" }, overlays: [{ text: req.language === "he" ? "עקבו" : "Follow", position: "center", animation: "pop" }], transitionOut: "cut" },
            ],
          },
          req,
        );
      },
    },
  };
  return providers;
}
```

- [ ] **Step 2: Write the failing pipeline tests**

`packages/engine/src/pipeline.test.ts`:
```ts
import { parseStoryboard, SceneFailuresError, UnsupportedFormatError } from "@reel/core";
import { probe } from "@reel/media";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAssetStore } from "./asset-store";
import { generateAssets, hashes, renderAndExport, type PipelineDeps } from "./pipeline";
import { createFakeProviders } from "./providers/fake";
import type { PlanRequest } from "./providers/types";

const REQ: PlanRequest = {
  brief: "3 tips",
  language: "he",
  targetDurationSec: 15,
  pacing: "punchy",
  captionPreset: "bold_pop",
  palette: ["#FFE14D", "#111111"],
  voice: { voiceId: "fake", modelId: "eleven_v4" },
};

async function setup(failPromptsContaining?: string) {
  const dir = await mkdtemp(join(tmpdir(), "pipeline-"));
  const providers = createFakeProviders({ workDir: dir, failPromptsContaining });
  const deps: PipelineDeps = { providers, store: new FileAssetStore(join(dir, "cache")), tmpDir: dir, log: () => {} };
  return { dir, providers, deps };
}

describe("pipeline (fake providers, real ffmpeg + Remotion)", () => {
  it("generates, renders and exports a Hebrew faceless reel, then reuses every cached asset", async () => {
    const { dir, providers, deps } = await setup();
    const sb = await providers.planner.plan(REQ);
    const gen = await generateAssets(sb, deps);
    expect(Object.keys(gen.visuals).sort()).toEqual(["s1", "s2"]);
    expect(gen.spans).toHaveLength(3);

    const out = await renderAndExport(sb, gen, deps, join(dir, "out"));
    const info = await probe(out.reel);
    expect(info.video).toMatchObject({ width: 1080, height: 1920, codec: "h264", pixFmt: "yuv420p" });
    expect(info.video!.fps).toBeCloseTo(30, 3);
    expect(info.audio).toMatchObject({ codec: "aac", sampleRate: 48000 });
    expect(Math.abs(info.durationSec - out.timeline.durationInFrames / 30)).toBeLessThan(0.1);
    expect(out.timeline.direction).toBe("rtl");
    expect((await probe(out.preview)).video).toMatchObject({ width: 540, height: 960 });

    const before = { ...providers.calls };
    await generateAssets(sb, deps);
    expect(providers.calls).toEqual(before);
  }, 600_000);

  it("caches successful scenes and reports the failed one", async () => {
    const { providers, deps } = await setup("FAIL");
    const sb = await providers.planner.plan(REQ);
    sb.scenes[1].visual.prompt = "FAIL this prompt";
    const err = await generateAssets(sb, deps).catch((e) => e);
    expect(err).toBeInstanceOf(SceneFailuresError);
    expect(err.failures).toEqual([{ sceneId: "s2", reason: expect.stringMatching(/content moderation/) }]);
    expect(await deps.store.get(hashes.image(providers.image.model, sb.scenes[0].visual.prompt!))).not.toBeNull();
  }, 300_000);

  it("refuses formats other than faceless before spending anything", async () => {
    const { providers, deps } = await setup();
    const sb = await providers.planner.plan(REQ);
    const avatar = parseStoryboard({ ...sb, format: "avatar" });
    await expect(generateAssets(avatar, deps)).rejects.toBeInstanceOf(UnsupportedFormatError);
    expect(providers.calls.voice).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx vitest run packages/engine/src/pipeline.test.ts`
Expected: FAIL with "Failed to resolve import "./pipeline"".

- [ ] **Step 4: Implement `pipeline.ts`**

```ts
import {
  assemble,
  DEFAULT_COST_TABLE,
  DEFAULT_TAIL_MS,
  inputHash,
  SceneFailuresError,
  sceneSpans,
  UnsupportedFormatError,
  videoBillSeconds,
  WordSchema,
  type SceneSpan,
  type Storyboard,
  type Timeline,
  type Word,
} from "@reel/core";
import { conformVideo, exportDeliverable, fitDuration, normalizeLoudness, probe, thumbnail, trimTrailingSilence } from "@reel/media";
import { renderReel } from "@reel/video/render";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { AssetMeta, FileAssetStore, StoredAsset } from "./asset-store";
import { contentTypeFor, downloadTo, extFromUrl } from "./download";
import type { Providers, VoiceRequest } from "./providers/types";
import { serveDir } from "./serve";

export type PipelineDeps = { providers: Providers; store: FileAssetStore; tmpDir: string; log: (msg: string) => void };
export type GeneratedAssets = {
  voice: StoredAsset;
  words: Word[];
  spans: SceneSpan[];
  visuals: Record<string, { kind: "video" | "image"; asset: StoredAsset }>;
};
export type RenderOutputs = { timeline: Timeline; master: string; reel: string; preview: string; thumbnail: string };

/** Cache keys. Bump a step's `v` when its processing changes so old results are not reused. */
export const hashes = {
  voice: (req: VoiceRequest) => inputHash({ step: "voice", v: 1, ...req }),
  image: (model: string, prompt: string) => inputHash({ step: "image", v: 1, model, prompt }),
  video: (model: string, prompt: string, imageHash: string, durationSec: number) =>
    inputHash({ step: "i2v", v: 1, model, prompt, imageHash, durationSec }),
  fit: (sourceHash: string, targetMs: number) => inputHash({ step: "fit", v: 1, sourceHash, targetMs }),
};

const estUsd = (model: string, key: "perImage" | "perSecond" | "per1kChars", quantity: number) => {
  const price = DEFAULT_COST_TABLE[model]?.[key];
  return price === undefined ? undefined : price * quantity;
};

async function cached(
  store: FileAssetStore,
  hash: string,
  create: () => Promise<{ path: string; ext: string; meta: Omit<AssetMeta, "createdAt"> }>,
): Promise<StoredAsset> {
  const hit = await store.get(hash);
  if (hit) return hit;
  const made = await create();
  return store.putFile(hash, made.path, made.ext, made.meta);
}

export async function generateAssets(sb: Storyboard, deps: PipelineDeps): Promise<GeneratedAssets> {
  if (sb.format !== "faceless") throw new UnsupportedFormatError(sb.format);
  if (!sb.voice) throw new Error("A faceless storyboard needs a voice");
  const { providers: p, store, tmpDir, log } = deps;
  await mkdir(tmpDir, { recursive: true });
  const tmp = (name: string) => join(tmpDir, name);

  // 1. Voice + word timings (everything else is timed from this).
  const voiceReq: VoiceRequest = {
    text: sb.scenes.map((s) => s.script).join(" "),
    voiceId: sb.voice.voiceId,
    modelId: sb.voice.modelId,
    language: sb.language,
    stability: sb.voice.stability,
    style: sb.voice.style,
  };
  const voice = await cached(store, hashes.voice(voiceReq), async () => {
    log("voice: synthesizing");
    const res = await p.voice.synthesize(voiceReq);
    const raw = tmp(`voice-raw.${res.ext}`);
    await writeFile(raw, res.audio);
    const trimmed = tmp("voice-trimmed.wav");
    await trimTrailingSilence(raw, trimmed);
    const normalized = tmp("voice.wav");
    await normalizeLoudness(trimmed, normalized);
    return {
      path: normalized,
      ext: "wav",
      meta: {
        kind: "audio",
        provider: "elevenlabs",
        model: voiceReq.modelId,
        requestId: res.requestId,
        estUsd: estUsd(`elevenlabs/${voiceReq.modelId}`, "per1kChars", voiceReq.text.length / 1000),
        extra: { words: res.words, timingSource: res.timingSource },
      },
    };
  });
  const words = z.array(WordSchema).parse(voice.meta.extra?.words ?? []);
  const durationMs = Math.round((await probe(voice.path)).durationSec * 1000);
  const spans = sceneSpans(sb.scenes.map((s) => s.script), words, durationMs);

  // 2. Visuals, all scenes in parallel (the Higgsfield gateway enforces the account concurrency limit).
  const visuals: GeneratedAssets["visuals"] = {};
  const failures: { sceneId: string; reason: string }[] = [];
  const last = sb.scenes.length - 1;
  await Promise.all(
    sb.scenes.map(async (scene, i) => {
      const { kind, prompt } = scene.visual;
      if (kind === "graphic") return;
      try {
        if (!prompt) throw new Error("missing visual prompt");
        const sceneSec = (spans[i].endMs - spans[i].startMs + (i === last ? DEFAULT_TAIL_MS : 0)) / 1000;
        const image = await cached(store, hashes.image(p.image.model, prompt), async () => {
          log(`${scene.id}: generating image`);
          const res = await p.image.generate({ prompt });
          const ext = extFromUrl(res.url, "png");
          const file = tmp(`${scene.id}-image.${ext}`);
          await downloadTo(res.url, file);
          return { path: file, ext, meta: { kind: "image", provider: "higgsfield", model: p.image.model, requestId: res.requestId, estUsd: estUsd(p.image.model, "perImage", 1) } };
        });
        if (kind === "image") {
          visuals[scene.id] = { kind: "image", asset: image };
          return;
        }
        const billSec = videoBillSeconds(sceneSec);
        const rawVideo = await cached(store, hashes.video(p.video.model, prompt, image.hash, billSec), async () => {
          log(`${scene.id}: animating image (${billSec}s)`);
          const imageUrl = await p.uploader.upload(await readFile(image.path), contentTypeFor(image.fileName));
          const res = await p.video.imageToVideo({ imageUrl, prompt, durationSec: billSec });
          const file = tmp(`${scene.id}-raw.mp4`);
          await downloadTo(res.url, file);
          return { path: file, ext: "mp4", meta: { kind: "video", provider: "higgsfield", model: p.video.model, requestId: res.requestId, estUsd: estUsd(p.video.model, "perSecond", billSec) } };
        });
        const targetMs = Math.round(sceneSec * 1000);
        const fitted = await cached(store, hashes.fit(rawVideo.hash, targetMs), async () => {
          const conformed = tmp(`${scene.id}-conformed.mp4`);
          await conformVideo(rawVideo.path, conformed);
          const out = tmp(`${scene.id}-fitted.mp4`);
          await fitDuration(conformed, out, targetMs / 1000);
          return { path: out, ext: "mp4", meta: { kind: "video", provider: "ffmpeg" } };
        });
        visuals[scene.id] = { kind: "video", asset: fitted };
      } catch (err) {
        failures.push({ sceneId: scene.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  if (failures.length) throw new SceneFailuresError(failures.sort((a, b) => a.sceneId.localeCompare(b.sceneId)));
  return { voice, words, spans, visuals };
}

export async function renderAndExport(
  sb: Storyboard,
  gen: GeneratedAssets,
  deps: PipelineDeps,
  outDir: string,
  onProgress?: (progress: number) => void,
): Promise<RenderOutputs> {
  await mkdir(outDir, { recursive: true });
  const server = await serveDir(deps.store.root);
  try {
    const timeline = assemble({
      storyboard: sb,
      spans: gen.spans,
      words: gen.words,
      visuals: Object.fromEntries(
        Object.entries(gen.visuals).map(([id, v]) => [id, { kind: v.kind, src: server.urlFor(v.asset.fileName) }]),
      ),
      voiceUrl: server.urlFor(gen.voice.fileName),
    });
    // Asset URLs in timeline.json point at the temporary local server and are only valid during this render.
    await writeFile(join(outDir, "timeline.json"), JSON.stringify(timeline, null, 2));
    const master = join(outDir, "master.mp4");
    deps.log("render: Remotion");
    await renderReel(timeline, master, onProgress);
    const reel = join(outDir, "reel.mp4");
    deps.log("export: social_1080p");
    await exportDeliverable(master, reel, "social_1080p");
    const preview = join(outDir, "preview.mp4");
    await exportDeliverable(master, preview, "preview_540p");
    const thumb = join(outDir, "thumbnail.jpg");
    await thumbnail(master, thumb, Math.min(1, timeline.durationInFrames / 30 / 2));
    return { timeline, master, reel, preview, thumbnail: thumb };
  } finally {
    await server.close();
  }
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run packages/engine/src/pipeline.test.ts && npm run typecheck`
Expected: PASS (3 tests; the first one renders a real ~5 s reel and takes 1–3 minutes). Typecheck exits 0.

- [ ] **Step 6: Watch the rendered reel (manual)**

Add a temporary `console.log(out.reel)` to the first test (and remove it before committing), run it once, and open the printed `reel.mp4`. Confirm:
- the Hebrew captions highlight word by word in sync with the tone's word timings (every 350 ms), reading right to left
- scene 2 whips in over scene 1
- the "עקבו" overlay pops in on scene 3

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src
git commit -m "feat(engine): cached generate pipeline, Remotion render and FFmpeg export, fake providers"
```

---

### Task 15: CLI (`reel plan` / `reel make`) and live smoke scripts

**Files:**
- Create: `packages/engine/src/providers/index.ts`, `packages/engine/src/cli.ts`, `packages/engine/scripts/smoke-elevenlabs.ts`
- Rewrite: `packages/engine/scripts/smoke-higgsfield.ts` (the old root `index.ts`)
- Test: `packages/engine/src/cli.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `createProviders(config: EngineConfig, workDir: string): Providers` (real or fake)
  - `createPlannerFor(config: EngineConfig, workDir: string): Planner`
  - `main(argv: string[]): Promise<void>` in `cli.ts`, which sets `process.exitCode` and never calls `process.exit`
  - CLI contract:
    - `npm run reel -- plan --brief "<text>" --out <dir> [--lang he|en] [--length 15|30|45|60] [--pacing calm|punchy] [--captions bold_pop|clean] [--palette "#RRGGBB,#RRGGBB"] [--voice <id>] [--fake]` writes `<dir>/storyboard.json`.
    - `npm run reel -- make <dir> [--yes] [--fake]` renders to `<dir>/renders/v<version>/{reel.mp4,preview.mp4,thumbnail.jpg,master.mp4,timeline.json}`.

- [ ] **Step 1: Write the failing CLI tests**

`packages/engine/src/cli.test.ts`:
```ts
import { parseStoryboard } from "@reel/core";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli";

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("reel CLI", () => {
  it("plan --fake writes a valid storyboard.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["plan", "--brief", "3 tips", "--out", dir, "--lang", "en", "--length", "15", "--fake"]);
    const sb = parseStoryboard(JSON.parse(await readFile(join(dir, "storyboard.json"), "utf8")));
    expect(sb.language).toBe("en");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("make rejects an invalid hand-edited storyboard before spending anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["plan", "--brief", "x", "--out", dir, "--fake"]);
    const file = join(dir, "storyboard.json");
    const sb = JSON.parse(await readFile(file, "utf8"));
    sb.scenes[0].visual.kind = "avatar";
    await writeFile(file, JSON.stringify(sb));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
    await main(["make", dir, "--fake"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/scenes\.0\.visual\.kind: visual kind "avatar" is not allowed in a faceless reel/);
    await expect(access(join(dir, "renders"))).rejects.toThrow();
  });

  it("make reports malformed JSON clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    await writeFile(join(dir, "storyboard.json"), "{ not json");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
    await main(["make", dir, "--fake"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/storyboard\.json is not valid JSON/);
  });

  it("prints usage for unknown commands", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
    await main(["wat"]);
    expect(logs.join("\n")).toMatch(/Usage:/);
    expect(process.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run packages/engine/src/cli.test.ts`
Expected: FAIL with "Failed to resolve import "./cli"".

- [ ] **Step 3: Implement `providers/index.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { requireRealCredentials, type EngineConfig } from "../config";
import { claudeDraftModel, createPlanner } from "../planner";
import { ElevenLabsVoice, sdkElevenLabs } from "./elevenlabs";
import { createFakeProviders } from "./fake";
import { HiggsfieldGateway, HiggsfieldImageGen, HiggsfieldUploader, HiggsfieldVideoGen, sdkSubscribe } from "./higgsfield";
import type { Planner, Providers } from "./types";

export function createProviders(config: EngineConfig, workDir: string): Providers {
  if (config.providers === "fake") return createFakeProviders({ workDir });
  requireRealCredentials(config);
  const credentials = config.higgsfield.credentials!;
  const gateway = new HiggsfieldGateway(sdkSubscribe(credentials), config.higgsfield.concurrency);
  return {
    image: new HiggsfieldImageGen(gateway, config.higgsfield.imageModel),
    video: new HiggsfieldVideoGen(gateway, config.higgsfield.videoModel, config.higgsfield.videoResolution),
    uploader: new HiggsfieldUploader(credentials, config.higgsfield.baseUrl),
    voice: new ElevenLabsVoice(sdkElevenLabs(config.elevenlabs.apiKey!)),
  };
}

/** Planning needs only Claude, so it doesn't require Higgsfield/ElevenLabs keys. */
export function createPlannerFor(config: EngineConfig, workDir: string): Planner {
  if (config.providers === "fake") return createFakeProviders({ workDir }).planner;
  return createPlanner(claudeDraftModel(new Anthropic(), config.claudeModel));
}
```

- [ ] **Step 4: Implement `cli.ts`**

```ts
import {
  assertWithinCap,
  CaptionPresetSchema,
  estimateCost,
  LanguageSchema,
  parseStoryboard,
  SceneFailuresError,
  type CostEstimate,
  type Storyboard,
} from "@reel/core";
import { assertFfmpegAvailable } from "@reel/media";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FileAssetStore } from "./asset-store";
import { costModels, loadConfig, loadEnvFile, type EngineConfig } from "./config";
import { generateAssets, renderAndExport } from "./pipeline";
import { createPlannerFor, createProviders } from "./providers";
import type { PlanRequest } from "./providers/types";

const USAGE = `Usage:
  npm run reel -- plan --brief "<text>" --out <dir> [--lang he|en] [--length 15|30|45|60]
                       [--pacing calm|punchy] [--captions bold_pop|clean] [--palette "#FFE14D,#111111"]
                       [--voice <elevenlabs voice id>] [--fake]
  npm run reel -- make <dir> [--yes] [--fake]

plan  asks Claude for a storyboard and writes <dir>/storyboard.json. Edit it freely.
make  validates <dir>/storyboard.json, prints the cost estimate, and with --yes generates
      assets and renders <dir>/renders/v<version>/reel.mp4. --fake uses free local stand-ins.`;

class UsageError extends Error {}

const LENGTHS = [15, 30, 45, 60] as const;

function printStoryboard(sb: Storyboard, estimate: CostEstimate, config: EngineConfig): void {
  console.log(`\n${sb.title}  (${sb.language}, ${sb.targetDurationSec}s target, ${sb.scenes.length} scenes)\n`);
  for (const s of sb.scenes) {
    const visual = s.visual.kind === "graphic" ? "graphic" : `${s.visual.kind}/${s.visual.motion}`;
    console.log(`  ${s.id.padEnd(4)} [${visual}] ${s.script}`);
    if (s.visual.prompt) console.log(`       prompt: ${s.visual.prompt}`);
    for (const o of s.overlays) console.log(`       overlay (${o.position}, ${o.animation}): ${o.text}`);
  }
  console.log("\nEstimated cost:");
  for (const line of estimate.lines) console.log(`  ${line.item.padEnd(12)} ${String(line.quantity).padStart(6)} ${line.unit.padEnd(6)} $${line.usd.toFixed(2)}`);
  console.log(`  total${" ".repeat(21)}$${estimate.totalUsd.toFixed(2)}  (cap $${config.spendCapUsd.toFixed(2)})\n`);
}

async function planCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      brief: { type: "string" },
      out: { type: "string" },
      lang: { type: "string", default: "he" },
      length: { type: "string", default: "30" },
      pacing: { type: "string", default: "punchy" },
      captions: { type: "string", default: "bold_pop" },
      palette: { type: "string", default: "#FFE14D,#111111" },
      voice: { type: "string" },
      fake: { type: "boolean", default: false },
    },
  });
  if (!values.brief || !values.out) throw new UsageError("plan needs --brief and --out");
  const language = LanguageSchema.parse(values.lang);
  const length = Number(values.length);
  if (!LENGTHS.includes(length as (typeof LENGTHS)[number])) throw new UsageError(`--length must be one of ${LENGTHS.join(", ")}`);
  if (values.pacing !== "calm" && values.pacing !== "punchy") throw new UsageError("--pacing must be calm or punchy");

  loadEnvFile();
  const config = loadConfig(process.env, { providers: values.fake ? "fake" : "real" });
  const voiceId = values.voice ?? config.elevenlabs.voices[language] ?? (values.fake ? "fake-voice" : undefined);
  if (!voiceId) throw new UsageError(`Set ELEVENLABS_VOICE_${language.toUpperCase()} in .env.local or pass --voice`);

  const req: PlanRequest = {
    brief: values.brief,
    language,
    targetDurationSec: length as PlanRequest["targetDurationSec"],
    pacing: values.pacing,
    captionPreset: CaptionPresetSchema.parse(values.captions),
    palette: values.palette.split(",").map((c) => c.trim()),
    voice: { voiceId, modelId: config.elevenlabs.modelId },
  };
  const workDir = await mkdtemp(join(tmpdir(), "reel-plan-"));
  console.log("Planning with Claude…");
  const sb = await createPlannerFor(config, workDir).plan(req);
  const outDir = resolve(values.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "storyboard.json"), JSON.stringify(sb, null, 2));
  printStoryboard(sb, estimateCost(sb, costModels(config)), config);
  console.log(`Wrote ${join(outDir, "storyboard.json")}. Edit it, then run: npm run reel -- make ${values.out} --yes`);
}

async function readStoryboard(dir: string): Promise<Storyboard> {
  const file = join(dir, "storyboard.json");
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseStoryboard(json);
}

async function makeCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: "boolean", default: false }, fake: { type: "boolean", default: false } },
  });
  const dir = positionals[0];
  if (!dir) throw new UsageError("make needs the reel directory");
  const sb = await readStoryboard(resolve(dir));

  loadEnvFile();
  const config = loadConfig(process.env, { providers: values.fake ? "fake" : "real" });
  const estimate = estimateCost(sb, costModels(config));
  printStoryboard(sb, estimate, config);
  if (config.providers === "real") {
    assertWithinCap(estimate, config.spendCapUsd);
    if (!values.yes) {
      console.log("Nothing generated. Re-run with --yes to spend credits (cached scenes are free).");
      return;
    }
  }

  await assertFfmpegAvailable();
  const tmpDir = await mkdtemp(join(tmpdir(), "reel-make-"));
  const deps = {
    providers: createProviders(config, tmpDir),
    store: new FileAssetStore(config.cacheDir),
    tmpDir,
    log: (msg: string) => console.log(`  ${msg}`),
  };
  const gen = await generateAssets(sb, deps);
  const outDir = join(resolve(dir), "renders", `v${sb.version}`);
  const out = await renderAndExport(sb, gen, deps, outDir, (p) => process.stdout.write(`\r  rendering ${Math.round(p * 100)}%`));
  process.stdout.write("\n");
  console.log(`\nDone:\n  reel:      ${out.reel}\n  preview:   ${out.preview}\n  thumbnail: ${out.thumbnail}`);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  try {
    if (command === "plan") return await planCommand(rest);
    if (command === "make") return await makeCommand(rest);
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) console.error(`${err.message}\n\n${USAGE}`);
    else console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof SceneFailuresError) {
      console.error("Fix those scenes' visual.prompt in storyboard.json and run make again. Finished scenes are cached and will not be charged again.");
    }
    process.exitCode = 1;
  }
}

// pathToFileURL percent-encodes the path, matching import.meta.url even when the repo path contains spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
```

- [ ] **Step 5: Run the CLI tests to confirm they pass**

Run: `npx vitest run packages/engine/src/cli.test.ts && npm run typecheck`
Expected: PASS (4 tests); typecheck exits 0.

- [ ] **Step 6: Write the live smoke scripts**

`packages/engine/scripts/smoke-elevenlabs.ts`:
```ts
import { alignmentToWords } from "@reel/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, loadEnvFile, REPO_ROOT } from "../src/config";
import { sdkElevenLabs } from "../src/providers/elevenlabs";

// Checks that eleven_v4 returns character alignment for Hebrew and English (spends a few credits).
loadEnvFile();
const config = loadConfig();
if (!config.elevenlabs.apiKey) {
  console.error("ELEVENLABS_API_KEY is not set in .env.local");
  process.exit(1);
}
const api = sdkElevenLabs(config.elevenlabs.apiKey);
const samples = { he: "3 טיפים ל-TikTok! ככה תגדילו את החשיפה.", en: "3 tips for TikTok! Here is how to grow your reach." };
const outDir = join(REPO_ROOT, "work", "smoke");
await mkdir(outDir, { recursive: true });

let ok = true;
for (const lang of ["he", "en"] as const) {
  const voiceId = config.elevenlabs.voices[lang];
  if (!voiceId) {
    console.error(`ELEVENLABS_VOICE_${lang.toUpperCase()} is not set in .env.local`);
    ok = false;
    continue;
  }
  const res = await api.tts(voiceId, { text: samples[lang], modelId: config.elevenlabs.modelId, languageCode: lang, outputFormat: "mp3_44100_128" });
  const file = join(outDir, `voice-${lang}.mp3`);
  await writeFile(file, Buffer.from(res.audioBase64, "base64"));
  const chars = res.alignment?.characters.length ?? 0;
  console.log(`${lang}: ${config.elevenlabs.modelId} → ${file}; alignment chars ${chars} / text chars ${[...samples[lang]].length}`);
  if (!res.alignment || chars === 0) {
    console.error(`${lang}: NO ALIGNMENT. The engine will fall back to Scribe transcription for word timings.`);
    ok = false;
  } else {
    console.log("   " + alignmentToWords(res.alignment).map((w) => `${w.text}@${w.startMs}ms`).join("  "));
  }
}
process.exitCode = ok ? 0 : 1;
```

`packages/engine/scripts/smoke-higgsfield.ts` (replace the old contents entirely):
```ts
import { probe } from "@reel/media";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, loadEnvFile, REPO_ROOT } from "../src/config";
import { contentTypeFor, downloadTo, extFromUrl } from "../src/download";
import { HiggsfieldGateway, HiggsfieldImageGen, HiggsfieldUploader, HiggsfieldVideoGen, sdkSubscribe } from "../src/providers/higgsfield";

// Checks image → upload → image-to-video end to end (spends a few credits).
loadEnvFile();
const config = loadConfig();
const credentials = config.higgsfield.credentials;
if (!credentials) {
  console.error("HF_CREDENTIALS is not set in .env.local (format key-id:key-secret)");
  process.exit(1);
}
const outDir = join(REPO_ROOT, "work", "smoke");
await mkdir(outDir, { recursive: true });
const gateway = new HiggsfieldGateway(sdkSubscribe(credentials), 1);

const image = await new HiggsfieldImageGen(gateway, config.higgsfield.imageModel).generate({
  prompt: "A barista pouring latte art, warm morning light, close-up, vertical 9:16 framing",
});
const imageFile = join(outDir, `image.${extFromUrl(image.url, "png")}`);
await downloadTo(image.url, imageFile);
const imageInfo = await probe(imageFile);
console.log(`image ${image.requestId}: ${imageInfo.video?.width}×${imageInfo.video?.height} → ${imageFile}`);

const publicUrl = await new HiggsfieldUploader(credentials, config.higgsfield.baseUrl).upload(await readFile(imageFile), contentTypeFor(imageFile));
console.log(`uploaded → ${publicUrl}`);

const video = await new HiggsfieldVideoGen(gateway, config.higgsfield.videoModel, config.higgsfield.videoResolution).imageToVideo({
  imageUrl: publicUrl,
  prompt: "slow push-in, steam rising from the cup",
  durationSec: 4,
});
const videoFile = join(outDir, "video.mp4");
await downloadTo(video.url, videoFile);
const v = await probe(videoFile);
console.log(`video ${video.requestId}: ${v.video?.width}×${v.video?.height} @ ${v.video?.fps.toFixed(2)} fps, ${v.durationSec.toFixed(2)} s, audio: ${v.audio ? "PRESENT (unexpected)" : "none"} → ${videoFile}`);
```

- [ ] **Step 7: Full verification**

Run: `npm test && npm run typecheck`
Expected: every test passes (core, media, video, engine); typecheck exits 0.

Run the whole flow for free:
```bash
npm run reel -- plan --brief "3 tips to grow on TikTok" --out work/demo --fake
npm run reel -- make work/demo --fake
```
Expected: `plan` prints 3 scenes and a cost estimate. `make` prints voice/image/animate/render/export steps and the paths under `work/demo/renders/v1/`. Open `reel.mp4`.

- [ ] **Step 8: Live smoke checks (manual, spends a small amount of credit; needs `.env.local` keys)**

Run: `npm run smoke:elevenlabs`
Expected: both languages print "alignment chars N" with N > 0 and a word list whose Hebrew words match the text. **If alignment is missing**, the engine still works through the Scribe fallback; note the result in the PR description.

Run: `npm run smoke:higgsfield`
Expected: the image is portrait (height > width, ~9:16), the upload returns an `https://` URL, and the video is portrait with `audio: none`. If the upload step returns 404, the upload route differs from the docs. Record the actual route from the Higgsfield dashboard/docs, update `HiggsfieldUploader` and its test, and commit that fix separately.

Then one real reel (costs roughly the printed estimate):
```bash
npm run reel -- plan --brief "3 טיפים לצמיחה מהירה בטיקטוק" --out work/real-he --lang he --length 15
npm run reel -- make work/real-he          # dry run: prints the estimate, spends nothing
npm run reel -- make work/real-he --yes
```

- [ ] **Step 9: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): reel CLI with plan/make checkpoint, live smoke scripts for ElevenLabs and Higgsfield"
```

---

## Plan 1b preview (not part of this plan)

Plan 1b wraps this engine in the web app from the spec:
- Supabase schema, RLS and magic-link auth
- a Postgres job queue and a worker that calls `generateAssets` / `renderAndExport`
- a Supabase-backed `AssetStore`
- a Next.js UI with the storyboard editor, approval, live progress and `@remotion/player` preview

The engine's public surface (`Planner.plan`, `generateAssets`, `renderAndExport`, `hashes`, `estimateCost`) is what 1b consumes.

Deferred from this plan, on purpose:
- **Background music:** the Timeline and composition already support `musicUrl`; picking or uploading a track needs the 1b UI.
- **`duckMusic` (sidechain ducking preset):** it's opt-in per the spec; Phase 5.
- **Revision diffs:** the `hashes` cache already makes re-runs pay only for changed scenes; the diff UI is Phase 5.
