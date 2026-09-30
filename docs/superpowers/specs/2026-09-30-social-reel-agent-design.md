# Social Reel Agent — Design Spec

- **Date:** 2026-09-30
- **Status:** Draft, awaiting review
- **Repo:** Higgsfield Social Agent Xpera

## 1. Purpose and success criteria

An internal web app where a small team turns a short brief into a finished vertical (9:16) social reel (Instagram Reels, TikTok, YouTube Shorts). Each reel includes voice, visuals, animated captions, overlays and transitions.

- **Higgsfield** generates the visuals: background video, images, graphics and avatars.
- **ElevenLabs** provides voice (TTS) and transcription (STT).
- **Remotion** does all editing and rendering.
- **Claude** plans and revises the reel.

**Success means** a team member submits a brief, reviews and approves a storyboard, and gets an MP4 they would post with little or no manual editing. Cheap revisions are available after rendering.

### Decisions made during brainstorming
| Topic | Decision |
|---|---|
| Product form | Web app |
| Audience | Internal tool for our team; invite-only, no billing |
| Control model | Checkpoints: approve the storyboard before spending credits; revise after render |
| Formats | All four: faceless, talking avatar, consistent brand character, own footage + AI (built in phases) |
| Languages | Hebrew and English, chosen per reel (RTL support required) |
| Hosting | Next.js + Supabase (auth, Postgres, Storage) + a Node worker that renders locally with Remotion |
| Agent approach | Storyboard-as-contract pipeline: Claude writes and edits a structured storyboard, code executes it. The revision step can later grow into a tool-using agent |

### Out of scope for v1
Public signup, billing, team roles or permissions, auto-publishing to social platforms, aspect ratios other than 9:16, chat-style live editing, Remotion Lambda.

## 2. Architecture

npm-workspaces monorepo:

```
apps/web        Next.js (App Router): UI + API routes (auth, CRUD, enqueue jobs)
apps/worker     Node process: claims jobs, runs pipeline steps, renders with Remotion
packages/core   zod schemas (Storyboard, Timeline), Claude planner/reviser, pipeline steps,
                provider adapters (higgsfield, elevenlabs, anthropic, fake), asset cache, cost table
packages/video  Remotion project: Reel composition driven purely by Timeline props;
                captions (RTL-aware), overlays, transitions, motion effects
scripts/        Live smoke scripts (the current index.ts moves here) and the lip-sync spike
```

**Supabase:**
- Auth: email magic link, signup disabled, users invited from the dashboard.
- Postgres: the tables in section 3.
- Storage buckets: `uploads`, `assets`, `renders`.

**Communication:**
- The web app writes rows: projects, storyboard versions and jobs.
- The worker claims jobs from the `jobs` table with `SELECT … FOR UPDATE SKIP LOCKED` (no Redis) and writes progress back to the job row.
- The web app subscribes to job and asset rows through Supabase Realtime for live progress.
- Provider API keys (`HF_CREDENTIALS`, `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`) live **only in the worker**. Every provider call, including Claude planning, goes through the queue.

**Reel lifecycle:**
```
brief ──plan job──▶ storyboard v1 (draft)
                     │ user edits / asks Claude to revise / approves
                     ▼
               generate job: voice|transcribe → visuals (parallel) → avatar lip-sync
                     │                           (every asset cached by input hash)
                     ▼
               assemble → Timeline JSON ──render──▶ MP4 in Storage
                     │
   revision prompt ──revise job──▶ storyboard v(n+1) → diff shown to user → confirm
                     → regenerate only changed assets → re-render
```

**Preview:** the web app embeds `@remotion/player` with the same composition and Timeline, so users can scrub a preview before and after the final render.

## 3. Data model

### 3.1 Storyboard: what the reel *is* (written by Claude, edited and approved by humans)

```ts
Storyboard {
  version: number
  language: "he" | "en"
  format: "faceless" | "avatar" | "character" | "footage"
  aspect: "9:16"                     // fixed in v1
  targetDurationSec: 15 | 30 | 45 | 60
  voice: { voiceId: string; modelId: string; stability?: number; style?: number } | null  // null for footage
  character?: { customReferenceId: string }        // character format
  sourceFootageAssetId?: string                     // footage format
  style: { captionPreset: string; font: string; palette: string[]; musicAssetId?: string;
           pacing: "calm" | "punchy" }
  scenes: Scene[]
}
Scene {
  id: string                         // stable across versions; the basis for diffs
  script: string                     // spoken line(s); for footage: transcript span reference
  footageSpan?: { startMs: number; endMs: number }  // footage format
  visual: {
    kind: "broll_video" | "image" | "avatar" | "footage" | "graphic"
    prompt?: string
    model?: string                   // override of the default model for this kind
    motion?: "none" | "zoom_in" | "zoom_out" | "pan_left" | "pan_right"
  }
  overlays: { text: string; position: "top" | "center" | "bottom"; animation: "pop" | "fade" | "type" }[]
  transitionOut: "cut" | "fade" | "whip" | "zoom"
}
```

### 3.2 Timeline: exactly what to render (derived by code, never written by Claude)

```ts
Timeline {
  fps: 30; width: 1080; height: 1920; durationInFrames: number
  language: "he" | "en"; direction: "rtl" | "ltr"
  audio: { voiceUrl?: string; musicUrl?: string; musicDuckingDb: number }
  clips: { sceneId: string; src: string; kind: "video" | "image"; fromFrame: number;
           durationInFrames: number; motion: string; transitionOut: string; layer: "base" | "overlay" }[]
  captions: { words: { text: string; startMs: number; endMs: number }[]; preset: string }
  overlays: { text: string; fromFrame: number; durationInFrames: number; position: string; animation: string }[]
}
```

Scene timing comes from real audio timestamps. Each scene's script is mapped to its span of spoken words, and clip durations snap to those spans.

### 3.3 Tables

| Table | Key columns |
|---|---|
| `projects` | id, owner_id, title, language, format, created_at |
| `storyboards` | id, project_id, version, json, status (`draft`/`approved`/`superseded`), created_by (`user`/`agent`), created_at |
| `assets` | id, project_id, input_hash (unique), kind, storage_path, provider, model, provider_request_id, meta (duration, est_cost, error), status |
| `jobs` | id, project_id, type (`plan`/`generate`/`render`/`revise`/`train_character`), status (`queued`/`running`/`needs_attention`/`done`/`failed`), progress (json per step/scene), payload, error, attempts, heartbeat_at |
| `renders` | id, project_id, storyboard_version, storage_path, timeline_json, created_at |
| `characters` | id, name, reference_image_paths, custom_reference_id, status |
| `settings` | key, value (default voices per language, caption presets, brand palette/fonts, cost table overrides, spend cap) |

Row Level Security: every authenticated user can access every row (it's one shared team workspace). The service role is used only by the worker.

### 3.4 Asset cache
`input_hash = sha256(provider, model, canonical(params), prompt, upstream asset hashes)`. Before any provider call, a step looks up `assets.input_hash` and reuses the asset if it's there. This single mechanism handles resumability, per-scene retries and partial regeneration after revisions.

## 4. Pipeline

### 4.1 Shared steps
- **plan:** Claude turns the brief and settings into a Storyboard, using structured output validated by zod. If validation fails, it gets one repair round with the errors attached. Prompts are language-aware, so Hebrew reels get the script written in Hebrew.
- **visuals** (per scene, in parallel):
  - `image`: `higgsfield-ai/soul/v2/standard` with `aspect_ratio: "9:16"`, `resolution: "1080p"`.
  - `broll_video`: a 9:16 image first (as above), then `bytedance/seedance-2.5/image-to-video` from that image. Image-to-video takes its framing from the input image, which guarantees vertical output. Always `generate_audio: false`, with duration covering the scene span (4–30 s).
  - `graphic`: rendered by Remotion from overlay data; no provider call.
  - A semaphore enforces the Higgsfield per-account concurrency limit (configurable, default 4). The concurrency-limit HTTP 400 is treated as transient.
  - The worker polls with `higgsfield.subscribe(..., { withPolling: true })` and `maxPollTime` of 15 min. No webhooks, so it runs without a public URL.
  - Every output is **copied into Supabase Storage right away**, because Higgsfield keeps outputs for about 7 days.
- **assemble:** pure function (Storyboard, assets, word timings) → Timeline.
- **render:** `@remotion/bundler` `bundle()` once per worker start, then `selectComposition` and `renderMedia({ codec: "h264" })`, then upload to `renders/`.

### 4.2 Per-format differences

| Format | Voice / timing | Visuals |
|---|---|---|
| **faceless** | ElevenLabs `textToSpeech.convertWithTimestamps` → character alignment grouped into words by our own converter (handles Hebrew) | image / b-roll / graphic scenes |
| **avatar** | Same TTS; the voice track is sliced per avatar scene (≤15 s per slice), exported as WAV and uploaded to Higgsfield | `AvatarProvider.lipSync(imageUrl, audioUrl)` produces the avatar clip; mixed with b-roll scenes |
| **character** | As avatar | The avatar image is generated by Soul V2 with `custom_reference_id` + `custom_reference_strength`; then as avatar |
| **footage** | The uploaded clip goes to Scribe `speechToText.convert({ modelId: "scribe_v2", timestampsGranularity: "word" })`, then `@remotion/elevenlabs` `elevenLabsTranscriptToCaptions` | The source clip is the base layer. Claude plans cutaway scenes (b-roll overlays) against the transcript instead of writing a script |

### 4.3 Voice models
`model_id` is always set explicitly, per language, in settings:
- Hebrew: default `eleven_v3`, which supports Hebrew. `eleven_multilingual_v2`, the ElevenLabs default, does **not**.
- English: default `eleven_multilingual_v2`.

### 4.4 Lip-sync risk and spike (Phase 2 gate)
Higgsfield's public docs list no lip-sync or talking-avatar model. The avatar path sits behind an interface:

```ts
interface AvatarProvider { lipSync(input: { imageUrl: string; audioUrl: string; durationSec: number }): Promise<{ videoUrl: string }> }
```

Phase 2 starts with a spike script that tests these candidates on real Hebrew and English audio:
1. Seedance 2.5 `reference-to-video` (`image_urls` + `audio_urls`, ≤30 s audio, 9:16)
2. Grok `xai/grok-imagine-video/v1.5/reference-to-video` (`audio_url`, ≤15 s)
3. The legacy `/v1/speak/higgsfield` endpoint (typed in the SDK, missing from the docs; WAV audio; 5/10/15 s)

We pick the candidate with acceptable lip-sync. If none qualifies, we add a dedicated lip-sync provider behind the same interface. Phases 1 and 4 don't depend on this.

### 4.5 Provider adapter gaps
- **Higgsfield file upload:** the v2 SDK has no upload helper. We write `uploadToHiggsfield(buffer, contentType)` against `POST /files/generate-upload-url`, then PUT the file. Audio must be WAV.
- **Soul ID training:** a thin REST wrapper for `POST /v1/custom-references` (`model_version: "v2"`) and polling `GET /v1/custom-references/{id}`.
- **SDK response shape:** `subscribe()` returns the raw V2 response (`status`, `request_id`, `video.url`, `images[].url`), not the README's `JobSet`. Adapters normalize the statuses `completed` / `failed` / `nsfw` / `canceled`.

## 5. Web app UX

1. **Login:** magic link, invite-only.
2. **Projects list:** thumbnail, title, status, language and format.
3. **New reel form:** brief, format, language, target length, voice (with preview), caption preset, pacing, and conditionally a character or an upload. Submitting enqueues `plan`.
4. **Project page:**
   - **Storyboard review:** editable scene rows (script, visual kind, prompt, overlays, transition); reorder, add or delete scenes; "Ask Claude" instruction box (`revise`); a cost estimate; an **Approve & generate** button.
   - **Generating:** Realtime progress per step and scene; each asset shows as soon as it's ready; a **Retry scene** button on failures.
   - **Rendered:** Remotion Player preview, MP4 download, a revision box. Revisions show a diff (changed scenes; credit cost vs free Remotion-only) before confirming. Version history with the render for each version.
5. **Characters library:** upload reference photos, train, see status.
6. **Settings:** default voices per language, caption presets, brand palette and fonts, cost table, spend cap.

**RTL:** for `he` reels, editor text fields use `dir="rtl"`, and Remotion captions and overlays render right to left with a Hebrew-capable Google font (Heebo by default) via `@remotion/google-fonts`. Captions come from `@remotion/captions` `createTikTokStyleCaptions`, whose tokens need a leading space.

## 6. Error handling

- **Idempotency:** each step checks the asset cache first, so retries never pay twice.
- **Transient errors** (network, Higgsfield concurrency-limit 400, ElevenLabs 429/5xx): exponential backoff, up to 3 attempts per call.
- **Permanent errors** (validation, `nsfw`, `failed`, `canceled`): the scene is marked failed with a readable reason, the job goes to `needs_attention`, and the other scenes continue and are cached.
- **Worker crash:** jobs in `running` with `heartbeat_at` older than 2 minutes are requeued on worker start.
- **Claude output:** zod validation with one repair round, then the job fails with the validation message.

## 7. Cost control

- Provider credits are spent only after storyboard approval, or after confirming a revision diff.
- The cost estimate comes from a per-model price table in settings (per second for video, per image, per 1k characters for TTS, per minute for STT).
- A per-reel **spend cap** (a setting): a job that would exceed it stops at `needs_attention` before making the call.
- Every provider call records model, duration and estimated cost in `assets.meta`, which gives a monthly spend view.
- `PROVIDERS=fake` uses fake adapters returning fixture media, for development and tests.

## 8. Testing

- **Unit tests (Vitest)** on the pure core:
  - TTS character-alignment → words (English and Hebrew fixtures)
  - scene span mapping
  - `assemble`
  - storyboard diff (changed scenes, cost vs free)
  - input-hash stability
  - cost estimate
  - storyboard schema validation
- **Adapter contract tests** against recorded response fixtures, including v2 SDK shapes and every terminal status and error.
- **Pipeline integration test:** fake providers + a stubbed Claude response run brief → plan → generate → a real Remotion render of a 3-scene reel. It asserts the MP4 exists and its duration matches.
- **Remotion stills** of each caption preset in Hebrew and English, to catch RTL regressions.
- **Live smoke scripts** (manual, spend credits): one per provider, plus the lip-sync spike.

## 9. Build phases (each ends usable)

1. **Foundation + faceless:**
   - monorepo, Supabase schema and RLS, auth, job queue and worker
   - Claude planner, Higgsfield image/b-roll, ElevenLabs TTS with timestamps
   - Remotion Reel composition with captions (he/en), overlays and transitions
   - storyboard review, approval, progress and preview UI
   - fake providers and tests
2. **Talking avatar:** the lip-sync spike, then the `AvatarProvider` implementation and avatar scenes.
3. **Brand character:** Soul ID training wrapper, Characters library, character format.
4. **Own footage:** upload, Scribe transcription, cutaway planning, footage base layer.
5. **Revision polish:** diff UI, version history, settings and presets, spend view.

## 10. Constraints and notes

- **Remotion license:** free for individuals and companies with up to 3 employees. Beyond that, a Remotion Company License is needed.
- **Linux deployment:** rendering needs Chrome Headless Shell dependencies. The renderer sits behind an interface so a later move to Remotion Lambda is contained.
- **Claude model:** use the latest capable Claude model for planning and revision (configurable in settings).
