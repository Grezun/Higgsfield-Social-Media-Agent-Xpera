"use client";
import { costModelsFor, estimateCost, type Storyboard } from "@reel/core";
import { useRouter } from "next/navigation";
import { useMemo, useReducer, useState, useTransition } from "react";
import { approveStoryboardAction, editAsNewVersionAction, retryGenerateAction, saveStoryboardAction } from "@/app/projects/[id]/actions";
import { checkStoryboard, editStoryboard, MAX_OVERLAYS, normalizeForSave } from "@/lib/storyboard-edit";
import { describeLength } from "@/lib/length-view";

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
  const length = useMemo(() => describeLength(sb), [sb]);

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
        <div className="column" style={{ alignItems: "flex-end", gap: "0.5em" }}>
          <span className="muted">{estimate === null ? "Estimate unavailable" : `Estimated generation cost: $${estimate.toFixed(2)}`}</span>
          <span className={length.tooLong ? "warn" : "muted"}>{length.text}</span>
        </div>
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
        <ul className="warn">{check.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
      )}
      {errors.length > 0 && <ul role="alert" className="error">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}

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
            <button type="button" disabled={pending} onClick={() => act(() => editAsNewVersionAction(projectId, storyboardId))}>Edit as new version</button>
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
