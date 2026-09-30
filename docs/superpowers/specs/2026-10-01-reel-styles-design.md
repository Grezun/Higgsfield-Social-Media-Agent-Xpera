# Reel Styles: Design

**Date:** 2026-10-01
**Status:** approved in chat, section by section; awaiting review of this written spec
**Builds on:** `2026-09-30-social-reel-agent-design.md` (Phases 1a and 1b, plus the length and Higgsfield reliability work, merged at 1b34483)
**Prompt sources:** `2026-10-01-reel-styles-prompts/*.md`. These are the user's 12 style prompts, stored verbatim.

## 1. Goal

"Create reel" opens a menu of reel styles instead of a single brief box. Each style is a **template**: a prompt written by the user with `{{VARIABLES}}`. The user fills in the variables in a form, and the agent plans the storyboard by following the filled-in prompt. The menu has 12 styles plus **Custom**, which is today's free-text brief.

### Understanding

**What the user said:**
- A style menu opens from "create reel".
- There are 12 named styles plus Custom.
- Each style has the user's own prompt, and the agent must create the reel by that prompt.
- Variables are filled in by the user.

**Decided in brainstorming:**
- This build is piece **A** of four:
  - **A.** Picker, templates, exact script and SRT.
  - **B.** Uploads.
  - **C.** Avatar and lip-sync.
  - **D.** Music, sound effects and reels with no voice.
- 8 styles are usable now. 4 show "Coming soon" until B, C or D ships.
- Styles live as files in the repo. There is no in-app editor.
- The style prompt is the brief given to Claude. The engine's rules stay in the system prompt, and per-style engine notes translate the prompt's wishes into what the renderer can do (option 1 of 3).

### Success criteria

1. A user picks a style, fills its form and gets a storyboard that visibly follows that style's structure. For example:
   - Myth vs Fact opens on a scene with a "מיתוס" overlay.
   - Listicle shows numbered item titles.
2. When the user pastes a script, the storyboard's voiceover is exactly that script, split into scenes. The planner never shortens or rewrites it.
3. Every render comes with an `.srt` that matches the burned-in captions.
4. Custom and existing reels behave exactly as before.

## 2. Scope

**In scope (piece A):**
- style registry package
- picker page
- per-style form
- template filling
- planner changes: style brief, engine notes, exact-script mode
- live length estimate in the form
- SRT generation and download
- DB migration: `projects.style_id`, `renders.srt_path`

**Out of scope:**
- **B: uploads.** Asset variables, Screen Tutorial, and real product or before-and-after material.
- **C: avatar and lip-sync.** Presenter-Led.
- **D: music, sound effects, and reels with no voice.** Text-Led and Looping/ASMR.
- An in-app prompt editor.
- Per-style caption presets.
- Automatic fact verification. The prompts' "verify claims" instructions are handled by telling Claude to use only the facts the user supplied.

## 3. Styles

The `id` is the folder name and the URL slug. "Shared" variables are filled from the shared settings and never appear as their own fields:
- `LANGUAGE` comes from the Language setting.
- `DURATION` and `DURATION_SECONDS` come from the Length setting (15/30/45/60).
- `ACCENT_COLOR` comes from the Accent colour.
- `VOICE` and `VOICE_STYLE` become a description of the selected voice. Examples: "the team Hebrew voice", "ElevenLabs voice <id>".

"Asset" variables are hidden in piece A and filled with `not provided (file uploads are not available yet; use generated visuals)`.

**Script variables:**
- `{{{{LANGUAGE}}_SCRIPT}}` is one form field, **Script**. It is optional; when it is empty, the value is `not provided: draft one`.
- Text-Led's `{{{{LANGUAGE}}_COPY}}` works the same way, but Text-Led is coming soon.

| id | Menu name | Status | Required fields | Optional fields | Hidden asset fields | Title from |
|---|---|---|---|---|---|---|
| `presenter` | Presenter-Led (Avatar) | coming soon (C) | TOPIC, MAIN_MESSAGE | TARGET_AUDIENCE, CTA, Script | PRESENTER_REFERENCE, SUPPORTING_ASSETS | TOPIC |
| `faceless` | Faceless + Voiceover | available | TOPIC, MAIN_MESSAGE | AUDIENCE, CTA, Script | IMAGES_VIDEOS_SCREENSHOTS | TOPIC |
| `screen-tutorial` | Screen Tutorial | coming soon (B) | TASK, APP_OR_WEBSITE | AUDIENCE, CTA, Script | SCREEN_ASSETS | TASK |
| `product-demo` | Product Demonstration | available | PRODUCT, PROBLEM, BENEFIT | AUDIENCE, VERIFIED_FACTS, CTA, Script | PRODUCT_ASSETS | PRODUCT |
| `before-after` | Before and After | available | SUBJECT, BEFORE_STATE, AFTER_STATE, METHOD | VERIFIED_DETAILS, CTA, Script | ASSETS | SUBJECT |
| `mini-story` | Mini Story | available | SUBJECT, CHALLENGE, RESOLUTION | SETTING, TURNING_POINT, TAKEAWAY, CTA, Script | ASSETS | SUBJECT |
| `listicle` | Listicle | available | TOPIC, TIPS_MISTAKES_TOOLS_OR_IDEAS (select: tips / mistakes / tools / ideas), NUMBER (select 3–7, default 3) | AUDIENCE, ITEMS, CTA, Script | ASSETS | TOPIC |
| `myth-fact` | Myth vs Fact | available | TOPIC, MYTH, FACT | AUDIENCE, SOURCES_OR_EVIDENCE, EXAMPLE, CTA, Script | ASSETS | TOPIC |
| `text-led` | Text-Led, Music Only | coming soon (D) | TOPIC, MAIN_MESSAGE | AUDIENCE, MOOD, CTA, Copy | ASSETS, MUSIC_ASSET | TOPIC |
| `customer-story` | Customer Story | available | NAME, PROBLEM, ACTION, RESULT | AUDIENCE, QUOTES, CTA, Script | ASSETS | NAME |
| `process` | Process / Behind the Scenes | available | PROCESS, RESULT | AUDIENCE, STEPS, TAKEAWAY, CTA, Script | ASSETS | PROCESS |
| `loop-asmr` | Looping Visual / ASMR | coming soon (D) | SUBJECT, ACTION | MOOD, HOOK_TEXT, CTA | ASSETS, AUDIO_ASSETS | SUBJECT |
| `custom` | Custom | available | today's brief | — | — | today's rule |

**Field widgets:**
- **Long text areas:** Script, ITEMS, QUOTES, VERIFIED_FACTS, VERIFIED_DETAILS, SOURCES_OR_EVIDENCE, STEPS, MAIN_MESSAGE, MYTH, FACT, PROBLEM, ACTION, RESULT, BEFORE_STATE, AFTER_STATE, METHOD, CHALLENGE, RESOLUTION, TURNING_POINT.
- **One-line inputs:** everything else.
- **Limits:** each field is capped at 2000 characters, and Script at 5000. `dir="auto"` is set on every input so Hebrew and English both type naturally.
- **Labels:** the UI shows English labels taken from each prompt's INPUTS lines, for example "Misconception" or "Verified outcome".
- **Defaults:** the default length is 30 s for every available style, since all their prompts say "default 30". The Length setting is pre-selected to it.

### 3.1 Engine notes (per available style)

These are short lines added after the style brief, telling Claude how to express the prompt with the renderer's building blocks. `<he|en>` means the label is written in the reel's language.

- **faceless:** No people speaking to camera. Change the visual about every 2–4 s, using the scene count limits. Prefer concrete demonstrations; use `graphic` scenes with an overlay for numbers and key terms.
- **product-demo:**
  - Order the scenes as problem → product → how it works → benefit → final product shot with the CTA.
  - Visual prompts describe the product as the user described it, and never invent logos or packaging details. Where no product description was given, describe it generically.
  - Use only claims from VERIFIED_FACTS and BENEFIT.
- **before-after:**
  - Scene 1 previews the result.
  - Before scenes carry a `לפני`/`Before` overlay, and after scenes carry an `אחרי`/`After` overlay.
  - Every generated before or after image also carries a short `המחשה`/`Illustration` overlay, because these are generated rather than documented.
  - Use matching framing words in the before and after visual prompts. There is no split-screen yet, so alternate matched shots instead.
- **mini-story:**
  - Follow the five moments. Keep one character described identically in every visual prompt: same age, clothing and setting words.
  - The narration is third person or narrator voice; nobody speaks on screen.
  - If the story is invented, the final scene carries a short `סיפור להמחשה`/`Illustrative story` overlay.
- **listicle:**
  - Open with a promise scene, then write exactly NUMBER item scenes. Each item scene has an overlay `N. <short title>`.
  - Close with a takeaway and CTA scene.
  - If ITEMS is empty, choose the items yourself.
- **myth-fact:**
  - The first scene is the myth, with an overlay `מיתוס`/`Myth`. Then comes the context.
  - The fact reveal has an overlay `עובדה`/`Fact`, followed by one example scene and a CTA scene.
  - Mark the correction with a `graphic` scene or a transition change.
- **customer-story:**
  - Open with the strongest outcome from RESULT.
  - Quotes appear only as overlays in quote marks, and only if QUOTES was provided, word for word (shortened with "…" if over the overlay limit).
  - Never invent numbers, names or endorsements.
  - Generated visuals are illustrative.
- **process:**
  - Open with the finished result, then the stages in the order given in STEPS, each with a short stage label overlay.
  - Return to the result for the CTA.

**Common engine rules** go in the system prompt once, for every style:
- The renderer can do: AI images, AI b-roll, graphic backgrounds, up to 2 overlays per scene, captions and transitions.
- Ignore requests for music, sound effects, split-screen, lip-sync, SRT or file assets; the app handles SRT itself. Never claim to do them.
- Never invent quotes, numbers, results, certifications or testimonials that are not in the inputs.
- Write labels and overlays in the reel's language. The prompts' Hebrew labels become their English equivalents for English reels.

## 4. Architecture

### 4.1 `packages/styles` (new, browser-safe data plus a Node loader)

```
packages/styles/
  src/
    registry.ts        # StyleDef[]: id, name, description, status, fields, sharedVars, assetVars, titleField, engineNotes, defaultDurationSec
    fill.ts            # fillTemplate(prompt, values, shared) → string
    prompts/<id>.md    # verbatim copies of docs/superpowers/specs/2026-10-01-reel-styles-prompts/<id>.md
    load.ts            # Node-only: readPrompt(id) → string (fs); not imported by the browser barrel
```

**`StyleDef`:**
- `id`, `name`, `description`
- `status: "available" | "coming_soon"`
- `comingSoonReason?`
- `fields: FieldDef[]`, where `FieldDef = { key, label, kind: "line" | "text" | "select", required, options?, default?, maxLength }`
- `scriptVar?: "SCRIPT" | "COPY"`
- `assetVars: string[]`
- `titleField: string`
- `engineNotes: string[]`
- `defaultDurationSec: 15 | 30 | 45 | 60`

`custom` is in the registry, with `status: "available"` and no fields, so the picker can render it; its route is today's form.

**`fillTemplate` rules:**
- `{{{{LANGUAGE}}_SCRIPT}}` and `{{{{LANGUAGE}}_COPY}}` are substituted **before** `{{LANGUAGE}}`.
- `{{LANGUAGE}}` becomes `Hebrew` or `English`.
- A shared variable becomes the value from the settings.
- An asset variable becomes the "not provided (uploads…)" text.
- A field left empty becomes `not provided`.
- A variable with no known source is a programming error: it throws, and the coverage test catches it before it ships.

**Values** are passed through verbatim, with no escaping. They only ever reach Claude as data inside the user message.

### 4.2 Web (`apps/web`)

- **`/new`** becomes the picker: a card grid built from the registry.
  - Coming-soon cards are disabled and show their reason, for example "Needs file uploads".
  - The Custom card links to `/new/custom`.
- **`/new/custom`** is today's `NewReelForm`, unchanged.
- **`/new/[styleId]`** is a server component.
  - An unknown id returns 404.
  - A coming-soon id renders a notice and no form.
  - An available style renders `StyleReelForm`: the style's fields, then the shared settings row (language, length pre-set to the style default, pacing, captions, accent, background, voice ID).
  - The Script field shows a **live estimate** under it using `estimateStoryboardSeconds` on the text: "≈ N s of speech; longer than your T s target". It is the warning style when the estimate exceeds target × `LENGTH_TOLERANCE`.
- **The server action**:
  1. Re-reads the registry.
  2. Rejects unknown or coming-soon styles and missing required fields.
  3. Builds the plan payload.
  4. Inserts the project with `style_id`, then queues the plan job with the existing `createReelFromForm` flow. The same orphan-project handling applies.
  5. Takes the project title from `titleField`, truncated to 120 characters.

### 4.3 Plan job payload

`PlanJobPayloadSchema` gains an optional part:

```
style?: { id: string; values: Record<string, string>; script?: string }
```

- The rest of the payload is unchanged: language, length, pacing, captions, palette and voice.
- For style reels, `brief` holds a short summary (`<style name>: <title field value>`), so existing code that reads `brief` keeps working. The planner uses the style part.

### 4.4 Worker and planner

**Plan handler:**
- When `payload.style` is present, it loads the `StyleDef` and prompt.
- It re-validates: the style is available and the required fields are present.
- It fills the template and passes `{ styleBrief, engineNotes, script }` into `PlanRequest.style`.

**`systemPrompt`** gains one paragraph with the common engine rules from §3.1. It is included only when `req.style` is set. Custom reels get today's prompt byte for byte.

**`userPrompt`** for style reels:
- `Style brief (follow its structure, pacing and tone):` followed by the filled template
- `Engine notes:` followed by the notes
- the existing language, length and pacing lines
- a mode line:
  - **Drafted mode** (no script): `No script was provided: write the voiceover yourself following the style brief.`
  - **Exact mode** (script given): `Exact script mode: the voiceover must be exactly the script below, split into scenes at natural pauses. Do not add, remove, reorder or change any word or punctuation mark. Only choose where each scene starts.` followed by the script.

**Exact-script check.** This is a pure function in `@reel/core`:

```
scriptMatches(expected: string, scenes: string[]): { ok: true } | { ok: false; diff: string }
```

- It compares `normalize(expected)` with `normalize(scenes.join(" "))`, where `normalize` applies NFC and collapses whitespace.
- Punctuation, digits and letters must match exactly.
- `diff` shows the first differing position with about 40 characters of context on each side.

**Planner flow** in exact mode:

| Step | Rule |
|---|---|
| 1 | The first attempt must pass the schema, `buildStoryboard` and `scriptMatches`. |
| 2 | A length issue caused by **speech duration** is ignored, because the planner never shortens a user script. A **scene count** issue still triggers the repair round, since merging scenes keeps every word. |
| 3 | If anything fails, there is one repair round: the existing repair prompt plus the `scriptMatches` diff. |
| 4 | If the second attempt still fails `scriptMatches`, planning throws `ScriptMismatchError`, with the message "Couldn't split your script without changing words. Try shorter sentences or break it into paragraphs." |
| 5 | If the second attempt matches but still has too many scenes, it is returned (the editor shows the warning). |

**Drafted mode** keeps today's behaviour, including length enforcement and the fallbacks.

**The storyboard** itself is unchanged: no new schema fields. Style overlays are ordinary overlays.

### 4.5 SRT

- `@reel/video` exports `buildSrt(timeline): string`. It uses the same `wordsToCaptions` and `createTikTokStyleCaptions` page grouping as `Captions.tsx`, with the same combine window, so every SRT cue matches an on-screen caption page.
- **Format:**
  - cues numbered from 1
  - `HH:MM:SS,mmm --> HH:MM:SS,mmm`
  - UTF-8 without BOM
  - text in logical order
  - at most two lines per cue, split at the word boundary nearest the middle when a page is longer than 42 characters
- The generate handler writes `reel.srt` next to `reel.mp4` in the `renders` bucket and stores `renders.srt_path`.
- A render that already exists and has no SRT is left alone; only new renders get one.
- The reel page shows "Download subtitles (.srt)" as a signed URL, the same way as the MP4.
- The CLI writes `reel.srt` into its output folder.

### 4.6 Database migration

```sql
alter table public.projects add column style_id text check (style_id is null or style_id ~ '^[a-z0-9-]{1,40}$');
alter table public.renders add column srt_path text;
```

- The web app inserts `style_id`. Signed-in users already have insert on `projects`, so no new grant is needed.
- `srt_path` is written only by the worker, with the secret key.
- DB types are regenerated.
- The migration is shown to the user before it is applied to the hosted project.

## 5. Errors

| Situation | Behaviour |
|---|---|
| Unknown style id in the URL | 404 page |
| Coming-soon style, whether through the URL or a crafted POST | The page shows a notice; the server action and the worker both refuse it |
| A required field is missing | Form errors, as today |
| A template variable with no source | Throws at fill time; a test keeps any shipped prompt from ever hitting this |
| Claude alters an exact script twice | The job fails with the `ScriptMismatchError` message and the project status is `failed`. Retry is available and only Claude tokens are spent. |
| The script is longer than the target | A warning in the form and the editor; never blocked or shortened |
| Uploading the SRT fails | The generate job fails like any other upload failure and a retry re-uploads. Nothing is paid again, because the assets are cached. |

## 6. Testing

No test makes a paid call. The unit tests cover:

- **`fillTemplate`:**
  - The nested script variable, in both Hebrew and English.
  - Shared, asset and empty variables.
  - An unknown variable throws.
- **Registry coverage:** for every `prompts/<id>.md`, every `{{VAR}}` is either a field, a shared variable, an asset variable or the script/copy variable. Every field key appears in its prompt, and every prompt file has a registry entry and the reverse, except `custom`, which has no prompt file.
- **Prompt integrity:** each `prompts/<id>.md` is byte-identical to its `docs/.../2026-10-01-reel-styles-prompts/<id>.md`.
- **`scriptMatches`:**
  - Hebrew, English, and mixed text with numbers and punctuation.
  - Whitespace differences pass.
  - One changed word fails, and the diff points at it.
- **Planner (fake model):**
  - A style brief and engine notes are present in the prompt.
  - Custom's prompts are unchanged, checked with a byte-equality snapshot.
  - Exact mode:
    - A match passes.
    - A mismatch goes through one repair and then succeeds.
    - A mismatch twice throws `ScriptMismatchError`.
    - An over-length exact script is returned without a repair call.
  - Drafted mode is unchanged.
- **Form parsing:** required fields, and coming-soon rejection.
- **`buildSrt`:**
  - Cue numbering and timestamps.
  - A Hebrew page.
  - Two-line splitting.
  - Cues match the caption pages.

**Integration:**
- the web build
- the worker in fake mode end to end, for one style with a script and one without
- one real planning run per mode on Claude, which costs a few cents and needs the user's go-ahead

## 7. Delivery

This is one implementation plan with about 6 tasks:

1. the styles package
2. `scriptMatches` and the planner's style and exact modes
3. the plan payload and worker wiring
4. the picker and style form (web)
5. SRT generation, storage and download
6. the migration and types

Execution is subagent-driven, on a feature branch, as before.
